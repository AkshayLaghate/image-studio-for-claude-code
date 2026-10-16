// image-studio: gives every Claude Code session two tools, generate_image and
// edit_image, served by the Codex CLI's built-in image tool on the person's
// ChatGPT/Codex plan. The work happens in ../bin/image-studio.mjs (Node), which
// this module runs. This module talks to Claude Code: it registers the tools,
// hands the finished image back to the model, and draws it in the chat.
import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderElement, RenderInput, ToolCallResult } from 'claude-code'

import type { RunningCall, ShownCall, ShownImage } from '../types'

const MOD_VERSION = '0.4.0'
const GENERATE = 'mcp__image-studio__generate_image'
const EDIT = 'mcp__image-studio__edit_image'
const ASPECTS = ['auto', 'square', 'landscape', 'portrait', 'wide', 'tall']

// What each image call saved, keyed by its tool_use_id, for the chat to draw.
const shown = atom({ plugin: 'image-studio', key: 'shown' } as const, null)

// Image calls still running, keyed by tool_use_id, for the placeholder and its timer.
const running = atom({ plugin: 'image-studio', key: 'running' } as const, null)

// The preview SVGs this copy of the module has built, by preview file.
const svgCache = new Map<string, string>()


type Settings = {
  effort: string
  outputDir: string
  timeoutSeconds: number
  codexPath: string
  nodePath: string
  useWithoutAsking: boolean
}

type HelperImage = {
  path: string
  format: string
  width?: number
  height?: number
  bytes: number
  note?: string
  model?: { mime: string; base64: string }
  preview?: { path: string; width: number; height: number; transparent?: boolean }
}
type HelperResult =
  | { ok: true; images: HelperImage[]; revisedPrompt?: string; elapsedSeconds?: number }
  | { ok: false; error: string; hint?: string; threadId?: string }

type Ran = { code: number | null; stdout: string; stderr: string }

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

const WHEN_TO_USE = {
  always: [
    'Use it when the person asks for an image, and also on your own initiative when a task you are doing needs a raster image that does not exist yet:',
    'a hero or background image for a page you are building, a sprite, texture, icon or splash screen for a game or app, an illustration for a document or slide, a placeholder photo for a mockup.',
    'Prefer code (SVG, CSS, a chart library) for diagrams, charts, simple shapes and UI chrome.',
  ].join(' '),
  asked: 'Use it only when the person explicitly asks for an image to be generated; do not call it on your own initiative.',
}

function generateDescription(settings: Settings): string {
  return [
    "Create a new raster image from a text description with OpenAI's image model, run through the person's own Codex CLI and ChatGPT plan, and save it to disk.",
    settings.useWithoutAsking ? WHEN_TO_USE.always : WHEN_TO_USE.asked,
    "One call makes one image and takes about 1-5 minutes; each image counts against the person's Codex usage limit, so make one image per need and do not fire off variations unasked.",
    'Write a detailed, art-directed prompt: subject, composition and framing, medium or style, lighting, color palette, mood, and any exact text to render (in quotes).',
    'Pass output_path when the image belongs somewhere in the project (e.g. assets/hero.png); when the person names no place, leave output_path out so the image lands in the project\'s generated-images folder rather than a temporary folder.',
    'The result names the saved file and already includes the image itself: check it there, without opening the file again with Read, and refine it with edit_image.',
    'The person already sees the picture under this call in the chat, so do not embed it in your reply as a Markdown image; link the file instead.',
  ].join(' ')
}

function editDescription(settings: Settings): string {
  return [
    "Edit an existing image file with OpenAI's image model through the person's Codex CLI and ChatGPT plan: change, add or remove elements, restyle, replace the background, recolor, or fix details while keeping the rest.",
    settings.useWithoutAsking
      ? 'Use it when the person asks for a change to an image, or to fix an image you generated that does not match what was needed.'
      : 'Use it only when the person explicitly asks for an image to be edited.',
    'Saves a new file (by default <name>-edit.png beside the original), so the original is untouched unless output_path names it and overwrite is true.',
    "Takes about 1-5 minutes and counts against the person's Codex usage limit.",
    'Describe the change precisely and say what must stay the same. Add reference_images for a style, character or product to match.',
    'The result already includes the edited image: check it there, without opening the file again with Read.',
    'The person already sees the picture under this call in the chat, so do not embed it in your reply as a Markdown image; link the file instead.',
  ].join(' ')
}

