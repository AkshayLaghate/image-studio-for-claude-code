#!/usr/bin/env node
// image-studio: generate or edit images with the Codex CLI's built-in image tool,
// billed to the ChatGPT / Codex plan you signed in with (`codex login`).
//
// The Claude Code mod in this folder calls this script, and it works on its own too:
//
//   node image-studio.mjs generate --prompt "a lighthouse at dusk, watercolor" --out art/lighthouse.png
//   node image-studio.mjs generate --mode edit --image photo.jpg --prompt "make the sky stormy"
//   echo "flat vector fox logo" | node image-studio.mjs generate --transparent
//   node image-studio.mjs doctor
//   node image-studio.mjs setup [--device-auth]   (installs the Codex CLI if missing, signs in)
//
// Options for `generate`:
//   --prompt <text>        what to draw (or pipe it on stdin, or --prompt-file <path>)
//   --mode generate|edit   edit: the first --image is the picture to change (default generate)
//   --image <path>         an input image; repeat for several (edit target first, then references)
//   --out <path>           where to save; default <out-dir>/<slug>-<timestamp>.<ext>,
//                          or <input>-edit.<ext> beside the edited picture
//   --out-dir <dir>        default ./generated-images
//   --aspect <shape>       square | landscape | portrait | wide | tall | auto (a hint to the model)
//   --transparent          ask for a transparent background
//   --overwrite            replace --out if it exists (default: add -2, -3, ...)
//   --model <name>         the Codex agent model that drives the tool (not the image model)
//   --effort <level>       that agent's reasoning effort: minimal | low | medium | high (default low)
//   --timeout <seconds>    default 600
//   --json                 print one JSON object on stdout (progress always goes to stderr)
//
// Environment: IMAGE_STUDIO_CODEX_BIN (path to the codex executable), CODEX_HOME.
// Requires Node 18+. No dependencies.

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { encodeJpeg, flatten, jpegPreview, decodePng, shrink } from './image-utils.mjs'

const VERSION = '0.4.0'
const PREVIEW_DIR = path.join(os.tmpdir(), 'image-studio-previews')
const PREVIEW_MAX_SIDE = 512
const PREVIEW_MAX_BASE64 = 110_000 // fits a chat drawing's 131,072-character SVG
const MODEL_MAX_SIDE = 1568 // Claude sees images up to this long side
const MODEL_PNG_MAX_BYTES = 1_500_000
const MODEL_OTHER_MAX_BYTES = 3_500_000
const MODEL_MAX_BASE64 = 3_000_000
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
const IS_WIN = process.platform === 'win32'
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const ASPECTS = {
  square: 'square, 1:1',
  landscape: 'landscape, wider than tall (about 3:2)',
  portrait: 'portrait, taller than wide (about 2:3)',
  wide: 'wide landscape (about 16:9)',
  tall: 'tall portrait (about 9:16)',
}

const log = msg => process.stderr.write(`[image-studio] ${msg}\n`)

