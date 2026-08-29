# Future work: one-shot symbol detection on rasterized construction drawings

This repository contains the frontend, the document library, and the interfaces. It contains **no
detection code**. This document is the design for that work.

The goal, from the brief:

> Create a one-shot algorithm that detects any quantity on this drawing (doors, detail markers,
> elevation markers, electrical receptacles). Use a rasterized version of the drawing, not the vector.

The user draws one box around one symbol. The system returns every other instance of that symbol,
and a count.

---

## 1. The number that decides everything: these are CAD exports

Before choosing an algorithm, look at what the input actually is. The seed set
(`data/skanska-drawing-set.pdf`, 28 sheets at 2592x1728 pt = 36x24 in) is a vector CAD export, not a
scan. Every symbol on it is a **block instance**: the same geometry, placed repeatedly by the
drafting software.

Rasterize that at a fixed DPI and the consequences are large:

| Property | Scanned drawing | This drawing set |
|---|---|---|
| Instances of a symbol on one sheet | Vary in size, skew, ink weight | **Pixel-identical**, up to rotation and mirroring |
| Scale variation within a sheet | Continuous | **None** - one drawing scale per viewport |
| Rotation | Continuous | Usually 0/90/180/270; arbitrary only on angled walls |
| Noise | Paper texture, JPEG artifacts | Anti-aliasing only |

**This is a near-duplicate patch retrieval problem, not a general object detection problem.** That
single observation is worth more than any model choice. It means simple, exact, explainable methods
are genuinely competitive here - and it means anything that throws away pixel-exactness in the name
of invariance is discarding the strongest signal available.

The corollary: **scale invariance matters between sheets, not within one.** A door on a 1/8" = 1'-0"
floor plan and the same door on a 1-1/2" = 1'-0" detail differ by 12x. Within one viewport they do not
differ at all.

### Working resolution

Everything downstream depends on one locked-down number. At 300 DPI a 36x24 sheet is
**10800 x 7200 px (78 MP)**. Symbol sizes at that resolution:

| Symbol | Approx. size @ 300 DPI | Notes |
|---|---|---|
| Electrical receptacle | 40-70 px | Compact, usually isolated, often rotated to face a wall |
| Detail marker | 90-140 px | Circle + dividing line + sheet/detail numbers inside |
| Elevation marker | 90-140 px | Circle + filled triangle pointer; **easily confused with the above** |
| Door | 80-250 px | Leaf + swing arc; connects to the wall by design; frequently mirrored |

78 MP is too large for a single FFT or a single network forward pass, so every strategy below runs
tiled. 150 DPI (19.6 MP) is a reasonable search resolution with a 300 DPI refinement pass, and is
worth benchmarking as the default.

---

## 2. The interface, fixed now

`src/api/detect.ts` already defines this, and `runStrategy()` is the only call site. Implementing a
strategy means satisfying this contract and nothing else.

```
POST /api/detect
{
  "strategyId": "fft-ncc",
  "fileName":   "skanska-drawing-set.pdf",
  "page":       4,                                    // 1-based
  "bbox":       { "x0": 0.3989, "y0": 0.0747,         // normalized to the page,
                  "x1": 0.4330, "y1": 0.1242 },       //   origin top-left
  "dpi":        300,
  "scope":      "page"                                // or "document"
}

200
{
  "strategyId":    "fft-ncc",
  "matches":       [ { "page": 4, "bbox": {...}, "score": 0.94, "rotationDeg": 90 }, ... ],
  "count":         37,
  "elapsedMs":     820,
  "thresholdUsed": 0.71
}
```

Two deliberate choices:

- **No pixels cross the wire.** The request carries a normalized box and a DPI, not a cropped PNG.
  The backend re-rasterizes the exemplar from the same source file, which guarantees the template and
  the search page come out of an identical rendering pipeline. A re-encoded browser crop would
  introduce a resampling difference between query and target - small, but this problem lives on
  near-exact matching.
- **Normalized coordinates throughout.** The frontend never stores a pixel rectangle
  (`src/lib/geometry.ts` is the only place they exist, and only for the duration of a paint), so the
  backend is free to work at any DPI and the results come back overlayable at any zoom.

---

## 3. Strategy 1 - patch embedding retrieval

*The RAG framing: index the sheet as vectors, then search it.*

### The idea