const COMMON_PROPERTIES = {
  output_path: {
    type: 'string',
    description:
      'Where to save the image, absolute or relative to the working directory. The extension follows the format Codex returns (normally .png). Existing files are not overwritten unless overwrite is true: -2, -3 is added instead.',
  },
  reference_images: {
    type: 'array',
    items: { type: 'string' },
    description: 'Paths of PNG, JPEG, WebP or GIF images to use as visual references (a style, character, product or layout to match).',
  },
  aspect: {
    type: 'string',
    enum: ASPECTS,
    description: 'Shape of the image: square (1:1), landscape (3:2), portrait (2:3), wide (16:9), tall (9:16), or auto. A strong hint, not an exact pixel size.',
  },
  transparent: {
    type: 'boolean',
    description: 'Ask for a transparent background (for icons, logos, sprites, stickers).',
  },
  overwrite: {
    type: 'boolean',
    description: 'Replace output_path if it already exists.',
  },
}

const GENERATE_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'A detailed description of the image to create.' },
    ...COMMON_PROPERTIES,
  },
  required: ['prompt'],
  additionalProperties: false,
}

const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    image_path: { type: 'string', description: 'The image file to edit (PNG, JPEG, WebP or GIF), absolute or relative to the working directory.' },
    instructions: { type: 'string', description: 'What to change, and what must stay the same.' },
    ...COMMON_PROPERTIES,
  },
  required: ['image_path', 'instructions'],
  additionalProperties: false,
}

function readSettings(options: PluginOptions): Settings {
  const text = (key: string, fallback: string) => {
    const value = options[key]
    return typeof value === 'string' && value.trim() ? value.trim() : fallback
  }
  const minutes = typeof options.timeoutMinutes === 'number' && options.timeoutMinutes > 0 ? options.timeoutMinutes : 10
  return {
    effort: ['minimal', 'low', 'medium', 'high'].includes(text('reasoningEffort', 'low').toLowerCase())
      ? text('reasoningEffort', 'low').toLowerCase()
      : 'low',
    outputDir: text('outputDir', 'generated-images'),
    timeoutSeconds: Math.round(minutes * 60),
    codexPath: text('codexPath', ''),
    nodePath: text('nodePath', 'node'),
    useWithoutAsking: options.useWithoutAsking !== false,
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => v.trim()) : []
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function size(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function baseName(file: string): string {
  return file.split(/[\\/]/).pop() || file
}

function folderOf(file: string): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return cut > 0 ? file.slice(0, cut) : file
}

async function isWindows($: EngineInterface): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

// The ways to start the helper, tried in order until one starts: the Node the
// person named or the one on PATH, then (macOS and Linux) Node as their login
// shell finds it, since an app opened from the Dock starts with a short PATH.
async function launchers($: EngineInterface, settings: Settings, script: string): Promise<string[][]> {
  const direct = [settings.nodePath, script]
  if (settings.nodePath !== 'node') return [direct]
  if (await isWindows($)) return [direct]
  const shell = (await $.env.get('SHELL')) || '/bin/sh'
  return [direct, [shell, '-lc', 'exec node "$0" "$@"', script]]
}

async function runHelper(
  $: EngineInterface,
  settings: Settings,
  args: string[],
  input: string | undefined,
  onProgress: (text: string) => void,
): Promise<Ran> {
  const script = `${$.plugin.root}/bin/image-studio.mjs`
  const env: Record<string, string> = settings.codexPath ? { IMAGE_STUDIO_CODEX_BIN: settings.codexPath } : {}
  let lastError: unknown
  for (const prefix of await launchers($, settings, script)) {
    const child = $.process.spawn({ argv: [...prefix, ...args], env, ...(input === undefined ? {} : { input }) })
    let stdout = ''
    let stderr = ''
    let hasStarted = false
    try {
      for await (const piece of child) {
        hasStarted = true
        if (piece.stream === 'stdout') stdout += piece.text
        else {
          stderr += piece.text
          onProgress(piece.text)
        }
      }
    } catch (err) {
      if (hasStarted) throw err
      lastError = err
      continue
    }
    const { code } = await child.result
    // A login shell that cannot find node exits 127 before the helper runs.
    if (code === 127 && !stdout && prefix[0] !== settings.nodePath) {
      lastError = new Error(stderr.trim() || 'node was not found')
      continue
    }
    return { code, stdout, stderr }
  }
  throw new Error(
    `Could not start Node to run the image-studio helper (${lastError instanceof Error ? lastError.message : String(lastError)}). Install Node 18+ or set the plugin's "Node executable" option to its full path.`,
  )
}

function lastJson<T>(stdout: string): T | undefined {
  const lines = stdout.trim().split('\n').reverse()
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      return JSON.parse(t) as T
    } catch {}
  }
  return undefined
}

