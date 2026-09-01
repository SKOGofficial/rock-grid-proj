/**
 * Shared vocabulary for the whole app.
 *
 * Summary:
 *   Two ideas here matter more than the rest. `NormRect` is the only rectangle type that ever
 *   crosses a module boundary, and `Selection` is the exact object handed to the detection
 *   backend. Everything else is bookkeeping.
 */

/** How a library file is rasterized: multi-page PDF, or a single-page bitmap. */
export type FileKind = 'pdf' | 'image'

/** One document in the `data/` library, as reported by `GET /api/library`. */
export interface LibraryFile {
  name: string
  /** Server path the bytes can be fetched from, e.g. `/data/skanska-drawing-set.pdf`. */
  url: string
  ext: string
  kind: FileKind
  sizeBytes: number
  /** ISO-8601 mtime. */
  modifiedAt: string
}

/**
 * A rectangle in normalized page coordinates: 0..1 of the page's intrinsic width and height,
 * origin top-left.
 *
 * This is the app's universal rectangle. Screen pixels are derived from it for painting and
 * thrown away immediately; nothing is ever stored in pixels. That is what lets a box survive
 * zooming, resizing, and leaving and re-entering a page - and it is what lets the detection
 * backend re-rasterize the same region at whatever DPI it wants.
 */
export interface NormRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Intrinsic page size: PDF points for `pdf` sources, pixels for `image` sources. */
export interface PageSize {
  width: number
  height: number
}

/**
 * The exemplar the user drew: one region of one page of one document, plus a rendered crop of it.
 *
 * This is the input to every detection strategy. `rect` says *where*, `thumbnailDataUrl` is the
 * *what* - a crop rendered at `cropDpi` rather than scraped off the screen, so the template is
 * the same quality no matter what zoom level the user happened to be at when they drew it.
 */
export interface Selection {
  fileName: string
  /** 1-based. */
  page: number
  rect: NormRect
  /** Intrinsic size of the page the rect is relative to. */
  pageSize: PageSize
  /** PNG data URL of the region, rendered at `cropDpi`. */
  thumbnailDataUrl: string
  cropDpi: number
  /** Pixel dimensions of the rendered crop. */
  cropSize: PageSize
  /** ISO-8601. */
  createdAt: string
}

/* ------------------------------------------------------------------------------------------ *
 * Detection contract
 *
 * Implemented for `fft-ncc` by the service in `cv/`. Every other strategy answers 501, which is
 * what `NotImplementedError` in `src/api/detect.ts` exists to be thrown on.
 * ------------------------------------------------------------------------------------------ */

/**
 * Strategy knobs. Every field is optional and the service supplies a default.
 *
 * Typed rather than a loose record because the service rejects unknown keys outright - a typo
 * here should be a compile error, not a 422 discovered at runtime.
 */
export interface DetectOptions {
  /** Explicit score cutoff. Omit to have one derived from the score distribution. */
  threshold?: number
  /** Absolute minimum score for a candidate to be reported at all. */
  floor?: number
  /** Overlap above which two boxes are treated as the same detection. */
  iouThreshold?: number
  /** Angles to search, in degrees. Must be multiples of 90. */
  rotations?: number[]
  /** Also search a horizontally flipped copy of each rotation. */
  mirror?: boolean
  /** Hard ceiling on returned candidates. */
  maxMatches?: number
  /** Include a correlation response map in the reply. Off by default; it is not free. */
  includeHeatmap?: boolean
}

/** What the frontend sends to run a strategy. */
export interface DetectRequest {
  strategyId: string
  fileName: string
  /** 1-based page the exemplar came from. Detection runs on this page unless `scope` widens it. */
  page: number
  /** The exemplar region, in normalized page coordinates. */
  bbox: NormRect
  /**
   * Resolution to **search** at.
   *
   * Not the exemplar's crop DPI, which is a different and much higher number chosen to make a
   * legible thumbnail. Sending 300 here would have the service rasterize 78 MP rather than 19.4,
   * for detail that symbol matching does not use. See `SEARCH_DPI` in `src/api/detect.ts`.
   */
  dpi: number
  /** Which pages to search. `page` is the default; `document` is not implemented and answers 501. */
  scope?: 'page' | 'document'
  options?: DetectOptions
}

/** One detected instance. */
export interface DetectMatch {
  bbox: NormRect
  /** 1-based page the match is on. */
  page: number
  /** Similarity in 0..1, comparable only within a single response. */
  score: number
  /** Rotation of the match relative to the exemplar, if the strategy searched rotations. */
  rotationDeg?: number
}

/** What a strategy returns. */
export interface DetectResponse {
  strategyId: string
  /**
   * Every candidate scoring at or above `floorUsed`, best first.
   *
   * Deliberately longer than `count`: this carries the candidates on *both* sides of the cutoff.
   * The cutoff is the least reliable number the service produces - on a measured sheet the derived
   * one returned 21 where the answer was 24 - so shipping only the survivors would hand the UI a
   * number it could not interrogate. Filtering client-side instead makes a threshold slider
   * instant, with no second request and no re-correlation.
   */
  matches: DetectMatch[]
  /** How many of `matches` score at or above `thresholdUsed`. This is the answer. */
  count: number
  elapsedMs: number
  /** The cutoff applied, whether supplied by the caller or derived. */
  thresholdUsed: number
  /** The floor `matches` was collected down to, and therefore a slider's lower bound. */
  floorUsed: number
  /** True when `maxMatches` truncated the list, so `count` is a floor rather than a total. */
  truncated: boolean
  pageWidth: number
  pageHeight: number
  /** DPI actually rendered at, which may be below the DPI requested for a very large sheet. */
  dpi: number
  /**
   * Correlation response map as a grayscale PNG data URL, when `includeHeatmap` was set.
   *
   * Page-sized and centre-aligned, so it overlays the stage at the origin with no offset. Sent
   * grayscale rather than colour-mapped so the UI can redraw a threshold contour as a slider
   * moves, without asking for a new one.
   */
  heatmapPng?: string
}
