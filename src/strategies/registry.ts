/**
 * The catalogue of detection strategies.
 *
 * Summary:
 *   The home page grid, the routing, and the strategy detail pages are all generated from this
 *   array. Adding a strategy means adding one entry - no new components, no new routes. Each
 *   entry's `id` is also the `strategyId` sent to the detection backend, so the card a user
 *   clicks and the program that eventually runs are bound by a single string.
 *
 *   The write-ups here are summaries. FUTURE_WORK.md carries the full design for each.
 */

/**
 * `ready` - usable now.
 * `planned` - designed in FUTURE_WORK.md, no implementation yet.
 */
export type StrategyStatus = 'ready' | 'planned'

export interface Strategy {
  /** Stable identifier, also the `strategyId` in the detection contract. */
  id: string
  name: string
  /** One line for the card face. */
  tagline: string
  /** A short paragraph for the detail page. */
  description: string
  /** The mechanism, in the order it runs. Rendered as a numbered list. */
  approach: string[]
  /** Honest assessment - what this buys and what it costs. */
  strengths: string[]
  risks: string[]
  /** Rough order-of-magnitude cost per sheet, for setting expectations. */
  cost: string
  status: StrategyStatus
  /** Route this card navigates to. */
  href: string
  /** Single glyph shown on the card. */
  glyph: string
}