class Failure extends Error {
  constructor(message, hint, extra = {}) {
    super(message)
    this.hint = hint
    this.extra = extra
  }
}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = { images: [], _: [] }
  const booleans = new Set(['json', 'transparent', 'overwrite', 'help', 'version', 'withPreviews', 'with-previews', 'deviceAuth', 'device-auth'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      opts._.push(arg)
      continue
    }
    let key = arg.slice(2)
    let value
    const eq = key.indexOf('=')
    if (eq >= 0) {
      value = key.slice(eq + 1)
      key = key.slice(0, eq)
    }
    if (booleans.has(key)) {
      opts[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value === undefined ? true : value !== 'false'
      continue
    }
    if (value === undefined) {
      value = argv[++i]
      if (value === undefined) throw new Failure(`--${key} needs a value`)
    }
    if (key === 'image') opts.images.push(value)
    else opts[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
  }
  return opts
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// ---------------------------------------------------------------- finding codex

function codexHome() {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex')
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function lookupOnPath(name) {
  const r = spawnSync(IS_WIN ? 'where' : 'which', IS_WIN ? [name] : ['-a', name], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  })
  if (r.status !== 0 || !r.stdout) return []
  return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
}

function lookupInLoginShell(name) {
  // GUI apps on macOS start with a short PATH; ask the person's login shell.
  if (IS_WIN) return []
  const shell = process.env.SHELL || '/bin/sh'
  const r = spawnSync(shell, ['-lc', `command -v ${name}`], { encoding: 'utf8', timeout: 10_000 })
  if (r.status !== 0 || !r.stdout) return []
  return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(p => path.isAbsolute(p))
}

function wellKnownCodexPaths() {
  const home = os.homedir()
  if (IS_WIN) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    return [
      path.join(appData, 'npm', 'codex.cmd'),
      path.join(localAppData, 'pnpm', 'codex.cmd'),
      path.join(home, 'scoop', 'shims', 'codex.exe'),
      path.join(localAppData, 'Programs', 'codex', 'codex.exe'),
    ]
  }
  return [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/usr/bin/codex',
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.npm-global', 'bin', 'codex'),
    path.join(home, '.volta', 'bin', 'codex'),
    path.join(home, '.bun', 'bin', 'codex'),
    '/Applications/Codex.app/Contents/Resources/codex',
  ]
}

// Turns a path to codex into how to start it. On Windows an npm install leaves
// codex.cmd, which Node cannot start without a shell: run its codex.js with
// this Node instead when it is there.
function launcherFor(p) {
  if (!IS_WIN) {
    // An npm install links codex to its codex.js; run that with this Node, so a
    // shebang's `node` need not be on PATH.
    try {
      const real = fs.realpathSync(p)
      if (real.endsWith('.js')) return { command: process.execPath, prefix: [real], display: p }
    } catch {}
    return { command: p, prefix: [], display: p }
  }
  const ext = path.extname(p).toLowerCase()
  if (ext === '.exe') return { command: p, prefix: [], display: p }
  if (ext === '.cmd' || ext === '.bat') {
    const js = path.join(path.dirname(p), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (isFile(js)) return { command: process.execPath, prefix: [js], display: p }
    return { command: p, prefix: [], shell: true, display: p }
  }
  return null // extensionless shell shims and .ps1 cannot be started directly
}

// Where `npm install -g` puts commands, which is not always on PATH (a custom
// npm prefix, or an app started before the install). Asked once, then kept.
let npmGlobalBins
function npmGlobalBinPaths() {
  if (npmGlobalBins) return npmGlobalBins
  npmGlobalBins = []
  try {
    const r = spawnSync(IS_WIN ? 'npm prefix -g' : 'npm', IS_WIN ? [] : ['prefix', '-g'], {
      encoding: 'utf8',
      shell: IS_WIN,
      windowsHide: true,
      timeout: 15_000,
    })
    const prefix = r.status === 0 ? r.stdout.trim() : ''
    if (prefix) {
      npmGlobalBins = IS_WIN
        ? [path.join(prefix, 'codex.cmd')]
        : [path.join(prefix, 'bin', 'codex')]
    }
  } catch {}
  return npmGlobalBins
}

function resolveCodex() {
  const override = process.env.IMAGE_STUDIO_CODEX_BIN || process.env.CODEX_IMAGE_CODEX_BIN || process.env.CODEX_BIN
  if (override) {
    const launcher = launcherFor(override) || { command: override, prefix: [], display: override }
    return { ...launcher, source: 'IMAGE_STUDIO_CODEX_BIN' }
  }
  const seen = new Set()
  const tryList = (list, source) => {
    for (const p of list) {
      if (seen.has(p)) continue
      seen.add(p)
      if (!isFile(p)) continue
      const launcher = launcherFor(p)
      if (launcher) return { ...launcher, source }
    }
    return null
  }
  return (
    tryList(lookupOnPath('codex'), 'PATH') ||
    tryList(wellKnownCodexPaths(), 'well-known location') ||
    tryList(lookupInLoginShell('codex'), 'login shell') ||
    tryList(npmGlobalBinPaths(), "npm's global folder")
  )
}

function quoteForCmd(s) {
  return /^[\w\-.:\\/=]+$/.test(s) ? s : `"${String(s).replace(/"/g, '""')}"`
}

function startProcess(launcher, args, options) {
  const fullArgs = [...launcher.prefix, ...args]
  if (launcher.shell) {
    const line = [launcher.command, ...fullArgs].map(quoteForCmd).join(' ')
    return spawn(line, { ...options, shell: true, windowsHide: true })
  }
  return spawn(launcher.command, fullArgs, { ...options, windowsHide: true, detached: !IS_WIN })
}

function runQuick(launcher, args, timeoutMs = 30_000) {
  return new Promise(resolve => {
    let out = ''
    let child
    try {
      child = startProcess(launcher, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: -1, out: String(err.message || err) })
      return
    }
    const timer = setTimeout(() => killTree(child), timeoutMs)
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ code: -1, out: String(err.message || err) })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out })
    })
  })
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return
  try {
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    else process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {}
  }
  if (!IS_WIN) {
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, 3000).unref()
  }
}

// ---------------------------------------------------------------- images