function describe(result: Extract<HelperResult, { ok: true }>, mode: 'generate' | 'edit'): string {
  const lines = result.images.map(img => {
    const dims = img.width && img.height ? `${img.width}x${img.height} ` : ''
    return `Saved ${mode === 'edit' ? 'edited ' : ''}image: ${img.path} (${dims}${img.format.toUpperCase()}, ${size(img.bytes)})${img.note ? `; ${img.note}` : ''}`
  })
  if (result.revisedPrompt) lines.push(`Prompt the image model used: ${result.revisedPrompt}`)
  if (result.elapsedSeconds) lines.push(`Took ${Math.round(result.elapsedSeconds)}s.`)
  const attached = result.images.filter(img => img.model).length
  if (attached === result.images.length) {
    lines.push(`The image${attached > 1 ? 's are' : ' is'} attached below${result.images.some(i => i.model?.mime === 'image/jpeg' && i.format === 'png') ? ' (a JPEG copy at review size; the PNG on disk is the full file)' : ''}. Check it against the request; use edit_image to fix anything.`)
  } else {
    lines.push('Open the file with the Read tool to see it before describing it; use edit_image on it for changes.')
  }
  return lines.join('\n')
}

async function serve(
  $: EngineInterface,
  e: Record<string, unknown>,
  mode: 'generate' | 'edit',
  settings: Settings,
): Promise<ToolCallResult> {
  const prompt = mode === 'edit' ? str(e.instructions) ?? str(e.prompt) : str(e.prompt)
  if (!prompt) return { deny: mode === 'edit' ? 'edit_image needs instructions.' : 'generate_image needs a prompt.' }
  const target = str(e.image_path)
  if (mode === 'edit' && !target) return { deny: 'edit_image needs image_path, the image to edit.' }
  const aspect = str(e.aspect)
  if (aspect && !ASPECTS.includes(aspect)) return { deny: `aspect must be one of ${ASPECTS.join(', ')}.` }

  const args = [
    'generate', '--json', '--with-previews',
    '--effort', settings.effort,
    '--out-dir', settings.outputDir,
    '--timeout', String(settings.timeoutSeconds),
  ]
  if (mode === 'edit' && target) args.push('--mode', 'edit', '--image', target)
  for (const ref of strings(e.reference_images)) args.push('--image', ref)
  const out = str(e.output_path)
  if (out) args.push('--out', out)
  if (aspect && aspect !== 'auto') args.push('--aspect', aspect)
  if (e.transparent === true) args.push('--transparent')
  if (e.overwrite === true) args.push('--overwrite')

  const started = Date.now()
  const label = mode === 'edit' ? 'Codex is editing the image' : 'Codex is generating an image'
  const tick = () => $.ui.status(`${label} · ${clock(Date.now() - started)}`)
  tick()

  // The placeholder the chat draws while this runs, and its once-a-second timer.
  const runningId = str(e.tool_use_id)
  let ticker: { cancel: () => void } | undefined
  if (runningId) {
    try {
      await update($, memberOf(running, { requestId: runningId }), (): RunningCall => ({ seconds: 0, mode, aspect: aspect ?? 'auto' }))
      ticker = $.clock.every(1000, () => {
        update($, memberOf(running, { requestId: runningId }), v => (v ? { ...v, seconds: v.seconds + 1 } : v)).catch(() => {})
      })
    } catch {}
  }
  try {
    let ran: Ran
    try {
      ran = await runHelper($, settings, args, prompt, () => tick())
    } catch (err) {
      return { deny: err instanceof Error ? err.message : String(err) }
    }
    const result = lastJson<HelperResult>(ran.stdout)
    if (!result) {
      const tail = ran.stderr.trim().split('\n').slice(-6).join('\n')
      return { deny: `The image-studio helper failed (exit ${ran.code ?? 'signal'}).${tail ? `\n${tail}` : ''}` }
    }
    if (!result.ok) {
      return { deny: `${result.error}${result.hint ? `\nFix: ${result.hint}` : ''}` }
    }

    // What the chat draws under this call. A failure here costs the preview only.
    const callId = str(e.tool_use_id)
    if (callId) {
      const images: ShownImage[] = result.images.map(img => ({
        path: img.path,
        format: img.format,
        ...(img.width && img.height ? { width: img.width, height: img.height } : {}),
        ...(img.preview ? { previewPath: img.preview.path, previewWidth: img.preview.width, previewHeight: img.preview.height } : {}),
      }))
      try {
        await update($, memberOf(shown, { requestId: callId }), (): ShownCall => ({ images }))
      } catch {}
    }

    const first = result.images[0]
    if (first) $.ui.toast(`Image saved: ${first.path}`)
    const blocks: ContentBlock[] = [{ type: 'text', text: describe(result, mode) }]
    for (const img of result.images) {
      if (img.model) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.model.mime, data: img.model.base64 } })
    }
    return { result: blocks }
  } finally {
    ticker?.cancel()
    if (runningId) await update($, memberOf(running, { requestId: runningId }), () => null).catch(() => {})
    $.ui.status(undefined)
  }
}

