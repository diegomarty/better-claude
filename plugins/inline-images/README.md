# Inline Images

A Claude Code mod: see pictures in the transcript, as the desktop app shows them. The images Claude reads, the ones you paste and the ones its answers embed are drawn under their rows; the ones an answer only names get a chip that shows the picture under the pointer; GIFs play.

```text
⏺ Read(screenshot.png)
  ⎿  Read image (151KB)
     ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀      ← the picture, under the row
     ▃▁▁▘▘▁▃▀▀▖▗▀▖▗▀▏▊▎▗▘▃▗▀▖▀▂▁▉▚▉▘▏▗▀▖▗▀▖▀▀
```

- **What Claude reads**: a `Read` of a PNG, JPEG, WebP or GIF shows the picture under its `⎿ Read image` line. A run of reads folded into one line (`Read 3 files`) shows each picture under it, named.
- **What you paste**: a prompt you sent with `[Image #N]` in it shows its pictures under it, side by side.
- **What Claude embeds**: an answer with `![alt](path)` to a picture on this machine shows it under the paragraph that embeds it. Links to the web, and to files that are not there, draw nothing.
- **What Claude names**: an answer that mentions a picture (`docs/media/leads.gif`, or just `leads.gif`) gets a chip beside the paragraph or list item that names it. Put the pointer on a chip and the picture opens in a card over the answer; move it off and the card closes; click it and the picture opens in the system's viewer. A name with no folder is looked for among the files under the working folder (`git ls-files`, ignored files left out); a name that matches no file gets no chip.

```text
  ╭──────────────────────────────╮
  │  (the picture)               │                ← the pointer on a chip
  │ docs/media/leads-filtros.gif │
  ╰──────────────────────────────╯
● 1. Imagen: leads-filtros.gif (2,6 MB)           leads-filtros.gif
  2. Imagen: intro-capitulo.gif (790 KB)          intro-capitulo.gif
```
- **GIFs play** while they show on screen, each frame for its own delay; scrolled away, they stop on the frame they were on.

## How it draws

In Ghostty and kitty the terminal draws the picture itself, through the kitty graphics protocol: it reads the PNG, or each frame of a GIF, from a file, so no picture crosses Claude Code. `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` sends the bytes to a terminal Claude Code does not know draws pictures (iTerm2 3.5 and later, under fullscreen rendering), shrunk to 1024 pixels and 2 MB. Elsewhere the picture is drawn in colored block elements, GIFs too: each cell sampled at eight by eight points, in linear light, in any terminal with true color. Cells are coarse: a screenshot of text shows its layout, not text you can read.

A picture takes as many cells as fit its shape, never much more than its own size, up to the **Picture height** option (`/config`, 12 rows by default) and 120 columns.

## Options

| Option | Default | |
| --- | --- | --- |
| Picture height | 12 | The most terminal rows a picture takes. |
| Play GIFs | on | Off, a GIF shows its first frame. |
| Pictures in answers | on | Show the local pictures an answer embeds, and a chip for each one it names. |

## Install

```text
/plugin marketplace add midudev/better-claude
/plugin install inline-images@better-claude
```

## Limits

- Images Claude reads are drawn from the file it read, at full quality, where it is still there; else from the bytes the model was sent, which are smaller.
- A GIF is decoded by the mod itself (no ffmpeg): up to 300 frames, each shrunk to 480 pixels, and all of them to 48 MB together; a longer one is shrunk further.
- Other formats are converted with `sips` on macOS and ImageMagick (`magick` or `convert`) elsewhere. Without them, a PNG still shows in Ghostty and kitty and a GIF everywhere; the rest say they need a converter.
- It reads pasted images from the folder Claude Code stores them in for the session (`<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>/…/images`), and keeps its own copies in `<that temp folder>/inline-images/<session id>`.
- tmux passes no pictures through: under it, the cells.
- The chips need the pointer, so Claude Code's fullscreen interface (`"tui": "fullscreen"` in your settings, or `/config`). The card opens over the rows above the chip's block, or below it where the rows above are too few, up to 24 for the picture.
- To put the chips beside their blocks, the mod draws such an answer itself, block by block, with the markdown renderer the engine draws replies with: an answer with no picture in it is the engine's as ever. Off fullscreen the engine draws it, the embedded pictures under it.
- Hovering the name inside the answer itself cannot open the card: the mod is not told where each word of an answer lands once it wraps, so the chips stand beside its block.
- Beside [Image Preview](../image-preview/README.md), the pasted pictures show under the prompt and hovering an `[Image #N]` is meant to still open its card; the two together have not been tried yet.

## How it works

One hooks module ([`hooks/register.tsx`](hooks/register.tsx)), a GIF decoder ([`hooks/gif.ts`](hooks/gif.ts)) and the cell painter ([`hooks/pixels.ts`](hooks/pixels.ts), shared with Image Preview):

- `ui.render` hooks on `ToolResult` and `ToolGroup` (Read calls whose output is an image), `UserMessage` (the `[Image #N]` of a sent prompt) and `AssistantMessage` (markdown images, and the pictures an answer names) draw the engine's row, then the pictures or chips under it.
- Each chip is a `Client` ([`hooks/chip.tsx`](hooks/chip.tsx), as in Image Preview) that posts when the pointer comes onto it, leaves it and clicks it; a `ui.message` hook keeps which chip has the pointer, and the answer draws the card last, `position: "absolute"`, over the rows above the chip's block (or below it, where the rows above are too few), so nothing moves under the pointer and no block paints over it. Where each block is comes from a probe in it ([`hooks/probe.tsx`](hooks/probe.tsx)), an unpainted `Client` as tall as its block, that says how many rows it was laid out in.
- Each picture is read once, in the background: a GIF is decoded into frames and each written to a raw RGBA file; another picture is drawn from its PNG, or a PNG `sips` or ImageMagick writes. The rows that wait on it draw again.
- A GIF is a keyed `Image` (or `Raster`, in cells); `$.ui.blit` swaps its frame after each delay, with no redraw. A row reported off screen stops its animation.

## Development

```bash
claude plugin validate ./plugins/inline-images   # from the repository root
claude plugin test ./plugins/inline-images       # runs hooks/register.test.tsx against the engine
```

MIT © Miguel Ángel Durán (midudev)
