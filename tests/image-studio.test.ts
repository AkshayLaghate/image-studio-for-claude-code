import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ProcessSpawnRequest, RenderElement } from 'claude-code'

const GENERATE = 'mcp__image-studio__generate_image'
const EDIT = 'mcp__image-studio__edit_image'

type Seen = {
  clock?: ReturnType<typeof mock.clock>
  logs: string[]
  tools: { name: string; description: string }[]
  commands: string[]
  spawns: ProcessSpawnRequest[]
  runs: (readonly string[])[]
  status: (string | undefined)[]
  toasts: string[]
  shownIds: string[]
  runningIds: string[]
}

type Block = { type: string; text?: string; source?: { media_type: string; data: string } }

// Answers what the plugin asks of the engine, standing in for a session on
// macOS whose helper prints `stdout` (one JSON line) after some progress.
function engine(on: On, stdout: string, options: { failFirstSpawn?: boolean; os?: string; hold?: Promise<void> } = {}): Seen {
  const seen: Seen = { tools: [], commands: [], spawns: [], runs: [], status: [], toasts: [], shownIds: [], runningIds: [], logs: [] }
  seen.clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => {
    seen.tools.push({ name: e.name, description: e.description })
    return { value: { tool: `mcp__image-studio__${e.name}` } }
  })
  on('command.register', ($, e) => {
    seen.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('env.get', ($, e) => ({
    value: e.name === 'OS' ? options.os : e.name === 'SHELL' ? '/bin/zsh' : e.name === 'HOME' ? '/Users/akshay' : undefined,
  }))
  on('ui.status', ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('state.set', ($, e, next) => {
    if (e.id && e.key === 'shown') seen.shownIds.push(e.id)
    if (e.id && e.key === 'running' && !seen.runningIds.includes(e.id)) seen.runningIds.push(e.id)
    return next(e)
  })
  on('fs.read', () => ({ value: { base64: '/9j/4AAQSkZJRgABAQ' } }))
  on('process.run', ($, e) => {
    seen.runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* ($, e) {
    seen.spawns.push(e)
    if (options.failFirstSpawn && seen.spawns.length === 1) return { deny: 'spawn node ENOENT' }
    yield { stream: 'stderr' as const, text: '[image-studio] codex session abc\n' }
    yield { stream: 'stderr' as const, text: '[image-studio] working 10s\n' }
    if (options.hold) await options.hold
    yield { stream: 'stdout' as const, text: `${stdout}\n` }
    return { value: { code: stdout.includes('"ok":true') ? 0 : 1, signal: null } }
  })
  return seen
}

const SAVED = '/proj/generated-images/red-apple-20261013.png'
const OK = JSON.stringify({
  ok: true,
  images: [
    {
      path: SAVED,
      format: 'png',
      width: 1536,
      height: 1024,
      bytes: 1_400_000,
      model: { mime: 'image/png', base64: 'iVBORw0KGgo' },
      preview: { path: '/tmp/image-studio-previews/p1.jpg', width: 512, height: 341 },
    },
  ],
  revisedPrompt: 'A glossy red apple on oak, soft studio light',
  elapsedSeconds: 74.2,
})

async function start($: Engine) {
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true } as never)
}

function blocks(result: unknown): Block[] {
  return Array.isArray(result) ? (result as Block[]) : []
}

test('registers both image tools and the doctor command at session start', async ($, on) => {
  const seen = engine(on, OK)
  await start($)
  expect(seen.tools.map(t => t.name)).toEqual(['generate_image', 'edit_image'])
  expect(seen.tools[0]!.description).toContain('on your own initiative')
  expect(seen.tools[0]!.description).toContain('do not embed it in your reply')
  expect(seen.commands).toEqual(['image-studio-doctor', 'image-studio-setup'])
})

test('with "Let Claude use it unasked" off, the tools say to wait to be asked', { options: { useWithoutAsking: false } }, async ($, on) => {
  const seen = engine(on, OK)
  await start($)
  expect(seen.tools[0]!.description).toContain('only when the person explicitly asks')
  expect(seen.tools[0]!.description).not.toContain('a task you are doing needs')
})

test('generate_image hands the model the saved path and the image itself', async ($, on) => {
  const seen = engine(on, OK)
  await start($)
  const ran = await $.tool.call({
    tool: GENERATE,
    prompt: 'A red apple on an oak table',
    output_path: 'assets/apple.png',
    aspect: 'landscape',
    transparent: true,
  } as never)
  expect(ran.deny).toBeUndefined()
  const [text, image] = blocks(ran.result)
  expect(text!.type).toBe('text')
  expect(text!.text).toContain(`Saved image: ${SAVED} (1536x1024 PNG, 1.3 MB)`)
  expect(text!.text).toContain('A glossy red apple on oak')
  expect(text!.text).toContain('attached below')
  expect(image).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo' } })

  const spawn = seen.spawns[0]!
  expect(spawn.argv[0]).toBe('node')
  expect(String(spawn.argv[1]).endsWith('/bin/image-studio.mjs')).toBe(true)
  expect(spawn.argv.slice(2)).toEqual([
    'generate', '--json', '--with-previews', '--effort', 'low', '--out-dir', 'generated-images', '--timeout', '600',
    '--out', 'assets/apple.png', '--aspect', 'landscape', '--transparent',
  ])
  expect(spawn.input).toBe('A red apple on an oak table')
  expect(seen.toasts).toEqual([`Image saved: ${SAVED}`])
  expect(seen.status.length).toBeGreaterThan(1)
  expect(seen.status[seen.status.length - 1]).toBeUndefined()
  expect(seen.shownIds.length).toBe(1)
})

test('without an attachable copy, the model is told to open the file', async ($, on) => {
  engine(on, JSON.stringify({ ok: true, images: [{ path: SAVED, format: 'png', bytes: 9_000_000 }] }))
  await start($)
  const ran = await $.tool.call({ tool: GENERATE, prompt: 'a huge poster' } as never)
  const all = blocks(ran.result)
  expect(all.length).toBe(1)
  expect(all[0]!.text).toContain('Read tool')
})

test('edit_image passes the image to edit first, then references', async ($, on) => {
  const seen = engine(on, OK)
  await start($)
  const ran = await $.tool.call({
    tool: EDIT,
    image_path: 'shots/hero.jpg',
    instructions: 'Make the sky stormy; keep the house unchanged',
    reference_images: ['refs/storm.png'],
  } as never)
  expect(blocks(ran.result)[0]!.text).toContain('Saved edited image:')
  const argv = seen.spawns[0]!.argv
  expect(argv.slice(argv.indexOf('--mode'))).toEqual(['--mode', 'edit', '--image', 'shots/hero.jpg', '--image', 'refs/storm.png'])
  expect(seen.spawns[0]!.input).toBe('Make the sky stormy; keep the house unchanged')
})

test('a helper failure reaches the model as an error with the fix', async ($, on) => {
  engine(on, JSON.stringify({ ok: false, error: 'Codex is not signed in.', hint: 'Run `codex login` in a terminal.' }))
  await start($)
  const ran = await $.tool.call({ tool: GENERATE, prompt: 'a cat' } as never)
  expect(ran.deny).toBe('Codex is not signed in.\nFix: Run `codex login` in a terminal.')
})

test('bad input is refused before anything runs', async ($, on) => {
  const seen = engine(on, OK)
  await start($)
  expect((await $.tool.call({ tool: GENERATE, prompt: '   ' } as never)).deny).toBe('generate_image needs a prompt.')
  expect((await $.tool.call({ tool: EDIT, instructions: 'x' } as never)).deny).toContain('needs image_path')
  expect((await $.tool.call({ tool: GENERATE, prompt: 'x', aspect: 'huge' } as never)).deny).toContain('aspect must be one of')
  expect(seen.spawns.length).toBe(0)
})

test('falls back to the login shell when node is not on the app PATH', async ($, on) => {
  const seen = engine(on, OK, { failFirstSpawn: true })
  await start($)
  const ran = await $.tool.call({ tool: GENERATE, prompt: 'a lighthouse' } as never)
  expect(ran.deny).toBeUndefined()
  expect(seen.spawns.length).toBe(2)
  expect(seen.spawns[1]!.argv.slice(0, 3)).toEqual(['/bin/zsh', '-lc', 'exec node "$0" "$@"'])
})

test('settings from the plugin options reach the helper', { options: { reasoningEffort: 'medium', outputDir: 'art', timeoutMinutes: 3, codexPath: '/opt/codex' } }, async ($, on) => {
  const seen = engine(on, OK)
  await start($)
  await $.tool.call({ tool: GENERATE, prompt: 'a fox' } as never)
  const spawn = seen.spawns[0]!
  expect(spawn.argv.slice(2, 9)).toEqual(['generate', '--json', '--with-previews', '--effort', 'medium', '--out-dir', 'art'])
  expect(spawn.argv).toContain('180')
  expect(spawn.env).toEqual({ IMAGE_STUDIO_CODEX_BIN: '/opt/codex' })
})

test('the chat draws the image under the call on every surface', async ($, on) => {
  const seen = engine(on, OK)
  await start($)
  const ran = await $.tool.call({ tool: GENERATE, prompt: 'A red apple' } as never)
  const id = seen.shownIds[0]!
  const props = { tool_use_id: id, tool: GENERATE, output: ran.result, isErrored: false }

  for (const surface of ['desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ plugin: 'image-studio', surface, component: 'ToolResult', requestId: id, props } as never)
    const svg = await ui.find({ type: 'Svg' })
    expect(svg).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'red-apple-20261013.png · 1536×1024' }))).toBeDefined()
    await ui.press({ key: 'img-0-open' })
    await ui.unmount()
  }
  expect(seen.runs).toEqual([['open', SAVED], ['open', SAVED]])

  const term = await $.ui.mount({ plugin: 'image-studio', surface: 'terminal', component: 'ToolResult', requestId: id, props } as never)
  expect(await term.find({ type: 'Image' })).toBeDefined()
  await term.press({ key: 'img-0-folder' })
  expect(seen.runs[2]).toEqual(['open', '-R', SAVED])
  await term.unmount()

  const phone = await $.ui.mount({ plugin: 'image-studio', surface: 'mobile', component: 'ToolResult', requestId: id, props } as never)
  expect(await phone.find({ type: 'Svg' })).toBeDefined()
  expect(await phone.find({ type: 'Button' })).toBeUndefined()
  await phone.unmount()
})

