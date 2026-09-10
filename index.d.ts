export interface RasterImage {
  width: number
  height: number
  /** row-major RGBA, width*height*4 bytes */
  data: Buffer
}

export interface PageFlags {
  /** the page has an image large enough to be content, not decoration */
  hasImage: boolean
  /** the page has an extractable text layer (false for a scanned page) */
  hasText: boolean
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
  render(page: number, opts?: { scale?: number }): RasterImage
  /** the page's embedded raster images, each rendered to RGBA */
  extractImages(page: number): RasterImage[]
  close(): void
}

export function open(pdf: Uint8Array, opts?: OpenOptions): Doc

/** One-shot: open, count, close. */
export function pageCount(pdf: Uint8Array, opts?: OpenOptions): number

/** One-shot: open, render one page, close. */
export function render(
  pdf: Uint8Array,
  page: number,
  opts?: { scale?: number; password?: string }
): RasterImage
