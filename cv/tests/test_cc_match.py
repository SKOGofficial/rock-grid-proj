"""
Checks for the connected-component building blocks: binarizing, wall-stripping, hole counting,
and the rotation-aware size check.

Summary:
    Same shape as `test_fft_ncc.py`: plain asserts, `test_*` names, a runner that reports every case
    rather than stopping at the first failure. `python -m cv.tests.test_cc_match` runs them today;
    pytest would collect them unchanged.

    Synthetic arrays throughout, same as the sibling suite and for the same reason: these functions
    are pure array manipulation, and the claim under test - "a wall disappears and a blob survives",
    "a ring has one hole" - can be checked against an answer that is not in dispute. `find_matches`
    itself needs a rendered PDF page and is exercised by hand against the seed set instead; see
    cv/README.md.

    Read the caveat in the root README before trusting these. They were written alongside the code
    they check, by the same author, in the same sitting.
"""

from __future__ import annotations

import sys
import traceback

import numpy as np

from cv.app.cc_match import (
    _binarize,
    _hole_count,
    _holes_compatible,
    _size_within_tolerance,
    _strip_long_structures,
)


def _paper(height: int, width: int) -> np.ndarray:
    """A blank white page - the value ink is drawn onto."""
    return np.full((height, width), 255, dtype=np.uint8)


# --------------------------------------------------------------------------------------------
# _binarize
# --------------------------------------------------------------------------------------------


#: Ink value used in the binarize tests. Not pure black: Otsu's threshold is only well-defined
#: between two populations, and a page that is *only* 0 and 255 is a degenerate histogram where any
#: cut from 0 to 254 maximizes the same variance - OpenCV's implementation happens to return 0 for
#: it, which would make the "cut sits between the two populations" claim trivially false for a
#: reason that has nothing to do with `_binarize`. A dark grey stand-in for ink keeps the two
#: populations genuinely separated, which is what a real anti-aliased render looks like anyway.
_INK = 40


def test_binarize_separates_ink_from_paper() -> None:
    """A dark square on white paper comes back as ink exactly where the square is."""
    page = _paper(20, 20)
    page[5:12, 5:14] = _INK

    mask, _otsu_value = _binarize(page)

    assert np.array_equal(mask > 0, page == _INK), "the mask should mark exactly the dark pixels"


def test_binarize_threshold_sits_between_the_two_populations() -> None:
    """Otsu's cut should land strictly between paper white and ink dark, not at either extreme."""
    page = _paper(20, 20)
    page[5:12, 5:14] = _INK

    _mask, otsu_value = _binarize(page)

    assert 0.0 < otsu_value < 255.0, f"expected a cut between the two populations, got {otsu_value}"


# --------------------------------------------------------------------------------------------
# _strip_long_structures
# --------------------------------------------------------------------------------------------


def test_strip_long_structures_removes_a_free_standing_wall() -> None:
    """A long horizontal line, nowhere near any symbol, is removed entirely."""
    mask = np.zeros((40, 100), dtype=np.uint8)
    mask[20, 5:95] = 255  # a 90 px wall

    stripped = _strip_long_structures(mask, kernel_length=25)

    assert not np.any(stripped), "an isolated wall should leave nothing behind"


def test_strip_long_structures_leaves_a_short_blob_alone() -> None:
    """A compact blob, well under the kernel length in every direction, survives untouched."""
    mask = np.zeros((40, 40), dtype=np.uint8)
    mask[10:18, 10:18] = 255  # an 8x8 blob

    stripped = _strip_long_structures(mask, kernel_length=25)

    assert np.array_equal(stripped, mask), "a blob shorter than the kernel in both axes must survive"