test('a call the session holds no record of is left to the engine', async ($, on) => {
  engine(on, OK)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'ENGINE ROW') as RenderElement
  })
  await start($)
  const props = { tool_use_id: 'unknown', tool: GENERATE, output: 'Saved image: x.png', isErrored: false }
  const ui = await $.ui.mount({ plugin: 'image-studio', surface: 'desktop', component: 'ToolResult', requestId: 'unknown', props } as never)
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'ENGINE ROW' })).toBeDefined()
  await ui.unmount()
})

test('a folded group holding an image call is opened, and that row draws the image', async ($, on) => {
  const seen = engine(on, OK)
  const expandedSeen: boolean[] = []
  on('ui.render', ($, e) => {
    if (e.component === 'ToolGroup') expandedSeen.push(e.props.isExpanded)
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'ENGINE ROW') as RenderElement
  })
  await start($)
  const ran = await $.tool.call({ tool: GENERATE, prompt: 'A red apple on an oak table' } as never)
  const id = seen.shownIds[0]!
  const done = { isRunning: false, isErrored: false, isInterrupted: false }
  const readCall = { tool_use_id: 'read-1', tool: 'Read', input: { file_path: SAVED }, output: {}, ...done }
  const imageCall = { tool_use_id: id, tool: GENERATE, input: { prompt: 'A red apple on an oak table' }, output: ran.result, ...done }

  for (const surface of ['desktop', 'terminal'] as const) {
    // "Read red-apple.png, used a tool": the group is drawn expanded instead.
    const group = await $.ui.mount({
      plugin: 'image-studio', surface, component: 'ToolGroup', requestId: 'g1',
      props: { calls: [readCall, imageCall], isActive: false, isExpanded: false },
    } as never)
    expect(expandedSeen[expandedSeen.length - 1]).toBe(true)
    await group.unmount()

    // The image call's own row then carries a header and the picture.
    const row = await $.ui.mount({ plugin: 'image-studio', surface, component: 'ToolUse', requestId: id, props: imageCall } as never)
    expect(await row.find({ type: 'Text', text: 'Generated image' })).toBeDefined()
    expect(await row.find({ type: surface === 'desktop' ? 'Svg' : 'Image' })).toBeDefined()
    await row.unmount()
  }

  // A group with no image call is left as the engine draws it.
  const plain = await $.ui.mount({
    plugin: 'image-studio', surface: 'desktop', component: 'ToolGroup', requestId: 'g2',
    props: { calls: [readCall], isActive: false, isExpanded: false },
  } as never)
  expect(expandedSeen[expandedSeen.length - 1]).toBe(false)
  await plain.unmount()

  // The result block under that row draws nothing: the row already has the picture,
  // and the engine's own block would show the image a second time.
  const result = await $.ui.mount({
    plugin: 'image-studio', surface: 'desktop', component: 'ToolResult', requestId: id,
    props: { tool_use_id: id, tool: GENERATE, output: ran.result, isErrored: false },
  } as never)
  expect(await result.find({ type: 'Svg' })).toBeUndefined()
  expect(await result.find({ type: 'Text', text: 'ENGINE ROW' })).toBeUndefined()
  await result.unmount()
})