function imageInfo(buf) {
  if (!buf || buf.length < 12) return null
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++
        continue
      }
      const marker = buf[i + 1]
      if (marker === 0xd8 || marker === 0x01 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7)) {
        i += marker === 0xff ? 1 : 2
        continue
      }
      const length = buf.readUInt16BE(i + 2)
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
      if (isSof) return { ext: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      i += 2 + length
    }
    return { ext: 'jpg' }
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16)
    if (chunk === 'VP8X' && buf.length >= 30) {
      return { ext: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      return { ext: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21)
      return { ext: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return { ext: 'webp' }
  }
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { ext: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  return null
}

function decodeBase64Image(data) {
  if (typeof data !== 'string' || data.length < 100) return null
  const raw = data.replace(/^data:[^;,]+;base64,/, '')
  if (!/^[A-Za-z0-9+/=\r\n_-]+$/.test(raw.slice(0, 200))) return null
  const bytes = Buffer.from(raw, raw.includes('-') || raw.includes('_') ? 'base64url' : 'base64')
  const info = imageInfo(bytes)
  return info ? { bytes, ...info } : null
}

function readImageFile(p) {
  try {
    const bytes = fs.readFileSync(p)
    const info = imageInfo(bytes)
    return info ? { bytes, ...info } : null
  } catch {
    return null
  }
}

// Walks any JSON value and collects what Codex reports about generated images:
// a saved file's path, the base64 result itself, and the prompt it revised.
function collectImageFacts(value, facts, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return
  if (Array.isArray(value)) {
    for (const item of value) collectImageFacts(item, facts, depth + 1)
    return
  }
  if (typeof value.saved_path === 'string' && value.saved_path) facts.savedPaths.push(value.saved_path)
  if (typeof value.savedPath === 'string' && value.savedPath) facts.savedPaths.push(value.savedPath)
  const type = typeof value.type === 'string' ? value.type : ''
  if (/image_gen/.test(type) || /imageGeneration/.test(type)) {
    if (typeof value.result === 'string' && value.result.length > 100) facts.results.push(value.result)
    if (typeof value.revised_prompt === 'string' && value.revised_prompt) facts.revisedPrompt = value.revised_prompt
    if (typeof value.failure === 'string' && value.failure) facts.failure = value.failure
    if (value.failure && typeof value.failure === 'object') facts.failure = JSON.stringify(value.failure)
  }
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (child && typeof child === 'object') collectImageFacts(child, facts, depth + 1)
  }
}

function newFacts() {
  return { savedPaths: [], results: [], revisedPrompt: undefined, failure: undefined }
}

function listDirNewestFirst(dir) {
  try {
    return fs.readdirSync(dir).sort().reverse()
  } catch {
    return []
  }
}

function findRollout(home, threadId) {
  if (!threadId) return null
  const root = path.join(home, 'sessions')
  let dayDirsChecked = 0
  for (const year of listDirNewestFirst(root)) {
    for (const month of listDirNewestFirst(path.join(root, year))) {
      for (const day of listDirNewestFirst(path.join(root, year, month))) {
        const dir = path.join(root, year, month, day)
        for (const name of listDirNewestFirst(dir)) {
          if (name.includes(threadId) && name.endsWith('.jsonl')) return path.join(dir, name)
        }
        if (++dayDirsChecked >= 14) return null
      }
    }
  }
  return null
}

function scanRollout(file, facts) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    if (!line.includes('image_gen') && !line.includes('saved_path') && !line.includes('imageGeneration')) continue
    try {
      collectImageFacts(JSON.parse(line), facts)
    } catch {}
  }
}

function filesUnder(dir, depth = 2) {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory() && depth > 0) out.push(...filesUnder(p, depth - 1))
    else if (entry.isFile()) out.push(p)
  }
  return out
}

