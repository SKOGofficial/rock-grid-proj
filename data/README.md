# Document library

This directory **is** the database. There is no schema, no server process, and no migration —
a document is in the library when its file is in this folder, and it is gone when the file is
deleted. That is a deliberate choice for this stage of the project: the interesting problem is
computer vision, not storage.

## What belongs here

Drawing sets and single sheets in any of these formats:

| Extension | Kind | Notes |
|---|---|---|
| `.pdf` | `pdf` | Multi-page. Rasterized in the browser by pdf.js. |
| `.png` `.jpg` `.jpeg` `.webp` `.gif` `.bmp` | `image` | Treated as single-page documents. |

Anything else in this folder is ignored by the listing endpoint.

## How it reaches the browser

`plugins/dataLibrary.ts` registers two routes on the Vite dev server:

- `GET /api/library` — a live `readdir` of this folder. Drop a file in, refresh the file list,
  and it is there. No restart, no re-index.
- `GET /data/<filename>` — the bytes, with HTTP `Range` support so pdf.js can stream page 1 of a
  large set without pulling the whole file.

## Seed data

`skanska-drawing-set.pdf` — 28 sheets, ~21 MB, copied from `Skanksa (1).pdf`. This is the drawing
set the detection work targets: doors, detail markers, elevation markers, and electrical
receptacles.

The drawing files are **not** committed (see the repository `.gitignore`); they are large binaries
and, in a real deployment, would be customer documents. Only this README and a `.gitkeep` are
tracked, so the folder survives a fresh clone. To restore the seed data on a new machine, copy the
source PDF back in under that name.

## Replacing this with a real backend later

The two routes above are the entire contract between the UI and storage. When the library needs to
become an actual service — object storage, per-project scoping, uploads, access control — implement
those two endpoints and point Vite at them with a `server.proxy` entry. Nothing under `src/`
changes, because nothing under `src/` knows this is a folder.