Cut the rasterized page into patches, embed each one, index them, and treat the exemplar box as a
query. Cosine similarity ranks candidate locations. The appeal is real: build the index once over a
whole 28-sheet set and every subsequent exemplar query is a millisecond lookup rather than a fresh
scan.

### Where the naive version breaks, and how to fix it

**A 10x10 patch is far too small to be discriminative.** At 300 DPI, 10 px is 0.033 inches - about
one stroke width. Nearly every inked patch on the sheet contains roughly "a short black line
fragment", so nearly every patch is cosine-similar to every other. The top-1000 results would be
noise.

The fix is to score over the **symbol's footprint**, not a single cell:

1. Keep small cells if you like them (they localize well), but form the query as the *ordered set* of
   cells under the exemplar box - a 60x60 px receptacle is a 6x6 grid of cells.
2. Score a candidate location by summing the per-cell similarities at the correct relative offsets.

It is worth being explicit about what that computation is: **summing per-cell similarity over a fixed
relative offset pattern is cross-correlation in embedding space.** Strategy 1, done correctly,
converges on Strategy 4a with a learned feature space instead of raw pixels. That is not an argument
against it - it is the reason it will work - but it does mean you should build 4a first and treat the
embedding as an upgrade to the feature space rather than a different system.

The alternative is simply to use patches sized to the symbol (64x64 or 128x128) with a stride of
8-16 px, and skip the aggregation. Simpler, and the index is far smaller.

### Embeddings, cheapest first

| Embedding | Dim | Notes |
|---|---|---|
| Raw pixels, per-patch z-scored | 4096 (64x64) | Z-scoring absorbs anti-aliasing and line-weight differences. Start here. |
| PCA over the above | 64-128 | Fit on a sample of inked patches. Retains ~95% variance, 30x smaller index. |
| HOG | 324 | Explicitly encodes stroke orientation; robust to 1-2 px placement jitter. |
| Dense ViT tokens | 384 | See Strategy 4c. The real upgrade, at real cost. |

### Index

Use hnswlib (in-process, no server) or FAISS IVF-PQ. Sizing matters: at 300 DPI with a 16 px stride,
one sheet is ~300k patch positions and the 28-sheet set is ~8.5M vectors.

**Prune by ink first.** A construction sheet is 90-97% white. Discarding patches whose ink density is
below a floor (or whose variance is zero) removes the overwhelming majority of positions before they
ever reach the index, and none of them could have been a symbol.

### On RoPE and positional encoding

The brief asks whether to embed position, possibly with RoPE. The short answer is **not into the
vectors you search over**, and the reason is worth stating precisely.

The entire premise of this search is that the same symbol at the top-left of the sheet and at the
bottom-right must produce the *same* vector. That is translation invariance, and it is the property
doing all the work. Adding absolute position to the embedding destroys it by construction: two
identical receptacles would land far apart in the space, exactly the failure you are trying to avoid.

RoPE is not an absolute-position scheme, though - it encodes *relative* position between tokens
inside an attention operation. There is a coherent design where it belongs: run a small transformer
over the patch-token grid *within a candidate window*, with RoPE supplying the relative geometry
between cells, and use the window-level output as the vector you index. Then RoPE is describing "the
arc is down-and-right of the leaf" - internal structure - and the window embedding remains
translation-invariant on the sheet. That is a genuinely reasonable architecture, and it is also a
significant amount of machinery to build before you have a baseline.

Either way: **position belongs in the index payload, not the similarity vector.** You need it - for
non-maximum suppression, for neighbourhood aggregation, for reporting boxes - but as metadata
attached to the vector, never as dimensions inside it.

---

## 4. Strategy 2 - signal processing

*Strip the drawing to the information that matters, then describe the shape.*

### The idea

Most of a sheet is irrelevant to any given query: hatching, dimension strings, leader lines, keynotes,
title block, background text. Filter until only the stroke geometry of interest survives, then
describe candidate regions with compact descriptors and compare against the exemplar.

### Preprocessing pipeline

1. **Binarize.** Render grayscale, then Otsu globally or Sauvola locally. Invert so ink = 1. On a
   vector render this is nearly lossless - the only grey is anti-aliasing.
