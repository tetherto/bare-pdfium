export interface RasterImage {
  width: number
  height: number
  /** row-major RGBA, width*height*4 bytes */
  data: Uint8Array
}

export interface Bounds {
  /** PDF points from the bottom-left corner of the page */
  x: number
  y: number
  width: number
  height: number
}

export interface ExtractedImage extends RasterImage {
  /** where the image sits on the page */
  bounds: Bounds
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
  /** render only this part of the page, in points from the bottom-left corner of the page as displayed */
  clip?: Bounds
}

export interface AsyncRenderOptions extends RenderOptions {
  /** an AbortSignal (from bare-abort-controller or any WHATWG implementation) that cancels the render */
  signal?: {
    readonly aborted: boolean
    readonly reason?: unknown
    addEventListener(type: 'abort', listener: () => void): void
    removeEventListener?(type: 'abort', listener: () => void): void
  }
}

export type LoadErrorCode = 'FILE' | 'FORMAT' | 'PASSWORD' | 'SECURITY' | 'PAGE' | 'UNKNOWN'

export interface LoadError extends Error {
  code: LoadErrorCode
}

export interface PageOptions {
  pages?: number[]
}

export interface ImportOptions extends PageOptions {
  at?: number
}

export interface WatermarkOptions extends PageOptions {
  size?: number
  angle?: number
  color?: [number, number, number]
  opacity?: number
  position?: 'over' | 'under'
  font?: Uint8Array | null
}

export type Color = [number, number, number]

export type DrawItem =
  | {
      type: 'text'
      text: string
      font: number
      size?: number
      x: number
      y: number
      color?: Color
      opacity?: number
    }
  | {
      type: 'rect'
      x: number
      y: number
      width: number
      height: number
      fill?: Color
      stroke?: Color
      lineWidth?: number
      opacity?: number
    }
  | {
      type: 'line'
      x1: number
      y1: number
      x2: number
      y2: number
      color?: Color
      lineWidth?: number
    }
  | { type: 'image'; image: Uint8Array; x: number; y: number; width: number; height: number }

export interface AddPageOptions {
  width?: number
  height?: number
  at?: number
}

export type Run = string | { text: string; bold?: boolean; italic?: boolean; code?: boolean }

export type Inline = string | Run[]

export interface ListItem {
  text: Inline
  items?: Array<Inline | ListItem>
  ordered?: boolean
}

export type Block =
  | { type: 'heading'; level?: 1 | 2 | 3 | 4 | 5 | 6; text: Inline }
  | { type: 'paragraph'; text: Inline; align?: 'left' | 'center' }
  | { type: 'list'; items: Array<Inline | ListItem>; ordered?: boolean; start?: number }
  | { type: 'table'; header?: Inline[]; rows: Inline[][] }
  | { type: 'image'; data: Uint8Array; width?: number; caption?: Inline }
  | { type: 'code'; text: string }
  | { type: 'quote'; text: Inline }
  | { type: 'rule' }
  | { type: 'pageBreak' }

export type FontSource =
  | 'Helvetica'
  | 'Times'
  | 'Courier'
  | Uint8Array
  | { regular: Uint8Array; bold?: Uint8Array; italic?: Uint8Array; boldItalic?: Uint8Array }

export interface ComposeOptions {
  pageSize?: 'A4' | 'A5' | 'Letter' | 'Legal' | [number, number]
  landscape?: boolean
  margin?: number
  font?: FontSource
  monoFont?: FontSource
  fontSize?: number
  lineHeight?: number
  pageNumbers?: boolean
  encrypt?: EncryptOptions
}

export interface Permissions {
  print?: boolean
  modify?: boolean
  copy?: boolean
  annotate?: boolean
  fillForms?: boolean
  assemble?: boolean
  printHighQuality?: boolean
}

export interface EncryptOptions {
  password: string
  ownerPassword?: string
  permissions?: Permissions
}

export interface SaveOptions {
  removeSecurity?: boolean
  encrypt?: EncryptOptions
}

export type FieldType =
  'text' | 'checkbox' | 'radio' | 'combobox' | 'listbox' | 'button' | 'signature' | 'unknown'

export interface Field {
  name: string
  type: FieldType
  value: string | boolean | string[] | null
  page: number
  readOnly: boolean
  required: boolean
  options?: string[]
  editable?: boolean
  multiSelect?: boolean
  /** each widget of the field: its page and where it sits on it */
  widgets: Array<Bounds & { page: number }>
}

export interface Metadata {
  title: string | null
  author: string | null
  subject: string | null
  keywords: string | null
  creator: string | null
  producer: string | null
  /** raw PDF date string, such as D:20240131120000Z */
  creationDate: string | null
  modDate: string | null
}

export interface OutlineItem {
  title: string
  /** the page the bookmark opens, or null when it points elsewhere */
  page: number | null
  children: OutlineItem[]
}

export interface Link extends Bounds {
  /** set for a link to a web address */
  uri: string | null
  /** set for a link to a page of this document */
  page: number | null
}

