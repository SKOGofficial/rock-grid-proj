"""
Scoring a detector against ground truth - the two metrics that fail differently.

Summary:
    FUTURE_WORK.md S8 tracks precision/recall/F1 at IoU 0.5 alongside count error rather than
    either alone, because a method can post near-zero count error while every match is wrong: the
    errors just happen to cancel. This module takes two box lists - a detector's output and the
    vector-layer oracle's ground truth (`vector_oracle.match_exemplar`) - and produces both.

    Nothing here touches an image, a PDF, or a strategy. That is deliberate, for the same reason
    `postprocess.py` stays image-free: the arithmetic is checkable against answers that are not in
    dispute, and every current or future strategy can be scored through this one function.
"""

from __future__ import annotations

from typing import NamedTuple, Sequence

from .fft_ncc import NormRect


class Evaluation(NamedTuple):
    """The scorecard for one predicted set against one ground-truth set, on one page."""

    precision: float
    recall: float
    f1: float
    #: `|predicted - actual| / actual`. `inf` when there is no ground truth but predictions exist;
    #: 0.0 when both are empty - there is nothing to count and nothing was missed.
    count_error: float
    true_positives: int
    false_positives: int
    false_negatives: int


def _iou(a: NormRect, b: NormRect) -> float:
    """Intersection-over-union of two normalized boxes."""
    x0, y0 = max(a.x0, b.x0), max(a.y0, b.y0)
    x1, y1 = min(a.x1, b.x1), min(a.y1, b.y1)
    intersection = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    area_a = (a.x1 - a.x0) * (a.y1 - a.y0)
    area_b = (b.x1 - b.x0) * (b.y1 - b.y0)
    union = area_a + area_b - intersection
    return intersection / union if union > 0.0 else 0.0


def evaluate(
    predicted: Sequence[NormRect],
    ground_truth: Sequence[NormRect],
    *,
    iou_threshold: float = 0.5,
) -> Evaluation:
    """
    Score one page's predictions against ground truth.

    Parameters:
        predicted: boxes from a detector (any strategy).
        ground_truth: boxes from the oracle, or from hand labelling.
        iou_threshold: overlap at or above which a predicted box counts as finding a ground-truth
            one. 0.5 is FUTURE_WORK.md S8's default.
    Returns:
        An `Evaluation`.
    Raises:
        Nothing.
    Summary:
        Matching is greedy, highest-IoU pair first, each box claimed at most once - the same
        greedy-by-score shape as `postprocess.suppress`, applied to cross-set matching instead of
        deduplication. A predicted box left unclaimed is a false positive; a ground-truth box left
        unclaimed is a false negative.
    """
    candidate_pairs = []
    for gi, gt in enumerate(ground_truth):
        for pi, pred in enumerate(predicted):
            iou = _iou(gt, pred)
            if iou >= iou_threshold:
                candidate_pairs.append((iou, gi, pi))
    candidate_pairs.sort(key=lambda pair: pair[0], reverse=True)

    claimed_gt: set[int] = set()
    claimed_pred: set[int] = set()
    for _, gi, pi in candidate_pairs:
        if gi in claimed_gt or pi in claimed_pred:
            continue
        claimed_gt.add(gi)
        claimed_pred.add(pi)

    true_positives = len(claimed_gt)
    false_positives = len(predicted) - true_positives
    false_negatives = len(ground_truth) - true_positives

    precision = true_positives / len(predicted) if predicted else 1.0 if not ground_truth else 0.0
    recall = true_positives / len(ground_truth) if ground_truth else 1.0 if not predicted else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0.0 else 0.0

    if ground_truth:
        count_error = abs(len(predicted) - len(ground_truth)) / len(ground_truth)
    else:
        count_error = 0.0 if not predicted else float("inf")

    return Evaluation(
        precision=precision,
        recall=recall,
        f1=f1,
        count_error=count_error,
        true_positives=true_positives,
        false_positives=false_positives,
        false_negatives=false_negatives,
    )
