"""
Checks for the peak-reduction stage.

Summary:
    Plain asserts and `test_*` names, so pytest collects this file if pytest is ever added, and
    `python -m cv.tests.test_postprocess` runs it today without one. The standalone runner reports
    every case by name rather than stopping at the first failure, because when a change breaks
    three of these it is useful to see which three.

    These cases are all synthetic - no PDF, no image. That is the point of `postprocess.py` taking
    candidate lists rather than response maps: the arithmetic can be checked against answers that
    are not in dispute.

    Read the caveat in the README before trusting them. They were written alongside the code they
    check, by the same author, in the same sitting.
"""

from __future__ import annotations

import sys
import traceback

from cv.app.postprocess import Candidate, choose_threshold, finalize, suppress


# --------------------------------------------------------------------------------------------
# Suppression: "is this the same detection as that one?"
# --------------------------------------------------------------------------------------------


def test_one_blob_collapses_to_one_survivor() -> None:
    """A correlation peak is broad, so a single symbol qualifies at several nearby offsets."""
    blob = [
        Candidate(100, 100, 60, 60, 0.90),
        Candidate(101, 100, 60, 60, 0.95),
        Candidate(102, 101, 60, 60, 0.88),
        Candidate(100, 102, 60, 60, 0.92),
        Candidate(101, 102, 60, 60, 0.86),
    ]
    kept = suppress(blob)
    assert len(kept) == 1, f"expected one survivor, got {len(kept)}"
    assert kept[0].score == 0.95, "suppression must keep the highest-scoring peak"


def test_adjacent_symbols_both_survive() -> None:
    """Two instances exactly one template apart are two symbols, not one."""
    pair = [Candidate(0, 0, 60, 60, 0.9), Candidate(60, 0, 60, 60, 0.9)]
    assert len(suppress(pair)) == 2


def test_diagonal_offset_both_survive() -> None:
    """
    The case that motivated using IoU instead of centre distance.

    Two boxes offset by 0.49 of the template in *both* axes overlap by only about 15%, which is
    plainly two symbols - but a per-axis distance rule sees both offsets as under half a template
    and merges them.
    """
    diagonal = [Candidate(0, 0, 100, 100, 0.95), Candidate(49, 49, 100, 100, 0.93)]
    assert len(suppress(diagonal)) == 2


def test_stacked_elongated_boxes_both_survive() -> None:
    """Doors are long and thin; a rule based on the diagonal would merge two stacked ones."""
    doors = [Candidate(0, 0, 250, 80, 0.9), Candidate(0, 80, 250, 80, 0.9)]
    assert len(suppress(doors)) == 2


def test_heavy_overlap_is_suppressed() -> None:
    """A duplicate offset by a fraction of the template is the same symbol found twice."""
    duplicate = [Candidate(0, 0, 60, 60, 0.95), Candidate(0, 10, 60, 60, 0.9)]
    assert len(suppress(duplicate)) == 1


def test_suppress_empty() -> None:
    assert suppress([]) == []


# --------------------------------------------------------------------------------------------
# Thresholding: "is this a detection at all?"
# --------------------------------------------------------------------------------------------


def test_threshold_finds_a_clear_cliff() -> None:
    """Three instances well above a background floor."""
    assert choose_threshold([0.98, 0.97, 0.96, 0.55, 0.52]) == 0.96


def test_threshold_keeps_uniformly_high_scores() -> None:
    """
    The commonest case, and the one the virtual floor exists for.

    Twenty CAD block instances score almost identically. The gaps between them are noise, so
    without the floor appended as a tail element the largest noise gap wins and the count is cut
    roughly in half.
    """
    assert choose_threshold([0.97] * 20) == 0.97


def test_threshold_single_instance() -> None:
    """A symbol that appears once is a legitimate answer, not a failure."""
    assert choose_threshold([0.99]) == 0.99


def test_threshold_nothing_above_floor() -> None:
    """A sheet with no instances must not have a cliff found inside its noise."""
    assert choose_threshold([0.2, 0.1]) == 0.5


def test_threshold_empty() -> None:
    assert choose_threshold([]) == 0.5


# --------------------------------------------------------------------------------------------
# The whole reduction
# --------------------------------------------------------------------------------------------


def test_finalize_reduces_to_the_count() -> None:
    peaks = [
        Candidate(i * 200, 0, 60, 60, score)
        for i, score in enumerate([0.98, 0.97, 0.96, 0.55, 0.52])
    ]
    result = finalize(peaks)
    assert len(result.matches) == 3
    assert result.threshold == 0.96, "the applied cutoff must be reported back"
    assert result.truncated is False


def test_finalize_dense_sheet_survives_the_knee_cap() -> None:
    """
    A dense electrical sheet can carry several hundred instances of one symbol.

    The knee search only examines the top 500, but it returns a *score* rather than a rank, so
    everything above that score is kept - the 501st included.
    """
    dense = [Candidate(i * 200, 0, 60, 60, 0.97) for i in range(600)]
    assert len(finalize(dense).matches) == 600


def test_finalize_explicit_threshold_overrides_the_floor() -> None:
    """
    A supplied cutoff has to be authoritative.

    The floor filter runs first, so without lowering it to match, asking for 0.4 would silently
    get the default 0.5 - which is exactly what a threshold slider in the UI would do.
    """
    result = finalize([Candidate(0, 0, 60, 60, 0.42)], threshold=0.4)
    assert len(result.matches) == 1
    assert result.threshold == 0.4


def test_finalize_reports_truncation() -> None:
    """A takeoff that quietly under-reports is worse than one that admits it gave up."""
    flood = [Candidate(i * 200, 0, 60, 60, 0.9) for i in range(2500)]
    result = finalize(flood, max_matches=2000)
    assert len(result.matches) == 2000
    assert result.truncated is True


def test_finalize_empty() -> None:
    result = finalize([])
    assert result.matches == []
    assert result.truncated is False


# --------------------------------------------------------------------------------------------


def main() -> int:
    """
    Run every check in this module, one at a time.

    Returns:
        0 if all passed, 1 otherwise.
    Summary:
        Runs each case independently rather than aborting at the first failure, and prints the
        traceback for any that fail so the reason is visible without a second run.
    """
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
