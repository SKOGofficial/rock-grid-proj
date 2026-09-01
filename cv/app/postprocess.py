"""
Turning a pile of correlation peaks into a count.

Summary:
    Two different questions get answered here, and conflating them is the classic way to get a
    confidently wrong number.

    Non-maximum suppression answers "is this the same detection as that one?". A correlation peak
    is broad - a template that matches at (x, y) still scores nearly as high one or two pixels
    away - so every real symbol produces a blob of qualifying positions rather than a single one.

    Thresholding answers "is this a detection at all?". After suppression the survivors still
    include every local maximum on the sheet: the twenty that are the symbol, and the few hundred
    pieces of background linework that happen to correlate weakly. Suppression deduplicated them;
    it made no judgement about which are real.

    Neither step substitutes for the other, and the count is the length of what comes out.

    Nothing here touches an image. That is deliberate: it keeps the arithmetic testable on
    synthetic input, and it means every future strategy in FUTURE_WORK.md can reuse it, not just
    the correlation one.
"""

from __future__ import annotations

from typing import Iterable, NamedTuple, Sequence

import numpy as np

#: Absolute minimum correlation for a peak to be considered at all.
#:
#: Without a hard floor the knee search below will happily find a cliff inside pure noise and
#: report matches on a sheet that contains none.
#:
#: This was 0.5 until measurement showed that was already discarding true instances. Searching for
#: a floor device on sheet E4, three genuine matches scored 0.541, 0.538 and 0.494 - depressed by
#: conduit stubs drawn through the template window - so the last was cut before anything downstream
#: could weigh it. The floor is meant to bound absurdity, not to decide the answer; 0.35 leaves the
#: judgement to the threshold, where a reviewer can see and move it.
DEFAULT_FLOOR = 0.35

#: Intersection-over-union above which two boxes are treated as the same detection.
#:
#: The value is not delicate. Duplicate peaks from one symbol sit a few pixels apart and score
#: around 0.9; genuinely adjacent symbols sit at least a template apart and score near 0. Those
#: two populations are far enough apart that anything from roughly 0.2 to 0.7 gives the same
#: answer on real drawings.
DEFAULT_IOU = 0.3

#: How many of the top survivors the knee search examines.
#:
#: This bounds the *search*, not the result. Because the knee yields a score value rather than a
#: rank, a sheet carrying 600 instances still returns all 600 - see `choose_threshold`.
KNEE_CANDIDATES = 500

#: Hard ceiling on returned matches. Set far above any plausible instance count; it exists to
#: stop a pathological run from returning a million boxes, and when it bites the caller is told.
MAX_MATCHES = 2000


class Candidate(NamedTuple):
    """One correlation peak, in the pixel space of the rendered page."""

    x: int
    y: int
    width: int
    height: int
    score: float
    rotation_deg: int = 0


class Detections(NamedTuple):
    """The result of reducing candidates to an answer."""

    matches: list[Candidate]
    #: The score cutoff actually applied, whether chosen or supplied.
    threshold: float
    #: True when `MAX_MATCHES` truncated the result, so the count is a floor rather than a total.
    truncated: bool


def iou_matrix(boxes: np.ndarray, index: int, others: np.ndarray) -> np.ndarray:
    """
    Intersection-over-union of one box against many.

    Parameters:
        boxes: float array of shape (n, 4) holding x0, y0, x1, y1.
        index: row of the box to compare from.
        others: integer array of rows to compare against.
    Returns:
        Float array of IoU values, one per entry in `others`.
    Raises:
        Nothing.
    Summary:
        Vectorized so the greedy loop below stays linear in the number of survivors rather than
        quadratic in Python.
    """
    x0 = np.maximum(boxes[index, 0], boxes[others, 0])
    y0 = np.maximum(boxes[index, 1], boxes[others, 1])
    x1 = np.minimum(boxes[index, 2], boxes[others, 2])
    y1 = np.minimum(boxes[index, 3], boxes[others, 3])

    intersection = np.maximum(0.0, x1 - x0) * np.maximum(0.0, y1 - y0)
    area = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    union = area[index] + area[others] - intersection
    return np.where(union > 0.0, intersection / union, 0.0)


