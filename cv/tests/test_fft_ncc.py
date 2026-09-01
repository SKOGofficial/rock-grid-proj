"""
Checks for the orientation bank.

Summary:
    Same shape as `test_postprocess.py`: plain asserts, `test_*` names, and a runner that reports
    every case rather than stopping at the first failure. `python -m cv.tests.test_fft_ncc` runs
    them today; pytest would collect them unchanged.

    Synthetic arrays throughout - no PDF and no rendering. The bank is pure array manipulation and
    `cv2.matchTemplate` takes arrays, so the claim under test can be checked against answers that
    are not in dispute.

    What is being defended is one non-obvious property. Every instance of a symbol on a sheet is
    the same CAD block, so against the *right* orientation each one correlates at essentially 1.0.
    A rotation-only bank has no right orientation for a reflected instance, and what it scores
    instead depends entirely on how self-similar the symbol is to its own reflection: measured on
    the 'F' below it is 0.894, and a more strongly chiral mark goes far lower.

    The failure that produces is not a clean absence, which is what makes it awkward. The reflected
    instances land in a second cluster below the upright ones, and `choose_threshold` looks for
    exactly that kind of gap when it decides where instances stop and background begins - so the
    likeliest outcome is that they are found, ranked, and then cut. "Finds most of them and
    struggles with the mirrors" is the symptom of a bank, not of a threshold.

    Putting the reflections in the bank collapses the two clusters into one, because a mirrored
    instance is then matched by an exact copy of itself like every other.
    `test_mirrored_instance_needs_the_mirrored_bank` is that property written down.

    Read the caveat in the README before trusting these. They were written alongside the change
    they check, by the same author, in the same sitting.
"""

from __future__ import annotations

import sys
import traceback

import cv2
import numpy as np

from cv.app.fft_ncc import DEFAULT_ROTATIONS, _oriented_templates


def _glyph() -> np.ndarray:
    """
    A small chiral mark - an 'F' - as black ink on white.

    Returns:
        A square uint8 array.
    Raises:
        Nothing.
    Summary:
        Square on purpose. Every orientation then has the same shape, so "these eight are all
        different" is a claim about content rather than one a shape comparison could satisfy for
        free, and one response-map index is valid for every entry in the bank.

        Chiral on purpose too. A symbol with a mirror line matches its own reflection perfectly and
        would pass every check here while proving nothing; 'F' is the standard example of a shape
        with neither a mirror line nor rotational symmetry.
    """
    rows = (
        ".........",
        ".#######.",
        ".#######.",
        ".##......",
        ".#####...",
        ".#####...",
        ".##......",
        ".##......",
        ".........",
    )
    return np.array([[0 if cell == "#" else 255 for cell in row] for row in rows], dtype=np.uint8)


def _page_with_both_hands(glyph: np.ndarray) -> tuple[np.ndarray, tuple[int, int], tuple[int, int]]:
    """
    A blank sheet carrying the glyph twice: once upright, once reflected.

    Parameters:
        glyph: the square mark to place.
    Returns:
        (page, upright corner, mirrored corner), corners as (row, column) - which is the indexing
        order of a `matchTemplate` response, so they can be used to read a score directly.
    Raises:
        Nothing.
    Summary:
        The two instances are placed far enough apart that neither appears in the other's
        correlation neighbourhood, so a score read at one corner is about that instance alone.
    """
    size = glyph.shape[0]
    page = np.full((80, 160), 255, dtype=np.uint8)

    upright = (24, 20)
    mirrored = (24, 110)
    page[upright[0] : upright[0] + size, upright[1] : upright[1] + size] = glyph
    page[mirrored[0] : mirrored[0] + size, mirrored[1] : mirrored[1] + size] = np.fliplr(glyph)

    return page, upright, mirrored


def _best_score_at(page: np.ndarray, bank: list, corner: tuple[int, int]) -> float:
    """
    The best score any orientation in the bank achieves at exactly one position.

    Parameters:
        page: the array being searched.
        bank: output of `_oriented_templates`.
        corner: (row, column) of the instance's top-left pixel.
    Returns:
        The maximum correlation over the bank at that position.
    Raises:
        Nothing.
    Summary:
        Reads the score at a known corner rather than taking the map's global maximum, so a case
        cannot pass because some unrelated part of the page happened to correlate well.
    """
    row, column = corner
    return max(
        float(cv2.matchTemplate(page, oriented, cv2.TM_CCOEFF_NORMED)[row, column])
        for _degrees, _mirrored, oriented in bank
    )


# --------------------------------------------------------------------------------------------
# The bank itself: what is in it
# --------------------------------------------------------------------------------------------