function dedupeImages(images) {
  const seen = new Set()
  return images.filter(img => {
    const key = `${img.bytes.length}:${img.bytes.subarray(0, 64).toString('hex')}:${img.bytes.subarray(-64).toString('hex')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function locateImages({ home, threadId, startedAt, facts }) {
  const rollout = findRollout(home, threadId)
  if (rollout) scanRollout(rollout, facts)

  // 1. Files Codex says it saved.
  const saved = [...new Set(facts.savedPaths)]
    .map(p => (path.isAbsolute(p) ? p : path.join(home, p)))
    .map(p => ({ img: readImageFile(p), from: p }))
    .filter(x => x.img)
  if (saved.length) return { images: dedupeImages(saved.map(x => x.img)), source: 'saved_path', rollout }

  // 2. The base64 result recorded in the session.
  const inline = facts.results.map(decodeBase64Image).filter(Boolean)
  if (inline.length) return { images: dedupeImages(inline), source: 'session log', rollout }

  // 3. Codex's default output folder.
  const generated = path.join(home, 'generated_images')
  const candidates = threadId ? filesUnder(path.join(generated, threadId), 1) : []
  const recent = candidates.length
    ? candidates
    : filesUnder(generated, 2).filter(p => {
        try {
          return fs.statSync(p).mtimeMs >= startedAt - 2000
        } catch {
          return false
        }
      })
  const files = recent
    .filter(p => IMAGE_EXTS.has(path.extname(p).toLowerCase()))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
    .map(readImageFile)
    .filter(Boolean)
  if (files.length) return { images: dedupeImages(files), source: 'generated_images', rollout }

  return { images: [], source: undefined, rollout }
}

// ---------------------------------------------------------------- output paths

function slugify(text) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
  return (words.join('-') || 'image').slice(0, 48).replace(/-+$/, '')
}

function stamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function withSuffix(file, suffix) {
  const ext = path.extname(file)
  return file.slice(0, file.length - ext.length) + suffix + ext
}

function uniquePath(file) {
  if (!fs.existsSync(file)) return file
  for (let n = 2; n < 1000; n++) {
    const candidate = withSuffix(file, `-${n}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return withSuffix(file, `-${Date.now()}`)
}

const EXT_ALIASES = { '.jpeg': 'jpg', '.jpg': 'jpg', '.png': 'png', '.webp': 'webp', '.gif': 'gif' }

function writeOutputs(images, opts, prompt) {
  const results = []
  images.forEach((img, index) => {
    let target
    if (opts.out) {
      target = path.resolve(opts.out)
      if (index > 0) target = withSuffix(target, `-${index + 1}`)
    } else {
      const dir = path.resolve(opts.outDir || 'generated-images')
      target = path.join(dir, `${slugify(prompt)}-${stamp()}${index > 0 ? `-${index + 1}` : ''}.${img.ext}`)
    }
    let note
    const ext = path.extname(target).toLowerCase()
    if (!ext) {
      target += `.${img.ext}`
    } else if (EXT_ALIASES[ext] !== img.ext) {
      note = `saved as .${img.ext} because Codex returned ${img.ext.toUpperCase()} data (asked for ${ext})`
      target = target.slice(0, target.length - ext.length) + `.${img.ext}`
    }
    if (!opts.overwrite) target = uniquePath(target)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, img.bytes)
    results.push({
      path: target,
      format: img.ext,
      width: img.width,
      height: img.height,
      bytes: img.bytes.length,
      ...(note ? { note } : {}),
    })
  })
  return results
}

// ---------------------------------------------------------------- copies for Claude and the chat

function prunePreviews() {
  try {
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000
    for (const name of fs.readdirSync(PREVIEW_DIR)) {
      const p = path.join(PREVIEW_DIR, name)
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true })
    }
  } catch {}
}

// What the mod needs beside the saved file: `model`, the image as Claude should
// see it (the file itself when small enough, else a JPEG at Claude's own
// resolution), and `preview`, a small JPEG the chat draws.
function imageCopies(img, out) {
  const copies = {}
  const decoded = img.ext === 'png' ? decodePng(img.bytes) : null
  const longSide = Math.max(img.width || 0, img.height || 0)

  if (img.ext === 'png' && img.bytes.length <= MODEL_PNG_MAX_BYTES && longSide <= MODEL_MAX_SIDE) {
    copies.model = { mime: MIME.png, base64: img.bytes.toString('base64') }
  } else if (decoded) {
    // Step quality, then size, down until the copy is comfortably under the API's per-image limit.
    let side = MODEL_MAX_SIDE
    let quality = 85
    for (let attempt = 0; attempt < 8; attempt++) {
      const base64 = encodeJpeg(flatten(shrink(decoded, side), 12), quality).toString('base64')
      if (base64.length <= MODEL_MAX_BASE64) {
        copies.model = { mime: MIME.jpg, base64 }
        break
      }
      if (quality > 60) quality -= 12
      else side = Math.round(side * 0.75)
    }
  } else if (img.ext !== 'png' && MIME[img.ext] && img.bytes.length <= MODEL_OTHER_MAX_BYTES) {
    copies.model = { mime: MIME[img.ext], base64: img.bytes.toString('base64') }
  }

  let preview = null
  if (decoded) {
    preview = jpegPreview(img.bytes, { maxSide: PREVIEW_MAX_SIDE, maxBase64: PREVIEW_MAX_BASE64 })
  } else if (img.ext === 'jpg' && img.bytes.length * 4 / 3 <= PREVIEW_MAX_BASE64 && img.width && img.height) {
    preview = { mime: MIME.jpg, base64: img.bytes.toString('base64'), width: img.width, height: img.height }
  }
  if (preview) {
    try {
      fs.mkdirSync(PREVIEW_DIR, { recursive: true })
      prunePreviews()
      const file = path.join(PREVIEW_DIR, `${randomUUID()}.jpg`)
      fs.writeFileSync(file, Buffer.from(preview.base64, 'base64'))
      copies.preview = { path: file, width: preview.width, height: preview.height, transparent: !!preview.transparent }
    } catch (err) {
      log(`could not write the chat preview: ${err.message}`)
    }
  }
  return copies
}

