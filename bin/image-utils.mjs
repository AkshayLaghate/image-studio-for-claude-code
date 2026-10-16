// Small, dependency-free image helpers for image-studio: decode a PNG, scale it
// down, and encode a baseline JPEG. Used to make the chat preview and a smaller
// copy for Claude when a generated image is too large to attach whole.
//
// The JPEG encoder follows the public-domain baseline encoder by Andreas Ritter
// (as ported in jpeg-js): AAN float DCT, standard tables, 4:4:4 sampling.

import zlib from 'node:zlib'

// ---------------------------------------------------------------- PNG decode

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** Decodes a non-interlaced PNG to RGBA, or returns null for anything else. */
export function decodePng(buf) {
  if (!buf || buf.length < 33 || PNG_SIGNATURE.some((b, i) => buf[i] !== b)) return null
  let pos = 8
  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let interlace = 0
  let palette = null
  let alphaTable = null
  const idat = []
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + length)
    pos += 12 + length
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') alphaTable = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  const channels = CHANNELS[colorType]
  if (!width || !height || !channels || interlace !== 0) return null
  if (depth !== 8 && depth !== 16) return null
  if (colorType === 3 && (!palette || depth !== 8)) return null
  if (width * height > 64_000_000) return null

  let raw
  try {
    raw = zlib.inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }
  const bpp = channels * (depth / 8)
  const stride = width * bpp
  if (raw.length < (stride + 1) * height) return null

  const out = new Uint8Array(width * height * 4)
  let prev = new Uint8Array(stride)
  let line = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v = src[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = v & 0xff
    }
    const step = depth / 8
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const s = x * bpp
      const at = k => line[s + k * step] // high byte for 16-bit samples
      if (colorType === 0) {
        out[o] = out[o + 1] = out[o + 2] = at(0)
        out[o + 3] = 255
      } else if (colorType === 2) {
        out[o] = at(0)
        out[o + 1] = at(1)
        out[o + 2] = at(2)
        out[o + 3] = 255
      } else if (colorType === 3) {
        const index = line[s]
        out[o] = palette[index * 3] ?? 0
        out[o + 1] = palette[index * 3 + 1] ?? 0
        out[o + 2] = palette[index * 3 + 2] ?? 0
        out[o + 3] = alphaTable && index < alphaTable.length ? alphaTable[index] : 255
      } else if (colorType === 4) {
        out[o] = out[o + 1] = out[o + 2] = at(0)
        out[o + 3] = at(1)
      } else {
        out[o] = at(0)
        out[o + 1] = at(1)
        out[o + 2] = at(2)
        out[o + 3] = at(3)
      }
    }
    const swap = prev
    prev = line
    line = swap
  }
  return { width, height, data: out }
}

// ---------------------------------------------------------------- resize

/** Scales RGBA down so its long side is at most `maxSide` (area average). */
export function shrink(image, maxSide) {
  const { width, height, data } = image
  const scale = Math.min(1, maxSide / Math.max(width, height))
  if (scale === 1) return image
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const out = new Uint8Array(w * h * 4)
  const xr = width / w
  const yr = height / h
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * yr)
    const y1 = Math.max(y0 + 1, Math.min(height, Math.floor((y + 1) * yr)))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * xr)
      const x1 = Math.max(x0 + 1, Math.min(width, Math.floor((x + 1) * xr)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * width + x0) * 4
        for (let sx = x0; sx < x1; sx++, i += 4) {
          const alpha = data[i + 3]
          r += data[i] * alpha
          g += data[i + 1] * alpha
          b += data[i + 2] * alpha
          a += alpha
          n++
        }
      }
      const o = (y * w + x) * 4
      out[o] = a ? Math.round(r / a) : 0
      out[o + 1] = a ? Math.round(g / a) : 0
      out[o + 2] = a ? Math.round(b / a) : 0
      out[o + 3] = Math.round(a / n)
    }
  }
  return { width: w, height: h, data: out }
}

