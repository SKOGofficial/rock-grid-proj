"""
Turning a page of a drawing into an array the matcher can work on.

Summary:
    Everything downstream is pixels, and this is where pixels come from. Two properties matter
    more than the rest.

    First, the page and the exemplar template are rendered from *the same* call at *the same*
    DPI. Normalized cross-correlation is not scale-invariant, so a template rasterized even a few
    percent off from the page it is searched against loses score on every candidate, and a real
    mismatch finds nothing at all. Cropping the template out of the page array - rather than
    accepting a pre-rendered crop from the browser - makes that class of bug impossible.

    Second, the scale arithmetic here has to agree exactly with `scaleForDpi()` in
    `src/lib/source.ts`. A PDF has no pixels; it is vector geometry measured in points, and a
    point is 1/72 inch by definition. Both renderers take a multiplier rather than a DPI, so both
    compute `dpi / 72` and neither is allowed to be clever about it.
"""

from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path
from typing import NamedTuple

import numpy as np
import pypdfium2 as pdfium

#: PDF user-space units are 1/72 inch by definition. This is the whole of the DPI-to-scale bridge.
POINTS_PER_INCH = 72.0

#: Ceiling on a rendered page, in pixels.
#:
#: The drawing sets in scope are 36x24 inches, which is 19.4 MP at the default 150 DPI search
#: resolution - comfortable. A 60x40 plot sheet at the same DPI would be 54 MP, and the float32
#: correlation response map is four times whatever this is. Rather than fail on a large sheet, the
#: DPI is quietly reduced and the caller is told what was actually used.
MAX_PIXELS = 40_000_000

#: Rendered pages held in memory. Each is width*height bytes - about 19 MB for a D-size sheet at
#: 150 DPI - so four is roughly 78 MB. Detection re-runs (a threshold adjustment, a second
#: exemplar on the same sheet) then cost nothing.
_CACHE_SIZE = 4


class RenderedPage(NamedTuple):
    """A rasterized page, and the resolution it was actually rendered at."""

    #: uint8 grayscale, shape (height, width). Read-only - see `render_page`.
    image: np.ndarray
    #: The DPI used, which may be below the DPI requested if `MAX_PIXELS` forced a reduction.
    dpi: float
    #: 1-based, echoed back so a caller holding several results cannot mix them up.
    page: int


def page_count(path: Path) -> int:
    """
    Count the pages in a document.

    Parameters:
        path: absolute path to the PDF.
    Returns:
        The number of pages.
    Raises:
        pypdfium2 errors if the file is missing or is not a readable PDF.
    Summary:
        Used to validate a requested page number before rendering, so an out-of-range request
        fails with a clear message instead of an index error from deep inside the renderer.
    """
    with pdfium.PdfDocument(path) as document:
        return len(document)


def clamp_dpi(width_pt: float, height_pt: float, dpi: float, max_pixels: int = MAX_PIXELS) -> float:
    """
    Reduce a DPI until the rendered page fits within a pixel budget.

    Parameters:
        width_pt, height_pt: intrinsic page size in PDF points.
        dpi: the requested resolution.
        max_pixels: the ceiling on width * height.
    Returns:
        The requested DPI, or the largest DPI whose render fits the budget.
    Raises:
        Nothing.
    Summary:
        Pixel count grows with the square of DPI, so the correction is a square root rather than a
        ratio. Separated from rendering because it is pure arithmetic and worth being able to
        check on its own.
    """
    scale = dpi / POINTS_PER_INCH
    pixels = (width_pt * scale) * (height_pt * scale)
    if pixels <= max_pixels or pixels <= 0:
        return float(dpi)
    return float(dpi) * math.sqrt(max_pixels / pixels)


def _render_uncached(path: str, page: int, dpi: float, max_pixels: int) -> RenderedPage:
    """
    Rasterize one page. See `render_page` for the parameters.

    Summary:
        The private half of the cached pair. Kept separate so the caching layer holds nothing but
        a dictionary lookup, and so this can be called directly when debugging a cache problem.
    """
    with pdfium.PdfDocument(path) as document:
        total = len(document)
        if not 1 <= page <= total:
            raise ValueError(f"Page {page} is out of range; the document has {total} pages")

        # The wire contract is 1-based and pypdfium2 is 0-based. This is the only place in the
        # service that conversion happens - an off-by-one here would silently search the wrong
        # sheet and report a confident count for it.
        pdf_page = document[page - 1]

        width_pt, height_pt = pdf_page.get_size()
        effective_dpi = clamp_dpi(width_pt, height_pt, dpi, max_pixels)

        bitmap = pdf_page.render(
            scale=effective_dpi / POINTS_PER_INCH,
            # Single channel straight out of PDFium rather than rendering BGRA and converting:
            # a third of the memory, one less full-image pass, and matchTemplate wants one
            # channel anyway.
            grayscale=True,
            # Drawings are ink on paper. Without an opaque white fill the background decodes to
            # 0 - which is black - inverting ink and paper and destroying correlation.
            fill_color=(255, 255, 255, 255),
            # pdf.js renders annotations by default, so this side must too. The two rasterizers
            # disagreeing about what is on the page would be a subtle way to lose matches.
            draw_annots=True,
        )

        array = np.asarray(bitmap.to_numpy())
        if array.ndim == 3:
            array = array[:, :, 0]

        # `to_numpy` is a view over the bitmap's buffer, which PDFium frees when this block exits.
        # The copy has to happen while the document is still open.
        image = np.array(array, dtype=np.uint8, copy=True, order="C")

    # The array is handed out of a cache, so several callers may hold the same object. Freezing it
    # turns "someone mutated a cached page" from a mystifying bug into an immediate error.
    image.flags.writeable = False
    return RenderedPage(image=image, dpi=effective_dpi, page=page)


@lru_cache(maxsize=_CACHE_SIZE)
def _render_cached(
    path: str,
    page: int,
    dpi: float,
    max_pixels: int,
    fingerprint: tuple[int, int],
) -> RenderedPage:
    """
    Memoized `_render_uncached`.

    Summary:
        `fingerprint` is the file's (mtime_ns, size). It is unused in the body and exists purely
        to be part of the cache key, so replacing a drawing in the library invalidates the entry
        rather than serving pixels from the file that used to be there.
    """
    del fingerprint
    return _render_uncached(path, page, dpi, max_pixels)


def render_page(
    path: Path,
    page: int,
    dpi: float,
    max_pixels: int = MAX_PIXELS,
) -> RenderedPage:
    """
    Rasterize a page to a grayscale array.

    Parameters:
        path: absolute path to the PDF. Assumed already validated - this function does not check
            that it sits inside the library directory, because that check belongs at the HTTP
            boundary where untrusted input actually arrives.
        page: 1-based page number.
        dpi: desired resolution. May be reduced; see the returned `dpi`.
        max_pixels: ceiling on the rendered pixel count.
    Returns:
        A `RenderedPage`. Its `image` is **read-only** and may be shared with other callers; copy
        it before modifying.
    Raises:
        ValueError: the page number is out of range.
        OSError: the file cannot be read.
    Summary:
        The entry point for every pixel in the service. Results are cached on the file's identity
        and modification time, so re-running detection against the same sheet - which the user
        will do while adjusting a threshold - does not re-rasterize 19 MP.
    """
    stats = path.stat()
    return _render_cached(
        str(path),
        int(page),
        # Rounded so that floating-point noise in a requested DPI cannot miss an otherwise
        # identical cache entry.
        round(float(dpi), 3),
        int(max_pixels),
        (stats.st_mtime_ns, stats.st_size),
    )
