// Tests for bin/image-studio.mjs, the Node helper that drives `codex exec`.
// They run it against tests/mock-codex.mjs, a stand-in for the Codex CLI, so no
// ChatGPT account or network is needed:  node --test tests/helper.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { decodePng, encodeJpeg, flatten, jpegPreview, shrink } from '../bin/image-utils.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const HELPER = path.join(here, '..', 'bin', 'image-studio.mjs')
const MOCK = path.join(here, 'mock-codex.mjs')
const IS_WIN = process.platform === 'win32'

// A scratch folder with a `codex` command that runs the mock, and a project dir.
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-studio-test-'))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.mkdirSync(path.join(root, 'project'))
  if (IS_WIN) {
    fs.writeFileSync(path.join(bin, 'codex.cmd'), `@"${process.execPath}" "${MOCK}" %*\r\n`)
  } else {
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${MOCK}" "$@"\n`, { mode: 0o755 })
  }
  return { root, bin, project: path.join(root, 'project'), codexHome: path.join(root, 'codex-home') }
}

function run(box, args, env = {}, input) {
  const r = spawnSync(process.execPath, [HELPER, ...args], {
    cwd: box.project,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      PATH: `${box.bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${IS_WIN ? process.env.PATH : '/usr/bin:/bin'}`,
      SHELL: '/bin/false',
      CODEX_HOME: box.codexHome,
      MOCK_DELAY_MS: '50',
      ...env,
    },
    timeout: 60_000,
  })
  let json
  try {
    json = JSON.parse(r.stdout.trim().split('\n').pop())
  } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

function png(w, h, rgba) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = buf => {
    let c = 0xffffffff
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgba).flat())])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const isJpeg = buf => buf[0] === 0xff && buf[1] === 0xd8 && buf.at(-2) === 0xff && buf.at(-1) === 0xd9

test('doctor reports ready with a signed-in Codex', () => {
  const box = sandbox()
  const r = run(box, ['doctor', '--json'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.json.ready, true)
  assert.deepEqual(
    r.json.checks.map(c => c.status),
    ['ok', 'ok', 'ok', 'ok', 'info'],
  )
})

test('generate saves the image from the session log, with a copy for Claude and a chat preview', () => {
  const box = sandbox()
  const record = path.join(box.root, 'record.json')
  const r = run(box, ['generate', '--json', '--with-previews', '--out', 'art/apple.png', '--aspect', 'wide'], { MOCK_RECORD: record }, 'a red apple')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.json.ok, true)
  const [img] = r.json.images
  assert.equal(img.path, path.join(box.project, 'art', 'apple.png'))
  assert.deepEqual([img.width, img.height, img.format], [300, 200, 'png'])
  assert.equal(r.json.source, 'session log')
  assert.equal(img.model.mime, 'image/png')
  assert.ok(isJpeg(fs.readFileSync(img.preview.path)), 'preview is a JPEG')

  const sent = JSON.parse(fs.readFileSync(record, 'utf8'))
  assert.ok(sent.args.includes('--sandbox') && sent.args.includes('read-only'))
  assert.ok(sent.args.includes('image_generation'))
  assert.match(sent.stdin, /wide landscape/)
  assert.match(sent.stdin, /a red apple/)
})

test('generate finds a file Codex reports as saved', () => {
  const box = sandbox()
  const r = run(box, ['generate', '--json', '--prompt', 'a pear'], { MOCK_MODE: 'saved' })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.json.source, 'saved_path')
  assert.ok(r.json.images[0].path.startsWith(path.join(box.project, 'generated-images')))
})

test("generate falls back to Codex's generated_images folder", () => {
  const box = sandbox()
  const r = run(box, ['generate', '--json', '--prompt', 'a plum'], { MOCK_MODE: 'dironly' })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.json.source, 'generated_images')
})

test('an edit is saved beside the picture it changed, and never over it', () => {
  const box = sandbox()
  const original = path.join(box.project, 'hero.png')
  fs.writeFileSync(original, png(8, 8, [0, 0, 255, 255]))
  const first = run(box, ['generate', '--json', '--mode', 'edit', '--image', 'hero.png', '--prompt', 'make it red'])
  const second = run(box, ['generate', '--json', '--mode', 'edit', '--image', 'hero.png', '--prompt', 'make it green'])
  assert.equal(first.json.images[0].path, path.join(box.project, 'hero-edit.png'))
  assert.equal(second.json.images[0].path, path.join(box.project, 'hero-edit-2.png'))
  assert.deepEqual(fs.readFileSync(original), png(8, 8, [0, 0, 255, 255]))
})

test('a refusal comes back as an error with the reason', () => {
  const box = sandbox()
  const r = run(box, ['generate', '--json', '--prompt', 'x'], { MOCK_MODE: 'refuse' })
  assert.equal(r.code, 1)
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /content policy/)
})

test('a usage limit comes back with a hint', () => {
  const box = sandbox()
  const r = run(box, ['generate', '--json', '--prompt', 'x'], { MOCK_MODE: 'turnfail' })
  assert.equal(r.json.ok, false)
  assert.match(r.json.hint, /limit/)
})

test('signed out: generate stops early and says how to sign in', () => {
  const box = sandbox()
  const r = run(box, ['generate', '--json', '--prompt', 'x'], { MOCK_LOGIN: 'none' })
  assert.equal(r.json.ok, false)
  assert.match(r.json.hint, /codex login/)
})

test('setup installs the Codex CLI when missing, then signs in', { skip: IS_WIN && 'uses a POSIX npm stand-in' }, () => {
  const box = sandbox()
  fs.rmSync(path.join(box.bin, 'codex'))
  // A stand-in npm whose global install puts the codex command in place.
  fs.writeFileSync(
    path.join(box.bin, 'npm'),
    `#!/bin/sh\nif [ "$1" = "prefix" ]; then echo "${box.root}/none"; exit 0; fi\necho "added 1 package in 2s"\nprintf '#!/bin/sh\\nexec "${process.execPath}" "${MOCK}" "$@"\\n' > "${box.bin}/codex"\nchmod +x "${box.bin}/codex"\n`,
    { mode: 0o755 },
  )
  const signedIn = path.join(box.root, 'signed-in')
  const r = run(box, ['setup', '--json'], { MOCK_LOGIN_FILE: signedIn })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.json.ready, true)
  assert.match(r.stderr, /installing the Codex CLI/)
  assert.match(r.stderr, /codex: https:\/\/auth\.openai\.com/)
  assert.match(r.stderr, /ok: signed in with ChatGPT/)
  assert.ok(fs.existsSync(signedIn))
})

test('setup reports a sign-in that did not finish', () => {
  const box = sandbox()
  const r = run(box, ['setup', '--json'], { MOCK_LOGIN_FILE: path.join(box.root, 'signed-in'), MOCK_LOGIN_FAIL: '1' })
  assert.equal(r.code, 1)
  assert.match(r.json.error, /did not finish/)
})

test('image utils: decode, shrink and encode a preview', () => {
  const img = decodePng(png(64, 32, [200, 30, 30, 128]))
  assert.deepEqual([img.width, img.height], [64, 32])
  const small = shrink(img, 16)
  assert.deepEqual([small.width, small.height], [16, 8])
  assert.ok(isJpeg(encodeJpeg(flatten(small), 80)))
  const preview = jpegPreview(png(1024, 512, [10, 120, 220, 255]), { maxSide: 512, maxBase64: 110_000 })
  assert.deepEqual([preview.width, preview.height, preview.transparent], [512, 256, false])
})