/** Puts RGBA over a light checkerboard (so transparency stays visible) as RGB. */
export function flatten(image, cell = 8) {
  const { width, height, data } = image
  const rgb = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const o = (y * width + x) * 3
      const alpha = data[i + 3] / 255
      const bg = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0 ? 255 : 226
      rgb[o] = Math.round(data[i] * alpha + bg * (1 - alpha))
      rgb[o + 1] = Math.round(data[i + 1] * alpha + bg * (1 - alpha))
      rgb[o + 2] = Math.round(data[i + 2] * alpha + bg * (1 - alpha))
    }
  }
  return { width, height, rgb }
}

/** True when any pixel is not fully opaque. */
export function hasAlpha(image) {
  const { data } = image
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true
  return false
}

// ---------------------------------------------------------------- JPEG encode

const ZIGZAG = [
  0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53, 10, 19, 23, 32, 39,
  45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
]
const Y_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22,
  37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
]
const C_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
]
const DC_Y_NRCODES = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
const DC_Y_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
const AC_Y_NRCODES = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d]
const AC_Y_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1,
  0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56,
  0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85,
  0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa,
  0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6,
  0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9,
  0xfa,
]
const DC_C_NRCODES = [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]
const DC_C_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
const AC_C_NRCODES = [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77]
const AC_C_VALUES = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42,
  0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19,
  0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
  0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83,
  0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8,
  0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
  0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9,
  0xfa,
]
const AAN_SCALES = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379]

function huffmanTable(nrcodes, values) {
  const table = []
  let code = 0
  let k = 0
  for (let length = 1; length <= 16; length++) {
    for (let j = 1; j <= nrcodes[length]; j++) {
      table[values[k]] = [code, length]
      k++
      code++
    }
    code *= 2
  }
  return table
}

const HT_DC_Y = huffmanTable(DC_Y_NRCODES, DC_Y_VALUES)
const HT_AC_Y = huffmanTable(AC_Y_NRCODES, AC_Y_VALUES)
const HT_DC_C = huffmanTable(DC_C_NRCODES, DC_C_VALUES)
const HT_AC_C = huffmanTable(AC_C_NRCODES, AC_C_VALUES)

const CATEGORY = new Int32Array(65535)
const BITCODE = new Array(65535)
;(() => {
  let low = 1
  let high = 2
  for (let cat = 1; cat <= 15; cat++) {
    for (let n = low; n < high; n++) {
      CATEGORY[32767 + n] = cat
      BITCODE[32767 + n] = [n, cat]
    }
    for (let n = -(high - 1); n <= -low; n++) {
      CATEGORY[32767 + n] = cat
      BITCODE[32767 + n] = [high - 1 + n, cat]
    }
    low <<= 1
    high <<= 1
  }
})()

function quantTables(quality) {
  const q = Math.min(100, Math.max(1, quality))
  const sf = q < 50 ? Math.floor(5000 / q) : Math.floor(200 - q * 2)
  const yTable = new Array(64)
  const cTable = new Array(64)
  for (let i = 0; i < 64; i++) {
    yTable[ZIGZAG[i]] = Math.min(255, Math.max(1, Math.floor((Y_QUANT[i] * sf + 50) / 100)))
    cTable[ZIGZAG[i]] = Math.min(255, Math.max(1, Math.floor((C_QUANT[i] * sf + 50) / 100)))
  }
  const fdY = new Float64Array(64)
  const fdC = new Float64Array(64)
  let k = 0
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      fdY[k] = 1.0 / (yTable[ZIGZAG[k]] * AAN_SCALES[row] * AAN_SCALES[col] * 8.0)
      fdC[k] = 1.0 / (cTable[ZIGZAG[k]] * AAN_SCALES[row] * AAN_SCALES[col] * 8.0)
      k++
    }
  }
  return { yTable, cTable, fdY, fdC }
}

