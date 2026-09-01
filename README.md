# One-Shot Takeoff

Draw a box around a single symbol on a construction drawing; find every other instance of it.

One strategy is implemented end to end: **FFT cross-correlation**, in [cv/](cv/README.md). The other
five are designed in **[FUTURE_WORK.md](FUTURE_WORK.md)** and plug in behind the same function.

The target quantities are doors, detail markers, elevation markers and electrical receptacles, taken
off a rasterized version of the drawing rather than its vector geometry.

## Run it

Two processes, in two terminals. The frontend alone will start and browse drawings; detection needs
the service as well.

```bash
npm install
npm run dev
```

```bash
npm run cv
```

Then open <http://localhost:5173>. The second command needs a Python virtualenv first - see
[cv/README.md](cv/README.md). Without it running, everything works except Find matches, which says
so plainly rather than failing obscurely.

## What is here

**The home page** is a grid of square tiles, one per detection strategy, generated from
`src/strategies/registry.ts`. Adding a strategy is one entry in that array.

**Test Strategy** (`/test`) is the exemplar picker, and the reason the rest of the plumbing exists:

- Open any document from the library; PDFs and bitmaps behave identically.
- Zoom (buttons, ctrl/⌘ + wheel at the cursor, fit-page, fit-width, 1:1), page through the set, pan
  by dragging in Pan mode, holding space, or middle-dragging.
- **Left-drag to draw a bounding box** around a symbol. The box stays locked to the drawing at any
  zoom, and comes back when you leave the page and return.
- The **exemplar chip** in the corner shows the captured region as the detector would receive it - a
  300 DPI re-render, not a screen grab - with Copy JSON and Save PNG.
- **Find matches** runs the detector. Results appear as green boxes, with near misses dashed, and a
  slider moves the cutoff and re-counts instantly - no second request. Optionally the correlation
  response map overlays the drawing, so a symbol that produced *no* signal looks different from one
  that scored just under the line.

> [!NOTE]
> **The automatic cutoff is not trustworthy yet.** On grid bubbles it returns 75 where the answer
> is 8. That is why the slider exists and why the reply carries candidates on both sides of the
> line. FUTURE_WORK §7 has the measurements.
>
> The seed-set "21 where the answer is 24" that used to sit beside it has been struck: those three
> instances were mirrored, and the orientation bank searched rotations only. Searching reflections
> returns 24 at the same derived cutoff.

## The database is a directory

`data/` is the document store. A file is in the library when it is in that folder. See
[data/README.md](data/README.md).

`plugins/dataLibrary.ts` is a Vite plugin - not a separate backend - exposing two routes:

| Route | Purpose |
|---|---|
| `GET /api/library` | Live `readdir` of `data/`. Drop a file in, hit Refresh, it is there. |
| `GET /data/<name>` | The bytes, with HTTP `Range` support so pdf.js streams the 21 MB seed set instead of downloading it up front. |

Those two routes are the whole contract between the UI and storage. Replacing them with a real
service is a `server.proxy` entry and no changes under `src/`.

## Two design decisions worth knowing

**Selections are stored in normalized page coordinates**, never pixels - `{x0, y0, x1, y1}` in 0..1 of
the page's intrinsic size. That is what lets a box survive zooming, resizing and page changes, and it
is what lets the detection backend re-rasterize the same region at whatever DPI it wants.
`src/lib/geometry.ts` is the only module that produces pixel rectangles, and they live for one paint.

**The viewer rasterizes only the visible region**, not the whole page. At 800% zoom a full-page canvas
for a 36x24 inch sheet would be 24,000 px wide; the visible region is never much larger than the
window. Renders go to an offscreen canvas and are swapped in on completion, superseded renders are
cancelled, and renders are serialized per page - pdf.js will not run two `render()` calls against the
same page proxy at once, and the second one never resolves if you try.

## Layout

```
data/                    the document library (contents gitignored)
plugins/dataLibrary.ts   /api/library and /data/* as Vite middleware
src/
  api/detect.ts          runStrategy() - the single seam for all detection work
  api/library.ts         the library client
  lib/source.ts          RenderSource: paint any region of any page at any scale
  lib/pdf.ts             pdf.js implementation
  lib/raster.ts          bitmap implementation
  lib/geometry.ts        normalized <-> pixel conversions
  lib/crop.ts            300 DPI exemplar rendering
  components/            viewer, toolbar, selection overlay, chip, file list
  pages/                 home, strategy detail, test workspace
  strategies/registry.ts the strategy catalogue - add a tile by adding an entry
cv/                      the detection service (Python) - see cv/README.md
```

## Adding a strategy

1. Add an entry to `src/strategies/registry.ts`. The tile, the route and the detail page follow.
2. Add it to `IMPLEMENTED_STRATEGIES` in `cv/app/main.py` and dispatch to your matcher.

There is no step 3, and no UI to write. `runStrategy()` in `src/api/detect.ts` is already the single
call site; unimplemented ids answer 501 and surface as `NotImplementedError`.

## Tests

The detection service has checks under `cv/tests/`. They need no pytest — plain asserts and a
runner that reports every case by name rather than stopping at the first failure:

```bash
cv/.venv/Scripts/python -m cv.tests.test_postprocess
```

They are pytest-collectable too, if pytest is ever added.

> [!IMPORTANT]
> **These tests have not been independently reviewed.** They were written alongside the code they
> check, by the same author, in the same sitting — so a misunderstanding baked into the
> implementation is very likely baked into its test as well. A green run currently proves the code
> matches its author's intent, not that the intent was right.
>
> Before relying on them, go through **each case individually** and decide for yourself whether
> the expected answer is actually correct. Several encode real judgement calls rather than
> obvious facts, and those are the ones to argue with first:
>
> - `test_diagonal_offset_both_survive` — asserts two boxes overlapping ~15% are two symbols.
>   Is 0.3 the right IoU cutoff on real drawings, or does it split single detections?
> - `test_threshold_keeps_uniformly_high_scores` — the virtual-floor behaviour. Correct for a
>   sheet full of one symbol; check what it does when a sheet has *no* instances.
> - `test_finalize_dense_sheet_survives_the_knee_cap` — 600 instances at one score is a friendly
>   distribution. A real dense sheet has a spread, and the knee may land somewhere less obliging.
> - `test_stacked_elongated_boxes_both_survive` — the numbers are a plausible door, not a
>   measured one. Worth re-deriving from an actual door on a real sheet.
>
> Cases exercising empty input and truncation are mechanical and need less scrutiny.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev server with the library routes on `:5173` |
| `npm run build` | Typecheck, then production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run preview` | Serve the production build, library routes included |
| `npm run cv` | Detection service on `:8000` (needs the venv - see [cv/README.md](cv/README.md)) |
| `python -m cv.tests.test_postprocess` | Detection-service checks (see the caveat above) |
