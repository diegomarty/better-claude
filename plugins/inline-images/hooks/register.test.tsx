// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { decodeGif, shrink } from './gif'

// A PNG of one red pixel.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const SCREEN = { columns: 120, rows: 40, isFullscreen: true }

/** A GIF 2×1 of a red and a blue palette, one frame per entry of `frames`, each all of one palette index. */
function gif (frames: number[], delay = 20) {
  const bytes = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 2, 0, 1, 0, 0x80, 0, 0, 255, 0, 0, 0, 0, 255]
  for (const index of frames) {
    // The graphic control extension, then the image: clear, the index twice, end, in 3-bit codes.
    bytes.push(0x21, 0xf9, 4, 0, delay, 0, 0, 0)
    const code = 4 | (index << 3) | (index << 6) | (5 << 9)
    bytes.push(0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, 2, code & 0xff, code >> 8, 0)
  }
  bytes.push(0x3b)
  return Uint8Array.from(bytes)
}

/** Everything beneath the mod: the session, its files, the processes it runs and what the engine draws. */
function world (on: On, { env = { TERM_PROGRAM: 'ghostty' }, files = {} as Record<string, string>, tracked = [] as string[] } = {}) {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, env)
  const runs: { argv: string[]; stdin?: string }[] = []
  const blits: { requestId: string; key: string; source?: unknown; cells?: string }[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.root', () => ({ value: '/project/app' }))
  on('session.cwd', () => ({ value: '/project/app' }))
  on('process.run', ($, e) => {
    runs.push({ argv: [...e.argv], stdin: e.init?.stdin })
    // `sh -c 'base64 --decode > "$0"' <file>`: the bytes written are read back.
    if (e.argv[0] === 'sh' && e.argv[3]?.endsWith('.source.gif') && e.init?.stdin) files[e.argv[3]] = e.init.stdin
    const stdout = e.argv[0] === 'id' ? '501\n' : e.argv[0] === 'git' ? tracked.join('\0') : e.argv[0] === 'uname' ? 'Darwin\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', ($, e) => ({ value: { kind: 'file' as const, size: files[e.path]?.length ?? 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', ($, e) => ({ value: { base64: files[e.path] ?? PNG } }))
  on('ui.blit', ($, e) => {
    blits.push(e as never)
    return { value: {} }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  return { clock, runs, blits }
}

const startSession = ($: Engine) => $.session.start({ cwd: '/project/app', surface: 'terminal', isInteractive: true })

const readResult = ($: Engine, output: unknown, onScreen: { first: number; last: number; of: number } | null = { first: 0, last: 1, of: 2 }) =>
  $.ui.mount({
    plugin: 'inline-images',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'tu-1',
    props: { tool_use_id: 'tu-1', tool: 'Read', output, isErrored: false, onScreen },
    viewport: SCREEN
  })

const image = (base64: string, type = 'image/png') => ({ type: 'image', file: { base64, type, originalSize: 100 } })

test('decodes every frame of a GIF, with its delay', () => {
  const { width, height, frames } = decodeGif(gif([0, 1], 30))
  expect([width, height, frames.length]).toEqual([2, 1, 2])
  expect([...frames[0]!.data]).toEqual([255, 0, 0, 255, 255, 0, 0, 255])
  expect([...frames[1]!.data]).toEqual([0, 0, 255, 255, 0, 0, 255, 255])
  expect(frames.map(frame => frame.delay)).toEqual([300, 300])
})

test('plays a frame asking for no delay at the pace browsers do', () => {
  expect(decodeGif(gif([0], 0)).frames[0]!.delay).toBe(100)
})

test('shrinks a picture to fit, averaging what each pixel covers', () => {
  const { width, height, data } = shrink(decodeGif(gif([0])).frames[0]!, 1, 1)
  expect([width, height, ...data]).toEqual([1, 1, 255, 0, 0, 255])
})

test('a picture Claude reads shows under its row, from the file it read', async ($, on) => {
  world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  await $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'ToolUse', requestId: 'tu-1', props: { tool_use_id: 'tu-1', tool: 'Read', input: { file_path: '/project/app/shot.png' }, isRunning: false, isErrored: false, isInterrupted: false }, viewport: SCREEN })
  const row = await readResult($, image(PNG))
  expect(await row.find({ key: 'engine' })).toBeDefined()
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { source: { file: '/project/app/shot.png', format: 'png' }, columns: 1, rows: 1, alt: 'shot.png' } })
})

test('a picture whose file is gone shows from the bytes Claude read', async ($, on) => {
  const w = world(on)
  await startSession($)
  const row = await readResult($, image(PNG))
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { source: { format: 'png' } } })
  const written = w.runs.find(run => run.argv[0] === 'sh')
  expect(written?.stdin).toBe(PNG)
})

test('a GIF plays while it shows, each frame swapped in after its delay', async ($, on) => {
  const w = world(on)
  await startSession($)
  const row = await readResult($, image(gif([0, 1]).toBase64(), 'image/gif'))
  const drawn = await row.find({ type: 'Image' })
  expect(drawn).toMatchObject({ props: { source: { format: 'rgba', width: 2, height: 1 } } })
  // Both frames written to files the terminal reads, in one process.
  expect(w.runs.find(run => run.argv[2]?.includes('.rgba'))?.stdin?.split('\n').filter(Boolean)).toHaveLength(2)
  await w.clock.advance(200)
  expect(w.blits).toHaveLength(1)
  expect(w.blits[0]).toMatchObject({ requestId: 'tu-1', source: { file: expect.stringMatching(/\/1\.rgba$/) } })
  await w.clock.advance(200)
  expect(w.blits[1]).toMatchObject({ source: { file: expect.stringMatching(/\/0\.rgba$/) } })
})

test('a GIF off screen does not play', async ($, on) => {
  const w = world(on)
  await startSession($)
  await readResult($, image(gif([0, 1]).toBase64(), 'image/gif'), null)
  await w.clock.advance(1000)
  expect(w.blits).toHaveLength(0)
})

test('a terminal that cannot draw pictures gets them in colored cells', async ($, on) => {
  world(on, { env: { TERM_PROGRAM: 'Apple_Terminal' } })
  await startSession($)
  const row = await readResult($, image(gif([0, 1]).toBase64(), 'image/gif'))
  expect(await row.find({ type: 'Raster' })).toMatchObject({ props: { columns: 1, rows: 1 } })
  expect(await row.find({ type: 'Image' })).toBeUndefined()
})

test('a local picture an answer links to shows under it; a link to no file draws nothing', async ($, on) => {
  world(on, { files: { '/project/app/out/chart.png': PNG } })
  await startSession($)
  const reply = (text: string, requestId: string) => $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'AssistantMessage', requestId, props: { text, isFirstOfReply: true }, viewport: SCREEN })
  const linked = await reply('Here it is: ![the chart](./out/chart.png)', 'a-1')
  expect(await linked.find({ type: 'Image' })).toMatchObject({ props: { source: { file: '/project/app/out/chart.png' }, alt: 'chart.png' } })
  const missing = await reply('See ![none](missing.png) and ![web](https://example.com/a.png)', 'a-2')
  expect(await missing.find({ type: 'Image' })).toBeUndefined()
  expect(await missing.find({ type: 'Text', text: /no preview/ })).toBeUndefined()
})