2. **Remove long linear structures.** Morphological opening with a long horizontal structuring
   element isolates horizontal walls, dimension lines and grid lines; the same with a vertical
   element. Subtract both from the mask. This is the table-line-removal trick from document analysis,
   and it is the single most valuable preprocessing step here - it *detaches symbols from the walls
   they touch*, which is what makes Strategy 4b viable.
3. **Suppress text.** Connected components whose height falls in the annotation range and whose
   stroke statistics look like type. Optional, and be careful: detail markers contain text you need.
4. **Band-pass to stroke width.** A top-hat transform with a disk structuring element of the stroke
   radius, or a difference-of-Gaussians tuned to it, isolates line work at the symbol's scale.

Every parameter above is in pixels and therefore **resolution-dependent**. Derive them from the DPI
and the exemplar's measured stroke width rather than hard-coding them; otherwise the pipeline silently
degrades the moment someone renders at 150 DPI.

### Descriptors

Once regions are isolated, compare them with descriptors that are rotation-tolerant by construction:

| Descriptor | Dim | Invariance | Notes |
|---|---|---|---|
| Hu moments | 7 | Rotation, scale, translation | Cheap, but too coarse to separate similar markers |
| **Zernike moments** (to order 8) | 25 | Rotation (magnitudes), translation | The right default for compact symbols |
| Ring projection | 32-64 | Rotation | Radial ink histogram; excellent for circular markers |
| Fourier-Mellin magnitude | 128+ | Rotation **and** scale | Use when comparing across sheets at different drawing scales |

Compare with cosine distance. These are small enough that an exhaustive comparison against every
candidate region is free.

### The fast path in the same family

Matched filtering is signal processing too, and it is the strongest member of this family. See
Strategy 4a - it belongs here conceptually and is broken out only because it deserves to be built
first.

---

## 5. Strategy 3 - keypoint fingerprint (the SLAM framing)

*Describe the region by its distinctive points and their arrangement, then find that arrangement again.*

This is loop closure: build a fingerprint of a place, then recognize the place elsewhere. The
structure is right - local descriptors plus geometric verification is exactly how you get robustness
to occlusion, which matters because symbols on these sheets overlap walls, hatching and text.

### Why the off-the-shelf version underperforms here

Point out the mismatch honestly before building it. SIFT, ORB and AKAZE detect blobs and corners from
intensity gradients across a scale space. A 50 px symbol drawn with 2 px strokes on white gives you:

- **Too few keypoints.** Often 3-8 per symbol, which is below what RANSAC needs to be reliable.
- **Non-distinctive descriptors.** A gradient histogram around a line-drawing corner looks like every
  other line-drawing corner on the sheet. Line art is exactly the regime where these descriptors are
  weakest.

### The version that fits the domain

Replace the texture keypoint with a **structural** one:

1. Extract line segments with LSD or EDLines (or a Hough transform, which also directly gives you
   circles - see below).
2. Build a junction graph: segment endpoints, T-junctions, X-junctions, arc centres and arc endpoints.
3. Describe each junction by its **branch angles and incident segment lengths**, ordered
   rotation-covariantly (sort by angle, store angle differences). This is genuinely distinctive on
   line art in a way SIFT is not.
4. **Geometric hashing.** For each ordered triple of junctions in the exemplar, compute a
   similarity-invariant hash and store it. Scan the sheet's junction triples, look up, and vote.
5. Verify each vote cluster with RANSAC over a rigid transform, allowing reflection (doors are
   mirrored constantly).

Also worth knowing: **shape context** descriptors on sampled contour points, and the classical symbol
spotting literature that solved much of this before deep learning (Rusiñol & Lladós; the survey in
§10).

**A domain shortcut**: detail and elevation markers are circles. A Hough circle transform finds every
circle of the exemplar's radius on the sheet in one pass, and reduces the problem to classifying a few
hundred crops. Do not be too proud to use it.

---

## 6. Strategy 4 - additional approaches

### 4a. FFT normalized cross-correlation - build this first

The baseline everything else must beat, and on this input it may well be the answer.

1. Rasterize page and exemplar at the same DPI; convert to zero-mean grayscale.
2. Compute normalized cross-correlation via FFT - correlation as a frequency-domain product, with
   local mean and variance maps from integral images to do the normalization.
3. Sweep a **rotation bank**: 0/90/180/270 are exact array operations with no interpolation, plus
   horizontal mirror. Add a few small angles (±5°, ±10°) only if doors on angled walls demand it.
