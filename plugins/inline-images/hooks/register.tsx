import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, EventOf, ImageSource, Register, RenderElement, Timer } from 'claude-code'

import { decodeGif, isGif, shrink } from './gif'
import { parseBmp, toCells } from './pixels'
import type { Pixels } from './pixels'
import type { Hovered, Picture } from '../types'

type Engine = EngineInterface
type RenderOf<C extends string> = Extract<EventOf['ui.render'], { component: C, surface: 'terminal' }>
type Ui = Elements['terminal']

const pictures = atom({ plugin: 'inline-images', key: 'pictures' } as const, {} as Record<string, Picture>)
const hovered = atom({ plugin: 'inline-images', key: 'hovered' } as const, null as Hovered | null)

const TOKEN = /\[Image #(\d+)\]/g
// `![alt](path)`, an optional title after the path.
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_COLUMNS = 120
// Under a tool row the transcript writes `  ⎿  `: the picture lines up with the text after it.
const RESULT_INDENT = 5
const MESSAGE_INDENT = 2
// About how many pixels a cell is across: a picture is never drawn larger than about its own size.
const CELL_PIXELS = 8
// The longest side a still picture is shrunk to for the terminal; the bytes one may be sent.
const STILL_PIXELS = 1600
const VIEW_PIXELS = 1024
const VIEW_BYTES = 2 * 1024 * 1024
// The longest side the cells are sampled from, eight points a cell across.
const CELL_SOURCE_PIXELS = 800
// A GIF's frames are shrunk to this side, and all of them together to this many bytes.
const FRAME_PIXELS = 480
const FRAME_BUDGET = 48 * 1024 * 1024
const MAX_FRAMES = 300
// The engine writes a pasted image just after the paste puts its placeholder in the box.
const WAIT_MS = 200
const WAIT_TRIES = 15
// A picture an answer names without drawing it: in a link's target, in code, or bare.
const REFERENCE = /\]\(\s*<?([^)\s>]+\.(?:png|jpe?g|gif|webp))>?[^)]*\)|`([^`\n]+\.(?:png|jpe?g|gif|webp))`|((?:~|\.{1,2})?\/?[\w@%+.-]+(?:\/[\w@%+.-]+)*\.(?:png|jpe?g|gif|webp))(?![\w/])/gi
const WEB_LINK = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi
const MAX_REFERENCES = 24
// The card a chip opens: the most rows its picture takes, and what the border and caption add.
const HOVER_ROWS = 24
const CARD_ROWS = 3
const MIN_CARD_ROWS = 6
// What the screen keeps under the transcript: the prompt and the lines around it.
const BOTTOM_ROWS = 8

/** What the terminal is shown of a picture, frame by frame: an Image's sources, or pixels to draw in cells. */
type Loaded = { sources?: ImageSource[]; pixels?: Pixels[]; delays: number[] }

// How the terminal draws a picture: Ghostty and kitty read a file; one Claude Code was told draws
// pictures (CLAUDE_CODE_FORCE_TERMINAL_IMAGES) is sent its bytes; any other gets it in colored cells.
let graphics: 'none' | 'file' | 'bytes' = 'none'
let isWindows = false
let temp: string | undefined
let sessionId: string | undefined
let folder: string | undefined
let cache: string | undefined
const loaded = new Map<string, Loaded>()
const loading = new Set<string>()
const cells = new Map<string, string>()
// The pictures each answer names, by its text; the image files under the working folder.
const references = new Map<string, Promise<string[]>>()
let index: Promise<string[]> | undefined
// The file each chip names, by `<requestId>/<chip key>`; and where the answer showing the card was when it opened.
const chipFiles = new Map<string, string>()
let hoveredAt: string | undefined
// How many rows each block of an answer was laid out in, by the answer's requestId, as its probes said.
const blockRows = new Map<string, number[]>()
// The file a Read call read, by its tool_use_id, as its row named it.
const readPaths = new Map<string, string>()

/** An animation playing: where it is drawn, which picture, and the frame on show. */
type Playing = { requestId: string; element: string; key: string; frame: number; columns: number; rows: number; timer?: Timer }
const playing = new Map<string, Playing>()

const idsIn = (text: string) => [...new Set([...text.matchAll(TOKEN)].map(match => Number(match[1])))]

/** A short, stable name for a key, to name its files by. */
function nameOf (key: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193)
  return `${key.slice(0, key.indexOf(':'))}-${(hash >>> 0).toString(16)}`
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/**
 * Claude Code's temp folder: `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>`; on Windows
 * `<CLAUDE_CODE_TMPDIR or the system's temp folder>\claude`.
 */