def test_bank_is_four_without_mirror() -> None:
    """Rotations only: one entry per angle, nothing flagged as a reflection."""
    bank = _oriented_templates(_glyph(), DEFAULT_ROTATIONS, mirror=False)
    assert len(bank) == 4, f"expected four orientations, got {len(bank)}"
    assert not any(mirrored for _degrees, mirrored, _array in bank)


def test_bank_is_eight_with_mirror() -> None:
    """Mirroring pairs each rotation with its reflection - the full symmetry group of the square."""
    bank = _oriented_templates(_glyph(), DEFAULT_ROTATIONS, mirror=True)
    assert len(bank) == 8, f"expected eight orientations, got {len(bank)}"
    assert sum(1 for _degrees, mirrored, _array in bank if mirrored) == 4


def test_mirror_adds_reflections_not_more_rotations() -> None:
    """
    All eight orientations are distinct images.

    `fliplr(rot90(t, k))` for k in 0..3 is the four reflections of the square - a vertical flip, a
    horizontal flip and the two diagonal transposes - so the bank is the complete dihedral group
    and no entry duplicates another. A bank that emitted a rotation where a reflection belonged
    would still have eight entries and still pass the count check above; this is what would catch
    it.
    """
    bank = _oriented_templates(_glyph(), DEFAULT_ROTATIONS, mirror=True)
    arrays = [array for _degrees, _mirrored, array in bank]

    for i, first in enumerate(arrays):
        for j, second in enumerate(arrays[i + 1 :], start=i + 1):
            assert not np.array_equal(first, second), f"orientations {i} and {j} are the same image"


def test_every_orientation_is_contiguous() -> None:
    """`rot90` and `fliplr` return views, and OpenCV needs contiguous input."""
    bank = _oriented_templates(_glyph(), DEFAULT_ROTATIONS, mirror=True)
    for degrees, mirrored, array in bank:
        assert array.flags["C_CONTIGUOUS"], f"{degrees} deg mirrored={mirrored} is not contiguous"


def test_rejects_a_rotation_that_is_not_a_right_angle() -> None:
    """Arbitrary angles need interpolation, which the matcher deliberately does not do."""
    try:
        _oriented_templates(_glyph(), (0, 45), mirror=False)
    except ValueError:
        return
    raise AssertionError("a 45 degree rotation should have been refused")


# --------------------------------------------------------------------------------------------
# The bug this branch exists for
# --------------------------------------------------------------------------------------------


def test_mirrored_instance_needs_the_mirrored_bank() -> None:
    """
    A rotation-only bank scores a reflected instance below an upright one; adding reflections
    closes the gap exactly.

    Measured here: both banks score the upright instance 1.000. The eight-entry bank scores the
    reflected instance 1.000 as well - it is matched by an exact copy of itself. The four-entry
    bank scores it 0.894.

    0.894 is the number that makes this worth a test rather than an assertion. It is well above the
    0.35 floor, so the instance is not absent from a rotation-only result - it is present, ranked
    below every upright instance, sitting in its own cluster with a 0.1 gap above it. That gap is
    the shape `choose_threshold` hunts for, which is how a rotation-only run ends up confidently
    reporting a count with the mirrored instances excluded from it.

    The margin is a property of this glyph, not of the code - a more strongly chiral symbol scores
    far lower and a nearly symmetric one far higher - so the assertion below is deliberately loose.
    What must hold for any symbol is the direction and the closing.
    """
    glyph = _glyph()
    page, upright, mirrored = _page_with_both_hands(glyph)

    rotations_only = _oriented_templates(glyph, DEFAULT_ROTATIONS, mirror=False)
    with_reflections = _oriented_templates(glyph, DEFAULT_ROTATIONS, mirror=True)

    upright_without = _best_score_at(page, rotations_only, upright)
    upright_with = _best_score_at(page, with_reflections, upright)
    mirrored_without = _best_score_at(page, rotations_only, mirrored)
    mirrored_with = _best_score_at(page, with_reflections, mirrored)

    assert upright_without > 0.99, f"upright instance should match exactly, got {upright_without}"
    assert upright_with > 0.99, "adding reflections must not cost the upright instance anything"
    assert mirrored_with > 0.99, f"reflected instance should match exactly, got {mirrored_with}"

    # The gap, and then its absence. Both directions are asserted because either alone is
    # satisfiable by a broken bank: a bank that found nothing would pass the first, and a bank that
    # searched only reflections would pass the second.
    assert mirrored_without < upright_without - 0.05, (
        f"a rotation-only bank scored the reflected instance {mirrored_without:.3f} against "
        f"{upright_without:.3f} upright - too close to demonstrate the gap this glyph should show"
    )
    assert abs(mirrored_with - upright_with) < 1e-6, (
        "with reflections in the bank a mirrored instance is an exact copy like any other and must "
        f"score the same as an upright one, got {mirrored_with:.3f} against {upright_with:.3f}"
    )


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
