"""
The detection service: one endpoint, `POST /api/detect`.

Summary:
    This is the boundary. Everything inside it works on validated values; everything outside it is
    a stranger's JSON. Two responsibilities dominate.

    Resolving `fileName` to a path is the only place the service touches the filesystem based on
    what a client sent, so the check is resolve-first-then-contain rather than string inspection.
    And the response deliberately carries *every* candidate above the floor rather than only those
    above the cutoff, because measurement showed the cutoff is the least trustworthy number in the
    system - see `DetectResponse`.

    Run it with:

        uvicorn cv.app.main:app --host 127.0.0.1 --port 8000

    Bound to localhost on purpose. The service reads files from a directory and has no
    authentication, so on 0.0.0.0 it would serve a document library to everything on the network.
    A container can override that, because there the network boundary is the container's.

    No CORS middleware, for the same reason: Vite proxies `/api/detect` same-origin, so none is
    needed, and a permissive one would let any page in the browser reach this.
"""

from __future__ import annotations

import base64
import os
import time
from pathlib import Path
from typing import Literal

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from . import cc_match
from .fft_ncc import DEFAULT_DPI, DEFAULT_MIRROR, DEFAULT_ROTATIONS, NormRect
from .fft_ncc import find_matches as fft_ncc_find_matches
from .postprocess import DEFAULT_FLOOR, DEFAULT_IOU, MAX_MATCHES, choose_threshold

#: Extensions the detector can open. Bitmap library files are not handled yet.
SUPPORTED_EXTENSIONS = {".pdf"}

#: The document library. Overridable so a container can mount it elsewhere.
DATA_DIR = Path(
    os.environ.get("DATA_DIR", Path(__file__).resolve().parents[2] / "data")
).resolve()

#: One matcher per strategy id with a backend. Every entry has the exact signature
#: `fft_ncc.find_matches` does, so `detect()` below calls whichever was asked for identically.
#: Everything else in `src/strategies/registry.ts` answers 501, which is what `NotImplementedError`
#: in `src/api/detect.ts` exists to be thrown on.
STRATEGY_MATCHERS = {
    "fft-ncc": fft_ncc_find_matches,
    "connected-components": cc_match.find_matches,
}
IMPLEMENTED_STRATEGIES = set(STRATEGY_MATCHERS)

app = FastAPI(title="One-Shot Takeoff detection service", version="0.1.0")


