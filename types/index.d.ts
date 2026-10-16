// image-studio's session state: what the chat draws under each image tool call.

/** One saved image as the chat shows it. */
export type ShownImage = {
  /** The saved image, absolute. */
  path: string
  /** Its format as saved (png, jpg, webp, gif). */
  format: string
  /** The saved image's own size, when known. */
  width?: number
  height?: number
  /** A small JPEG copy the desktop app draws, absolute. */
  previewPath?: string
  /** The preview's size in pixels (its long side at most 512). */
  previewWidth?: number
  previewHeight?: number
}

/** What one generate_image or edit_image call saved, keyed by its tool_use_id. */
export type ShownCall = { images: ShownImage[] }

/** An image call still running, keyed by its tool_use_id: what its placeholder draws. */
export type RunningCall = {
  /** Whole seconds since the call started; the placeholder's timer. */
  seconds: number
  /** generate or edit, for the placeholder's words. */
  mode: 'generate' | 'edit'
  /** The shape asked for (square, landscape, ...), for the placeholder's shape. */
  aspect: string
}

declare module 'claude-code' {
  interface PluginState {
    'image-studio': { shown: StateFamily<ShownCall | null>; running: StateFamily<RunningCall | null> }
  }
}
