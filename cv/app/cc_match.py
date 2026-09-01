"""
Connected-component shape matching - FUTURE_WORK.md Strategy 4b.

Summary:
    Where `fft_ncc.py` searches every pixel offset, this strategy searches only where ink actually
    is. A rasterized line drawing is close to binary, so labelling its connected components turns
    the search space from millions of pixel offsets into a few hundred candidate blobs - each of
    which can then be verified expensively without the cost mattering.

    Three stages, in order:

    1. Binarize the page and strip long straight runs (walls, dimension lines, leader lines) with
       directional morphological opening. This is what detaches a symbol from the geometry it
       touches, and it is the step that decides what this strategy is good at: compact, isolated
       glyphs separate cleanly; a door's swing arc, drawn attached to the wall by design, mostly
       does not. See FUTURE_WORK.md §4b and §10.
    2. Label what remains and reject components whose bounding-box size, ink pixel count, or hole
       count (the number of enclosed white regions - a receptacle's two slots, a marker's ring)
       fall outside tolerance of the exemplar's own.
    3. Verify survivors with real normalized cross-correlation against the same oriented-template
       bank `fft_ncc.py` builds - reusing its `_oriented_templates`, since a symbol on this drawing
       set is a rotated or mirrored copy of itself either way. At a few hundred candidates this
       costs nothing, which is the payoff for having thrown away the sliding search.

    Deliberately reuses rather than duplicates: `postprocess.finalize` for suppression and
    thresholding (its own docstring already anticipated a second caller with variable box sizes),
    `raster.render_page` for pixels, and `fft_ncc.NormRect` / `fft_ncc._oriented_templates` for the
    orientation bank. Nothing here imports anything that would change `fft_ncc.py`'s own behavior.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import NamedTuple, Sequence

import cv2
import numpy as np

from .fft_ncc import (
    DEFAULT_DPI,
    DEFAULT_ROTATIONS,
    MIN_TEMPLATE_EDGE,
    MatchResult,
    NormRect,
    _oriented_templates,
)
from .postprocess import DEFAULT_FLOOR, DEFAULT_IOU, MAX_MATCHES, Candidate, finalize
from .raster import render_page

#: Length of the structuring element used to strip walls and dimension lines, in inches.
#:
#: Long enough to detach a symbol from the straight runs that connect it to the rest of the
#: drawing; short enough not to eat into the symbol's own strokes. This is the parameter that
#: decides the door trade-off named in FUTURE_WORK.md §10: a door leaf and swing arc are drawn at a
#: scale that overlaps this length, so opening removes part of the symbol along with the wall.
WALL_KERNEL_INCHES = 0.6

#: Tolerance on a candidate's bounding-box width and height against the exemplar's, as a fraction.
SIZE_TOLERANCE = 0.15

#: Tolerance on a candidate's ink pixel count against the exemplar's, as a fraction.
INK_TOLERANCE = 0.25

#: Components smaller than this, in ink pixels, are noise - a binarization speckle, not a symbol.
MIN_COMPONENT_INK = 9


class _ExemplarProfile(NamedTuple):
    """What a candidate component is compared against."""

    width: int
    height: int
    ink_count: int
    holes: int


def _binarize(image: np.ndarray) -> tuple[np.ndarray, float]:
    """
    Ink as a binary mask, and the threshold that produced it.

    Parameters:
        image: uint8 grayscale page, ink dark on a light background.
    Returns:
        (mask, otsu_value) - mask is uint8, 255 where ink, 0 elsewhere; otsu_value is the threshold
        Otsu chose, so the exemplar template can be binarized against the *same* cut rather than
        finding its own, which would let a small selection's Otsu pick a different threshold than
        the page it is being compared against.
    Raises:
        Nothing.
    Summary:
        A vector CAD export has almost no grey outside anti-aliasing, so Otsu's global threshold -
        built for exactly this bimodal case - separates ink from paper cleanly.
    """
    otsu_value, mask = cv2.threshold(image, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return mask, float(otsu_value)


def _strip_long_structures(mask: np.ndarray, kernel_length: int) -> np.ndarray:
    """
    Remove straight runs at least `kernel_length` long, in each axis, from a binary mask.

    Parameters:
        mask: uint8 ink mask, 255 where ink.
        kernel_length: minimum run length removed, in pixels. Forced odd.
    Returns:
        A new mask with long horizontal and vertical structures subtracted.
    Raises:
        Nothing.
    Summary:
        Morphological opening with a long structuring element keeps only ink that structure can
        fully contain - which a wall or a dimension line does and a compact symbol mostly does not.
        Horizontal and vertical are handled separately because CAD walls are axis-aligned; the union
        of both openings is what gets subtracted.
    """
    kernel_length = max(3, kernel_length) | 1
    horizontal = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_length, 1))
    vertical = cv2.getStructuringElement(cv2.MORPH_RECT, (1, kernel_length))

    walls = cv2.bitwise_or(
        cv2.morphologyEx(mask, cv2.MORPH_OPEN, horizontal),
        cv2.morphologyEx(mask, cv2.MORPH_OPEN, vertical),
    )
    return cv2.bitwise_and(mask, cv2.bitwise_not(walls))


def _hole_count(mask: np.ndarray) -> int:
    """
    Count enclosed white regions inside a binary ink mask.

    Parameters:
        mask: uint8, 255 where ink.
    Returns:
        The number of hole contours - inner rings, like a receptacle's slots or a marker's circle
        interior.
    Raises:
        Nothing.
    Summary:
        `RETR_CCOMP` organizes contours into exactly two levels, outer boundaries and the holes cut
        into them. A hole contour is one with a parent, so counting those directly gives the hole
        count without needing the full topology `RETR_TREE` would produce.
    """
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return 0
    return int(np.count_nonzero(hierarchy[0][:, 3] != -1))


def _size_within_tolerance(
    width: int, height: int, exemplar_width: int, exemplar_height: int, tolerance: float
) -> bool:
    """
    Whether a candidate's box could be the exemplar at 0/90/180/270 degrees.

    Parameters:
        width, height: the candidate's bounding-box dimensions.
        exemplar_width, exemplar_height: the exemplar's, unrotated.
        tolerance: allowed fractional deviation.
    Returns:
        True if either the exemplar's own orientation or its 90-degree swap matches within
        tolerance.
    Raises:
        Nothing.
    Summary:
        A component's bounding box is axis-aligned regardless of how the symbol inside it was
        drawn, so a 90-degree instance presents as the exemplar's dimensions swapped, not rotated.
        Both orientations are checked; NCC scoring afterwards is what actually confirms which angle.
    """
    for target_width, target_height in ((exemplar_width, exemplar_height), (exemplar_height, exemplar_width)):
        if (
            abs(width - target_width) <= tolerance * target_width
            and abs(height - target_height) <= tolerance * target_height
        ):
            return True
    return False


def _component_at(labels: np.ndarray, left: int, top: int, right: int, bottom: int) -> int | None:
    """
    Which labelled component the user's drawn box actually lands on.

    Parameters:
        labels: the page-wide label array from `cv2.connectedComponentsWithStats`.
        left, top, right, bottom: the drawn box, in page pixels.
    Returns:
        The label with the most pixels inside the box, or `None` if the box contains no ink.
    Raises:
        Nothing.
    Summary:
        Pixel-overlap, not bounding-box overlap, and majority rather than any-touch - so a box that
        is a few pixels loose on one side, or that clips a stray neighbour, still resolves to the
        symbol that actually fills most of it.
    """
    region = labels[top:bottom, left:right]
    values = region[region > 0]
    if values.size == 0:
        return None
    unique, counts = np.unique(values, return_counts=True)
    return int(unique[np.argmax(counts)])


def _holes_compatible(holes: int, exemplar_holes: int) -> bool:
    """
    Whether a candidate's interior structure is compatible with the exemplar's - coarsely.

    Parameters:
        holes: the candidate component's hole count.
        exemplar_holes: the exemplar's own, measured the same way.
    Returns:
        True if the two agree on whether there is any enclosed interior detail at all.
    Raises:
        Nothing.
    Summary:
        Not a count comparison. Measured against the seed set: a receptacle's circle-and-triangle
        mark crops to well under 40 px a side at 150 DPI search resolution, small enough that Otsu
        binarization is noisy - the *same* symbol measured 1, 3, and 4 holes at different positions
        on one sheet, purely from anti-aliasing speckle, not from anything different about the
        symbol. The exact number is unusable at this resolution; whether there is interior detail
        at all is what survives the noise, and it is what actually separates a solid symbol from
        one built around a ring or slots - the case this check exists for. Size and ink count above
        already narrow the field sharply, and NCC verification after this is what actually confirms
        a candidate; this is a coarse, corroborating filter, not the deciding one.
    """
    return (holes > 0) == (exemplar_holes > 0)


def find_matches(
    path: Path,
    page: int,
    bbox: NormRect,
    *,
    dpi: float = DEFAULT_DPI,
    rotations: Sequence[int] = DEFAULT_ROTATIONS,
    mirror: bool = False,
    threshold: float | None = None,
    floor: float = DEFAULT_FLOOR,
    iou_threshold: float = DEFAULT_IOU,
    max_matches: int = MAX_MATCHES,
    include_heatmap: bool = False,
) -> MatchResult:
    """
    Find every instance of the exemplar on one page by connected-component matching.

    Parameters:
        path: the document. Assumed already validated against the library directory.
        page: 1-based page number.
        bbox: the exemplar region, in normalized page coordinates.
        dpi: search resolution. May be reduced for very large sheets; the value used is returned.
        rotations: angles to search, in degrees. Must be multiples of 90.
        mirror: also verify candidates against a horizontally flipped copy of each rotation.
        threshold: explicit score cutoff; `None` derives one from the distribution.
        floor, iou_threshold, max_matches: passed through to `finalize`.
        include_heatmap: accepted for interface parity with `fft_ncc.find_matches`, but this
            strategy never searches a dense grid of offsets, so it has no page-wide response surface
            to report. Always returns `heatmap=None`.
    Returns:
        A `MatchResult` whose `detections.matches` are boxes in **page pixels**, matching the shape
        `fft_ncc.find_matches` returns so the HTTP layer can call either strategy identically.
    Raises:
        ValueError: the box is degenerate, falls outside the page, covers the whole page, or
            contains no ink to match against.
    Summary:
        Binarize and strip walls once for the whole page; label what remains; reject components
        outside tolerance on size, ink count, and hole count; verify survivors with real NCC against
        the exemplar's oriented bank at their own location, rather than a sliding search.
    """
    started = time.perf_counter()

    rendered = render_page(path, page, dpi)
    image = rendered.image
    page_height, page_width = image.shape

    # Same bbox-to-pixels clamping `fft_ncc.find_matches` uses. Duplicated rather than imported:
    # both are a handful of lines, and importing it would mean reaching into `fft_ncc.py`'s private
    # surface for logic simple enough to just repeat correctly.
    left = int(round(min(bbox.x0, bbox.x1) * page_width))
    top = int(round(min(bbox.y0, bbox.y1) * page_height))
    right = int(round(max(bbox.x0, bbox.x1) * page_width))
    bottom = int(round(max(bbox.y0, bbox.y1) * page_height))

    left = max(0, min(left, page_width - 1))
    top = max(0, min(top, page_height - 1))
    right = max(left + 1, min(right, page_width))
    bottom = max(top + 1, min(bottom, page_height))

    ink, _otsu_value = _binarize(image)

    kernel_length = max(3, int(round(rendered.dpi * WALL_KERNEL_INCHES)))
    detached = _strip_long_structures(ink, kernel_length)

    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(detached, connectivity=8)

    # The exemplar reads its profile from the page's own segmentation, not from re-binarizing the
    # drawn crop in isolation. Those disagree more than the difference looks like it should: a crop
    # a few pixels loose on one side changes what falls inside it, but candidates elsewhere are
    # measured from the *same* labelling this uses, and only a profile measured the identical way
    # is comparable to theirs. Binarizing the crop on its own, this strategy's first version did,
    # made the match exquisitely sensitive to how tightly the user happened to drag - to the point
    # of matching nothing on a real page, since the drawn box does not have to align with the
    # symbol's own connected-component boundary. Snapping to that boundary here removes the
    # sensitivity entirely: the box only has to overlap the symbol, not trace it.
    component_label = _component_at(labels, left, top, right, bottom)
    if component_label is None:
        raise ValueError("Selection contains no ink to match against")

    exemplar_x = int(stats[component_label, cv2.CC_STAT_LEFT])
    exemplar_y = int(stats[component_label, cv2.CC_STAT_TOP])
    exemplar_width = int(stats[component_label, cv2.CC_STAT_WIDTH])
    exemplar_height = int(stats[component_label, cv2.CC_STAT_HEIGHT])

    if exemplar_width < MIN_TEMPLATE_EDGE or exemplar_height < MIN_TEMPLATE_EDGE:
        raise ValueError(
            f"The symbol under this selection is {exemplar_width}x{exemplar_height} px at "
            f"{rendered.dpi:.0f} DPI; at least {MIN_TEMPLATE_EDGE} px on each edge is needed to "
            "correlate"
        )
    if exemplar_width >= page_width or exemplar_height >= page_height:
        raise ValueError("Selection covers the whole page; nothing is left to search")

    # The template - both for the exemplar's own hole count below and for the NCC bank - is the
    # component's own tight bounding box in the original grayscale, not the user's drawn one.
    template = image[
        exemplar_y : exemplar_y + exemplar_height, exemplar_x : exemplar_x + exemplar_width
    ]
    exemplar_mask = (
        labels[exemplar_y : exemplar_y + exemplar_height, exemplar_x : exemplar_x + exemplar_width]
        == component_label
    ).astype(np.uint8) * 255

    exemplar = _ExemplarProfile(
        width=exemplar_width,
        height=exemplar_height,
        ink_count=int(stats[component_label, cv2.CC_STAT_AREA]),
        holes=_hole_count(exemplar_mask),
    )

    bank = _oriented_templates(template, rotations, mirror)

    candidates: list[Candidate] = []

    for label in range(1, num_labels):  # label 0 is the background
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < MIN_COMPONENT_INK:
            continue

        width = int(stats[label, cv2.CC_STAT_WIDTH])
        height = int(stats[label, cv2.CC_STAT_HEIGHT])
        if not _size_within_tolerance(width, height, exemplar.width, exemplar.height, SIZE_TOLERANCE):
            continue
        if abs(area - exemplar.ink_count) > INK_TOLERANCE * exemplar.ink_count:
            continue

        x = int(stats[label, cv2.CC_STAT_LEFT])
        y = int(stats[label, cv2.CC_STAT_TOP])
        component_mask = (labels[y : y + height, x : x + width] == label).astype(np.uint8) * 255
        if not _holes_compatible(_hole_count(component_mask), exemplar.holes):
            continue

        # Verification only, not a search: score the bank at this one location rather than sliding
        # it. `matchTemplate` on a window exactly the template's size returns a single score.
        centroid_x, centroid_y = centroids[label]
        best_score = -1.0
        best_box: tuple[int, int, int, int] | None = None
        best_degrees = 0
        best_mirrored = False

        for degrees, mirrored, oriented in bank:
            oriented_height, oriented_width = oriented.shape
            if oriented_width > page_width or oriented_height > page_height:
                continue

            if (oriented_width, oriented_height) == (width, height):
                # This orientation is the shape the component was actually detected at, so its
                # own measured corner is exact - use it rather than a corner derived from the
                # centroid. That distinction matters: these symbols carry 1-2 px strokes, and the
                # rounding in a centroid-derived corner is enough on its own to crater the score of
                # a genuine match. Only a *rotated* orientation, whose dimensions the component was
                # never measured at, has no exact corner and needs the centroid as a placement.
                window_x, window_y = x, y
            else:
                window_x = int(round(centroid_x - oriented_width / 2))
                window_y = int(round(centroid_y - oriented_height / 2))
            window_x = max(0, min(window_x, page_width - oriented_width))
            window_y = max(0, min(window_y, page_height - oriented_height))

            window = image[
                window_y : window_y + oriented_height, window_x : window_x + oriented_width
            ]
            score = float(cv2.matchTemplate(window, oriented, cv2.TM_CCOEFF_NORMED)[0, 0])
            if score > best_score:
                best_score = score
                best_box = (window_x, window_y, oriented_width, oriented_height)
                best_degrees = degrees
                best_mirrored = mirrored

        if best_box is None or best_score < floor:
            continue

        window_x, window_y, oriented_width, oriented_height = best_box
        candidates.append(
            Candidate(
                x=window_x,
                y=window_y,
                width=oriented_width,
                height=oriented_height,
                score=best_score,
                rotation_deg=int(best_degrees),
                mirrored=bool(best_mirrored),
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
        template_size=(exemplar_width, exemplar_height),
        orientations_searched=len(bank),
        elapsed_ms=(time.perf_counter() - started) * 1000.0,
        heatmap=None,
    )
