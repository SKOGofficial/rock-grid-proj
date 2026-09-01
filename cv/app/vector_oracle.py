"""
The vector layer as a labelling oracle - ground-truth boxes with no annotation effort.

Summary:
    FUTURE_WORK.md S4e proposed reading ground-truth symbol boxes for free by enumerating repeated
    Form XObjects in the source PDF's content stream. Measured against skanska-drawing-set.pdf,
    that premise fails outright: page 4 has four XObjects, all images, and its two `Do`
    invocations account for a raster image drawn twice, not a symbol. Every stroke and glyph that
    draws a receptacle, marker or door is inlined directly into the content stream - see the
    "Measured, and the premise fails outright" note under S4e for how this was confirmed.

    What survives is the geometry itself. pdfminer.six's layout analysis resolves every
    stroked/filled primitive and text glyph to a bounding box in final page space, with the full
    `cm`/`q`/`Q` transform stack already applied - regardless of whether that primitive came from a
    block insert or was drawn inline. Clustering those primitives by spatial adjacency is
    connected-component labelling performed on exact vector geometry instead of a rasterized,
    threshold-dependent bitmap: the vector counterpart of Strategy 4b, and more precise than its
    raster form because there is no binarization step to get wrong.
"""

from __future__ import annotations

from typing import Sequence

from pdfminer.high_level import extract_pages
from pdfminer.layout import LAParams, LTChar, LTCurve, LTLine, LTPage, LTRect

from .fft_ncc import NormRect

#: Layout primitives treated as "ink" for clustering. Deliberately excludes LTFigure/LTImage: the
#: seed set's only images are non-symbol raster content (see module docstring), and including a
#: page-spanning image here would merge every symbol on the sheet into one component.
_INK_TYPES = (LTCurve, LTLine, LTRect, LTChar)

#: Longest normalized edge a single primitive may have before it is dropped as a long linear
#: structure - a wall, a dimension line, a grid line - rather than part of a symbol.
#:
#: FUTURE_WORK.md S4 step 2 achieves this on a raster with morphological opening, tuned to the
#: measured stroke width. Exact vector extents make that machinery unnecessary here: a plain length
#: cap on each primitive is the same filter with no resolution-dependent kernel to tune. 0.05 is 5%
#: of a sheet's long edge - about 1.8 inches on the 36-inch seed sheets - comfortably above the
#: largest symbol in scope (a door, up to ~1 inch) and comfortably below the shortest wall run.
DEFAULT_MAX_PRIMITIVE_EXTENT = 0.05

#: Default gap for `cluster_primitives` - see that function for what the value controls.
#:
#: 0.005 was the first value tried here, reasoned from symbol scale rather than measured, and it
#: was wrong by a wide margin: against the real E4 floor-device exemplar (page 26, true count 24,
#: the same exemplar documented in `cv/README.md`'s example request) it recovered only 6 of 24
#: instances. The cause was not what it looked like at first glance - not conduit or wall lines
#: bleeding into a symbol's cluster, but **adjacent floor devices touching each other**: this sheet
#: places them only about 0.0047 apart edge to edge, well inside a 0.005 gap, so neighbouring
#: instances were being merged pairwise into one oversized cluster (the merged sizes measured at
#: 2.2-2.4x the exemplar's width, consistent with exactly two symbols fused). Sweeping `gap` down
#: against that same exemplar: 0.0007 recovers 15, a stable plateau of 21 holds across
#: 0.0002-0.0004, and 0.0001 spikes to 25 - a single value above the true count, more likely one
#: spurious match than a better fit. 0.0003 sits in the middle of that plateau.
DEFAULT_GAP = 0.0003

#: Fixed cell size for the spatial hash in `cluster_primitives`, deliberately independent of
#: `gap` - see that function's docstring for why the two must not be tied together. Sized
#: comfortably above a single glyph or short stroke and comfortably below a symbol's own
#: footprint, so most primitives land in one or two cells rather than being fragmented across
#: dozens, regardless of what `gap` the caller passes.
_GRID_CELL = 0.01