async function tempFolder ($: Engine) {
  if (!isWindows) {
    const base = ((await $.env.get('CLAUDE_CODE_TMPDIR')) || '/tmp').replace(/\/+$/, '')
    return `${base}/claude-${(await $.process.run(['id', '-u'])).stdout.trim()}`
  }
  const system = (await $.env.get('TEMP')) || (await $.env.get('TMP')) || `${(await $.env.get('SystemRoot')) || 'C:\\Windows'}\\temp`
  return `${((await $.env.get('CLAUDE_CODE_TMPDIR')) || system).replace(/[\\/]+$/, '')}/claude`
}

/** Where pasted images are stored for this session: `<temp>/<project path, dashed>/<session id>/images`. */
async function sessionFolder ($: Engine) {
  if (folder) return folder
  const id = await $.session.id()
  const root = (temp ??= await tempFolder($))
  const names = new Set([await $.session.root(), await $.session.cwd()].map(path => path.replace(/[^a-zA-Z0-9]/g, '-')))
  for (const name of names) {
    if (await $.fs.exists(`${root}/${name}/${id}/images`)) return (folder = `${root}/${name}/${id}`)
  }
  // A project path too long for a folder name gets a hash after it: look for the session instead.
  for (const entry of await $.fs.list(root).catch(() => [])) {
    if (entry.kind === 'dir' && (await $.fs.exists(`${root}/${entry.name}/${id}/images`))) return (folder = `${root}/${entry.name}/${id}`)
  }
  return undefined
}

async function pastedFile ($: Engine, id: number) {
  const found = await sessionFolder($)
  if (!found) return undefined
  const name = (await $.fs.list(`${found}/images`).catch(() => [])).find(entry => entry.name.startsWith(`${id}.`))?.name
  return name && /^\d+\.[a-z]+$/.test(name) ? `${found}/images/${name}` : undefined
}

/** The mod's own folder for this session, made once. */
async function cacheFolder ($: Engine) {
  if (cache) return cache
  const path = `${(temp ??= await tempFolder($))}/inline-images/${await $.session.id()}`
  if (isWindows) await $.process.run(['powershell', '-NoProfile', '-Command', 'New-Item -ItemType Directory -Force -Path $env:INLINE_IMAGES_DIR | Out-Null'], { env: { INLINE_IMAGES_DIR: path } })
  else await $.process.run(['mkdir', '-p', path])
  return (cache = path)
}

/** Forgets what was read in another session: after /clear the pasted ids start again from 1. */
async function follow ($: Engine) {
  const id = await $.session.id()
  if (id === sessionId) return
  sessionId = id
  folder = undefined
  cache = undefined
  loaded.clear()
  cells.clear()
  for (const play of playing.values()) play.timer?.cancel()
  playing.clear()
  references.clear()
  blockRows.clear()
  index = undefined
  await update($, pictures, () => ({}))
  await update($, hovered, () => null)
}

/** Writes base64 bytes to a file: `$.fs` writes text alone. */
async function writeBytes ($: Engine, path: string, base64: string) {
  const result = await $.process.run(['sh', '-c', 'base64 --decode > "$0"', path], { stdin: base64 })
  if (result.exitCode !== 0) throw new Error(`could not write ${baseName(path)}`)
}

/** Writes each base64 line of `lines` to `<dir>/<i>.rgba`, in one process. */
async function writeFrames ($: Engine, dir: string, lines: string[]) {
  const script = 'i=0; while IFS= read -r line; do printf %s "$line" | base64 --decode > "$0/$i.rgba" || exit 1; i=$((i+1)); done'
  const result = await $.process.run(['sh', '-c', script, dir], { stdin: `${lines.join('\n')}\n` })
  if (result.exitCode !== 0) throw new Error('could not write the frames')
}

// The converter that worked here: sips on macOS, ImageMagick elsewhere.
let tool: 'sips' | 'magick' | 'convert' | undefined

/** Writes `file` as `format` to `out`, its longest side shrunk to `side` pixels at most. */
async function convert ($: Engine, file: string, out: string, format: 'png' | 'bmp', side: number) {
  const tools = tool ? [tool] : (['sips', 'magick', 'convert'] as const)
  for (const name of tools) {
    const argv = name === 'sips'
      ? ['sips', '-s', 'format', format, '-Z', String(side), file, '--out', out]
      : [name, `${file}[0]`, '-resize', `${side}x${side}>`, `${format === 'bmp' ? 'BMP3' : 'PNG'}:${out}`]
    const result = await $.process.run(argv).catch(() => undefined)
    if (result?.exitCode === 0) {
      tool = name
      return
    }
  }
  throw new Error('needs sips (macOS) or ImageMagick to read it')
}

