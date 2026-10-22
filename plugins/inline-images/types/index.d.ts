/** A picture as the mod read it: its size in pixels and how many frames it has, or why it has none. */
export type Picture = { width: number; height: number; frames: number } | { error: string }

/** The chip the pointer is on: the answer it is under, by `requestId`, its key, and the picture it names. */
export type Hovered = { requestId: string; element: string; path: string }

declare module 'claude-code' {
  interface PluginState {
    'inline-images': {
      /** Each picture read so far, by its key: `read:<tool_use_id>`, `paste:<N>` or `file:<path>`. */
      pictures: Record<string, Picture>
      /** The chip under an answer the pointer is on, whose picture shows in a card; null while none is. */
      hovered: Hovered | null
    }
  }
}