class ApiModel(BaseModel):
    """
    Base for every model on the wire.

    Summary:
        The frontend speaks camelCase and Python speaks snake_case, so an alias generator does the
        translation rather than a hand-written mapping that can drift from `src/types.ts`.

        `extra="forbid"` is the useful half: a misspelled field is a 422 naming the offender,
        instead of being silently dropped while the caller wonders why nothing changed.
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Rect(ApiModel):
    """A rectangle in normalized page coordinates: 0..1, origin top-left."""

    x0: float = Field(ge=0.0, le=1.0)
    y0: float = Field(ge=0.0, le=1.0)
    x1: float = Field(ge=0.0, le=1.0)
    y1: float = Field(ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _check_ordered(self) -> "Rect":
        if self.x1 <= self.x0 or self.y1 <= self.y0:
            raise ValueError("bbox requires x1 > x0 and y1 > y0")
        return self


class DetectOptions(ApiModel):
    """Strategy knobs. Every one has a default; sending none is normal."""

    #: Explicit score cutoff. `None` derives one from the distribution - see `DetectResponse`.
    threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    #: Absolute minimum score for a peak to be reported at all.
    floor: float = Field(default=DEFAULT_FLOOR, ge=0.0, le=1.0)
    iou_threshold: float = Field(default=DEFAULT_IOU, ge=0.0, le=1.0)
    rotations: list[int] = Field(default_factory=lambda: list(DEFAULT_ROTATIONS))
    #: Search reflections as well as rotations. Defaulted from the matcher rather than restated, so
    #: a request that omits options behaves exactly like one the app sent.
    mirror: bool = DEFAULT_MIRROR
    max_matches: int = Field(default=MAX_MATCHES, ge=1, le=20_000)
    #: Return the correlation response map too. Off by default - it costs a page-sized float32
    #: accumulation and a PNG encode, and most runs do not want it.
    include_heatmap: bool = False

    @field_validator("rotations")
    @classmethod
    def _check_rotations(cls, value: list[int]) -> list[int]:
        if not value:
            raise ValueError("rotations must not be empty")
        if any(angle % 90 for angle in value):
            raise ValueError("rotations must be multiples of 90")
        return value


class DetectRequest(ApiModel):
    """Mirrors `DetectRequest` in `src/types.ts`."""

    strategy_id: str
    file_name: str
    page: int = Field(ge=1)
    bbox: Rect
    dpi: float = Field(default=DEFAULT_DPI, ge=36.0, le=600.0)
    scope: Literal["page", "document"] = "page"
    options: DetectOptions = Field(default_factory=DetectOptions)


class DetectMatch(ApiModel):
    """One detected instance, in the same coordinate space the exemplar was drawn in."""

    bbox: Rect
    page: int
    score: float
    rotation_deg: int | None = None
    #: Whether this instance was found via a reflected orientation rather than a plain rotation.
    mirrored: bool = False


class DetectResponse(ApiModel):
    """
    Mirrors `DetectResponse` in `src/types.ts`.

    Summary:
        `matches` holds **every** candidate down to `floorUsed`, not only those above
        `thresholdUsed`, so `len(matches)` is deliberately larger than `count`.

        That is a considered choice. The cutoff is still the least reliable number the service
        produces - on grid bubbles the derived one returns 75 where the answer is 8. Shipping only
        the survivors would make that a number nobody can interrogate. Shipping everything lets the
        UI move a threshold slider and re-count instantly, with no round trip and no
        re-correlation.

        The sheet E4 case that used to be cited here - 21 where the answer was 24, and "no single
        cutoff could return 24 without also admitting a false positive" - was misattributed. The
        three missing instances were mirrored, and the bank searched only rotations, so no cutoff
        could have recovered them and the threshold was never the culprit. With reflections
        searched, the same derived cutoff of 0.700 returns 24. Worth remembering the next time this
        response's shape is justified: the argument for it stands on the grid-bubble case, and one
        of its two supporting measurements turned out to be a different bug wearing a cutoff's
        clothes.
    """

    strategy_id: str
    matches: list[DetectMatch]
    #: How many of `matches` score at or above `threshold_used`. This is the answer.
    count: int
    elapsed_ms: float
    #: The cutoff applied - supplied by the caller, or derived from the score distribution.
    threshold_used: float
    #: The floor `matches` was collected down to, and therefore the slider's lower bound.
    floor_used: float
    #: True when `maxMatches` truncated the list, so `count` is a floor rather than a total.
    truncated: bool
    page_width: int
    page_height: int
    #: The DPI actually rendered at, which may be below the DPI requested for a very large sheet.
    dpi: float
    #: Grayscale response map as a PNG data URL, when `includeHeatmap` was set. Page-sized and
    #: centre-aligned, so the UI overlays it at the origin with no offset arithmetic.
    heatmap_png: str | None = None


def resolve_document(file_name: str) -> Path:
    """
    Resolve a client-supplied name to a real file inside the library.

    Parameters:
        file_name: the `fileName` from the request.
    Returns:
        The absolute path.
    Raises:
        HTTPException: 404 for anything that is not a readable supported file inside `DATA_DIR`.
    Summary:
        Resolve first, then check containment. Inspecting the string for ".." before resolving is
        the broken version of this check - it misses symlinks pointing out of the directory, and it
        misses encodings that only become traversal after normalization. Resolving both sides and
        asking whether one is still beneath the other is the check that holds.

        Every failure returns the same 404, so probing cannot distinguish "blocked" from "absent"
        and therefore cannot enumerate what exists outside the library.

        Mirrors `resolveLibraryFile` in `plugins/dataLibrary.ts`. Two validators with different
        rules guarding one directory is itself a vulnerability; the difference is where a bug lives.
    """
    not_found = HTTPException(status_code=404, detail="Document not found")

    if not file_name or "\0" in file_name:
        raise not_found

    candidate = Path(file_name)
    if candidate.is_absolute() or candidate.drive or candidate.root:
        raise not_found

    resolved = (DATA_DIR / candidate).resolve()
    if not resolved.is_relative_to(DATA_DIR):
        raise not_found
    if resolved.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise not_found
    if not resolved.is_file():
        raise not_found
    return resolved


def _encode_heatmap(heatmap: np.ndarray | None) -> str | None:
    """
    Turn a downsampled response map into a data URL.

    Parameters:
        heatmap: uint8 array from the matcher, or None.
    Returns:
        A `data:image/png;base64,...` string, or None.
    Raises:
        Nothing; an encode failure yields None rather than failing the detection.
    Summary:
        Single-channel grayscale on purpose. Colour-mapping it here would freeze the palette and,
        worse, freeze any threshold contour at whatever the cutoff happened to be when it was
        generated. Sending the raw scores lets the UI redraw that contour as a slider moves,
        without asking for a new map.
    """
    if heatmap is None:
        return None
    ok, buffer = cv2.imencode(".png", heatmap)
    if not ok:
        return None
    return "data:image/png;base64," + base64.b64encode(buffer.tobytes()).decode("ascii")


@app.post("/api/detect", response_model=DetectResponse)
def detect(request: DetectRequest) -> DetectResponse:
    """
    Find every instance of the exemplar on one page.

    Parameters:
        request: see `DetectRequest`.
    Returns:
        A `DetectResponse`.
    Raises:
        HTTPException: 400 for an unusable selection, 404 for an unresolvable document,
            501 for a strategy or scope with no implementation.
    Summary:
        Declared `def` rather than `async def`, deliberately. Correlation is about 1.5 seconds of
        CPU; on the event loop that would block every other request behind it. A sync endpoint runs
        in FastAPI's threadpool instead, and because OpenCV releases the GIL during matchTemplate
        those threads genuinely run in parallel rather than taking turns.
    """
    if request.strategy_id not in IMPLEMENTED_STRATEGIES:
        raise HTTPException(
            status_code=501,
            detail=f'The "{request.strategy_id}" strategy has no backend yet. See FUTURE_WORK.md.',
        )

    # Refusing is better than quietly doing something narrower than what was asked: a whole-document
    # count that silently covered one page would be wrong with nothing in the response to say so.
    if request.scope != "page":
        raise HTTPException(
            status_code=501,
            detail='Only scope "page" is implemented. Whole-document search is milestone 3.',
        )

    document = resolve_document(request.file_name)
    options = request.options
    started = time.perf_counter()
    matcher = STRATEGY_MATCHERS[request.strategy_id]

    try:
        result = matcher(
            document,
            request.page,
            NormRect(request.bbox.x0, request.bbox.y0, request.bbox.x1, request.bbox.y1),
            dpi=request.dpi,
            rotations=tuple(options.rotations),
            mirror=options.mirror,
            # Collect down to the floor rather than to the cutoff, so the caller receives the
            # candidates either side of the decision and can move it without a round trip.
            threshold=options.floor,
            floor=options.floor,
            iou_threshold=options.iou_threshold,
            max_matches=options.max_matches,
            include_heatmap=options.include_heatmap,
        )
    except ValueError as error:
        # A selection too small to correlate, or a page that does not exist. Both are things the
        # user did, and the message is written to be shown to them.
        raise HTTPException(status_code=400, detail=str(error)) from error

    scores = [candidate.score for candidate in result.detections.matches]
    threshold_used = (
        options.threshold
        if options.threshold is not None
        else choose_threshold(scores, floor=options.floor)
    )

    width = result.page_width
    height = result.page_height
    matches = [
        DetectMatch(
            bbox=Rect(
                x0=candidate.x / width,
                y0=candidate.y / height,
                x1=(candidate.x + candidate.width) / width,
                y1=(candidate.y + candidate.height) / height,
            ),
            page=request.page,
            score=candidate.score,
            rotation_deg=candidate.rotation_deg,
            mirrored=candidate.mirrored,
        )
        for candidate in result.detections.matches
    ]

    return DetectResponse(
        strategy_id=request.strategy_id,
        matches=matches,
        count=sum(1 for score in scores if score >= threshold_used),
        elapsed_ms=(time.perf_counter() - started) * 1000.0,
        threshold_used=float(threshold_used),
        floor_used=float(options.floor),
        truncated=result.detections.truncated,
        page_width=width,
        page_height=height,
        dpi=result.dpi,
        heatmap_png=_encode_heatmap(result.heatmap),
    )