test('a group from a host that leaves out call ids is still opened', async ($, on) => {
  engine(on, OK)
  const expandedSeen: boolean[] = []
  on('ui.render', ($, e) => {
    if (e.component === 'ToolGroup') expandedSeen.push(e.props.isExpanded)
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'ENGINE ROW') as RenderElement
  })
  await start($)
  const call = { tool: GENERATE, input: { prompt: 'x' }, output: [], isRunning: false, isErrored: false, isInterrupted: false }
  const group = await $.ui.mount({
    plugin: 'image-studio', surface: 'desktop', component: 'ToolGroup', requestId: 'g3',
    props: { calls: [call], isActive: false, isExpanded: false },
  } as never)
  expect(expandedSeen[expandedSeen.length - 1]).toBe(true)
  await group.unmount()
})

test('/image-studio-doctor reports the mod version and what the chat drew', async ($, on) => {
  const seen = engine(on, OK)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'ENGINE ROW') as RenderElement
  })
  await start($)
  const before = await $.command.run({ command: 'image-studio-doctor', args: '' } as never)
  expect(before.text).toContain('image-studio mod 0.4.0')
  expect(before.text).toContain('has not asked this mod to draw')

  const ran = await $.tool.call({ tool: GENERATE, prompt: 'A red apple' } as never)
  const id = seen.shownIds[0]!
  const row = await $.ui.mount({
    plugin: 'image-studio', surface: 'desktop', component: 'ToolUse', requestId: id,
    props: { tool_use_id: id, tool: GENERATE, input: { prompt: 'A red apple' }, output: ran.result, isRunning: false, isErrored: false, isInterrupted: false },
  } as never)
  await row.unmount()
  const after = await $.command.run({ command: 'image-studio-doctor', args: '' } as never)
  expect(after.text).toContain(`ToolUse desktop ${id.slice(-6)}: drew the row; the app shows the picture below it`)
  expect(after.text).toContain(', loaded from ')
})

