import type { Pixels } from './pixels'

/** One frame of an animation, composed over the ones before it, and how long it shows, in ms. */
export type Frame = Pixels & { delay: number }

// Browsers show a frame that asks for 10 ms or less for 100 ms: so do GIFs expect to be played.
const MIN_DELAY = 20
const SLOW_DELAY = 100

export const isGif = (bytes: Uint8Array) => bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46

/** Decodes one image's LZW code stream into `count` palette indices. */
function lzw (data: Uint8Array, minSize: number, count: number) {
  const out = new Uint8Array(count)
  const clear = 1 << minSize
  const end = clear + 1
  const prefix = new Int16Array(4096)
  const suffix = new Uint8Array(4096)
  const first = new Uint8Array(4096)
  const stack = new Uint8Array(4097)
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1
    suffix[i] = i
    first[i] = i
  }
  let size = minSize + 1
  let next = end + 1
  let previous = -1
  let bits = 0
  let held = 0
  let written = 0
  for (let i = 0; i < data.length && written < count;) {
    while (bits < size && i < data.length) {
      held |= data[i++]! << bits
      bits += 8
    }
    if (bits < size) break
    const code = held & ((1 << size) - 1)
    held >>>= size
    bits -= size
    if (code === clear) {
      size = minSize + 1
      next = end + 1
      previous = -1
      continue
    }
    if (code === end) break
    let top = 0
    let current = code
    if (previous === -1) {
      if (code >= clear) break
      out[written++] = code
      previous = code
      continue
    }
    // A code not yet in the table is the previous string and its own first byte.
    if (code >= next) {
      stack[top++] = first[previous]!
      current = previous
    }
    while (current >= clear && top < 4096) {
      stack[top++] = suffix[current]!
      current = prefix[current]!
    }
    stack[top++] = current
    if (next < 4096) {
      prefix[next] = previous
      suffix[next] = current
      first[next] = first[previous]!
      next++
      if (next === 1 << size && size < 12) size++
    }
    while (top > 0 && written < count) out[written++] = stack[--top]!
    previous = code
  }
  return out
}

/** The rows of an interlaced image in the order it stores them. */
function interlacedRows (height: number) {
  const order: number[] = []
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]] as const) for (let y = start; y < height; y += step) order.push(y)
  return order
}

/**
 * Every frame of a GIF, each the whole canvas as it shows then (8-bit RGBA, transparent where
 * nothing is drawn), with its delay. At most `maxFrames`; past that the animation is cut.
 */
export function decodeGif (bytes: Uint8Array, maxFrames = 500): { width: number; height: number; frames: Frame[] } {
  if (!isGif(bytes) || bytes.length < 13) throw new Error('not a GIF file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint16(6, true)
  const height = view.getUint16(8, true)
  if (width === 0 || height === 0) throw new Error('an empty GIF')
  if (width * height > 4096 * 4096) throw new Error('a GIF too large to decode')
  const flags = bytes[10]!
  let at = 13
  let globalPalette: Uint8Array | undefined
  if (flags & 0x80) {
    const size = 3 * (1 << ((flags & 7) + 1))
    globalPalette = bytes.subarray(at, at + size)
    at += size
  }

  const canvas = new Uint8Array(width * height * 4)
  const frames: Frame[] = []
  let delay = 0
  let transparent = -1
  let disposal = 0

  const blocks = () => {
    const parts: Uint8Array[] = []
    let total = 0
    while (at < bytes.length) {
      const size = bytes[at++]!
      if (size === 0) break
      parts.push(bytes.subarray(at, at + size))
      total += size
      at += size
    }
    const data = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      data.set(part, offset)
      offset += part.length
    }
    return data
  }

  while (at < bytes.length && frames.length < maxFrames) {
    const kind = bytes[at++]!
    if (kind === 0x3b) break
    if (kind === 0x21) {
      const label = bytes[at++]!
      // The graphic control extension: the next image's delay, transparency and disposal.
      if (label === 0xf9 && bytes[at] === 4) {
        const packed = bytes[at + 1]!
        disposal = (packed >> 2) & 7
        delay = view.getUint16(at + 2, true) * 10
        transparent = packed & 1 ? bytes[at + 4]! : -1
      }
      blocks()
      continue
    }
    if (kind !== 0x2c) break

    const left = view.getUint16(at, true)
    const top = view.getUint16(at + 2, true)
    const w = view.getUint16(at + 4, true)
    const h = view.getUint16(at + 6, true)
    const packed = bytes[at + 8]!
    at += 9
    let palette = globalPalette
    if (packed & 0x80) {
      const size = 3 * (1 << ((packed & 7) + 1))
      palette = bytes.subarray(at, at + size)
      at += size
    }
    const minSize = bytes[at++]!
    const indices = lzw(blocks(), minSize, w * h)
    if (!palette) throw new Error('a GIF with no palette')

    // Disposal 3 puts the canvas back as it was before this frame once it has shown.
    const saved = disposal === 3 ? canvas.slice() : undefined
    const rows = packed & 0x40 ? interlacedRows(h) : undefined
    for (let row = 0; row < h; row++) {
      const y = top + (rows ? rows[row]! : row)
      if (y >= height) continue
      for (let x = 0; x < w; x++) {
        const index = indices[row * w + x]!
        if (index === transparent || left + x >= width) continue
        const out = (y * width + left + x) * 4
        canvas[out] = palette[index * 3] ?? 0
        canvas[out + 1] = palette[index * 3 + 1] ?? 0
        canvas[out + 2] = palette[index * 3 + 2] ?? 0
        canvas[out + 3] = 255
      }
    }
    frames.push({ width, height, data: canvas.slice(), delay: delay <= 10 ? SLOW_DELAY : Math.max(MIN_DELAY, delay) })

    // Disposal 2 clears the frame's area to transparent before the next.
    if (disposal === 2) {
      for (let y = top; y < Math.min(height, top + h); y++) canvas.fill(0, (y * width + left) * 4, (y * width + Math.min(width, left + w)) * 4)
    } else if (saved) canvas.set(saved)
    delay = 0
    transparent = -1
    disposal = 0
  }
  if (frames.length === 0) throw new Error('a GIF with no frames')
  return { width, height, frames }
}

/** The picture shrunk (never enlarged) to fit `maxWidth` by `maxHeight`, each output pixel the average of those it covers. */
export function shrink (pixels: Pixels, maxWidth: number, maxHeight: number): Pixels {
  const scale = Math.min(1, maxWidth / pixels.width, maxHeight / pixels.height)
  if (scale === 1) return pixels
  const width = Math.max(1, Math.round(pixels.width * scale))
  const height = Math.max(1, Math.round(pixels.height * scale))
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * pixels.height) / height)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * pixels.height) / height))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * pixels.width) / width)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * pixels.width) / width))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * pixels.width + sx) * 4
          const alpha = pixels.data[i + 3]!
          r += pixels.data[i]! * alpha
          g += pixels.data[i + 1]! * alpha
          b += pixels.data[i + 2]! * alpha
          a += alpha
        }
      }
      const out = (y * width + x) * 4
      if (a > 0) {
        data[out] = Math.round(r / a)
        data[out + 1] = Math.round(g / a)
        data[out + 2] = Math.round(b / a)
      }
      data[out + 3] = Math.round(a / ((y1 - y0) * (x1 - x0)))
    }
  }
  return { width, height, data }
}