4. Take the per-pixel max across the bank as the response map, threshold, and run NMS.

Tile the page at ~2048x2048 with an overlap of at least the template size. On CPU this lands around
0.2-1 s per sheet.

**The refinement that makes it work on markers.** Detail markers and elevation markers are the same
circle with *different numbers inside*. Plain NCC will score them against each other on the circle and
be confused by the digits. The fix is **masked correlation**: build a weight mask over the template
that zeroes the interior text region and keeps only the circle, the dividing line and the pointer, and
run masked FFT correlation (Padfield's formulation, §10). This is precisely the tool for this problem
and is the highest-value single technique in this document after the oracle in 4e.

**Honest limits.** NCC degrades when a symbol overlaps other linework, and it has no notion of
partial matches. It is a floor, not a ceiling.

### 4b. Connected-component shape matching - the cheapest thing that works

On binary line art, connected-component labelling enumerates candidate glyphs directly, collapsing the
search space from millions of pixel offsets to a few hundred objects.

1. Binarize; **remove long linear structures first** (§4, step 2) so symbols detach from walls.
2. Label with 8-connectivity; merge components whose boxes overlap, to rejoin broken strokes.
3. Reject anything outside the exemplar's bounding-box dimensions (±15%), ink pixel count (±25%), or
   hole count (Euler number).
4. Score the survivors with NCC or Zernike moments - at a few hundred candidates, cost is irrelevant.

~50-200 ms per sheet, and the output is naturally deduplicated. Excellent for receptacles and markers.
**Poorly suited to doors**, whose swing arc is drawn attached to the wall and will not separate.

### 4c. Deep dense patch features (DINOv2 / DINOv3)

The modern form of Strategy 1: a frozen self-supervised ViT supplies the patch embeddings.

1. Tile the page; extract dense patch tokens from a frozen backbone.
2. Average and L2-normalize the tokens under the exemplar box into a query vector.
3. Cosine-match against every page token for a similarity heat map; upsample, threshold, suppress.

**Get the resolution arithmetic right, because it is the thing that kills this approach.** A ViT-S/14
at 518x518 produces 37x37 tokens, each covering 14 input pixels. A 50 px receptacle spans about 3.5
tokens - far too coarse to localize, and its query vector is an average of three or four tokens that
each straddle the symbol boundary. The fix is to **resample so symbols are 100-200 px** at the
backbone's input, which means running the backbone on upscaled crops rather than on the sheet at its
native scale.

The other honest caveat: these backbones are trained on natural photographs. Sparse black-on-white
line art is out of domain, and the features are correspondingly less discriminative than the benchmark
numbers suggest. Two mitigations, in order of effort: use it as a **re-ranker** over NCC candidates
rather than as a first-stage detector, or continue self-supervised pretraining on the drawing corpus.

### 4d. Learned template matching and one-shot detectors

Worth knowing about, worth deferring:

- **QATM** - a differentiable quality-aware matching layer over CNN features, trainable end to end.
  The learned analogue of 4a.
- **OS2D** - one-stage one-shot detection by dense correlation of learned features plus a feed-forward
  geometric alignment, trained so that train and test classes do not overlap. The closest published
  formulation to this exact task.
- **Tiled YOLO / DETR per symbol class** - once labels exist (see 4e), a supervised detector on tiles
  will outperform everything above. "One-shot at inference" and "trained on other symbol classes" are
  not in conflict.

### 4e. The vector layer as a labelling oracle - do this early

The brief requires the *detector* to work on raster. It says nothing about where the *evaluation data*
comes from.

The source PDF is vector. Its symbols are CAD block instances, which appear in the content stream as
repeated Form XObjects or repeated operator sequences. Extract them with PyMuPDF or pdfplumber and you
get, for free and across all 28 sheets:

- a near-perfect ground-truth box for **every instance of every symbol**,
- with no annotation effort,
- on the exact document the raster method is being evaluated against.

Use it to:

1. **Measure** precision and recall of the raster method automatically, on the full set, on every
   commit.
2. **Calibrate** the score threshold per symbol class instead of guessing.
3. **Generate training data** for 4d, turning a no-label problem into a supervised one.

Validate the oracle itself against a small hand-checked sample first - block extraction has its own
failure modes (exploded blocks, symbols drawn as raw geometry). But the leverage here is larger than
any algorithmic choice in this document.

---

## 7. The shared verification layer

Every strategy above produces a score map or a candidate list. None of them produces a *count*. This
layer is common to all of them and should be written once.

**Thresholding.** Do not hard-code a similarity cutoff; it will not transfer between symbol classes or
sheets. Because instances are near-duplicates, the sorted score list usually has a visible cliff
between true instances and background. Find the knee - the largest relative drop in the top-K sorted
scores - report the count there, and expose a slider around it. The user re-counting by dragging a
threshold is a *feature*, not an admission of failure.

**Non-maximum suppression.** Greedy, suppressing within roughly half the template diagonal. Correlation
peaks are broad; without this a single symbol reports as a dozen matches.

**Rotation deduplication.** A 4-fold symmetric symbol fires at all four rotations in the same place.
Deduplicate across the bank before counting, keeping the highest-scoring orientation.

**Reporting.** Return boxes in normalized page coordinates so the frontend can overlay them in the
same space the exemplar was drawn in.

---

## 8. Evaluation

Track two metrics, because they fail differently:

- **Precision / recall / F1 at IoU 0.5** - the detection quality.
- **Count error per sheet per class**, `|predicted - actual| / actual` - the thing the user actually
  wants. A method at 92% precision and 92% recall can post near-zero count error because the errors
  cancel. That is luck, and reporting only the count would hide it. Report both.

Evaluate on the full 28-sheet set using the §4e oracle, plus a small hand-labelled set used only to
validate the oracle.

---

## 9. Recommended sequencing

| Milestone | Work | Why here |
|---|---|---|
| 0 | Rasterizer service; `/api/detect` returns fixed boxes | Proves the contract end to end before any CV exists |
| 1 | **FFT-NCC + rotation bank + masked correlation + NMS** | The baseline. Likely solves markers and receptacles outright |
| 2 | Connected-component pre-filter | Cuts per-sheet cost by an order of magnitude |
| 3 | **Vector-layer oracle + evaluation harness** | Stop guessing whether changes help |
| 4 | Doors: arc detection, mirroring, cross-scale matching | The hardest class; needs 1-3 in place first |
| 5 | Deep features or a learned detector | Only if 1-4 plateau below the accuracy bar |

Strategies 1 and 3 are deliberately *not* on the critical path. Both are sound, and both are more
machinery than the problem needs until a simpler method has been shown to fail.

---

## 10. Per-symbol notes

| Symbol | Easiest strategy | The specific difficulty |
|---|---|---|
| **Electrical receptacle** | 4b then 4a | Rotated to face its wall, so the rotation bank matters; may touch the wall line |
| **Detail marker** | 4a with masked correlation | Interior text differs per instance - mask it out or every marker matches every other |
| **Elevation marker** | 4a with masked correlation | Same circle as the detail marker; the *pointer* is the discriminating feature, so keep it unmasked and weight it |
| **Door** | 3 or 4d | Attached to the wall (defeats 4b), mirrored (needs reflection in the bank), and drawn at different scales across sheets |

---

## 11. References

- Rezvanifar, Cote & Albu, *Symbol Spotting on Digital Architectural Floor Plans Using a Deep
  Learning-Based Framework*, CVPRW 2020 -
  [PDF](https://openaccess.thecvf.com/content_CVPRW_2020/papers/w34/Rezvanifar_Symbol_Spotting_on_Digital_Architectural_Floor_Plans_Using_a_Deep_CVPRW_2020_paper.pdf)
- *Symbol spotting for architectural drawings: state-of-the-art and new industry-driven developments*,
  IPSJ TCVA 2019 - [Springer](https://link.springer.com/article/10.1186/s41074-019-0055-1)
- *Few-Shot Symbol Detection in Engineering Drawings*, Applied Artificial Intelligence 2024 -
  [Taylor & Francis](https://www.tandfonline.com/doi/full/10.1080/08839514.2024.2406712)
- Osokin et al., *OS2D: One-Stage One-Shot Object Detection by Matching Anchor Features*, ECCV 2020 -
  [arXiv:2003.06800](https://arxiv.org/abs/2003.06800)
- Padfield, *Masked Object Registration in the Fourier Domain*, IEEE TIP 2012 - the masked NCC
  formulation used in §4a
- DINOv3 reference implementation - [facebookresearch/dinov3](https://github.com/facebookresearch/dinov3)