/** A PNG's width and height, from its header. */
function pngSize (bytes: Uint8Array) {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

const bytesOf = async ($: Engine, file: string) => Uint8Array.fromBase64((await $.fs.read(file, { as: 'bytes' })).base64)

/** A GIF's frames, shrunk to fit the budget, as the terminal is shown them. */
async function loadGif ($: Engine, key: string, bytes: Uint8Array): Promise<Picture> {
  const gif = decodeGif(bytes, MAX_FRAMES)
  const count = gif.frames.length
  // Every frame together within the budget: a long animation is shrunk further.
  const side = Math.min(FRAME_PIXELS, Math.floor(Math.sqrt(FRAME_BUDGET / 4 / count) * Math.max(gif.width, gif.height) / Math.sqrt(gif.width * gif.height)))
  const frames = gif.frames.map(frame => shrink(frame, side, side))
  const { width, height } = frames[0]!
  const delays = gif.frames.map(frame => frame.delay)
  if (graphics === 'none') {
    loaded.set(key, { pixels: frames, delays })
  } else if (graphics === 'bytes') {
    loaded.set(key, { sources: frames.map(frame => ({ rgba: frame.data.toBase64(), width, height })), delays })
  } else {
    const dir = `${await cacheFolder($)}/${nameOf(key)}`
    await $.process.run(['mkdir', '-p', dir])
    await writeFrames($, dir, frames.map(frame => frame.data.toBase64()))
    loaded.set(key, { sources: frames.map((_, i) => ({ file: `${dir}/${i}.rgba`, format: 'rgba' as const, width, height })), delays })
  }
  return { width: gif.width, height: gif.height, frames: count }
}

/** A still picture, as a PNG the terminal reads or is sent, or as pixels to draw in cells. */
async function loadStill ($: Engine, key: string, file: string, bytes: Uint8Array): Promise<Picture> {
  const out = `${await cacheFolder($)}/${nameOf(key)}`
  if (graphics === 'none') {
    await convert($, file, `${out}.bmp`, 'bmp', CELL_SOURCE_PIXELS)
    const pixels = parseBmp(await bytesOf($, `${out}.bmp`))
    loaded.set(key, { pixels: [pixels], delays: [0] })
    // The size the picture has, not the size it was shrunk to: it decides how many cells it takes.
    const size = pngSize(bytes)
    return { width: size?.width ?? pixels.width, height: size?.height ?? pixels.height, frames: 1 }
  }
  let png = file
  let pngBytes = bytes
  const size = pngSize(bytes)
  const side = graphics === 'bytes' ? VIEW_PIXELS : STILL_PIXELS
  if (!size || Math.max(size.width, size.height) > side || (graphics === 'bytes' && bytes.length > VIEW_BYTES)) {
    png = `${out}.png`
    await convert($, file, png, 'png', side)
    pngBytes = await bytesOf($, png)
  }
  const shown = pngSize(pngBytes)
  if (!shown) throw new Error('could not read it')
  if (graphics === 'bytes' && pngBytes.length > VIEW_BYTES) throw new Error('too large to send')
  loaded.set(key, { sources: [graphics === 'file' ? { file: png, format: 'png' } : { png: pngBytes.toBase64() }], delays: [0] })
  return { width: size?.width ?? shown.width, height: size?.height ?? shown.height, frames: 1 }
}

/**
 * Reads a picture once, from a file or from bytes the transcript holds (`ext` naming their kind);
 * the drawings that wait on it draw again.
 */
async function load ($: Engine, key: string, from: () => Promise<{ file: string } | { base64: string; ext: string } | undefined>) {
  if (loaded.has(key) || loading.has(key)) return
  loading.add(key)
  let picture: Picture
  try {
    const origin = await from()
    if (!origin) throw new Error('not found')
    let file: string
    if ('file' in origin) {
      file = origin.file
      if ((await $.fs.stat(file)).size > MAX_FILE_BYTES) throw new Error('larger than 32 MB')
    } else {
      file = `${await cacheFolder($)}/${nameOf(key)}.source.${origin.ext}`
      await writeBytes($, file, origin.base64)
    }
    const bytes = await bytesOf($, file)
    picture = isGif(bytes) ? await loadGif($, key, bytes) : await loadStill($, key, file, bytes)
  } catch (error) {
    picture = { error: error instanceof Error ? error.message : String(error) }
  } finally {
    loading.delete(key)
  }
  // Read in the background: a module unloaded meanwhile has no state to write to.
  await update($, pictures, all => ({ ...all, [key]: picture })).catch(() => undefined)
}

/**
 * The box of cells a picture takes: as large as the bounds allow, keeping its shape (a cell is about
 * twice as tall as it is wide), never much larger than the picture itself.
 */
function fitCells (width: number, height: number, maxColumns: number, maxRows: number) {
  let columns = Math.max(1, Math.min(maxColumns, Math.ceil(width / CELL_PIXELS)))
  let rows = Math.max(1, Math.round((columns * height) / width / 2))
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.min(columns, Math.round((rows * 2 * width) / height)))
  }
  return { columns, rows }
}