def suppress(candidates: Sequence[Candidate], iou_threshold: float = DEFAULT_IOU) -> list[Candidate]:
    """
    Collapse overlapping detections of the same instance.

    Parameters:
        candidates: peaks to reduce, in any order.
        iou_threshold: overlap above which a lower-scoring box is discarded.
    Returns:
        The kept candidates, highest score first.
    Raises:
        Nothing.
    Summary:
        Standard greedy non-maximum suppression on intersection-over-union.

        IoU rather than centre distance, for two reasons. Distance over-suppresses diagonal
        neighbours: two boxes offset by 0.49 of the template in *both* axes overlap by only 15%,
        which is clearly two symbols, yet a per-axis distance rule merges them. And distance is
        only equivalent to IoU while every box is the same size - true for template matching, but
        false for the connected-component strategy that will reuse this function with boxes of
        varying size.
    """
    if not candidates:
        return []

    boxes = np.array(
        [(c.x, c.y, c.x + c.width, c.y + c.height) for c in candidates],
        dtype=np.float64,
    )
    remaining = np.argsort([-c.score for c in candidates], kind="stable")

    kept: list[int] = []
    while remaining.size:
        best = int(remaining[0])
        kept.append(best)
        rest = remaining[1:]
        if rest.size == 0:
            break
        remaining = rest[iou_matrix(boxes, best, rest) <= iou_threshold]

    return [candidates[i] for i in kept]


def choose_threshold(
    scores: Iterable[float],
    floor: float = DEFAULT_FLOOR,
    max_candidates: int = KNEE_CANDIDATES,
) -> float:
    """
    Pick the score cutoff that separates instances from background.

    Parameters:
        scores: scores of the *deduplicated* candidates. Running this on raw peaks would let the
            hundreds of duplicates around each strong symbol flatten the distribution and bury the
            very cliff being looked for.
        floor: absolute minimum score, also used as the virtual tail element below.
        max_candidates: how many of the top scores to examine.
    Returns:
        A score value; callers keep candidates scoring at or above it.
    Raises:
        Nothing.
    Summary:
        These symbols are CAD block instances, so real matches cluster tightly at a high score and
        background falls away beneath them. The cutoff is therefore the largest gap between
        consecutive sorted scores.

        The floor is appended as a virtual final element, and that detail is what makes the method
        work rather than fail on the commonest case. Twenty grid bubbles all scoring 0.97 with
        nothing else above the floor have only noise-sized gaps between them; without the virtual
        tail the largest of those noise gaps wins and the count is cut arbitrarily in half. With
        it, the 0.97 -> 0.50 drop at the end wins and all twenty survive.

        The same detail is why `max_candidates` cannot truncate a result: what comes back is a
        score, not a rank. If the top 500 all sit at 0.97 the cutoff lands just above the floor,
        and the caller then keeps every candidate above it - the 501st included.
    """
    ranked = sorted((float(s) for s in scores if s >= floor), reverse=True)[:max_candidates]
    if not ranked:
        return float(floor)

    series = np.array(ranked + [float(floor)], dtype=np.float64)
    gaps = series[:-1] - series[1:]
    return float(series[int(np.argmax(gaps))])


def finalize(
    candidates: Sequence[Candidate],
    *,
    threshold: float | None = None,
    floor: float = DEFAULT_FLOOR,
    iou_threshold: float = DEFAULT_IOU,
    max_matches: int = MAX_MATCHES,
) -> Detections:
    """
    Reduce raw correlation peaks to the answer.

    Parameters:
        candidates: every peak the matcher found.
        threshold: an explicit cutoff. `None` derives one from the score distribution.
        floor: absolute minimum score. Lowered automatically if an explicit `threshold` sits
            below it, so that asking for a permissive cutoff actually gets one.
        iou_threshold: overlap above which two boxes are the same detection.
        max_matches: hard ceiling on the returned list.
    Returns:
        A `Detections`, whose `matches` length is the count.
    Raises:
        Nothing.
    Summary:
        Order is load-bearing: floor, then suppression, then the cutoff. The cutoff has to see
        deduplicated scores, so it cannot run before suppression.
    """
    effective_floor = float(floor) if threshold is None else min(float(floor), float(threshold))

    above_floor = [c for c in candidates if c.score >= effective_floor]
    kept = suppress(above_floor, iou_threshold)

    cutoff = (
        choose_threshold([c.score for c in kept], floor=effective_floor)
        if threshold is None
        else float(threshold)
    )

    matches = [c for c in kept if c.score >= cutoff]
    truncated = len(matches) > max_matches
    if truncated:
        matches = matches[:max_matches]

    return Detections(matches=matches, threshold=cutoff, truncated=truncated)