def extract_primitives(
    path: str,
    page: int,
    *,
    max_extent: float = DEFAULT_MAX_PRIMITIVE_EXTENT,
) -> list[NormRect]:
    """
    Every stroked, filled, or glyph primitive on a page, as a normalized box.

    Parameters:
        path: path to the source PDF.
        page: 1-based page number, matching the detection API's convention.
        max_extent: primitives wider or taller than this fraction of the page are dropped - see
            `DEFAULT_MAX_PRIMITIVE_EXTENT`.
    Returns:
        One `NormRect` per surviving primitive, unordered and un-clustered.
    Raises:
        Nothing beyond what pdfminer raises for an unreadable file or an out-of-range page.
    Summary:
        pdfminer's coordinate origin is bottom-left; every other box in this service has the origin
        top-left (see `NormRect`), so the vertical axis is flipped here and nowhere else.
    """
    pages = extract_pages(path, page_numbers=[page - 1], laparams=LAParams())
    root: LTPage = next(iter(pages))

    boxes: list[NormRect] = []

    def walk(item: object) -> None:
        if isinstance(item, _INK_TYPES):
            x0, y0, x1, y1 = item.bbox
            rect = NormRect(
                x0=x0 / root.width,
                y0=1.0 - y1 / root.height,
                x1=x1 / root.width,
                y1=1.0 - y0 / root.height,
            )
            if rect.x1 - rect.x0 <= max_extent and rect.y1 - rect.y0 <= max_extent:
                boxes.append(rect)
        for child in getattr(item, "_objs", ()):
            walk(child)

    walk(root)
    return boxes


