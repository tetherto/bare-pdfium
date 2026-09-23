export interface RasterImage {
  width: number
  height: number
  /** row-major RGBA, width*height*4 bytes */
  data: Uint8Array
}

export interface PageFlags {
  /** the page has an image large enough to be content, not decoration */
  hasImage: boolean
  /** the page has an extractable text layer (false for a scanned page) */
  hasText: boolean
}

export interface TextOptions {
  hyphens?: 'join' | 'keep' | 'raw'
  clip?: boolean
}

export interface RenderOptions {
  scale?: number
}

export type LoadErrorCode = 'FILE' | 'FORMAT' | 'PASSWORD' | 'SECURITY' | 'PAGE' | 'UNKNOWN'

export interface LoadError extends Error {
  code: LoadErrorCode
}

export interface OpenOptions {
  /** password for an encrypted PDF */
  password?: string
}

/** An open PDF. Parses the file once; reuse it for every page op, then close(). */
export class Doc {
  pageCount(): number
  /** page dimensions in PDF points (1/72"), without rendering */
  pageSize(page: number): { width: number; height: number }
  pageFlags(page: number): PageFlags
  /** rasterize one page to RGBA; `scale` maps points to pixels (1 = 72 DPI) */
  render(page: number, opts?: RenderOptions): RasterImage
  renderAsync(page: number, opts?: RenderOptions): Promise<RasterImage>
  /** the page's embedded raster images, each rendered to RGBA */
  extractImages(page: number): RasterImage[]
  /** the page's text layer as a string, empty when the page has none (a scan) */
  extractText(page: number, opts?: TextOptions): string
  extractTextAsync(page: number, opts?: TextOptions): Promise<string>
  /** every page's text, yielded one at a time so nothing accumulates */
  textPages(opts?: TextOptions): IterableIterator<{ page: number; text: string }>
  textPagesAsync(opts?: TextOptions): AsyncIterableIterator<{ page: number; text: string }>
  close(): void
}

export function open(pdf: Uint8Array, opts?: OpenOptions): Doc

/** Open a PDF by path; PDFium reads it from disk on demand instead of holding the whole file in memory. */
export function openFile(path: string, opts?: OpenOptions): Doc

/** One-shot: open, count, close. */
export function pageCount(pdf: Uint8Array, opts?: OpenOptions): number

/** One-shot: open, render one page, close. */
export function render(
  pdf: Uint8Array,
  page: number,
  opts?: RenderOptions & OpenOptions
): RasterImage

/** One-shot: open, stream every page's text, close when the iterator is done. */
export function textPages(
  pdf: Uint8Array,
  opts?: OpenOptions & TextOptions
): IterableIterator<{ page: number; text: string }>