// ---------------------------------------------------------------- the request

function buildInstructions(prompt, { mode, imageCount, aspect, transparent }) {
  const lines = [
    'You are being run by an automated bridge. Your only job is to call your built-in `image_gen` tool, then stop.',
    '',
    'Rules:',
    '- Use the built-in `image_gen` tool. Do not use the imagegen CLI fallback, scripts/image_gen.py, an API key, Python, shell commands or file edits.',
    '- Make exactly one image with one `image_gen` call.',
    '- Use the request below as the image prompt as faithfully as you can: keep every concrete detail, the style, and any exact text that must appear in the image (spelled exactly). Do not add unrelated content.',
  ]
  if (mode === 'edit') {
    lines.push(
      '- This is an EDIT. Attached image 1 is the picture to change. Keep everything the request does not ask to change: subject identity, composition, framing, colors, lighting and style.',
    )
    if (imageCount > 1) lines.push(`- Attached images 2-${imageCount} are references for the edit.`)
  } else if (imageCount > 0) {
    lines.push(`- The ${imageCount} attached image(s) are visual references for the new image.`)
  }
  if (aspect && ASPECTS[aspect]) lines.push(`- Shape: ${ASPECTS[aspect]}.`)
  if (transparent) lines.push('- The image needs a genuinely transparent background (real alpha) and a clean cutout of the subject.')
  lines.push(
    '- When the tool has returned, reply with exactly one line: IMAGE_DONE',
    '- If you cannot make the image (a refusal or a tool failure), reply with exactly one line: IMAGE_FAILED: <short reason>',
    '',
    'Image request:',
    '"""',
    prompt.trim(),
    '"""',
  )
  return lines.join('\n')
}

function classify(text) {
  const t = (text || '').toLowerCase()
  if (/not logged in|login required|unauthori[sz]ed|\b401\b|sign in again|log out and sign in|refresh token/.test(t)) {
    return 'Run `codex login` in a terminal and sign in with your ChatGPT account, then try again.'
  }
  if (/usage limit|rate limit|\b429\b|too many requests|quota/.test(t)) {
    return 'Your Codex plan limit was reached. Image turns use the limit 3-5x faster than text; wait for the window to reset.'
  }
  if (/image_gen\w*\W+(?:\w+\W+){0,3}(?:not available|unavailable|not supported|disabled)|unknown feature/.test(t)) {
    return 'Update Codex (`npm i -g @openai/codex@latest`) and run `codex features list | grep image_generation`.'
  }
  if (/network|connect|dns|proxy|timed out/.test(t)) return 'Codex could not reach OpenAI; check the network or proxy.'
  return undefined
}