function fdctQuant(data, fdtbl, out) {
  for (let off = 0; off < 64; off += 8) {
    const d0 = data[off], d1 = data[off + 1], d2 = data[off + 2], d3 = data[off + 3]
    const d4 = data[off + 4], d5 = data[off + 5], d6 = data[off + 6], d7 = data[off + 7]
    const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6
    const t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4
    let t10 = t0 + t3
    const t13 = t0 - t3
    let t11 = t1 + t2
    let t12 = t1 - t2
    data[off] = t10 + t11
    data[off + 4] = t10 - t11
    const z1 = (t12 + t13) * 0.707106781
    data[off + 2] = t13 + z1
    data[off + 6] = t13 - z1
    t10 = t4 + t5
    t11 = t5 + t6
    t12 = t6 + t7
    const z5 = (t10 - t12) * 0.382683433
    const z2 = 0.5411961 * t10 + z5
    const z4 = 1.306562965 * t12 + z5
    const z3 = t11 * 0.707106781
    const z11 = t7 + z3
    const z13 = t7 - z3
    data[off + 5] = z13 + z2
    data[off + 3] = z13 - z2
    data[off + 1] = z11 + z4
    data[off + 7] = z11 - z4
  }
  for (let off = 0; off < 8; off++) {
    const d0 = data[off], d1 = data[off + 8], d2 = data[off + 16], d3 = data[off + 24]
    const d4 = data[off + 32], d5 = data[off + 40], d6 = data[off + 48], d7 = data[off + 56]
    const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6
    const t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4
    let t10 = t0 + t3
    const t13 = t0 - t3
    let t11 = t1 + t2
    let t12 = t1 - t2
    data[off] = t10 + t11
    data[off + 32] = t10 - t11
    const z1 = (t12 + t13) * 0.707106781
    data[off + 16] = t13 + z1
    data[off + 48] = t13 - z1
    t10 = t4 + t5
    t11 = t5 + t6
    t12 = t6 + t7
    const z5 = (t10 - t12) * 0.382683433
    const z2 = 0.5411961 * t10 + z5
    const z4 = 1.306562965 * t12 + z5
    const z3 = t11 * 0.707106781
    const z11 = t7 + z3
    const z13 = t7 - z3
    data[off + 40] = z13 + z2
    data[off + 24] = z13 - z2
    data[off + 8] = z11 + z4
    data[off + 56] = z11 - z4
  }
  for (let i = 0; i < 64; i++) {
    const v = data[i] * fdtbl[i]
    out[i] = v > 0 ? Math.floor(v + 0.5) : Math.ceil(v - 0.5)
  }
  return out
}

