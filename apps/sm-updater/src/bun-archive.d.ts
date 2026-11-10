// Типы Bun.Archive API (Bun 1.3.6+)
// @types/bun@1.3.8 ещё не включает эти типы

declare module 'bun' {
  type ArchiveInput =
    | Record<string, string | Blob | ArrayBufferView | ArrayBufferLike>
    | Blob
    | ArrayBufferView
    | ArrayBufferLike

  type ArchiveOptions = {
    compress?: 'gzip'
    level?: number
  }

  interface ArchiveExtractOptions {
    glob?: string | readonly string[]
  }

  class Archive {
    constructor(data: ArchiveInput, options?: ArchiveOptions)
    extract(path: string, options?: ArchiveExtractOptions): Promise<number>
    blob(): Promise<Blob>
    bytes(): Promise<Uint8Array<ArrayBuffer>>
    files(glob?: string | readonly string[]): Promise<Map<string, File>>
  }
}