test('an unknown reasoning effort falls back to low', { options: { reasoningEffort: 'turbo' } }, async ($, on) => {
  const seen = engine(on, OK)
  await start($)
  await $.tool.call({ tool: GENERATE, prompt: 'a fox' } as never)
  expect(seen.spawns[0]!.argv.slice(4, 7)).toEqual(['--with-previews', '--effort', 'low'])
})

test('on Desktop a standalone call leaves the picture to the app; a grouped call shows it', async ($, on) => {
  const seen = engine(on, OK)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'ENGINE ROW') as RenderElement
  })
  await start($)
  const ran = await $.tool.call({ tool: GENERATE, prompt: 'A red apple' } as never)
  const id = seen.shownIds[0]!
  const props = { tool_use_id: id, tool: GENERATE, input: { prompt: 'A red apple' }, output: ran.result, isRunning: false, isErrored: false, isInterrupted: false }

  // Standalone: heading, file name and buttons, but no picture of its own.
  const alone = await $.ui.mount({ plugin: 'image-studio', surface: 'desktop', component: 'ToolUse', requestId: id, props } as never)
  expect(await alone.find({ type: 'Text', text: 'Generated image' })).toBeDefined()
  expect(await alone.find({ type: 'Button', key: 'img-0-open' } as never)).toBeDefined()
  expect(await alone.find({ type: 'Svg' })).toBeUndefined()
  await alone.unmount()

  // The terminal has no picture of the app's own, so it always draws one.
  const term = await $.ui.mount({ plugin: 'image-studio', surface: 'terminal', component: 'ToolUse', requestId: id, props } as never)
  expect(await term.find({ type: 'Image' })).toBeDefined()
  await term.unmount()

  // Once the call shows up inside a group, the row carries the full preview.
  const group = await $.ui.mount({
    plugin: 'image-studio', surface: 'desktop', component: 'ToolGroup', requestId: 'g9',
    props: { calls: [props], isActive: false, isExpanded: false },
  } as never)
  await group.unmount()
  const grouped = await $.ui.mount({ plugin: 'image-studio', surface: 'desktop', component: 'ToolUse', requestId: id, props } as never)
  expect(await grouped.find({ type: 'Svg' })).toBeDefined()
  await grouped.unmount()
})