/** Encodes RGB (3 bytes a pixel) as a baseline 4:4:4 JPEG. */
export function encodeJpeg({ width, height, rgb }, quality = 80) {
  const { yTable, cTable, fdY, fdC } = quantTables(quality)
  const bytes = []
  let bitBuffer = 0
  let bitCount = 7
  const writeByte = b => bytes.push(b & 0xff)
  const writeWord = w => {
    writeByte(w >> 8)
    writeByte(w)
  }
  const writeBits = ([value, length]) => {
    let pos = length - 1
    while (pos >= 0) {
      if (value & (1 << pos)) bitBuffer |= 1 << bitCount
      pos--
      bitCount--
      if (bitCount < 0) {
        if (bitBuffer === 0xff) {
          writeByte(0xff)
          writeByte(0)
        } else writeByte(bitBuffer)
        bitCount = 7
        bitBuffer = 0
      }
    }
  }

  // Headers
  writeWord(0xffd8)
  writeWord(0xffe0)
  writeWord(16)
  ;[0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0].forEach(writeByte)
  writeWord(1)
  writeWord(1)
  writeByte(0)
  writeByte(0)
  writeWord(0xffdb)
  writeWord(132)
  writeByte(0)
  for (let i = 0; i < 64; i++) writeByte(yTable[i])
  writeByte(1)
  for (let i = 0; i < 64; i++) writeByte(cTable[i])
  writeWord(0xffc0)
  writeWord(17)
  writeByte(8)
  writeWord(height)
  writeWord(width)
  writeByte(3)
  ;[1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1].forEach(writeByte)
  writeWord(0xffc4)
  writeWord(0x01a2)
  const writeTable = (cls, nrcodes, values) => {
    writeByte(cls)
    for (let i = 1; i <= 16; i++) writeByte(nrcodes[i])
    for (const v of values) writeByte(v)
  }
  writeTable(0x00, DC_Y_NRCODES, DC_Y_VALUES)
  writeTable(0x10, AC_Y_NRCODES, AC_Y_VALUES)
  writeTable(0x01, DC_C_NRCODES, DC_C_VALUES)
  writeTable(0x11, AC_C_NRCODES, AC_C_VALUES)
  writeWord(0xffda)
  writeWord(12)
  writeByte(3)
  ;[1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0].forEach(writeByte)

  // Scan
  const ydu = new Float64Array(64)
  const udu = new Float64Array(64)
  const vdu = new Float64Array(64)
  const quantized = new Int32Array(64)
  const zz = new Int32Array(64)
  const processDu = (cdu, fdtbl, dc, htdc, htac) => {
    const q = fdctQuant(cdu, fdtbl, quantized)
    for (let j = 0; j < 64; j++) zz[ZIGZAG[j]] = q[j]
    const diff = zz[0] - dc
    if (diff === 0) writeBits(htdc[0])
    else {
      const pos = 32767 + diff
      writeBits(htdc[CATEGORY[pos]])
      writeBits(BITCODE[pos])
    }
    let end0 = 63
    while (end0 > 0 && zz[end0] === 0) end0--
    if (end0 === 0) {
      writeBits(htac[0x00])
      return zz[0]
    }
    let i = 1
    while (i <= end0) {
      const start = i
      while (zz[i] === 0 && i <= end0) i++
      let zeros = i - start
      if (zeros >= 16) {
        const lng = zeros >> 4
        for (let n = 1; n <= lng; n++) writeBits(htac[0xf0])
        zeros &= 0xf
      }
      const pos = 32767 + zz[i]
      writeBits(htac[(zeros << 4) + CATEGORY[pos]])
      writeBits(BITCODE[pos])
      i++
    }
    if (end0 !== 63) writeBits(htac[0x00])
    return zz[0]
  }

  let dcY = 0
  let dcU = 0
  let dcV = 0
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      for (let k = 0; k < 64; k++) {
        const row = Math.min(height - 1, y + (k >> 3))
        const col = Math.min(width - 1, x + (k & 7))
        const p = (row * width + col) * 3
        const r = rgb[p]
        const g = rgb[p + 1]
        const b = rgb[p + 2]
        ydu[k] = 0.299 * r + 0.587 * g + 0.114 * b - 128
        udu[k] = -0.16874 * r - 0.33126 * g + 0.5 * b
        vdu[k] = 0.5 * r - 0.41869 * g - 0.08131 * b
      }
      dcY = processDu(ydu, fdY, dcY, HT_DC_Y, HT_AC_Y)
      dcU = processDu(udu, fdC, dcU, HT_DC_C, HT_AC_C)
      dcV = processDu(vdu, fdC, dcV, HT_DC_C, HT_AC_C)
    }
  }
  if (bitCount < 7) writeBits([(1 << (bitCount + 1)) - 1, bitCount + 1])
  writeWord(0xffd9)
  return Buffer.from(bytes)
}

// ---------------------------------------------------------------- previews

/**
 * A JPEG of a PNG scaled to fit `maxSide`, stepping size and quality down until
 * its base64 is at most `maxBase64` characters. Null when the PNG can't be read.
 */
export function jpegPreview(pngBytes, { maxSide, maxBase64, quality = 80 }) {
  const decoded = decodePng(pngBytes)
  if (!decoded) return null
  const transparent = hasAlpha(decoded)
  let side = maxSide
  let q = quality
  for (let attempt = 0; attempt < 8; attempt++) {
    const small = shrink(decoded, side)
    const jpeg = encodeJpeg(flatten(small, Math.max(4, Math.round(Math.min(small.width, small.height) / 24))), q)
    const base64 = jpeg.toString('base64')
    if (base64.length <= maxBase64) {
      return { mime: 'image/jpeg', base64, width: small.width, height: small.height, transparent }
    }
    if (q > 55) q -= 10
    else side = Math.round(side * 0.8)
  }
  return null
}