const answer = ($: Engine, text: string, requestId = 'a-1', onScreen: { first: number; last: number; of: number } | null = { first: 0, last: 9, of: 10 }) =>
  $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'AssistantMessage', requestId, props: { text, isFirstOfReply: true, onScreen }, viewport: SCREEN })

test('a picture an answer only names gets a chip beside the block that names it, found under the working folder by its name', async ($, on) => {
  world(on, { files: { '/project/app/docs/media/leads.gif': gif([0, 1]).toBase64() }, tracked: ['docs/media/leads.gif', 'src/index.ts'] })
  await startSession($)
  const row = await answer($, 'The README has two:\n\n1. Imagen: `leads.gif` (2,6 MB), in `docs/media/`\n2. And `other.png`, which is not there.')
  expect((await row.findAll({ type: 'Markdown' })).map(block => block.props.text)).toEqual([
    'The README has two:',
    '1. Imagen: `leads.gif` (2,6 MB), in `docs/media/`',
    '2. And `other.png`, which is not there.'
  ])
  expect(await row.find({ key: 'ref:0' })).toMatchObject({ type: 'Client', props: { module: 'hooks/chip.tsx', props: { label: 'leads.gif' } } })
  // Beside the list item that names it.
  expect(JSON.stringify(await row.find({ key: 'block-1' }))).toContain('"ref:0"')
  expect(await row.find({ key: 'ref:1' })).toBeUndefined()
  expect(await row.find({ type: 'Image' })).toBeUndefined()
})

