"""
Checks for the vector-layer oracle's clustering and matching arithmetic.

Summary:
    Plain asserts and `test_*` names, so pytest collects this file if pytest is ever added, and
    `python -m cv.tests.test_vector_oracle` runs it today without one. See `test_postprocess.py`
    for the runner and its caveat - this file follows the same pattern.

    `extract_primitives` is deliberately not exercised here: it is a thin wrapper over pdfminer,
    and the boxes it produces have already been measured against skanska-drawing-set.pdf (see
    FUTURE_WORK.md S4e). `cluster_primitives` and `match_exemplar` take plain box lists, so their
    logic is checked here against synthetic geometry instead.
"""

from __future__ import annotations

import sys
import traceback

from cv.app.fft_ncc import NormRect
from cv.app.vector_oracle import cluster_primitives, match_exemplar


def _box(x0: float, y0: float, x1: float, y1: float) -> NormRect:
    return NormRect(x0, y0, x1, y1)


# --------------------------------------------------------------------------------------------
# Clustering: "which primitives belong to the same symbol?"
# --------------------------------------------------------------------------------------------


def test_touching_primitives_merge() -> None:
    """Two strokes that share an edge are one component, like a circle's two halves."""
    strokes = [_box(0.0, 0.0, 0.01, 0.01), _box(0.01, 0.0, 0.02, 0.01)]
    merged = cluster_primitives(strokes, gap=0.001)
    assert len(merged) == 1
    assert merged[0] == _box(0.0, 0.0, 0.02, 0.01)


def test_small_gap_still_merges() -> None:
    """The gap bridges the real, small breaks between strokes of the same symbol."""
    strokes = [_box(0.0, 0.0, 0.01, 0.01), _box(0.0125, 0.0, 0.02, 0.01)]
    merged = cluster_primitives(strokes, gap=0.005)
    assert len(merged) == 1


def test_far_apart_primitives_stay_separate() -> None:
    """Two distinct symbols must not be bridged just because a `gap` exists at all."""
    strokes = [_box(0.0, 0.0, 0.01, 0.01), _box(0.5, 0.5, 0.51, 0.51)]
    merged = cluster_primitives(strokes, gap=0.005)
    assert len(merged) == 2


def test_transitive_chain_merges_into_one() -> None:
    """A is close to B, B is close to C: all three are one component even though A and C are not."""
    chain = [_box(0.0, 0.0, 0.01, 0.01), _box(0.011, 0.0, 0.021, 0.01), _box(0.022, 0.0, 0.032, 0.01)]
    merged = cluster_primitives(chain, gap=0.002)
    assert len(merged) == 1
    assert merged[0] == _box(0.0, 0.0, 0.032, 0.01)


def test_cluster_empty() -> None:
    assert cluster_primitives([], gap=0.005) == []


def test_cluster_single_box_is_unchanged() -> None:
    box = _box(0.2, 0.2, 0.25, 0.25)
    assert cluster_primitives([box], gap=0.005) == [box]


# --------------------------------------------------------------------------------------------
# Exemplar matching: "which clusters are the same symbol as this one?"
# --------------------------------------------------------------------------------------------


def test_same_size_clusters_match() -> None:
    exemplar = _box(0.0, 0.0, 0.02, 0.02)
    same_size_elsewhere = _box(0.5, 0.5, 0.52, 0.52)
    matches = match_exemplar([exemplar, same_size_elsewhere], exemplar)
    assert same_size_elsewhere in matches


def test_differently_sized_cluster_is_rejected() -> None:
    """A door-sized cluster must not match a receptacle-sized exemplar."""
    exemplar = _box(0.0, 0.0, 0.02, 0.02)
    door_sized = _box(0.5, 0.5, 0.58, 0.53)
    matches = match_exemplar([exemplar, door_sized], exemplar)
    assert door_sized not in matches


def test_within_tolerance_matches() -> None:
    """A symbol drawn a few percent differently by anti-aliasing still matches."""
    exemplar = _box(0.0, 0.0, 0.02, 0.02)
    slightly_larger = _box(0.5, 0.5, 0.5215, 0.5215)  # +7.5% each edge
    matches = match_exemplar([slightly_larger], exemplar, bbox_tolerance=0.15)
    assert matches == [slightly_larger]


def test_nearest_to_exemplar_sorts_first() -> None:
    exemplar = _box(0.10, 0.10, 0.12, 0.12)
    near = _box(0.13, 0.10, 0.15, 0.12)
    far = _box(0.80, 0.80, 0.82, 0.82)
    matches = match_exemplar([far, exemplar, near], exemplar)
    assert matches[0] == exemplar
    assert matches[1] == near


def test_match_empty() -> None:
    assert match_exemplar([], _box(0.0, 0.0, 0.02, 0.02)) == []


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