// Opens a saved image (or its folder) with the computer's own viewer.
async function reveal($: EngineInterface, file: string, inFolder: boolean): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  const argv = (await isWindows($))
    ? inFolder
      ? ['explorer.exe', `/select,${file}`]
      : ['explorer.exe', file]
    : home.startsWith('/Users/')
      ? inFolder
        ? ['open', '-R', file]
        : ['open', file]
      : ['xdg-open', inFolder ? folderOf(file) : file]
  try {
    await $.process.run(argv, { timeoutMs: 15_000 })
  } catch (err) {
    $.ui.toast(`Could not open ${baseName(file)}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function previewSvg($: EngineInterface, image: ShownImage): Promise<string | undefined> {
  if (!image.previewPath || !image.previewWidth || !image.previewHeight) return undefined
  const cached = svgCache.get(image.previewPath)
  if (cached) return cached
  try {
    const read = await $.fs.read(image.previewPath, { as: 'bytes' })
    const w = image.previewWidth
    const h = image.previewHeight
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
      `<image href="data:image/jpeg;base64,${read.base64}" x="0" y="0" width="${w}" height="${h}"/></svg>`
    if (svg.length > 131_072) return undefined
    svgCache.set(image.previewPath, svg)
    return svg
  } catch {
    return undefined
  }
}

function isImageTool(tool: string): boolean {
  return tool === GENERATE || tool === EDIT
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const SHAPES: Record<string, [number, number]> = {
  square: [1, 1],
  landscape: [3, 2],
  portrait: [2, 3],
  wide: [16, 9],
  tall: [9, 16],
}
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// A rounded tile with a soft band of light sweeping across it, as image apps
// show while a picture is being made. Grey at low opacity, so it sits on light
// and dark themes alike; SMIL animates it, which the Desktop app runs in an
// interactive Svg.
function shimmerSvg(w: number, ht: number): string {
  const r = Math.round(Math.min(w, ht) * 0.05)
  const icon = Math.round(Math.min(w, ht) * 0.16)
  const cx = w / 2
  const cy = ht / 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${ht}" width="${w}" height="${ht}">` +
    `<defs><linearGradient id="sweep" gradientUnits="userSpaceOnUse" x1="${-w}" y1="0" x2="0" y2="${Math.round(ht * 0.5)}">` +
    `<stop offset="0" stop-color="#8c8c8c" stop-opacity="0"/>` +
    `<stop offset="0.5" stop-color="#8c8c8c" stop-opacity="0.22"/>` +
    `<stop offset="1" stop-color="#8c8c8c" stop-opacity="0"/>` +
    `<animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="${2 * w} 0" dur="1.8s" repeatCount="indefinite"/>` +
    `</linearGradient></defs>` +
    `<rect width="${w}" height="${ht}" rx="${r}" fill="#8c8c8c" fill-opacity="0.16"/>` +
    `<rect width="${w}" height="${ht}" rx="${r}" fill="url(#sweep)"/>` +
    `<g fill="none" stroke="#8c8c8c" stroke-opacity="0.45" stroke-width="${Math.max(2, Math.round(icon / 14))}" stroke-linejoin="round">` +
    `<rect x="${cx - icon / 2}" y="${cy - icon * 0.4}" width="${icon}" height="${icon * 0.8}" rx="${icon * 0.12}"/>` +
    `<path d="M${cx - icon * 0.38} ${cy + icon * 0.26} L${cx - icon * 0.1} ${cy - icon * 0.04} L${cx + icon * 0.08} ${cy + icon * 0.14} L${cx + icon * 0.2} ${cy + icon * 0.04} L${cx + icon * 0.38} ${cy + icon * 0.26}"/>` +
    `<circle cx="${cx + icon * 0.2}" cy="${cy - icon * 0.16}" r="${icon * 0.07}"/>` +
    `</g></svg>`
  )
}

