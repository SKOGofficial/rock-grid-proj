"""
Checks for the ground-truth scoring stage.

Summary:
    Plain asserts and `test_*` names, so pytest collects this file if pytest is ever added, and
    `python -m cv.tests.test_evaluate` runs it today without one. See `test_postprocess.py` for
    the runner and its caveat - this file follows the same pattern.

    All boxes here are synthetic normalized rectangles, not pixels from a real page: the point of
    `evaluate.py` taking box lists rather than detector output is that the arithmetic can be
    checked against answers that are not in dispute.
"""

from __future__ import annotations

import sys
import traceback

from cv.app.evaluate import evaluate
from cv.app.fft_ncc import NormRect


def _box(x0: float, y0: float, size: float = 0.05) -> NormRect:
    """A small square at (x0, y0), for tests that only care about position."""
    return NormRect(x0, y0, x0 + size, y0 + size)


# --------------------------------------------------------------------------------------------
# Perfect and empty cases
# --------------------------------------------------------------------------------------------


def test_perfect_match() -> None:
    boxes = [_box(0.1, 0.1), _box(0.5, 0.5)]
    result = evaluate(boxes, boxes)
    assert result.precision == 1.0
    assert result.recall == 1.0
    assert result.f1 == 1.0
    assert result.count_error == 0.0
    assert (result.true_positives, result.false_positives, result.false_negatives) == (2, 0, 0)


def test_both_empty() -> None:
    """No instances on the sheet and none reported - a correct answer, not a failure."""
    result = evaluate([], [])
    assert result.precision == 1.0
    assert result.recall == 1.0
    assert result.count_error == 0.0


def test_predictions_with_no_ground_truth() -> None:
    """A sheet with no instances, but the detector reports some - all false positives."""
    result = evaluate([_box(0.1, 0.1), _box(0.5, 0.5)], [])
    assert result.precision == 0.0
    assert result.false_positives == 2
    assert result.count_error == float("inf")


def test_ground_truth_with_no_predictions() -> None:
    """Every instance missed - all false negatives, recall zero."""
    result = evaluate([], [_box(0.1, 0.1), _box(0.5, 0.5)])
    assert result.recall == 0.0
    assert result.false_negatives == 2
    assert result.count_error == 1.0


# --------------------------------------------------------------------------------------------
# Partial overlap and the cancelling-errors case S8 exists to catch
# --------------------------------------------------------------------------------------------


def test_false_positive_and_false_negative() -> None:
    """One correct, one missed, one spurious - precision and recall diverge."""
    ground_truth = [_box(0.1, 0.1), _box(0.5, 0.5)]
    predicted = [_box(0.1, 0.1), _box(0.9, 0.9)]
    result = evaluate(predicted, ground_truth)
    assert result.true_positives == 1
    assert result.false_positives == 1
    assert result.false_negatives == 1
    assert result.precision == 0.5
    assert result.recall == 0.5


def test_count_error_hides_a_bad_match() -> None:
    """
    The exact failure S8 tracks two metrics to catch.

    Same count on both sides, but at different locations - zero count error despite every
    prediction being wrong. Precision and recall must both read zero regardless.
    """
    ground_truth = [_box(0.1, 0.1), _box(0.5, 0.5)]
    predicted = [_box(0.9, 0.9), _box(0.95, 0.1)]
    result = evaluate(predicted, ground_truth)
    assert result.count_error == 0.0
    assert result.precision == 0.0
    assert result.recall == 0.0


def test_below_iou_threshold_does_not_count() -> None:
    """A box that only clips a corner of the true one is not a match."""
    ground_truth = [NormRect(0.0, 0.0, 0.1, 0.1)]
    predicted = [NormRect(0.09, 0.09, 0.19, 0.19)]
    result = evaluate(predicted, ground_truth, iou_threshold=0.5)
    assert result.true_positives == 0
    assert result.false_positives == 1
    assert result.false_negatives == 1


def test_greedy_matching_does_not_double_claim() -> None:
    """Two predictions both overlapping one ground-truth box: only one can be the true positive."""
    ground_truth = [_box(0.1, 0.1)]
    predicted = [_box(0.1, 0.1), _box(0.11, 0.1)]
    result = evaluate(predicted, ground_truth)
    assert result.true_positives == 1
    assert result.false_positives == 1


# --------------------------------------------------------------------------------------------


def main() -> int:
    """Run every check in this module, one at a time. Returns 0 if all passed, 1 otherwise."""
    cases = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith("test_")]
    failures = 0

    for name, case in cases:
        try:
            case()
        except Exception:
            failures += 1
            print(f"  FAIL  {name}")
            traceback.print_exc(file=sys.stdout)
        else:
            print(f"  ok    {name}")

    print(f"\n{len(cases) - failures}/{len(cases)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