async function generate(opts) {
  const startedAt = Date.now()
  let prompt = opts.prompt
  if (!prompt && opts.promptFile) prompt = fs.readFileSync(path.resolve(opts.promptFile), 'utf8')
  if (!prompt && opts._.length) prompt = opts._.join(' ')
  if (!prompt) prompt = await readStdin()
  if (!prompt || !prompt.trim()) throw new Failure('No prompt given.', 'Pass --prompt "<description>" or pipe it on stdin.')

  const mode = opts.mode === 'edit' ? 'edit' : 'generate'
  const aspect = opts.aspect && opts.aspect !== 'auto' ? String(opts.aspect).toLowerCase() : undefined
  if (aspect && !ASPECTS[aspect]) throw new Failure(`Unknown --aspect "${opts.aspect}".`, `Use one of: auto, ${Object.keys(ASPECTS).join(', ')}.`)
  const effort = String(opts.effort || 'low').toLowerCase()
  if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Failure(`Unknown --effort "${opts.effort}".`)
  const timeoutMs = Math.max(30, Number(opts.timeout || 600)) * 1000

  const images = opts.images.map(p => path.resolve(p))
  for (const img of images) {
    if (!isFile(img)) throw new Failure(`Input image not found: ${img}`)
    if (!IMAGE_EXTS.has(path.extname(img).toLowerCase())) throw new Failure(`Not a PNG, JPEG, WebP or GIF file: ${img}`)
  }
  if (mode === 'edit' && images.length === 0) throw new Failure('Edit mode needs the image to edit (--image <path>).')

  const codex = resolveCodex()
  if (!codex) {
    throw new Failure(
      'The Codex CLI was not found.',
      'Install it with `npm i -g @openai/codex` and sign in with `codex login`, or set IMAGE_STUDIO_CODEX_BIN to its full path.',
    )
  }
  log(`using codex at ${codex.display}`)

  const login = await runQuick(codex, ['login', 'status'])
  if (/not logged in/i.test(login.out)) {
    throw new Failure('Codex is not signed in.', 'Run `codex login` in a terminal and sign in with your ChatGPT account.')
  }
  if (/api key/i.test(login.out)) log('note: Codex is signed in with an API key, so images are billed to that API account, not your ChatGPT plan.')

  const home = codexHome()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'image-studio-'))
  const lastMessageFile = path.join(work, 'last-message.txt')
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--cd',
    work,
    '--output-last-message',
    lastMessageFile,
    '--enable',
    'image_generation',
    '-c',
    `model_reasoning_effort="${effort}"`,
  ]
  if (opts.model) args.push('--model', String(opts.model))
  for (const img of images) args.push('--image', img)

  const instructions = buildInstructions(prompt, { mode, imageCount: images.length, aspect, transparent: !!opts.transparent })
  const facts = newFacts()
  const state = { threadId: undefined, turnFailed: undefined, lastError: undefined, agentText: '', stderrTail: [] }

  log(mode === 'edit' ? 'asking Codex to edit the image' : 'asking Codex to generate the image')
  const heartbeat = setInterval(() => log(`working ${Math.round((Date.now() - startedAt) / 1000)}s`), 10_000)

  let child
  const exit = await new Promise(resolve => {
    try {
      child = startProcess(codex, args, { cwd: work, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    } catch (err) {
      resolve({ code: -1, error: err })
      return
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      log(`timed out after ${timeoutMs / 1000}s; stopping codex`)
      killTree(child)
    }, timeoutMs)
    const stopChild = () => {
      killTree(child)
      process.exit(130)
    }
    process.once('SIGTERM', stopChild)
    process.once('SIGINT', stopChild)

    let outBuf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      outBuf += chunk
      let nl
      while ((nl = outBuf.indexOf('\n')) >= 0) {
        handleEvent(outBuf.slice(0, nl), state, facts)
        outBuf = outBuf.slice(nl + 1)
      }
    })
    let errBuf = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      errBuf += chunk
      let nl
      while ((nl = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, nl).trim()
        errBuf = errBuf.slice(nl + 1)
        if (line) {
          state.stderrTail.push(line)
          if (state.stderrTail.length > 30) state.stderrTail.shift()
        }
      }
    })
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ code: -1, error: err, timedOut })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (outBuf.trim()) handleEvent(outBuf, state, facts)
      resolve({ code, signal, timedOut })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(instructions)
  })
  clearInterval(heartbeat)

  if (exit.error) {
    throw new Failure(`Could not start codex: ${exit.error.message || exit.error}`, 'Set IMAGE_STUDIO_CODEX_BIN to the full path of the codex executable.')
  }

  let lastMessage = ''
  try {
    lastMessage = fs.readFileSync(lastMessageFile, 'utf8').trim()
  } catch {}
  if (!lastMessage) lastMessage = state.agentText.trim()

  const found = locateImages({ home, threadId: state.threadId, startedAt, facts })
  try {
    fs.rmSync(work, { recursive: true, force: true })
  } catch {}

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 100) / 10
  if (!found.images.length) {
    const refusal = /IMAGE_FAILED:?\s*(.*)/i.exec(lastMessage)
    const reason = exit.timedOut
      ? `Codex did not finish within ${timeoutMs / 1000}s.`
      : refusal
        ? `Codex could not make the image: ${refusal[1] || 'no reason given'}`
        : facts.failure
          ? `The image tool failed: ${facts.failure}`
          : state.turnFailed
            ? `Codex failed: ${state.turnFailed}`
            : exit.code !== 0 && state.lastError
              ? `Codex failed: ${state.lastError}`
              : lastMessage
                ? `Codex finished without an image. It said: ${lastMessage.slice(0, 400)}`
                : `Codex exited (code ${exit.code}) without producing an image.`
    const detail = [state.turnFailed, state.lastError, facts.failure, ...state.stderrTail.slice(-5)].filter(Boolean).join('\n')
    throw new Failure(reason, classify(`${reason}\n${detail}`) || (exit.timedOut ? 'Try again, or raise --timeout.' : undefined), {
      threadId: state.threadId,
      elapsedSeconds,
      codexOutputTail: state.stderrTail.slice(-8),
      sessionLog: found.rollout || undefined,
    })
  }

  // An edit lands beside the picture it changed unless told otherwise; the
  // extension follows the bytes Codex returned.
  if (mode === 'edit' && !opts.out) {
    const first = images[0]
    opts.out = `${first.slice(0, first.length - path.extname(first).length)}-edit`
  }
  const outputs = writeOutputs(found.images, opts, prompt)
  if (opts.withPreviews) {
    outputs.forEach((out, i) => Object.assign(out, imageCopies(found.images[i], out)))
  }
  return {
    ok: true,
    images: outputs,
    revisedPrompt: facts.revisedPrompt,
    codexMessage: lastMessage || undefined,
    threadId: state.threadId,
    source: found.source,
    elapsedSeconds,
  }
}