def cluster_primitives(boxes: Sequence[NormRect], *, gap: float = DEFAULT_GAP) -> list[NormRect]:
    """
    Merge primitives into connected components by spatial adjacency.

    Parameters:
        boxes: primitives from `extract_primitives`, in any order.
        gap: normalized distance within which two primitives are treated as one component - the
            vector equivalent of the raster "merge components whose boxes overlap" step in
            FUTURE_WORK.md S4b. Bridges the small real gaps between adjacent strokes (an arc and
            the leaf it hinges from) without being large enough to bridge genuinely separate
            symbols.
    Returns:
        One merged `NormRect` per component, unordered.
    Raises:
        Nothing.
    Summary:
        A page carries tens of thousands of primitives - 36,705 measured on
        skanska-drawing-set.pdf page 4 (30,464 path primitives plus 6,241 glyphs) - so comparing
        every pair is minutes of pure-Python work, not the milliseconds this needs. The union-find
        instead runs over a uniform grid: each box is inserted into every cell its gap-expanded
        footprint touches, and only boxes sharing a cell are ever compared.

        The grid resolution is a fixed constant, not derived from `gap` at all. Keying the grid at
        `gap` was the first attempt (`cell = max(gap, floor)`), and it stayed slow for any `gap`
        above that floor: a 5 pt glyph expanded by a 0.005 `gap` on each side is wider than a
        0.005-wide cell, so it still landed in a dozen-plus cells, and a text-dense region (a
        keynote schedule, a dimension string) turned that redundancy into a per-cell candidate list
        large enough for its O(k^2) comparisons to dominate the runtime - measured at 20 s for one
        page. Fixing `_GRID_CELL` regardless of `gap` keeps insertion multiplicity bounded by
        primitive size alone (18-20x faster, measured), while correctness still comes entirely from
        the exact `gap`-tolerant overlap test below, not from the cell size. It assumes `gap` stays
        on the order of `_GRID_CELL` or smaller, which every use in this codebase does; a much
        larger `gap` would still be correct, just slower.
    """
    n = len(boxes)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj

    grid: dict[tuple[int, int], list[int]] = {}
    for i, box in enumerate(boxes):
        cx0, cy0 = int((box.x0 - gap) // _GRID_CELL), int((box.y0 - gap) // _GRID_CELL)
        cx1, cy1 = int((box.x1 + gap) // _GRID_CELL), int((box.y1 + gap) // _GRID_CELL)
        for cx in range(cx0, cx1 + 1):
            for cy in range(cy0, cy1 + 1):
                grid.setdefault((cx, cy), []).append(i)

    def overlaps(a: NormRect, b: NormRect) -> bool:
        return not (
            a.x1 + gap < b.x0
            or b.x1 + gap < a.x0
            or a.y1 + gap < b.y0
            or b.y1 + gap < a.y0
        )

    for candidates in grid.values():
        for a in range(len(candidates)):
            for b in range(a + 1, len(candidates)):
                i, j = candidates[a], candidates[b]
                if find(i) != find(j) and overlaps(boxes[i], boxes[j]):
                    union(i, j)

    groups: dict[int, list[NormRect]] = {}
    for i, box in enumerate(boxes):
        groups.setdefault(find(i), []).append(box)

    return [
        NormRect(
            x0=min(b.x0 for b in group),
            y0=min(b.y0 for b in group),
            x1=max(b.x1 for b in group),
            y1=max(b.y1 for b in group),
        )
        for group in groups.values()
    ]


#: Allowed fractional difference in width and height from the exemplar, in `match_exemplar`.
#:
#: Matches FUTURE_WORK.md S4b's raster connected-component filter exactly (bbox dimensions within
#: 15%), so the two strategies stay comparable rather than diverging on an arbitrary tolerance.
DEFAULT_BBOX_TOLERANCE = 0.15


def match_exemplar(
    clusters: Sequence[NormRect],
    exemplar: NormRect,
    *,
    bbox_tolerance: float = DEFAULT_BBOX_TOLERANCE,
) -> list[NormRect]:
    """
    Narrow clusters down to instances of one symbol.

    Parameters:
        clusters: candidate boxes from `cluster_primitives`.
        exemplar: the box drawn around one instance of the symbol being counted.
        bbox_tolerance: allowed fractional difference in width and height from the exemplar - see
            `DEFAULT_BBOX_TOLERANCE`.
    Returns:
        Matching clusters, nearest-centre-to-the-exemplar first - so the exemplar's own cluster is
        first in the list whenever it survives the filter.
    Raises:
        Nothing.
    Summary:
        `cluster_primitives` alone recovers a box per symbol, not a class label: two differently
        shaped symbols of similar size land in indistinguishable clusters (see FUTURE_WORK.md S4e).
        This is deliberately only a size gate, matching S4b's raster filter rather than improving
        on it, so the two strategies can be measured against the same evaluation harness on equal
        terms. A shape descriptor (primitive count, Hu/Zernike moments - FUTURE_WORK.md S2) is the
        natural next filter if size alone proves too permissive on a real sheet.
    """
    exemplar_width = exemplar.x1 - exemplar.x0
    exemplar_height = exemplar.y1 - exemplar.y0
    exemplar_center = ((exemplar.x0 + exemplar.x1) / 2, (exemplar.y0 + exemplar.y1) / 2)

    def close_enough(cluster: NormRect) -> bool:
        width = cluster.x1 - cluster.x0
        height = cluster.y1 - cluster.y0
        return (
            abs(width - exemplar_width) <= bbox_tolerance * exemplar_width
            and abs(height - exemplar_height) <= bbox_tolerance * exemplar_height
        )

    def center_distance(cluster: NormRect) -> float:
        center = ((cluster.x0 + cluster.x1) / 2, (cluster.y0 + cluster.y1) / 2)
        return (
            (center[0] - exemplar_center[0]) ** 2 + (center[1] - exemplar_center[1]) ** 2
        ) ** 0.5

    return sorted((c for c in clusters if close_enough(c)), key=center_distance)