export const STRATEGIES: Strategy[] = [
  {
    id: 'test-strategy',
    name: 'Test Strategy',
    tagline: 'Open a sheet, draw a box around one symbol.',
    description:
      'The exemplar picker. Load any document from the library, navigate and zoom to a symbol, ' +
      'and drag a bounding box around it. The selection is captured as a normalized rectangle plus ' +
      'a 300 DPI crop - the input every other strategy on this page consumes. No detection runs ' +
      'here; this is the harness the detection work will be driven from.',
    approach: [
      'Rasterize the requested page with pdf.js, painting only the visible region.',
      'Capture a left-drag as a rectangle in normalized page coordinates.',
      'Re-render that region offscreen at 300 DPI to produce a clean template.',
      'Hold the selection so it can be handed to a strategy, copied as JSON, or exported as PNG.',
    ],
    strengths: [
      'Resolution-independent: the selection survives zoom, resize, and page changes.',
      'The exported crop is identical no matter what zoom it was drawn at.',
    ],
    risks: ['Does not detect anything on its own - it only produces the query.'],
    cost: 'Interactive.',
    status: 'ready',
    href: '/test',
    glyph: '⌖',
  },
  {
    id: 'fft-ncc',
    name: 'FFT Cross-Correlation',
    tagline: 'Correlate the template across the sheet in the frequency domain.',
    description:
      'Normalized cross-correlation of the exemplar against the whole page, computed via FFT, ' +
      'swept over a small bank of rotations. Because these sheets are CAD exports, a given symbol ' +
      'is drawn at an identical scale everywhere on a sheet - which makes plain correlation far ' +
      'stronger here than its reputation in natural-image vision suggests. This is the baseline ' +
      'every other strategy has to beat.',
    approach: [
      'Rasterize the page at the exemplar DPI and convert both images to zero-mean grayscale.',
      'Compute normalized cross-correlation via FFT for each of 0/90/180/270 degrees.',
      'Take the per-pixel max across the rotation bank as the response map.',
      'Threshold, then apply non-maximum suppression at the template footprint.',
    ],
    strengths: [
      'No training, no model, no embedding index - a few hundred lines.',
      'Sub-second per sheet; exact when scale and rotation are quantized, which they are.',
    ],
    risks: [
      'Degrades once symbols overlap other geometry or carry differing interior text - measured, ' +
        'conduit drawn through a symbol costs it enough score to fall below the cutoff.',
      'The automatic cutoff is unreliable; move the slider rather than trusting the first number.',
    ],
    cost: '~1-2 s per sheet on CPU.',
    status: 'ready',
    href: '/strategy/fft-ncc',
    glyph: '∿',
  },
  {
    id: 'patch-rag',
    name: 'Patch Embedding Retrieval',
    tagline: 'Index the sheet as patch vectors, then search it like a document.',
    description:
      'Treat the sheet as a corpus: cut it into small overlapping patches, embed each one, and ' +
      'index them. The exemplar box becomes a query vector, and cosine similarity ranks candidate ' +
      'locations. The retrieval framing pays off once the index is reused across a whole multi-sheet ' +
      'set - build it once, then answer any number of exemplar queries against it.',
    approach: [
      'Cut the rasterized page into overlapping patches with a stride well under symbol size.',
      'Embed each patch - z-scored raw pixels through PCA to start, dense deep features later.',
      'Index the vectors with their page and pixel coordinates in an ANN index.',
      'Aggregate the exemplar footprint into a query vector, rank by cosine, then verify and suppress.',
    ],
    strengths: [
      'Amortizes across queries: one index answers every exemplar on the set.',
      'Swapping the embedding upgrades quality without touching the search machinery.',
    ],
    risks: [
      'A single small patch carries too little signal - scoring must span the symbol footprint.',
      'Encoding absolute position into the vectors defeats the translation invariance the search needs.',
    ],
    cost: 'Minutes to index a set; milliseconds per query.',
    status: 'planned',
    href: '/strategy/patch-rag',
    glyph: '⛶',
  },
  {
    id: 'signal-filter',
    name: 'Filtered Descriptor Match',
    tagline: 'Strip the drawing to its ink, then describe the shape.',
    description:
      'Most of a construction sheet is noise for this task: hatching, dimension strings, leader ' +
      'lines, background text. Binarize and morphologically filter until only the stroke geometry ' +
      'of interest survives, then describe candidate regions with compact rotation-tolerant shape ' +
      'descriptors and compare against the exemplar by cosine distance.',
    approach: [
      'Adaptive binarization, then morphological opening and closing tuned to the stroke width.',
      'Suppress long runs (walls, dimension lines) with directional morphology.',
      'Describe candidates with Hu or Zernike moments, ring projection, and Fourier-Mellin magnitude.',
      'Rank by cosine distance to the exemplar descriptor and verify geometrically.',
    ],
    strengths: [
      'Descriptors are tiny and rotation-tolerant by construction.',
      'The filtering stage is reusable by every other strategy as a preprocessing step.',
    ],
    risks: [
      'Morphology parameters are resolution-dependent and need retuning per sheet scale.',
      'Aggressive filtering can erase exactly the interior detail that separates two marker types.',
    ],
    cost: '~0.1-0.5 s per sheet on CPU.',
    status: 'planned',
    href: '/strategy/signal-filter',
    glyph: '⌇',
  },
  {
    id: 'connected-components',
    name: 'Connected-Component Match',
    tagline: 'Enumerate every ink blob, then compare only the plausible ones.',
    description:
      'A rasterized line drawing is almost binary, so connected-component labelling enumerates ' +
      'candidate glyphs directly. Filter components by bounding-box size and fill ratio against the ' +
      'exemplar, and the search space collapses from millions of pixel offsets to a few hundred ' +
      'objects - each of which can then be compared expensively without cost mattering.',
    approach: [
      'Binarize, then label connected components across the page.',
      'Merge components whose boxes overlap the exemplar footprint, joining broken strokes.',
      'Reject candidates outside the exemplar bounding-box and ink-density tolerance.',
      'Score survivors against the exemplar and report counts per class.',
    ],
    strengths: [
      'Fastest option by a wide margin, and its output is naturally deduplicated.',
      'Well matched to receptacles and detail markers, which are compact isolated glyphs.',
    ],
    risks: [
      'Symbols that touch walls or leader lines merge into one giant component.',
      'Poorly suited to doors, whose swing arc connects to the wall by design.',
    ],
    cost: '~50-200 ms per sheet.',
    status: 'planned',
    href: '/strategy/connected-components',
    glyph: '▦',
  },
  {
    id: 'keypoint-fingerprint',
    name: 'Keypoint Fingerprint',
    tagline: 'Fingerprint corners and junctions, then match constellations.',
    description:
      'The SLAM framing: describe the exemplar as a constellation of distinctive local points and ' +
      'find every place on the sheet where the same constellation reappears in the same geometric ' +
      'arrangement. On line art the standard blob detectors are weak, so the productive version ' +
      'builds the fingerprint from line-segment junctions rather than texture keypoints.',
    approach: [
      'Extract line segments with an LSD-style detector and derive junctions and endpoints.',
      'Encode each junction by its branch angles and the lengths of incident segments.',
      'Geometric-hash exemplar junction triples, then vote with the page junctions.',
      'Verify each vote cluster with RANSAC over a rigid transform.',
    ],
    strengths: [
      'Robust to partial occlusion and to symbols overlapping other geometry.',
      'Naturally recovers rotation, rather than sweeping a rotation bank.',
    ],
    risks: [
      'Symbols only 40-60 px across yield too few keypoints for a stable constellation.',
      'The most implementation-heavy option here, with the most parameters to tune.',
    ],
    cost: '~1-3 s per sheet.',
    status: 'planned',
    href: '/strategy/keypoint-fingerprint',
    glyph: '⌘',
  },
  {
    id: 'deep-patch',
    name: 'Deep Patch Features',
    tagline: 'Dense self-supervised features, matched by cosine similarity.',
    description:
      'The modern form of patch retrieval: replace hand-designed descriptors with dense patch ' +
      'embeddings from a self-supervised vision transformer such as DINOv2 or DINOv3. Run the page ' +
      'through the backbone once, average the exemplar patch tokens into a query, and cosine-match ' +
      'against every page token. No training and no labels - the backbone is used frozen.',
    approach: [
      'Tile the page and extract dense patch tokens from a frozen ViT backbone.',
      'Average and L2-normalize the tokens under the exemplar box into a query vector.',
      'Cosine-match the query against every page token to build a similarity heat map.',
      'Upsample the heat map, threshold, and suppress to recover boxes.',
    ],
    strengths: [
      'Tolerates clutter and partial overlap far better than raw-pixel correlation.',
      'Same code path serves every symbol class; nothing is per-class.',
    ],
    risks: [
      'Patch stride is coarse relative to a 50 px symbol, so localization needs refinement.',
      'Backbones are trained on natural images; sparse black-on-white line art is out of domain.',
    ],
    cost: '~1-4 s per sheet on GPU.',
    status: 'planned',
    href: '/strategy/deep-patch',
    glyph: '◈',
  },
]

/**
 * Look up a strategy by id.
 *
 * Parameters:
 *   id: the strategy identifier from the route.
 * Returns:
 *   The matching `Strategy`, or `undefined`.
 * Raises:
 *   Nothing.
 * Summary:
 *   Used by the strategy detail route to resolve `:id`.
 */
export function getStrategy(id: string | undefined): Strategy | undefined {
  return STRATEGIES.find((strategy) => strategy.id === id)
}
