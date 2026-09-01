"""
Command-line harness: score a detector against the vector-layer oracle on one page.

Summary:
    FUTURE_WORK.md S4e's whole case for the oracle is "stop guessing whether changes help" - this
    is the tool that stops the guessing. It runs the oracle (`vector_oracle`) and a detector
    (`fft_ncc`) against the same exemplar and page, and scores one against the other
    (`evaluate`), so a change to either can be checked against a number instead of eyeballed.

    A script, not an HTTP endpoint: FUTURE_WORK.md S8 describes evaluating "on the full 28-sheet
    set", which is a batch job run from a terminal while iterating on the code, not a request the
    frontend ever makes. `src/strategies/registry.ts` has no entry for this and should not gain
    one - the oracle is not a strategy a user picks, it is how strategies get graded.

    Usage:
        cv/.venv/Scripts/python -m cv.app.oracle_report <file.pdf> <page> <x0> <y0> <x1> <y1> [dpi]

    Coordinates are normalized, origin top-left - the same convention as an exemplar box drawn in
    the frontend (see `/test`), so a box can be copied from there straight onto the command line.
"""

from __future__ import annotations

import sys
from pathlib import Path

from .evaluate import evaluate
from .fft_ncc import DEFAULT_DPI, NormRect, find_matches
from .vector_oracle import cluster_primitives, extract_primitives, match_exemplar


def report(path: Path, page: int, exemplar: NormRect, dpi: float = DEFAULT_DPI) -> None:
    """
    Print ground truth, detector output, and the score between them, for one page.

    Parameters:
        path: the source PDF.
        page: 1-based page number.
        exemplar: the box drawn around one instance of the symbol being counted.
        dpi: search resolution passed through to the detector.
    Returns:
        Nothing; results go to stdout.
    Raises:
        Whatever `extract_primitives` or `find_matches` raise for a bad path, page, or selection.
    Summary:
        The oracle and the detector each work from the same normalized `exemplar` but otherwise
        do not share code, so a systematic bug in one is not invisible to the other.
    """
    primitives = extract_primitives(str(path), page)
    clusters = cluster_primitives(primitives)
    ground_truth = match_exemplar(clusters, exemplar)

    result = find_matches(path, page, exemplar, dpi=dpi)
    predicted = [
        NormRect(
            x0=candidate.x / result.page_width,
            y0=candidate.y / result.page_height,
            x1=(candidate.x + candidate.width) / result.page_width,
            y1=(candidate.y + candidate.height) / result.page_height,
        )
        for candidate in result.detections.matches
    ]

    scored = evaluate(predicted, ground_truth)

    print(f"oracle (vector layer):  {len(ground_truth)} instances")
    print(
        f"fft-ncc (raster):       {len(predicted)} instances "
        f"(cutoff {result.detections.threshold:.3f})"
    )
    print(
        f"precision={scored.precision:.3f}  recall={scored.recall:.3f}  "
        f"f1={scored.f1:.3f}  count_error={scored.count_error:.3f}"
    )
    print(
        f"true_positives={scored.true_positives}  "
        f"false_positives={scored.false_positives}  "
        f"false_negatives={scored.false_negatives}"
    )


def main(argv: list[str]) -> int:
    if len(argv) not in (6, 7):
        print(__doc__)
        return 1

    path = Path(argv[0])
    page = int(argv[1])
    exemplar = NormRect(*(float(value) for value in argv[2:6]))
    dpi = float(argv[6]) if len(argv) == 7 else DEFAULT_DPI

    report(path, page, exemplar, dpi)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