function headerRow(
  $: EngineInterface,
  e: RenderInput<'ToolResult'> | RenderInput<'ToolUse'>,
  label: string,
  detail: string,
): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box key="header">
      <Box flexShrink={0}>
        <Text bold>{label}</Text>
      </Box>
      {detail ? (
        <Box flexShrink={1} minWidth={0}>
          <Text dimColor wrap="truncate-end">{`  ${detail}`}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

// While an image call runs: an empty tile with a shimmer where the picture will
// be, and a timer under it. Undefined leaves the row to the app.
const runningNoted = new Set<string>()
async function drawRunning($: EngineInterface, e: RenderInput<'ToolUse'>): Promise<RenderElement | undefined> {
  const p = e.props
  const state = await read($, memberOf(running, e))
  if (!state) return undefined
  if (!runningNoted.has(p.tool_use_id)) {
    runningNoted.add(p.tool_use_id)
    note(`ToolUse ${e.surface} ${shortId(p.tool_use_id)}: drew the placeholder`)
  }
  const input = (p.input ?? {}) as Record<string, unknown>
  const detail = clip(str(input.prompt) ?? str(input.instructions) ?? '', 90)
  const label = state.mode === 'edit' ? 'Editing image' : 'Generating image'
  const time = clock(state.seconds * 1000)
  const [rw, rh] = SHAPES[state.aspect] ?? [1, 1]

  if (e.surface === 'terminal') {
    const { Box, Text } = $.ui.resolve(e)
    const cols = Math.max(16, Math.min(48, (e.viewport?.columns ?? 80) - 6))
    const rows = Math.max(5, Math.min(16, Math.round((cols * rh) / rw / 2)))
    const spin = SPINNER[state.seconds % SPINNER.length]
    return (
      <Box flexDirection="column">
        {headerRow($, e, label, detail)}
        <Box borderStyle="round" borderDimColor width={cols} height={rows} alignItems="center" justifyContent="center">
          <Text dimColor>{`${spin} ${label.toLowerCase()}…`}</Text>
        </Box>
        <Text dimColor>{time}</Text>
      </Box>
    )
  }
  if (e.surface === 'desktop') {
    const { Box, Text, Svg } = $.ui.resolve(e)
    const long = 400
    const tileW = rw >= rh ? long : Math.round((long * rw) / rh)
    const tileH = rw >= rh ? Math.round((long * rh) / rw) : long
    return (
      <Box flexDirection="column">
        {headerRow($, e, label, detail)}
        <Svg source={shimmerSvg(tileW, tileH)} alt={`${label}…`} width={tileW} height={tileH} isInteractive />
        <Text dimColor>{`${label}… ${time}`}</Text>
      </Box>
    )
  }
  return undefined
}

// The saved image(s) of one call: the picture itself where the surface can show
// one, its name and size, and buttons that open it on this computer; under a
// header line when the tree stands in for the call's whole row.
async function drawImages(
  $: EngineInterface,
  e: RenderInput<'ToolResult'> | RenderInput<'ToolUse'>,
  call: ShownCall,
  header?: { label: string; detail: string },
  withPicture = true,
): Promise<RenderElement> {
  const rows = []
  if (header) rows.push(headerRow($, e, header.label, header.detail))
  for (const [index, image] of call.images.entries()) {
    const name = baseName(image.path)
    const dims = image.width && image.height ? ` · ${image.width}×${image.height}` : ''
    const caption = `${name}${dims}`
    const key = `img-${index}`

    if (e.surface === 'terminal') {
      const { Box, Text, Button, Image } = $.ui.resolve(e)
      const width = Math.max(10, Math.min(64, (e.viewport?.columns ?? 80) - 6))
      const tall = image.width && image.height ? Math.round((width * image.height) / image.width / 2) : Math.round(width / 3)
      rows.push(
        <Box key={key} flexDirection="column">
          {image.format === 'png' ? (
            <Image key={`${key}-pic`} source={{ file: image.path, format: 'png' }} columns={width} rows={Math.max(4, Math.min(32, tall))} alt={`[image: ${name}]`} />
          ) : null}
          <Box>
            <Text dimColor>{caption}  </Text>
            <Button key={`${key}-open`} label="Open" onPress={() => reveal($, image.path, false)} />
            <Button key={`${key}-folder`} label="Show in folder" onPress={() => reveal($, image.path, true)} />
          </Box>
        </Box>,
      )
    } else if (e.surface === 'mobile') {
      const { Box, Text, Svg } = $.ui.resolve(e)
      const svg = await previewSvg($, image)
      rows.push(
        <Box key={key} flexDirection="column">
          {svg ? <Svg source={svg} alt={caption} width={Math.min(image.previewWidth ?? 320, 320)} /> : null}
          <Text dimColor>{caption}</Text>
        </Box>,
      )
    } else {
      const { Box, Text, Button, Svg } = $.ui.resolve(e)
      const svg = withPicture ? await previewSvg($, image) : undefined
      rows.push(
        <Box key={key} flexDirection="column">
          {svg ? <Svg source={svg} alt={caption} width={image.previewWidth} height={image.previewHeight} /> : null}
          <Box>
            <Text dimColor>{caption}  </Text>
            <Button key={`${key}-open`} label="Open" onPress={() => reveal($, image.path, false)} />
            <Button key={`${key}-folder`} label="Show in folder" onPress={() => reveal($, image.path, true)} />
          </Box>
        </Box>,
      )
    }
  }
  const { Box } = $.ui.resolve(e)
  return <Box flexDirection="column">{rows}</Box>
}

// What the chat was asked to draw for image calls in this session, newest
// last, so /image-studio-doctor can say where a preview did or didn't appear.
const trace: string[] = []
function note(entry: string): void {
  trace.push(entry)
  if (trace.length > 30) trace.shift()
}
function shortId(id: string | undefined): string {
  return id ? id.slice(-6) : 'no-id'
}

// Image calls whose row already drew the picture, so the result block beneath
// a standalone row draws nothing instead of showing the image again.
const drawnInRow = new Set<string>()

// Image calls the app folded into a group. There the Desktop app shows only a
// small thumbnail, so the row draws the full preview; a call standing alone
// gets the app's own full-size picture beneath it, so its row leaves it out.
const inGroup = new Set<string>()

// The result block under a standalone image call: draws the picture unless the
// call's own row already did. Undefined leaves it to the engine.
async function drawResult($: EngineInterface, e: RenderInput<'ToolResult'>): Promise<RenderElement | undefined> {
  const id = e.props.tool_use_id
  const where = `ToolResult ${e.surface} ${shortId(id)}`
  if (e.props.isErrored) return note(`${where}: errored call, left to the app`), undefined
  if (drawnInRow.has(id)) {
    // The row above already shows the picture and its file; the engine's own
    // result block would show the image a second time.
    note(`${where}: row above already shows it, drew nothing`)
    const { Box } = $.ui.resolve(e)
    return <Box />
  }
  const call = await read($, memberOf(shown, e))
  if (!call || call.images.length === 0) return note(`${where}: no record of this call`), undefined
  note(`${where}: drew the preview`)
  return drawImages($, e, call)
}

// A group the transcript folded ("Read x.png, used a tool") that holds a
// finished image call: unfold it, so the image call gets a row of its own.
async function unfoldGroup($: EngineInterface, e: RenderInput<'ToolGroup'>): Promise<RenderInput<'ToolGroup'> | undefined> {
  const ours = e.props.calls.filter(c => isImageTool(c.tool) && !c.isRunning && !c.isErrored && !c.isInterrupted)
  if (ours.length === 0) return undefined
  let holdsImage = false
  let missingIds = 0
  for (const c of ours) {
    if (c.tool_use_id) inGroup.add(c.tool_use_id)
    if (!c.tool_use_id) {
      // An older host leaves the id out: open the group anyway, the row decides.
      missingIds++
      holdsImage = true
      continue
    }
    const call = await read($, memberOf(shown, { requestId: c.tool_use_id }))
    if (call && call.images.length > 0) holdsImage = true
  }
  const where = `ToolGroup ${e.surface} (${e.props.calls.length} calls${missingIds ? `, ${missingIds} without ids` : ''})`
  if (!holdsImage) return note(`${where}: no record of its image call`), undefined
  if (e.props.isExpanded) return note(`${where}: already open`), undefined
  note(`${where}: opened it`)
  return { ...e, props: { ...e.props, isExpanded: true } }
}

// An image call's own row, once it has finished: a header line and the picture.
async function drawRow($: EngineInterface, e: RenderInput<'ToolUse'>): Promise<RenderElement | undefined> {
  const p = e.props
  const where = `ToolUse ${e.surface} ${shortId(p.tool_use_id)}`
  if (p.isErrored || p.isInterrupted) return undefined
  if (p.isRunning) return drawRunning($, e)
  const call = await read($, memberOf(shown, e))
  if (!call || call.images.length === 0) return note(`${where}: no record of this call`), undefined
  drawnInRow.add(p.tool_use_id)
  const withPicture = e.surface !== 'desktop' || inGroup.has(p.tool_use_id)
  note(withPicture ? `${where}: drew the row with the preview` : `${where}: drew the row; the app shows the picture below it`)
  const input = (p.input ?? {}) as Record<string, unknown>
  const detail = clip(str(input.prompt) ?? str(input.instructions) ?? '', 90)
  return drawImages($, e, call, { label: p.tool === EDIT ? 'Edited image' : 'Generated image', detail }, withPicture)
}

function traceReport(root: string): string {
  const lines = [`image-studio mod ${MOD_VERSION}, loaded from ${root}`]
  if (trace.length === 0) {
    lines.push('Drawing: the app has not asked this mod to draw an image call in this session yet.')
  } else {
    lines.push('Drawing in this session (oldest first):', ...trace.map(t => `  ${t}`))
  }
  return lines.join('\n')
}

// The .catch answer for the tool hooks: they never call next, so a failure is
// always this plugin's own and is reported to the model as an error.
const failed = () => ({
  deny: 'image-studio: the image request failed before it finished. Run /image-studio-doctor to check the setup.',
})

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'generate_image', description: generateDescription(settings), inputSchema: GENERATE_SCHEMA, isDeferred: false })
    await $.tool.register({ name: 'edit_image', description: editDescription(settings), inputSchema: EDIT_SCHEMA, isDeferred: false })
    await $.command.register({
      name: 'image-studio-doctor',
      description: 'Check that Codex image generation is ready (Codex CLI, ChatGPT sign-in, image tool)',
    })
    await $.command.register({
      name: 'image-studio-setup',
      description: 'Get image generation ready: installs the Codex CLI if needed and signs you in with ChatGPT',
      argumentHint: '[device]',
    })
    return next(e)
  })

  // These hooks answer for the plugin's own tools; if one fails outright the
  // model gets a plain error instead of an unanswered call (see `failed`).
  on('tool.call', { tool: GENERATE }, ($, e) => serve($, { ...e }, 'generate', settings)).catch(failed)
  on('tool.call', { tool: EDIT }, ($, e) => serve($, { ...e }, 'edit', settings)).catch(failed)

  // The picture is drawn by the image call's own row, wherever the app draws
  // that row; a folded group is opened so the row shows, and the result block
  // under a standalone row draws it only when the row did not.
  on('ui.render', { component: 'ToolUse', props: { tool: GENERATE } }, async ($, e, next) => (await drawRow($, e)) ?? next(e))
  on('ui.render', { component: 'ToolUse', props: { tool: EDIT } }, async ($, e, next) => (await drawRow($, e)) ?? next(e))
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => next((await unfoldGroup($, e)) ?? e))
  on('ui.render', { component: 'ToolResult', props: { tool: GENERATE } }, async ($, e, next) => (await drawResult($, e)) ?? next(e))
  on('ui.render', { component: 'ToolResult', props: { tool: EDIT } }, async ($, e, next) => (await drawResult($, e)) ?? next(e))

  // Installs the Codex CLI when missing and signs in with ChatGPT, showing each
  // step (and the sign-in link) in the transcript as it happens.
  on('command.run', { command: 'image-studio-setup' }, async ($, e) => {
    const args = ['setup']
    if (/\bdevice\b/i.test(e.args)) args.push('--device-auth')
    let pending = ''
    const show = (text: string) => {
      pending += text
      let nl
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).replace(/\r$/, '').trim()
        pending = pending.slice(nl + 1)
        const m = /^\[image-studio\] (?:(step|ok|note|codex|npm): )?(.*)$/.exec(line)
        if (!m || !m[2]) continue
        if (m[1] === 'npm' && !/added|changed|error|ERR|EACCES/i.test(m[2])) continue
        $.ui.log(m[1] === 'codex' || m[1] === 'npm' ? `  ${m[2]}` : m[2])
      }
    }
    $.ui.log('image-studio setup: checking the Codex CLI and your ChatGPT sign-in…')
    let ran: Ran
    try {
      ran = await runHelper($, settings, args, undefined, show)
    } catch (err) {
      return { text: `✘ ${err instanceof Error ? err.message : String(err)}` }
    }
    const failure = lastJson<{ ok: false; error: string; hint?: string }>(ran.stdout)
    if (failure && failure.ok === false) return { text: `✘ ${failure.error}${failure.hint ? `\n${failure.hint}` : ''}` }
    return { text: ran.stdout.trim() || `setup exited with ${ran.code ?? 'a signal'}` }
  })

  on('command.run', { command: 'image-studio-doctor' }, async $ => {
    const env = settings.codexPath ? { IMAGE_STUDIO_CODEX_BIN: settings.codexPath } : undefined
    const script = `${$.plugin.root}/bin/image-studio.mjs`
    let lastError = ''
    for (const prefix of await launchers($, settings, script)) {
      try {
        const ran = await $.process.run([...prefix, 'doctor'], { timeoutMs: 90_000, ...(env ? { env } : {}) })
        if (ran.exitCode === 127 && !ran.stdout.trim()) {
          lastError = ran.stderr.trim()
          continue
        }
        const report = ran.stdout.trim() || ran.stderr.trim() || `doctor exited with ${ran.exitCode}`
        return { text: `${report}\n\n${traceReport($.plugin.root)}` }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }
    return {
      text: `✘ Could not start Node to run the image-studio helper: ${lastError}\nInstall Node 18+ or set the plugin's "Node executable" option to its full path.\n\n${traceReport($.plugin.root)}`,
    }
  })
}
