# Detection service

The computer-vision half of One-Shot Takeoff. One endpoint, one implemented strategy.

The frontend runs separately (`npm run dev`) and Vite proxies `/api/detect` here. **Both processes
have to be running** or the Find matches button reports the service as unreachable.

## Setup

```bash
python -m venv cv/.venv
cv/.venv/Scripts/python -m pip install -r cv/requirements.txt
```

On macOS and Linux the interpreter is at `cv/.venv/bin/python`. Python 3.12 — 3.14 is avoided
because OpenCV and numpy wheel coverage for it is not yet dependable.

## Run

```bash
npm run cv
```

From the project root, in its own terminal. That wrapper picks the right interpreter path per
platform and tells you plainly if the venv is missing. The equivalent by hand:

```bash
cv/.venv/Scripts/python -m uvicorn cv.app.main:app --host 127.0.0.1 --port 8000
```

**Localhost on purpose.** The service reads files from a directory and has no authentication, so on
`0.0.0.0` it would serve a document library to everything on the network. Override that only where
something else provides the boundary — a container, for instance.

`DATA_DIR` overrides the document library location; it defaults to `data/` at the project root.

## Tests

```bash
cv/.venv/Scripts/python -m cv.tests.test_postprocess
```

```bash
cv/.venv/Scripts/python -m cv.tests.test_fft_ncc
```

No pytest needed, though it would collect them. Read the caveat in the root README before trusting
a green run — they were written alongside the code they check.

## The endpoint

```
POST /api/detect
{
  "strategyId": "fft-ncc",
  "fileName":   "skanska-drawing-set.pdf",
  "page":       26,
  "bbox":       { "x0": 0.1317, "y0": 0.2374, "x1": 0.1407, "y1": 0.2447 },
  "dpi":        150,
  "options":    { "threshold": 0.7, "includeHeatmap": false }
}
```

`matches` comes back holding **every** candidate down to `floorUsed`, not only those above
`thresholdUsed` — so `matches.length` is deliberately larger than `count`. That is what lets the UI
move a threshold slider and re-count without another request. `count` is the answer at the cutoff
actually applied.

| Status | Means |
|---|---|
| 400 | The selection is unusable, or the page does not exist |
| 404 | The document cannot be resolved inside the library. Traversal and absent both answer this, so probing cannot enumerate what is outside |
| 422 | Malformed request. Unknown option keys are rejected by name rather than ignored |
| 501 | The strategy or the scope has no implementation |

## How it fits together

| File | Does |
|---|---|
| `app/raster.py` | PDF page → grayscale array, cached on the file's identity and mtime |
| `app/fft_ncc.py` | Slices the template from that same array, correlates it across a rotation and reflection bank |
| `app/postprocess.py` | Suppresses duplicates, picks a cutoff. No images — shared by every future strategy |
| `app/main.py` | Validation, path safety, the wire contract |

Two decisions worth knowing before changing anything:

**The template is a slice of the page being searched**, not a separately rendered image. Normalized
cross-correlation is not scale-invariant, so a template rasterized even slightly differently loses
score on every candidate. Slicing makes that class of bug impossible — and it is why the request
carries a normalized box rather than the browser's crop.

**The template rotates, not the page.** `np.rot90` at 90-degree multiples is a lossless reindexing,
and every peak comes back already in page coordinates with no inverse transform to get wrong.

## What it does not do yet

- **The automatic cutoff is unreliable.** On grid bubbles it returns 75 where the answer is 8. Move
  the slider. FUTURE_WORK §7 has the measurements and what would replace it.

  The other half of that charge has been withdrawn. Sheet E4 returning 21 where the answer is 24
  was blamed on the cutoff for a long time; it was not the cutoff. The three missing instances are
  mirrored, and a rotation-only bank could not score them — at the *same* derived cutoff of 0.700,
  searching reflections returns 24, with three new positions and none lost.
- **Mirroring is on by default.** Reflections are searched alongside all four rotations (all eight
  orientations of the square), and `DetectMatch.mirrored` says which ones were found that way. Turn
  it off in the results panel for symbols carrying text or digits, where a reflected hit is a false
  positive rather than an instance.
- **No masked correlation.** OpenCV accepts a mask only for `TM_SQDIFF` and `TM_CCORR_NORMED`, not
  the `TM_CCOEFF_NORMED` used here. This is what would separate detail markers from elevation
  markers, and stop conduit drawn through a symbol from costing it score.
- **PDF only.** Bitmap library files are listed by the frontend but cannot be searched.
- **One page per request.** `scope: "document"` answers 501.
- **No authentication, no rate limiting, no health endpoint.**