test('while an image is being made, the row shows a shimmering placeholder and a timer', async ($, on) => {
  let release = () => {}
  const hold = new Promise<void>(resolve => (release = resolve))
  const seen = engine(on, OK, { hold })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'ENGINE ROW') as RenderElement
  })
  await start($)
  const call = $.tool.call({ tool: GENERATE, prompt: 'A red apple', aspect: 'wide' } as never)
  await seen.clock!.settle()
  const id = seen.runningIds[0]!
  expect(id).toBeDefined()
  const props = { tool_use_id: id, tool: GENERATE, input: { prompt: 'A red apple', aspect: 'wide' }, isRunning: true, isErrored: false, isInterrupted: false }

  const desk = await $.ui.mount({ plugin: 'image-studio', surface: 'desktop', component: 'ToolUse', requestId: id, props } as never)
  const tile = await desk.find({ type: 'Svg' })
  expect(tile).toBeDefined()
  expect(await desk.find({ type: 'Text', text: 'Generating image… 0:00' })).toBeDefined()
  await seen.clock!.advance(3000)
  expect(await desk.find({ type: 'Text', text: 'Generating image… 0:03' })).toBeDefined()
  await desk.unmount()

  const term = await $.ui.mount({ plugin: 'image-studio', surface: 'terminal', component: 'ToolUse', requestId: id, props } as never)
  expect(await term.find({ type: 'Text', text: 'generating image…' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: '0:03' })).toBeDefined()
  await term.unmount()

  release()
  const ran = await call
  expect(ran.deny).toBeUndefined()

  // Once it has finished, the placeholder is gone and the row is the result.
  const done = await $.ui.mount({
    plugin: 'image-studio', surface: 'terminal', component: 'ToolUse', requestId: id,
    props: { ...props, isRunning: false, output: ran.result },
  } as never)
  expect(await done.find({ type: 'Text', text: 'generating image…' })).toBeUndefined()
  expect(await done.find({ type: 'Image' })).toBeDefined()
  await done.unmount()
})

test('/image-studio-setup shows each step and the sign-in link as it happens', async ($, on) => {
  const seen: string[] = []
  const argvs: (readonly string[])[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__image-studio__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('env.get', ($, e) => ({ value: e.name === 'SHELL' ? '/bin/zsh' : undefined }))
  on('ui.log', ($, e) => {
    seen.push(e.text)
    return { value: undefined }
  })
  on('process.spawn', async function* ($, e) {
    argvs.push(e.argv)
    yield { stream: 'stderr' as const, text: '[image-studio] step: installing the Codex CLI (npm install -g @openai/codex). This takes a minute.\n' }
    yield { stream: 'stderr' as const, text: '[image-studio] npm: npm warn deprecated something\n[image-studio] npm: added 1 package in 9s\n' }
    yield { stream: 'stderr' as const, text: '[image-studio] codex: If your browser did not open, navigate to this URL to authenticate:\n[image-studio] codex: https://auth.openai.com/oauth/authorize?client_id=x\n' }
    yield { stream: 'stderr' as const, text: '[image-studio] ok: signed in with ChatGPT\n' }
    yield { stream: 'stdout' as const, text: '✔ Sign-in: Logged in using ChatGPT\nReady: Claude can generate images through Codex.\n' }
    return { value: { code: 0, signal: null } }
  })
  await start($)
  const out = await $.command.run({ command: 'image-studio-setup', args: 'device' } as never)
  expect(argvs[0]!.slice(2)).toEqual(['setup', '--device-auth'])
  expect(seen).toEqual([
    'image-studio setup: checking the Codex CLI and your ChatGPT sign-in…',
    'step: installing the Codex CLI (npm install -g @openai/codex). This takes a minute.'.replace('step: ', ''),
    '  added 1 package in 9s',
    '  If your browser did not open, navigate to this URL to authenticate:',
    '  https://auth.openai.com/oauth/authorize?client_id=x',
    'signed in with ChatGPT',
  ])
  expect(out.text).toContain('Ready: Claude can generate images through Codex.')
})
