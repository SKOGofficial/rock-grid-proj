"""
Normalized cross-correlation against a rotation bank - the first working detector.

Summary:
    The whole method rests on one property of the input: these sheets are CAD exports, so every
    instance of a symbol on a given sheet is the *same drawing*, placed repeatedly. Correlation is
    therefore not the blunt instrument its reputation in natural-image vision suggests - it is
    close to exact matching, and it needs no training, no index and no model.

    Two decisions carry most of the correctness.

    The template is a slice of the very array being searched, not a separately rendered image.
    Normalized cross-correlation is not scale-invariant, so a template rasterized even slightly
    differently from the page loses score on every candidate. Slicing makes that impossible.

    The template rotates, not the page. The template is a few tens of kilobytes and the page is
    19 megapixels, so reorienting the small one eight times is free - but the real reason is
    coordinates. Every peak comes back already in page space, with no inverse transform to get
    wrong. `np.rot90` at 90-degree multiples is a lossless reindexing; arbitrary angles would need
    interpolation, which softens 1-2 pixel CAD strokes and degrades every candidate rather than
    just the rotated ones.

    Eight, not four, because the bank covers reflections too - see `DEFAULT_MIRROR`. Leaving them
    out does not lose a mirrored instance outright; it demotes it into a cluster below the upright
    ones, where the automatic cutoff then cuts it.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import NamedTuple, Sequence

import cv2
import numpy as np

from .postprocess import (
    DEFAULT_FLOOR,
    DEFAULT_IOU,
    MAX_MATCHES,
    Candidate,
    Detections,
    finalize,
)
from .raster import render_page

#: Default search resolution.
#:
#: A 36x24 inch sheet is 19.4 MP here, and the float32 response map about 71 MB. At 300 DPI both
#: are four times larger for detail that symbol matching does not use.
DEFAULT_DPI = 150.0

#: Rotations searched by default.
#:
#: CAD blocks snap to orthogonal walls, so these four cover the overwhelming majority.
DEFAULT_ROTATIONS: tuple[int, ...] = (0, 90, 180, 270)

#: Whether reflections are searched alongside those rotations, by default.
#:
#: On, because leaving them out does not fail loudly. Every instance of a symbol is the same CAD
#: block, so against the right orientation each scores essentially 1.0 - but a rotation-only bank
#: has no right orientation for a reflected instance, and scores it by however self-similar the
#: symbol happens to be to its own reflection. On a synthetic 'F' that is 0.894
#: (`cv/tests/test_fft_ncc.py`); on a strongly chiral mark it is far lower.
#:
#: Well above the floor either way, which is the awkward part. The reflected instances are not
#: absent from the result, they form a second cluster beneath the upright ones - and a gap between
#: two clusters is exactly what `choose_threshold` hunts for when deciding where instances stop.
#: So a rotation-only run tends to find the mirrored symbols, rank them last, and then cut them,
#: reporting a confident count that is short by however many were mirrored.
#:
#: Turning it on collapses the two clusters into one. The cost is why this stays a knob: it doubles
#: the correlation work, and on symbols carrying text or digits a mirrored hit is a false positive
#: rather than an instance. `DEFAULT_ROTATIONS` plus this gives all eight orientations of the
#: square - four rotations, and `fliplr` composed with each.
DEFAULT_MIRROR = True

#: Smallest usable template edge, in pixels. Below this a correlation score means very little.
MIN_TEMPLATE_EDGE = 8

#: Cap on peaks kept from a single orientation before suppression.
#:
#: A cluttered sheet with a permissive floor can produce enormous peak counts. Keeping the best
#: this many bounds the work without affecting any plausible real answer.
MAX_PEAKS_PER_ORIENTATION = 20_000


class NormRect(NamedTuple):
    """A rectangle in normalized page coordinates: 0..1, origin top-left."""

    x0: float
    y0: float
    x1: float
    y1: float


#: Longest edge of the heatmap handed back, in pixels.
#:
#: The raw response map is page-sized float32 - about 78 MB - which has no business on a wire. The
#: diagnostic value is in the spatial pattern, not the precision.
HEATMAP_MAX_EDGE = 1400


class MatchResult(NamedTuple):
    """Everything the HTTP layer needs to build a response."""

    detections: Detections
    page_width: int
    page_height: int
    dpi: float
    #: (width, height) of the unrotated template, in page pixels.
    template_size: tuple[int, int]
    orientations_searched: int
    elapsed_ms: float
    #: Downsampled response map as uint8, or None. Encoding it is the HTTP layer's business.
    heatmap: np.ndarray | None = None


def _downsample_heatmap(heat: np.ndarray, max_edge: int = HEATMAP_MAX_EDGE) -> np.ndarray:
    """
    Reduce a response map to something transmittable, without losing its peaks.

    Parameters:
        heat: page-sized float32 response map.
        max_edge: longest edge of the result.
    Returns:
        A uint8 array, scores clamped to 0..1 and scaled to 0..255.
    Raises:
        Nothing.
    Summary:
        Max-pools before resizing. This is the whole difficulty: `INTER_AREA` *averages*, so a
        genuine three-pixel peak surrounded by background is averaged into the background and
        vanishes - producing a map that shows the broad structure and loses precisely the thing it
        was requested for. Dilating by the reduction factor first makes each output pixel the
        maximum of the block it covers.

        Negative correlation is clamped away; `TM_CCOEFF_NORMED` ranges -1..1 and nothing below
        zero is of interest here.
    """
    height, width = heat.shape
    factor = max(1, int(np.ceil(max(height, width) / max_edge)))

    if factor > 1:
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (factor * 2 + 1, factor * 2 + 1))
        heat = cv2.dilate(heat, kernel)
        heat = cv2.resize(
            heat,
            (max(1, width // factor), max(1, height // factor)),
            interpolation=cv2.INTER_NEAREST,
        )

    return (np.clip(heat, 0.0, 1.0) * 255.0).astype(np.uint8)


def _oriented_templates(
    template: np.ndarray,
    rotations: Sequence[int],
    mirror: bool,
) -> list[tuple[int, bool, np.ndarray]]:
    """
    Build the bank of rotated (and optionally mirrored) templates.

    Parameters:
        template: the unrotated template.
        rotations: angles in degrees; only multiples of 90 are meaningful.
        mirror: whether to add a horizontally flipped copy of each rotation.
    Returns:
        A list of (degrees, mirrored, array) with each array C-contiguous.
    Raises:
        ValueError: a rotation is not a multiple of 90.
    Summary:
        `np.rot90` and `np.fliplr` return views, and OpenCV needs contiguous input, so each is
        materialized once here rather than inside the correlation loop.
    """
    bank: list[tuple[int, bool, np.ndarray]] = []
    for degrees in rotations:
        if degrees % 90 != 0:
            raise ValueError(f"Rotation {degrees} is not a multiple of 90")
        rotated = np.rot90(template, (degrees // 90) % 4)
        bank.append((degrees % 360, False, np.ascontiguousarray(rotated)))
        if mirror:
            bank.append((degrees % 360, True, np.ascontiguousarray(np.fliplr(rotated))))
    return bank


def _peaks(response: np.ndarray, floor: float, width: int, height: int) -> np.ndarray:
    """
    Reduce a correlation response map to its local maxima.

    Parameters:
        response: float32 map from `cv2.matchTemplate`.
        floor: minimum score to consider.
        width, height: template dimensions, used to size the max filter.
    Returns:
        An (n, 3) float array of (x, y, score), best first.
    Raises:
        Nothing.
    Summary:
        Thresholding alone yields a blob of qualifying positions per symbol - a peak is broad, so
        a match at (x, y) still scores nearly as high a pixel away. Comparing against a dilation
        (a max filter) keeps only positions that are the largest in their neighbourhood, which
        collapses each blob to roughly one point and keeps suppression's input in the hundreds
        rather than the millions.
    """
    kernel_width = max(3, (width // 2) | 1)
    kernel_height = max(3, (height // 2) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_width, kernel_height))

    local_max = cv2.dilate(response, kernel)
    ys, xs = np.nonzero((response >= floor) & (response >= local_max))
    if ys.size == 0:
        return np.empty((0, 3), dtype=np.float64)

    scores = response[ys, xs].astype(np.float64)
    order = np.argsort(-scores, kind="stable")[:MAX_PEAKS_PER_ORIENTATION]
    return np.column_stack((xs[order], ys[order], scores[order]))


def find_matches(
    path: Path,
    page: int,
    bbox: NormRect,
    *,
    dpi: float = DEFAULT_DPI,
    rotations: Sequence[int] = DEFAULT_ROTATIONS,
    mirror: bool = DEFAULT_MIRROR,
    threshold: float | None = None,
    floor: float = DEFAULT_FLOOR,
    iou_threshold: float = DEFAULT_IOU,
    max_matches: int = MAX_MATCHES,
    include_heatmap: bool = False,
) -> MatchResult:
    """
    Find every instance of the exemplar on one page.

    Parameters:
        path: the document. Assumed already validated against the library directory.
        page: 1-based page number.
        bbox: the exemplar region, in normalized page coordinates.
        dpi: search resolution. May be reduced for very large sheets; the value used is returned.
        rotations: angles to search, in degrees. Must be multiples of 90.
        mirror: also search a horizontally flipped copy of each rotation. On by default; see
            `DEFAULT_MIRROR` for what it costs and when to turn it off.
        threshold: explicit score cutoff; `None` derives one from the distribution.
        floor, iou_threshold, max_matches: passed through to `finalize`.
    Returns:
        A `MatchResult` whose `detections.matches` are boxes in **page pixels**. Converting to
        normalized coordinates is the HTTP layer's job, where the wire contract lives.
    Raises:
        ValueError: the box is degenerate, falls outside the page, or is as large as the page.
    Summary:
        Renders once, slices the template out of that render, correlates the page against each
        oriented template in turn, and hands every orientation's peaks to `finalize` as a single
        list. Merging before suppression is what deduplicates a symmetric symbol that fires at all
        four angles in the same place - no separate rotation-dedup step is needed.
    """
    started = time.perf_counter()

    rendered = render_page(path, page, dpi)
    image = rendered.image
    page_height, page_width = image.shape

    left = int(round(min(bbox.x0, bbox.x1) * page_width))
    top = int(round(min(bbox.y0, bbox.y1) * page_height))
    right = int(round(max(bbox.x0, bbox.x1) * page_width))
    bottom = int(round(max(bbox.y0, bbox.y1) * page_height))

    left = max(0, min(left, page_width - 1))
    top = max(0, min(top, page_height - 1))
    right = max(left + 1, min(right, page_width))
    bottom = max(top + 1, min(bottom, page_height))

    template = image[top:bottom, left:right]
    template_height, template_width = template.shape

    if template_width < MIN_TEMPLATE_EDGE or template_height < MIN_TEMPLATE_EDGE:
        raise ValueError(
            f"Selection is {template_width}x{template_height} px at {rendered.dpi:.0f} DPI; "
            f"at least {MIN_TEMPLATE_EDGE} px on each edge is needed to correlate"
        )
    if template_width >= page_width or template_height >= page_height:
        raise ValueError("Selection covers the whole page; nothing is left to search")

    candidates: list[Candidate] = []
    bank = _oriented_templates(template, rotations, mirror)

    # Accumulated only when asked for; it is another page-sized float32 alongside the response map.
    heat = np.zeros((page_height, page_width), dtype=np.float32) if include_heatmap else None

    for degrees, mirrored, oriented in bank:
        oriented_height, oriented_width = oriented.shape
        if oriented_width > page_width or oriented_height > page_height:
            continue

        # One orientation at a time. The response map is roughly the size of the page in float32 -
        # about 71 MB for a D-size sheet - so holding all four at once would be gratuitous.
        response = cv2.matchTemplate(image, oriented, cv2.TM_CCOEFF_NORMED)

        if heat is not None:
            # Each orientation's map is a different size - a 90-degree template swaps width and
            # height - so they cannot simply be maximised together. Scattering each at its *centre*
            # offset solves that and the alignment problem at once: matchTemplate scores the
            # template's top-left corner, so a map accumulated in that frame would need shifting by
            # half a symbol before it could be overlaid. Placing scores at centres up front makes
            # the result page-aligned, and makes that off-by-half-a-symbol bug unrepresentable.
            offset_y, offset_x = oriented_height // 2, oriented_width // 2
            rows, columns = response.shape
            window = heat[offset_y : offset_y + rows, offset_x : offset_x + columns]
            np.maximum(window, response, out=window)

        found = _peaks(response, floor, oriented_width, oriented_height)
        del response

        for x, y, score in found:
            candidates.append(
                Candidate(
                    x=int(x),
                    y=int(y),
                    width=oriented_width,
                    height=oriented_height,
                    score=float(score),
                    rotation_deg=int(degrees),
                    mirrored=bool(mirrored),
                )
            )

    detections = finalize(
        candidates,
        threshold=threshold,
        floor=floor,
        iou_threshold=iou_threshold,
        max_matches=max_matches,
    )

    return MatchResult(
        detections=detections,
        page_width=page_width,
        page_height=page_height,
        dpi=rendered.dpi,
        template_size=(template_width, template_height),
        orientations_searched=len(bank),
        elapsed_ms=(time.perf_counter() - started) * 1000.0,
        heatmap=None if heat is None else _downsample_heatmap(heat),
    )