export interface TextMatch {
  /** position of the match in the page's text layer, as extractText with hyphens: 'raw' counts it */
  index: number
  length: number
  /** one rectangle per line the match spans */
  rects: Bounds[]
}

export interface TextSpan extends Bounds {
  text: string
}

export interface FindOptions {
  matchCase?: boolean
  wholeWord?: boolean
}

export type FieldValues = Record<string, string | number | boolean | string[]>

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
  renderAsync(page: number, opts?: AsyncRenderOptions): Promise<RasterImage>
  /** the page's embedded raster images, each rendered to RGBA, with where each sits on the page */
  extractImages(page: number): ExtractedImage[]
  /** the page's text layer as a string, empty when the page has none (a scan) */
  extractText(page: number, opts?: TextOptions): string
  extractTextAsync(page: number, opts?: TextOptions): Promise<string>
  /** every page's text, yielded one at a time so nothing accumulates */
  textPages(opts?: TextOptions): IterableIterator<{ page: number; text: string }>
  textPagesAsync(opts?: TextOptions): AsyncIterableIterator<{ page: number; text: string }>
  importPages(source: Doc, opts?: ImportOptions): void
  importPagesAsync(source: Doc, opts?: ImportOptions): Promise<void>
  rotate(degrees: number, opts?: PageOptions): void
  rotateAsync(degrees: number, opts?: PageOptions): Promise<void>
  watermark(text: string, opts?: WatermarkOptions): void
  watermarkAsync(text: string, opts?: WatermarkOptions): Promise<void>
  fields(): Field[]
  fieldsAsync(): Promise<Field[]>
  fillFields(values: FieldValues): Field[]
  fillFieldsAsync(values: FieldValues): Promise<Field[]>
  /** remove pages; a page listed twice is removed once */
  deletePages(pages: number[]): void
  deletePagesAsync(pages: number[]): Promise<void>
  /** move the listed pages, in that order, so the first one lands at index `to` */
  movePages(pages: number[], to: number): void
  movePagesAsync(pages: number[], to: number): Promise<void>
  /** draw annotations and form widgets into the page content and remove them */
  flatten(opts?: PageOptions): void
  flattenAsync(opts?: PageOptions): Promise<void>
  metadata(): Metadata
  outline(): OutlineItem[]
  /** the page's label, such as 'iv' or 'A-3', or null when the document has none */
  pageLabel(page: number): string | null
  links(page: number): Link[]
  findText(page: number, query: string, opts?: FindOptions): TextMatch[]
  /** each run of text PDFium lays out on the page, with its rectangle */
  textSpans(page: number): TextSpan[]
  addPage(opts?: AddPageOptions): number
  loadFont(font: string | Uint8Array): number
  measureText(text: string, font: number, size: number): number
  fontMetrics(font: number, size: number): { ascent: number; descent: number }
  draw(page: number, items: DrawItem[]): void
  drawAsync(page: number, items: DrawItem[]): Promise<void>
  save(opts?: SaveOptions): Uint8Array
  saveAsync(opts?: SaveOptions): Promise<Uint8Array>
  close(): void
}

export function create(): Doc

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

export function merge(pdfs: Uint8Array[]): Uint8Array

export function extractPages(pdf: Uint8Array, pages: number[], opts?: OpenOptions): Uint8Array

export function rotate(
  pdf: Uint8Array,
  degrees: number,
  opts?: OpenOptions & PageOptions
): Uint8Array

export function decrypt(pdf: Uint8Array, password: string): Uint8Array

export function encrypt(
  pdf: Uint8Array,
  password: string,
  opts?: Omit<EncryptOptions, 'password'>
): Uint8Array

export function watermark(
  pdf: Uint8Array,
  text: string,
  opts?: OpenOptions & WatermarkOptions
): Uint8Array

export function fields(pdf: Uint8Array, opts?: OpenOptions): Field[]

export function fillFields(pdf: Uint8Array, values: FieldValues, opts?: OpenOptions): Uint8Array

export function mergeAsync(pdfs: Uint8Array[]): Promise<Uint8Array>

export function extractPagesAsync(
  pdf: Uint8Array,
  pages: number[],
  opts?: OpenOptions
): Promise<Uint8Array>

export function rotateAsync(
  pdf: Uint8Array,
  degrees: number,
  opts?: OpenOptions & PageOptions
): Promise<Uint8Array>

export function decryptAsync(pdf: Uint8Array, password: string): Promise<Uint8Array>

export function encryptAsync(
  pdf: Uint8Array,
  password: string,
  opts?: Omit<EncryptOptions, 'password'>
): Promise<Uint8Array>

export function watermarkAsync(
  pdf: Uint8Array,
  text: string,
  opts?: OpenOptions & WatermarkOptions
): Promise<Uint8Array>

export function fieldsAsync(pdf: Uint8Array, opts?: OpenOptions): Promise<Field[]>

export function fillFieldsAsync(
  pdf: Uint8Array,
  values: FieldValues,
  opts?: OpenOptions
): Promise<Uint8Array>

export function compose(content: string | Block[], opts?: ComposeOptions): Uint8Array

export function composeAsync(content: string | Block[], opts?: ComposeOptions): Promise<Uint8Array>