test('the pointer on a chip opens its picture in a card over the answer; leaving closes it, a click opens the file', async ($, on) => {
  const w = world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  const row = await answer($, 'First.\n\nSecond.\n\nI saved it as shot.png.', 'a-1', { first: 0, last: 9, of: 10 })
  // Each block's probe says how tall it was laid out: rows 0-1, 3-4 and 6.
  for (const [i, rows] of [2, 2, 1].entries()) await row.post({ rows }, { in: `probe:${i}` })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  // The card is 4 rows (the border, a one-row picture, the caption): over the rows above the third block.
  expect(await row.find({ key: 'card' })).toMatchObject({ props: { position: 'absolute', top: 2 } })
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { source: { file: '/project/app/shot.png' }, alt: 'shot.png' } })
  // As wide as its caption, every cell beside the one-cell picture written: the answer does not show through.
  expect(await row.find({ key: 'frame' })).toMatchObject({ props: { width: 10 } })
  expect(await row.find({ type: 'Text', text: '   ' })).toBeDefined()
  expect(await row.find({ type: 'Text', text: '    ' })).toBeDefined()
  expect(await row.find({ type: 'Text', text: 'shot.png' })).toBeDefined()
  await row.pointer({ type: 'leave', x: 0, y: 0, in: 'ref:0' })
  expect(await row.find({ key: 'card' })).toBeUndefined()
  await row.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'ref:0' })
  await row.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'ref:0' })
  expect(w.runs.some(run => run.argv[0] === 'open' && run.argv[1] === '/project/app/shot.png')).toBe(true)
})

test('a card with too few rows above its block opens over the rows below it', async ($, on) => {
  world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  // The answer's top scrolled away: no rows above it on screen to count on.
  const row = await answer($, 'See shot.png here.\n\nAnd more.\n\nAnd more still.\n\nThe end.', 'a-1', { first: 1, last: 19, of: 20 })
  for (const [i, rows] of [2, 4, 4, 4].entries()) await row.post({ rows }, { in: `probe:${i}` })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  expect(await row.find({ key: 'card' })).toMatchObject({ props: { top: 2 } })
})

test('a picture embedded in an answer shows under its paragraph, its markdown not written as well', async ($, on) => {
  world(on, { files: { '/project/app/out/chart.png': PNG } })
  await startSession($)
  const row = await answer($, 'Here it is:\n\n![the chart](out/chart.png)\n\nDone.')
  expect((await row.findAll({ type: 'Markdown' })).map(block => block.props.text)).toEqual(['Here it is:', 'Done.'])
  expect(JSON.stringify(await row.find({ key: 'block-1' }))).toContain('"Image"')
})

test('a picture the answer embeds gets no chip of its own', async ($, on) => {
  world(on, { files: { '/project/app/out/chart.png': PNG } })
  await startSession($)
  const row = await answer($, 'Here: ![chart](out/chart.png), saved as out/chart.png')
  expect(await row.find({ type: 'Image' })).toBeDefined()
  expect(await row.find({ key: 'ref:0' })).toBeUndefined()
})