def test_strip_long_structures_detaches_a_nearby_wall_without_touching_the_blob() -> None:
    """The documented case a symbol drawn *near*, not *touching*, a wall: only the wall goes."""
    mask = np.zeros((40, 100), dtype=np.uint8)
    mask[20, 5:95] = 255  # a 90 px wall
    mask[25:33, 40:48] = 255  # an 8x8 blob, five rows below the wall - not connected to it

    stripped = _strip_long_structures(mask, kernel_length=25)

    assert not np.any(stripped[20, :]), "the wall row should be gone"
    assert np.array_equal(stripped[25:33, 40:48], mask[25:33, 40:48]), "the untouched blob must survive"


# --------------------------------------------------------------------------------------------
# _hole_count
# --------------------------------------------------------------------------------------------


def test_hole_count_solid_blob_has_no_holes() -> None:
    mask = np.zeros((20, 20), dtype=np.uint8)
    mask[5:15, 5:15] = 255

    assert _hole_count(mask) == 0


def test_hole_count_ring_has_one_hole() -> None:
    """A filled square with a smaller white square cut from its centre - a marker's circle, flattened."""
    mask = np.zeros((20, 20), dtype=np.uint8)
    mask[4:16, 4:16] = 255
    mask[8:12, 8:12] = 0  # the hole, fully enclosed by ink on every side

    assert _hole_count(mask) == 1


def test_hole_count_two_slots_has_two_holes() -> None:
    """A receptacle stand-in: one outer body, two disjoint enclosed slots."""
    mask = np.zeros((20, 30), dtype=np.uint8)
    mask[4:16, 4:26] = 255
    mask[8:12, 8:12] = 0  # slot one
    mask[8:12, 18:22] = 0  # slot two

    assert _hole_count(mask) == 2


def test_hole_count_ignores_a_notch_open_to_the_outside() -> None:
    """A bite taken out of the *edge* is not a hole - it was never enclosed."""
    mask = np.zeros((20, 20), dtype=np.uint8)
    mask[4:16, 4:16] = 255
    mask[8:12, 0:8] = 0  # reaches the mask's own edge, so it is not surrounded by ink

    assert _hole_count(mask) == 0


# --------------------------------------------------------------------------------------------
# _holes_compatible
# --------------------------------------------------------------------------------------------


def test_holes_compatible_accepts_an_exact_match() -> None:
    assert _holes_compatible(1, 1)


def test_holes_compatible_accepts_a_noisy_exemplar_count() -> None:
    """
    The case this function exists for: measured on the seed set, one exemplar crop bled 4 holes
    from anti-aliasing where every true instance elsewhere on the sheet cleanly measured 1 or 3.
    Comparing exact counts would reject every one of them; comparing "has interior detail at all"
    does not.
    """
    assert _holes_compatible(1, 4)
    assert _holes_compatible(3, 4)


def test_holes_compatible_rejects_a_solid_symbol_against_a_ringed_one() -> None:
    """The distinction this function exists to keep: no interior detail at all is not a match."""
    assert not _holes_compatible(0, 4)
    assert not _holes_compatible(4, 0)


def test_holes_compatible_accepts_both_solid() -> None:
    assert _holes_compatible(0, 0)


# --------------------------------------------------------------------------------------------
# _size_within_tolerance
# --------------------------------------------------------------------------------------------


def test_size_within_tolerance_accepts_the_exemplars_own_dimensions() -> None:
    assert _size_within_tolerance(60, 40, 60, 40, tolerance=0.15)


def test_size_within_tolerance_accepts_the_90_degree_swap() -> None:
    """A component's bounding box is axis-aligned, so a 90-degree instance presents swapped."""
    assert _size_within_tolerance(40, 60, 60, 40, tolerance=0.15)


def test_size_within_tolerance_accepts_a_small_deviation() -> None:
    assert _size_within_tolerance(64, 42, 60, 40, tolerance=0.15)


def test_size_within_tolerance_rejects_outside_tolerance() -> None:
    assert not _size_within_tolerance(90, 40, 60, 40, tolerance=0.15)


def test_size_within_tolerance_rejects_a_swap_still_out_of_range() -> None:
    """The swapped orientation is checked too, but it still has to pass the same tolerance."""
    assert not _size_within_tolerance(41, 91, 60, 40, tolerance=0.15)


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