function handleEvent(line, state, facts) {
  const text = line.trim()
  if (!text.startsWith('{')) return
  let event
  try {
    event = JSON.parse(text)
  } catch {
    return
  }
  collectImageFacts(event, facts)
  switch (event.type) {
    case 'thread.started':
      state.threadId = event.thread_id || event.threadId
      log(`codex session ${state.threadId}`)
      break
    case 'turn.failed':
      state.turnFailed = event.error?.message || JSON.stringify(event.error || event)
      log(`turn failed: ${state.turnFailed}`)
      break
    case 'error':
      state.lastError = event.message || JSON.stringify(event)
      log(`codex: ${state.lastError}`)
      break
    case 'item.started':
    case 'item.completed': {
      const item = event.item || {}
      if (item.type === 'agent_message' && typeof item.text === 'string' && event.type === 'item.completed') {
        state.agentText = item.text
      }
      if (item.type && item.type !== 'agent_message') log(`${event.type === 'item.started' ? 'started' : 'finished'} ${item.type}`)
      break
    }
    case 'turn.completed':
      log('codex turn completed')
      break
  }
}

// ---------------------------------------------------------------- doctor

async function doctor() {
  const checks = []
  const add = (status, label, detail) => checks.push({ status, label, detail })
  const [major] = process.versions.node.split('.').map(Number)
  add(major >= 18 ? 'ok' : 'fail', 'Node', `v${process.versions.node} (${process.platform} ${process.arch})${major >= 18 ? '' : ': Node 18 or newer is needed'}`)

  const codex = resolveCodex()
  if (!codex) {
    add('fail', 'Codex CLI', 'not found. Install with `npm i -g @openai/codex`, or set IMAGE_STUDIO_CODEX_BIN to its path.')
  } else {
    const version = await runQuick(codex, ['--version'])
    add(version.code === 0 ? 'ok' : 'fail', 'Codex CLI', `${version.out.trim().split('\n').pop() || '(no version output)'} at ${codex.display} (found via ${codex.source})`)
    const login = await runQuick(codex, ['login', 'status'])
    const loginText = login.out.trim().split('\n').filter(Boolean).pop() || '(no output)'
    if (/not logged in/i.test(loginText)) add('fail', 'Sign-in', `${loginText}. Run \`codex login\` and choose "Sign in with ChatGPT".`)
    else if (/chatgpt/i.test(loginText)) add('ok', 'Sign-in', loginText)
    else if (/api key/i.test(loginText)) add('warn', 'Sign-in', `${loginText}: images will be billed to the API account. Run \`codex login\` with ChatGPT to use your plan.`)
    else add('warn', 'Sign-in', loginText)
    const features = await runQuick(codex, ['features', 'list'])
    const row = features.out.split('\n').find(l => /^\s*image_generation\s/.test(l))
    if (row) {
      const enabled = /\btrue\s*$/.test(row.trim())
      add(enabled ? 'ok' : 'warn', 'image_generation feature', `${row.trim().replace(/\s+/g, ' ')}${enabled ? '' : ' (this tool enables it per run)'}`)
    } else {
      add('warn', 'image_generation feature', 'not listed by `codex features list`; update Codex if generation fails.')
    }
  }
  add('info', 'CODEX_HOME', codexHome())
  const ready = !checks.some(c => c.status === 'fail')
  return { ok: ready, ready, version: VERSION, checks }
}

function formatDoctor(report) {
  const icon = { ok: '✔', warn: '⚠', fail: '✘', info: '•' }
  const lines = report.checks.map(c => `${icon[c.status]} ${c.label}: ${c.detail}`)
  lines.push(report.ready ? 'Ready: Claude can generate images through Codex.' : 'Not ready yet: fix the ✘ items above.')
  return lines.join('\n')
}

// ---------------------------------------------------------------- setup

// Runs a command to its end, forwarding each line it prints to stderr under
// `label`, so a caller (the mod) can show progress as it happens.
function runForwarding(launcher, args, label, timeoutMs) {
  return new Promise(resolve => {
    let child
    try {
      child = startProcess(launcher, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: -1, error: err })
      return
    }
    const timer = setTimeout(() => killTree(child), timeoutMs)
    const forward = stream => {
      let buf = ''
      stream.setEncoding('utf8')
      stream.on('data', chunk => {
        buf += chunk
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '').trim()
          buf = buf.slice(nl + 1)
          if (line) log(`${label}: ${line}`)
        }
      })
      stream.on('end', () => buf.trim() && log(`${label}: ${buf.trim()}`))
    }
    forward(child.stdout)
    forward(child.stderr)
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ code: -1, error: err })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? -1 })
    })
  })
}