function cellsOf (key: string, frame: number, columns: number, rows: number) {
  const id = `${key}#${frame}:${columns}x${rows}`
  let painted = cells.get(id)
  if (painted === undefined) {
    painted = toCells(loaded.get(key)!.pixels![frame]!, columns, rows)
    cells.set(id, painted)
  }
  return painted
}

const playId = (requestId: string, element: string) => `${requestId}/${element}`

/** Shows the next frame, then waits its delay; ends where the picture is no longer drawn. */
async function step ($: Engine, id: string) {
  const play = playing.get(id)
  const frames = play && loaded.get(play.key)
  if (!play || !frames) return void playing.delete(id)
  play.frame = (play.frame + 1) % frames.delays.length
  const { requestId, element: key, columns, rows } = play
  const shown = frames.sources
    ? await $.ui.blit({ requestId, key, source: frames.sources[play.frame]!, columns, rows }).catch(() => ({ deny: 'gone' }))
    : await $.ui.blit({ requestId, key, cells: cellsOf(play.key, play.frame, columns, rows), columns, rows }).catch(() => ({ deny: 'gone' }))
  if (playing.get(id) !== play) return
  if (shown.deny) return void playing.delete(id)
  play.timer = $.clock.after(frames.delays[play.frame]!, () => void step($, id))
}

/** Plays an animation drawn at a site while it shows; one off screen stops, on the frame it was on. */
function play ($: Engine, requestId: string, element: string, key: string, columns: number, rows: number, isShown: boolean) {
  const id = playId(requestId, element)
  const now = playing.get(id)
  if (now && (!isShown || now.columns !== columns || now.rows !== rows)) {
    now.timer?.cancel()
    playing.delete(id)
  }
  if (!isShown || playing.has(id)) return now?.frame ?? 0
  const frames = loaded.get(key)!
  const started: Playing = { requestId, element, key, frame: now?.frame ?? 0, columns, rows }
  playing.set(id, started)
  started.timer = $.clock.after(frames.delays[started.frame]!, () => void step($, id))
  return started.frame
}

type Site = { ui: Ui; requestId: string; maxColumns: number; maxRows: number; isShown: boolean; animate: boolean }

// The options: the most rows a picture takes, and whether GIFs play.
let maxRows = 12
let animate = true

/** Where a row's pictures are drawn, and how large they may be. */
function siteOf ($: Engine, e: RenderOf<'ToolResult' | 'ToolGroup' | 'UserMessage' | 'AssistantMessage'>, indent: number): Site {
  return {
    ui: $.ui.resolve(e),
    requestId: e.requestId,
    maxColumns: Math.max(8, Math.min(MAX_COLUMNS, (e.viewport?.columns ?? 80) - indent - 2)),
    maxRows,
    // Off screen (`null`) an animation stops; a surface that does not say counts as on screen.
    isShown: e.props.onScreen !== null,
    animate
  }
}

/** One picture, as large as the site allows: the picture itself, or a dim line while it loads or where it cannot be read. */
function pictureOf ($: Engine, site: Site, all: Record<string, Picture>, key: string, label: string, slot = 'image'): RenderElement {
  const { ui: { Image, Raster, Text }, requestId } = site
  const picture = all[key]
  const frames = loaded.get(key)
  if (picture && 'error' in picture) return <Text key={key} dimColor>{`${label}: no preview, ${picture.error}`}</Text>
  if (!picture || !frames) return <Text key={key} dimColor>{`${label} loading…`}</Text>

  const { columns, rows } = fitCells(picture.width, picture.height, site.maxColumns, site.maxRows)
  const element = `${slot}:${nameOf(key)}`
  const isAnimated = frames.delays.length > 1 && site.animate
  const frame = isAnimated ? play($, requestId, element, key, columns, rows, site.isShown) : 0
  return frames.sources
    ? <Image key={element} source={frames.sources[frame]!} columns={columns} rows={rows} alt={label} />
    : <Raster key={element} columns={columns} rows={rows} cells={cellsOf(key, frame, columns, rows)} />
}

/** A text exactly `width` cells wide: cut with an ellipsis, or padded with spaces. */
const fill = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width))

// The narrowest a card is, so its caption reads.
const MIN_CARD_COLUMNS = 24

/**
 * A picture in a bordered card, its path under it. It floats over the answer, which shows through any
 * cell it leaves unwritten: every line is written to the card's width, spaces and all, and the card
 * is no wider than the picture (or its caption, up to a point).
 */
