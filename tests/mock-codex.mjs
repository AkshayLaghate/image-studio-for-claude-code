#!/usr/bin/env node
// A stand-in for the Codex CLI, for tests: it behaves like `codex exec --json`
// does around its built-in image tool, and like `codex login`, so the helper can
// be tested without a ChatGPT account or network. MOCK_MODE picks the scenario.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

const args = process.argv.slice(2)
const mode = process.env.MOCK_MODE || 'rollout'
const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')

function png(w, h, rgb = [200, 60, 40]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = buf => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0).map((_, i) => rgb[i % 3])])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function jpegStub(w, h) {
  // SOI, APP0, SOF0 with dimensions, EOI: enough for the dimension parser.
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(200, 0x11), Buffer.from([0xff, 0xd9])])
}

if (args[0] === '--version') {
  console.log('codex-cli 9.9.9-mock')
  process.exit(0)
}
const loginFile = process.env.MOCK_LOGIN_FILE
if (args[0] === 'login' && args[1] === 'status') {
  const signedOut = process.env.MOCK_LOGIN === 'none' || (loginFile && !fs.existsSync(loginFile))
  if (signedOut) {
    console.error('Not logged in')
    process.exit(1)
  }
  console.error(process.env.MOCK_LOGIN === 'apikey' ? 'Logged in using an API key - sk-***' : 'Logged in using ChatGPT')
  process.exit(0)
}
if (args[0] === 'login') {
  console.error('Starting local login server on http://localhost:1455.')
  console.error('If your browser did not open, navigate to this URL to authenticate:')
  console.error('')
  console.error('https://auth.openai.com/oauth/authorize?client_id=mock')
  console.error('')
  if (process.env.MOCK_LOGIN_FAIL) {
    console.error('Login was cancelled.')
    process.exit(1)
  }
  if (loginFile) fs.writeFileSync(loginFile, 'signed in')
  console.error('Successfully logged in')
  process.exit(0)
}
if (args[0] === 'features' && args[1] === 'list') {
  console.log('fast_mode                                stable             true')
  console.log('image_generation                         stable             true')
  process.exit(0)
}
if (args[0] !== 'exec') {
  console.error(`mock codex: unsupported ${args.join(' ')}`)
  process.exit(2)
}

const stdin = fs.readFileSync(0, 'utf8')
if (process.env.MOCK_RECORD) fs.writeFileSync(process.env.MOCK_RECORD, JSON.stringify({ args, stdin, cwd: process.cwd() }, null, 2))

const opt = name => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const lastMessageFile = opt('--output-last-message')
const id = crypto.randomUUID()
const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n')
const now = new Date()
const dayDir = path.join(home, 'sessions', String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'))
fs.mkdirSync(dayDir, { recursive: true })
const rollout = path.join(dayDir, `rollout-${now.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`)
const rows = [{ type: 'session_meta', payload: { id, cwd: process.cwd(), source: 'exec' } }]
const finish = (message, code = 0) => {
  rows.push({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message }] } })
  fs.writeFileSync(rollout, rows.map(r => JSON.stringify({ timestamp: new Date().toISOString(), ...r })).join('\n') + '\n')
  if (lastMessageFile) fs.writeFileSync(lastMessageFile, message)
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: message } })
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
  process.exit(code)
}

emit({ type: 'thread.started', thread_id: id })
emit({ type: 'turn.started' })
process.stderr.write('Reading prompt from stdin...\n')

const delay = Number(process.env.MOCK_DELAY_MS || 300)
setTimeout(() => {
  if (mode === 'turnfail') {
    fs.writeFileSync(rollout, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    emit({ type: 'error', message: "You've hit your usage limit. Try again later." })
    emit({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later." } })
    process.exit(1)
  }
  if (mode === 'refuse') finish('IMAGE_FAILED: the request conflicts with the content policy')
  if (mode === 'noimage') finish('Here is a description of an apple instead.')

  const bytes = process.env.MOCK_PNG ? fs.readFileSync(process.env.MOCK_PNG) : mode === 'jpeg' ? jpegStub(1024, 1536) : png(Number(process.env.MOCK_W || 300), Number(process.env.MOCK_H || 200))
  if (mode === 'rollout' || mode === 'jpeg') {
    rows.push({ type: 'response_item', payload: { type: 'image_generation_call', id: 'ig_123', status: 'completed', revised_prompt: 'A red apple, studio light', result: bytes.toString('base64') } })
  } else if (mode === 'saved') {
    const dir = path.join(home, 'generated_images', id)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'ig_123.png')
    fs.writeFileSync(file, bytes)
    rows.push({ type: 'event_msg', payload: { type: 'image_generation_end', call_id: 'ig_123', revised_prompt: 'A red apple, saved', saved_path: file } })
  } else if (mode === 'dironly') {
    const dir = path.join(home, 'generated_images', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'ig_456.png'), bytes)
  } else if (mode === 'two') {
    rows.push({ type: 'response_item', payload: { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: bytes.toString('base64') } })
    rows.push({ type: 'response_item', payload: { type: 'image_generation_call', id: 'ig_2', status: 'completed', result: png(64, 64, [10, 200, 10]).toString('base64') } })
  }
  finish('IMAGE_DONE')
}, delay)