// Gets a machine ready: installs the Codex CLI when it is missing, signs in to
// Codex with ChatGPT when it is not, then reports what doctor sees.
async function setup(opts) {
  let codex = resolveCodex()
  if (codex) {
    log(`ok: Codex CLI found at ${codex.display}`)
  } else {
    log('step: installing the Codex CLI (npm install -g @openai/codex). This takes a minute.')
    const npm = { command: 'npm', prefix: [], shell: IS_WIN, display: 'npm' }
    const installed = await runForwarding(npm, ['install', '-g', '@openai/codex'], 'npm', 10 * 60_000)
    if (installed.code !== 0) {
      throw new Failure(
        'Installing the Codex CLI failed.',
        installed.error
          ? 'npm was not found. Install Node.js 18+ (it includes npm), then run setup again.'
          : 'Run `npm install -g @openai/codex` in a terminal and read its error (on macOS or Linux a global install may need a Node version manager, or sudo). Then run setup again.',
      )
    }
    npmGlobalBins = undefined
    codex = resolveCodex()
    if (!codex) {
      throw new Failure('The Codex CLI was installed but cannot be found yet.', 'Restart Claude Code (or open a new terminal) so it sees the new PATH, then run setup again.')
    }
    log(`ok: Codex CLI installed at ${codex.display}`)
  }

  const status = await runQuick(codex, ['login', 'status'])
  if (/logged in using chatgpt/i.test(status.out)) {
    log('ok: Codex is already signed in with ChatGPT')
  } else {
    if (/api key/i.test(status.out)) log('note: Codex is signed in with an API key; signing in with ChatGPT instead, so images use your plan')
    log(
      opts.deviceAuth
        ? 'step: signing in to Codex with your ChatGPT account. Open the link below and enter the code it shows.'
        : 'step: signing in to Codex with your ChatGPT account. A browser window opens; if it does not, open the link below.',
    )
    const args = opts.deviceAuth ? ['login', '--device-auth'] : ['login']
    await runForwarding(codex, args, 'codex', 10 * 60_000)
    const after = await runQuick(codex, ['login', 'status'])
    if (!/logged in using chatgpt/i.test(after.out)) {
      throw new Failure(
        'Signing in to Codex did not finish.',
        opts.deviceAuth
          ? 'Run setup again, or run `codex login` in a terminal.'
          : 'Run setup again. On a machine without a browser, use device sign-in: `/image-studio-setup device`.',
      )
    }
    log('ok: signed in with ChatGPT')
  }
  return doctor()
}

// ---------------------------------------------------------------- main

const HELP = `image-studio ${VERSION}: images from the Codex CLI's built-in image tool, on your ChatGPT plan

  image-studio generate --prompt "<text>" [--out file.png] [--image in.png ...] [--mode edit]
                       [--aspect square|landscape|portrait|wide|tall] [--transparent]
                       [--effort low] [--model <codex model>] [--timeout 600] [--json]
  image-studio doctor [--json]
  image-studio setup [--device-auth] [--json]
`

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2)
  let opts = { json: rest.includes('--json') }
  try {
    opts = parseArgs(rest)
    if (command === 'help' || command === '--help' || opts.help) {
      process.stdout.write(HELP)
      return
    }
    if (command === 'version' || command === '--version') {
      process.stdout.write(`${VERSION}\n`)
      return
    }
    if (command === 'doctor' || command === 'setup') {
      const report = command === 'setup' ? await setup(opts) : await doctor()
      process.stdout.write(opts.json ? `${JSON.stringify(report)}\n` : `${formatDoctor(report)}\n`)
      process.exitCode = report.ready ? 0 : 1
      return
    }
    if (command !== 'generate' && command !== 'edit') throw new Failure(`Unknown command "${command}".`, 'Use `generate`, `edit`, `doctor` or `setup`.')
    if (command === 'edit') opts.mode = 'edit'
    const result = await generate(opts)
    if (opts.json) process.stdout.write(`${JSON.stringify(result)}\n`)
    else {
      for (const img of result.images) process.stdout.write(`${img.path}\n`)
    }
  } catch (err) {
    const failure = err instanceof Failure ? err : new Failure(String(err?.stack || err))
    const payload = { ok: false, error: failure.message, ...(failure.hint ? { hint: failure.hint } : {}), ...failure.extra }
    if (opts.json) process.stdout.write(`${JSON.stringify(payload)}\n`)
    log(`error: ${failure.message}${failure.hint ? `\n[image-studio] hint: ${failure.hint}` : ''}`)
    process.exitCode = 1
  }
}

main()