function cardOf ($: Engine, site: Site, all: Record<string, Picture>, key: string, caption: string): [RenderElement, number] {
  const { Box, Text } = site.ui
  const picture = all[key]
  const label = baseName(caption)
  const isShown = picture && !('error' in picture) && loaded.has(key)
  const columns = isShown ? fitCells(picture.width, picture.height, site.maxColumns, site.maxRows).columns : 0
  const rows = isShown ? fitCells(picture.width, picture.height, site.maxColumns, site.maxRows).rows : 0
  const width = Math.min(site.maxColumns, Math.max(columns, Math.min(caption.length, MIN_CARD_COLUMNS)))
  // A caption wider than the card names the file alone.
  const name = caption.length > width ? label : caption
  const side = (n: number) => n > 0 && <Text>{Array.from({ length: rows }, () => ' '.repeat(n)).join('\n')}</Text>
  const left = Math.floor((width - columns) / 2)
  // The border's two rows, the caption's, and the picture's (or the line saying why there is none).
  const height = 3 + (isShown ? rows : 1)
  return [(
    <Box key="frame" flexDirection="column" borderStyle="round" borderDimColor flexShrink={0} width={width + 2}>
      {!isShown
        ? <Text dimColor>{fill(picture && 'error' in picture ? `${label}: no preview, ${picture.error}` : `${label} loading…`, width)}</Text>
        : (
          <Box flexDirection="row">
            {side(left)}
            {pictureOf($, site, all, key, label, 'card')}
            {side(width - columns - left)}
          </Box>
          )}
      <Text dimColor>{fill(name, width)}</Text>
    </Box>
  ), height]
}

/** A row drawn as the engine draws it, the pictures under it. */
function withPictures (ui: Ui, drawn: RenderElement, indent: number, pictures: RenderElement[]) {
  const { Box } = ui
  return (
    <Box flexDirection="column">
      {drawn}
      <Box flexDirection="column" paddingLeft={indent} rowGap={0}>
        {pictures}
      </Box>
    </Box>
  )
}

type ReadImage = { type: 'image'; file: { base64: string; type: string } }

const isReadImage = (output: unknown): output is ReadImage =>
  typeof output === 'object' && output !== null && (output as { type?: unknown }).type === 'image' &&
  typeof (output as ReadImage).file?.base64 === 'string'

const filePathOf = (input: unknown) => {
  const path = (input as { file_path?: unknown } | null)?.file_path
  return typeof path === 'string' ? path : undefined
}

/** Reads the picture a Read call returned: the file it read where it is still there, else the bytes it returned. */
function loadRead ($: Engine, toolUseId: string, output: ReadImage) {
  const key = `read:${toolUseId}`
  void load($, key, async () => {
    const path = readPaths.get(toolUseId)
    if (path && (await $.fs.exists(path))) return { file: path }
    return { base64: output.file.base64, ext: output.file.type.replace('image/', '').replace('jpeg', 'jpg') }
  })
  return key
}

/** The image files under the working folder, as git knows them (tracked or not, less the ignored), once a session. */
function imageIndex ($: Engine, cwd: string) {
  index ??= $.process.run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.PNG', '*.JPG', '*.JPEG', '*.GIF', '*.WEBP'], { cwd })
    .then(result => (result.exitCode === 0 ? result.stdout.split('\0').filter(Boolean).map(path => `${cwd}/${path}`) : []))
    .catch(() => [])
  return index
}

/** The text an answer draws its pictures from: what it embeds (`![alt](path)`), apart from what it only names. */
const embeddedIn = (text: string) => [...text.matchAll(MARKDOWN_IMAGE)].map(match => match[2]!).filter(target => !/^[a-z]+:\/\//i.test(target.replace(/^file:\/\//, '')) && IMAGE_FILE.test(target))

/** A path as an answer wrote it, made absolute: from home, or from the working folder. */
function absolute (target: string, cwd: string, home: string | undefined) {
  let path = target.replace(/^file:\/\//, '')
  try {
    path = decodeURI(path)
  } catch {}
  if (path.startsWith('/')) return path
  if (path.startsWith('~/')) return home ? `${home}${path.slice(1)}` : undefined
  return `${cwd}/${path.replace(/^\.\//, '')}`
}

/**
 * The image files an answer names without embedding them, each once, in order: a path that is there,
 * else the file under the working folder whose path ends with the name (`leads-filtros.gif`).
 */
async function referencesIn ($: Engine, text: string, cwd: string) {
  const bare = text.replace(MARKDOWN_IMAGE, ' ').replace(WEB_LINK, match => (match.startsWith('file://') ? match : ' '))
  const named = [...new Set([...bare.matchAll(REFERENCE)].map(match => (match[1] ?? match[2] ?? match[3])!.trim()))].slice(0, MAX_REFERENCES)
  if (named.length === 0) return []
  const home = named.some(name => name.startsWith('~/')) ? await $.env.get('HOME') : undefined
  const found: string[] = []
  for (const name of named) {
    const path = absolute(name, cwd, home)
    if (path && (await $.fs.exists(path))) {
      found.push(path)
      continue
    }
    const tail = `/${name.replace(/^(\.\/|~\/|\/)+/, '')}`
    const match = (await imageIndex($, cwd)).filter(file => file.endsWith(tail)).sort((a, b) => a.length - b.length)[0]
    if (match) found.push(match)
  }
  return [...new Set(found)]
}

/** Opens a picture in the system's viewer. */
async function openFile ($: Engine, path: string) {
  const argv = isWindows ? ['explorer', path.replaceAll('/', '\\')] : [(await $.env.get('WSL_DISTRO_NAME')) ? 'xdg-open' : (await $.process.run(['uname', '-s'])).stdout.trim() === 'Darwin' ? 'open' : 'xdg-open', path]
  await $.process.run(argv).catch(() => undefined)
}

/** A block of an answer: a paragraph, a list item with what is indented under it, a fence, a table; and whether a blank line comes before it. */
type Block = { text: string; gap: boolean }

/** An answer cut into the blocks its markdown draws one under another, so each can carry its chips beside it. */
function blocksOf (text: string) {
  const blocks: Block[] = []
  let lines: string[] = []
  let gap = false
  let fence: string | undefined
  const flush = () => {
    if (lines.length > 0) blocks.push({ text: lines.join('\n'), gap })
    lines = []
    gap = false
  }
  for (const line of text.split('\n')) {
    if (fence) {
      lines.push(line)
      if (line.trimStart().startsWith(fence)) fence = undefined
      continue
    }
    const opens = /^\s*(```|~~~)/.exec(line)
    if (opens) fence = opens[1]
    else if (line.trim() === '') {
      flush()
      gap = blocks.length > 0
      continue
    } else if (/^ {0,3}([-*+]|\d+[.)])\s/.test(line) && lines.length > 0 && !/^\s*\|/.test(lines[0]!)) flush()
    lines.push(line)
  }
  flush()
  return blocks
}

export const register: Register = (on, options) => {
  maxRows = Math.max(3, Math.min(60, Math.round(Number(options.rows ?? 12))))
  animate = options.animate !== false
  const markdown = options.markdown !== false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const program = await $.env.get('TERM_PROGRAM')
    const term = await $.env.get('TERM')
    const isNative = program === 'ghostty' || term === 'xterm-ghostty' || term === 'xterm-kitty' || (await $.env.get('KITTY_WINDOW_ID')) !== undefined
    const isForced = /^(1|true|yes|on)$/i.test((await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) ?? '')
    graphics = isNative ? 'file' : isForced ? 'bytes' : 'none'
    // A reload starts with nothing read: what the state says was read is read again.
    sessionId = undefined
    await follow($)
    return result
  })

  // The row of a Read call names the file it read: its picture is read from there, at full size.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool === 'Read') {
      const path = filePathOf(e.props.input)
      if (path) readPaths.set(e.props.tool_use_id, path)
    }
    return next(e)
  })

  // A Read of a picture: the picture under its `⎿ Read image` line.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.tool !== 'Read' || e.props.isErrored || !isReadImage(e.props.output)) return next(e)
    await follow($)
    const key = loadRead($, e.props.tool_use_id, e.props.output)
    const site = siteOf($, e, RESULT_INDENT)
    const path = readPaths.get(e.props.tool_use_id)
    return withPictures(site.ui, await next(e), RESULT_INDENT, [pictureOf($, site, await read($, pictures), key, path ? baseName(path) : 'image')])
  })

  // A run of reads folded into one line: each picture read, named, under the line.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded) return next(e)
    const reads = e.props.calls.flatMap(call =>
      call.tool === 'Read' && call.tool_use_id && !call.isErrored && isReadImage(call.output) ? [{ id: call.tool_use_id, output: call.output, path: filePathOf(call.input) }] : [])
    if (reads.length === 0) return next(e)
    await follow($)
    const site = siteOf($, e, RESULT_INDENT)
    const all = await read($, pictures)
    const { Text } = site.ui
    const drawn: RenderElement[] = []
    for (const { id, output, path } of reads) {
      if (path) readPaths.set(id, path)
      const key = loadRead($, id, output)
      const label = path ? baseName(path) : 'image'
      if (reads.length > 1) drawn.push(<Text key={`label:${id}`} dimColor>{label}</Text>)
      drawn.push(pictureOf($, site, all, key, label))
    }
    return withPictures(site.ui, await next(e), RESULT_INDENT, drawn)
  })

  // A prompt you sent with pictures pasted in: the pictures under it, side by side.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.origin.kind !== 'composer') return next(e)
    const ids = idsIn(e.props.text)
    if (ids.length === 0) return next(e)
    await follow($)
    for (const id of ids) {
      void load($, `paste:${id}`, async () => {
        let file = await pastedFile($, id)
        for (let tries = 0; !file && tries < WAIT_TRIES; tries++) {
          await $.clock.sleep(WAIT_MS)
          file = await pastedFile($, id)
        }
        return file ? { file } : undefined
      })
    }
    const site = siteOf($, e, MESSAGE_INDENT)
    const all = await read($, pictures)
    const { Box } = site.ui
    // Side by side, each in its share of the width.
    const share = { ...site, maxColumns: Math.max(8, Math.floor((site.maxColumns - (ids.length - 1)) / ids.length)) }
    const shown = ids.filter(id => !('error' in (all[`paste:${id}`] ?? {})))
    if (shown.length === 0) return next(e)
    return withPictures(site.ui, await next(e), MESSAGE_INDENT, [
      <Box key="pasted" flexDirection="row" columnGap={1}>
        {shown.map(id => pictureOf($, share, all, `paste:${id}`, `[Image #${id}]`))}
      </Box>
    ])
  })

  // An answer with pictures. In fullscreen the mod draws it block by block: a picture it embeds
  // (`![alt](path)`) under the block that embeds it, and a chip beside the block for each picture it
  // only names; the pointer on a chip opens that picture in a card over the rows above, a click opens
  // it in the system's viewer. Elsewhere (no pointer) the engine draws it, the embedded pictures under it.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!markdown || e.surface !== 'terminal') return next(e)
    const text = e.props.text
    // A cheap look first: most answers name no picture at all.
    if (!/\.(png|jpe?g|gif|webp|bmp|tiff?|heic)\b/i.test(text)) return next(e)
    await follow($)
    const cwd = await $.session.cwd()
    const home = await $.env.get('HOME')
    const site = siteOf($, e, MESSAGE_INDENT)
    const all = await read($, pictures)
    const { Box, Client, Markdown, Text } = site.ui

    /** The embedded pictures of a text, drawn: none for a link to a file that is not there. */
    /** The pictures a text embeds, drawn (none for a link to a file that is not there), and the targets drawn. */
    const embeddedOf = (part: string, place: Site) => {
      const drawn: RenderElement[] = []
      const targets = new Set<string>()
      const seen = new Set<string>()
      for (const target of embeddedIn(part)) {
        const file = absolute(target, cwd, home)
        if (!file) continue
        const key = `file:${file}`
        void load($, key, async () => ((await $.fs.exists(file)) ? { file } : undefined))
        const picture = all[key]
        if (picture && 'error' in picture && picture.error === 'not found') continue
        targets.add(target)
        if (seen.has(file)) continue
        seen.add(file)
        drawn.push(pictureOf($, place, all, key, baseName(file)))
      }
      return { drawn, targets }
    }

    // Chips need the pointer, which the terminal reports in fullscreen alone.
    if (e.viewport?.isFullscreen === false) {
      const { drawn } = embeddedOf(text, site)
      return drawn.length === 0 ? next(e) : withPictures(site.ui, await next(e), MESSAGE_INDENT, drawn)
    }

    const blocks = blocksOf(text)
    const named: string[][] = []
    for (const block of blocks) {
      if (!references.has(block.text)) references.set(block.text, referencesIn($, block.text, cwd))
      const embedded = embeddedIn(block.text).flatMap(target => absolute(target, cwd, home) ?? [])
      named.push((await references.get(block.text)!).filter(file => !embedded.includes(file)))
    }
    const hasEmbedded = embeddedIn(text).length > 0
    if (!hasEmbedded && named.every(files => files.length === 0)) return next(e)

    const now = await read($, hovered)
    const onScreen = e.props.onScreen
    if (now?.requestId === e.requestId) {
      const where = JSON.stringify(onScreen ?? null)
      // The answer moved under a resting pointer: the chip is no longer under it.
      if (hoveredAt !== undefined && hoveredAt !== where) void update($, hovered, () => null).catch(() => undefined)
      else hoveredAt = where
    }
    const isHosting = now?.requestId === e.requestId && hoveredAt === JSON.stringify(onScreen ?? null)
    const chipWidth = Math.max(0, ...named.flat().map(file => baseName(file).length))
    const bodyColumns = Math.max(16, site.maxColumns - (chipWidth > 0 ? chipWidth + 2 : 0))
    const place = { ...site, maxColumns: bodyColumns }
    let index = 0
    let open: { file: string; block: number } | undefined
    const rows = blocks.map((block, i) => {
      const chips = named[i]!.map(file => {
        const chip = `ref:${index++}`
        chipFiles.set(`${e.requestId}/${chip}`, file)
        if (isHosting && chip === now!.element) open = { file, block: i }
        return { chip, file }
      })
      const { drawn: pictures, targets } = embeddedOf(block.text, place)
      // A picture drawn under the block is not written in it too, as its alt and path.
      const shown = block.text.replace(MARKDOWN_IMAGE, (match, alt, target) => (targets.has(target) ? '' : match)).trim()
      return (
        <Box key={`block-${i}`} flexDirection="column" marginTop={block.gap ? 1 : 0}>
          {shown.length > 0 && (
            <Box flexDirection="row" columnGap={2}>
              <Box flexDirection="column" width={chips.length > 0 ? bodyColumns : undefined} flexShrink={1}>
                <Markdown text={shown} />
              </Box>
              {chips.length > 0 && (
                <Box flexDirection="column" flexShrink={0}>
                  {chips.map(({ chip, file }) => <Client key={chip} module="./chip.tsx" props={{ label: baseName(file) }} />)}
                </Box>
              )}
            </Box>
          )}
          {pictures}
          <Box position="absolute" top={0} left={0} width={1} height="100%">
            <Client key={`probe:${i}`} module="./probe.tsx" width={1} height="100%" />
          </Box>
        </Box>
      )
    })
    // The card of the chip the pointer is on, drawn last so no block paints over it: over the rows
    // above its block where they hold it, else over those below, else over the most there are.
    let card: RenderElement | undefined
    const heights = blockRows.get(e.requestId) ?? []
    if (open && heights.length >= blocks.length && heights.slice(0, open.block + 1).every(rows => rows > 0)) {
      const tops: number[] = []
      let at = 0
      blocks.forEach((block, i) => {
        at += block.gap ? 1 : 0
        tops.push(at)
        at += heights[i]!
      })
      const top = tops[open.block]!
      const bottom = top + heights[open.block]!
      const first = onScreen?.first ?? 0
      const last = onScreen?.last ?? at - 1
      const viewportRows = e.viewport?.rows ?? 40
      // Above the answer on screen: what the screen holds over its rows, when its top shows.
      const outside = first === 0 ? Math.max(0, viewportRows - BOTTOM_ROWS - (last - first + 1)) : 0
      const aboveIn = top - first
      const below = last - bottom + 1
      const caption = open.file.startsWith(`${cwd}/`) ? open.file.slice(cwd.length + 1) : open.file
      const cardSite = (rows: number) => ({ ...site, maxColumns: Math.max(8, site.maxColumns - 2), maxRows: Math.max(1, rows - CARD_ROWS) })
      const key = `file:${open.file}`
      const wanted = cardOf($, cardSite(HOVER_ROWS + CARD_ROWS), all, key, caption)[1]
      const [space, isAbove] = aboveIn >= wanted ? [aboveIn, true]
        : below >= wanted ? [below, false]
        : aboveIn + outside >= wanted ? [aboveIn + outside, true]
        : aboveIn + outside >= below ? [aboveIn + outside, true] : [below, false]
      if (space >= MIN_CARD_ROWS) {
        const [drawn, height] = cardOf($, cardSite(Math.min(space, HOVER_ROWS + CARD_ROWS)), all, key, caption)
        card = <Box key="card" position="absolute" top={isAbove ? top - height : bottom} left={0}>{drawn}</Box>
      }
    }
    // The reply's first block opens with the engine's bullet; the text stands two columns in.
    return (
      <Box flexDirection="row">
        <Text>{e.props.isFirstOfReply ? '● ' : '  '}</Text>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {rows}
          {card}
        </Box>
      </Box>
    )
  })

  // A probe says how many rows its block was laid out in: where a card floats over an answer. A chip
  // says when the pointer comes onto it and when it leaves: its card opens and closes, the picture
  // read as it first opens. Clicked, the picture opens in the system's viewer.
  on('ui.message', async ($, e, next) => {
    const result = await next(e)
    const rows = (e.data as { rows?: unknown } | null)?.rows
    if (/^probe:\d+$/.test(e.element) && typeof rows === 'number') {
      const heights = blockRows.get(e.requestId) ?? []
      heights[Number(e.element.slice('probe:'.length))] = rows
      blockRows.set(e.requestId, heights)
      // A card open over this answer moves with the blocks.
      await update($, hovered, now => (now?.requestId === e.requestId ? { ...now } : now))
      return result
    }
    const path = /^ref:\d+$/.test(e.element) ? chipFiles.get(`${e.requestId}/${e.element}`) : undefined
    if (!path) return result
    const data = e.data as { isOver?: unknown; isClicked?: unknown } | null
    const isThis = (now: Hovered | null) => now?.requestId === e.requestId && now.element === e.element
    if (data?.isClicked === true) {
      void openFile($, path)
      await update($, hovered, () => null)
      return result
    }
    if (data?.isOver === true) {
      void load($, `file:${path}`, async () => ({ file: path }))
      if (!isThis(await read($, hovered))) {
        hoveredAt = undefined
        await update($, hovered, () => ({ requestId: e.requestId, element: e.element, path }))
      }
    } else await update($, hovered, now => (isThis(now) ? null : now))
    return result
  })
}
