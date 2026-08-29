# Containerization plan

**Status: designed, not implemented.** This is a spec to pick up later. Nothing in this document has
been built yet — the app currently runs only via `npm install && npm run dev`.

The question this answers: *can this be sent to another computer and actually run there, and is
Docker, conda, or venv the right tool for an application this narrow?*

---

## 1. The tooling decision

**conda and venv are Python environment managers. This project contains no Python.** Verified: no
`.py` files, no `requirements.txt`, no `environment.yml`, no `pyproject.toml`. It is Node 22 +
TypeScript end to end. Neither tool can express "requires Node 22.12+" or install an npm package, so
for what exists today the real comparison is Docker vs. plain npm.

| | What it actually pins | Fits this app? |
|---|---|---|
| **venv** | Python packages only — not the interpreter, not the OS | No. Nothing for it to manage |
| **conda** | Python + C libraries + the interpreter. Heavy, and awkward around Node | No. Wrong ecosystem |
| **npm + `package-lock.json`** | JS dependencies exactly — but **not** the Node runtime or the OS | Partly. The lockfile is already reproducible; the gap is the host's Node version |
| **Docker** | Node version, OS, dependencies, and the run command | **Yes.** Closes the whole gap |

### Why Docker is a particularly good fit here

Not a default answer — three specific properties of this app:

- **The built bundle makes zero network calls.** The only URLs in `dist/` are React error-message
  links. No CDN, no web fonts, no telemetry. The container runs fully offline.
- **`dist/` is 1.9 MB**, and nothing needs native modules. The runtime image needs **no
  `node_modules` at all** — against 164 MB of dependencies that never have to ship.
- **The library is a directory**, which maps exactly onto a bind mount. The recipient points the
  container at their own drawings; nothing about the image needs to change.

Expected image size: **~60 MB**.

### Where venv *does* eventually belong

Inside the future CV service's own container. When the detection work from
[FUTURE_WORK.md](FUTURE_WORK.md) lands it will be Python (numpy, scipy, OpenCV, possibly torch), and
the two tools stack rather than compete: **Docker pins the OS, the CUDA runtime and the Python
version; a venv inside it pins the wheels.** Section 5 below leaves a defined slot for that so the
deployment does not need redesigning when it arrives.

### What the recipient needs

Docker, ~200 MB of disk, and a browser. Note that **Docker Desktop requires a paid subscription for
organizations over 250 employees or $10M revenue**, and for government entities of any size.
[Podman Desktop](https://podman-desktop.io/) and
[Rancher Desktop](https://rancherdesktop.io/) are Apache-2.0 with no such threshold and run this
Dockerfile unchanged — it is a plain OCI build with no Docker-specific features.

If they cannot install a container runtime at all, the fallback is genuinely fine: Node 22.12+ (or
20.19+), then `npm ci && npm run build && npm start`. Both paths should stay documented.

---

## 2. Extract the library middleware so two servers can share it

`plugins/dataLibrary.ts` currently has the `/api/library` and `/data/*` logic locked inside a Vite
plugin. The container needs those routes without Vite.

- **New `server/libraryMiddleware.ts`** — move `SUPPORTED_EXTENSIONS`, the MIME map, `sendJson`,
  `resolveLibraryFile` (the path-traversal guard) and `parseRange` out of the plugin. Types become
  plain `IncomingMessage` / `ServerResponse`, so the file has **no Vite import** and the production
  bundle stays small. Export `createLibraryMiddleware(root)`.
- **`plugins/dataLibrary.ts`** shrinks to the Vite wrapper around it, and gains a `DATA_DIR`
  environment override so dev and container resolve the library identically.

One implementation of the Range and path-traversal logic, used by both. That is the point — it is the
security-sensitive part, and it should not be duplicated.

---

## 3. A real server: `server/serve.ts`

Node's `http` module. No framework, no runtime dependencies.

- `/api/library` and `/data/*` through the shared middleware.
- Static `dist/`: `immutable, max-age=31536000` for the content-hashed `assets/*`, `no-cache` for
  `index.html`.
- **SPA fallback**, so `/test` and `/strategy/patch-rag` survive a hard refresh — but never for
  `/api/*` or `/data/*`, which must 404 properly rather than returning HTML.
- The same resolve-then-verify path guard as the library route.
- `HOST` / `PORT` / `DATA_DIR` / `DIST_DIR` from the environment, defaulting to `0.0.0.0:5173`.
- **SIGTERM handling.** Without it every `docker stop` waits out the full 10-second timeout.

### Why not just `vite preview`

It would work, and it is one line — the data-library plugin already registers itself via
`configurePreviewServer`. Two reasons not to:

1. **Vite ≥ 6.0.9 rejects requests whose `Host` header is not in `preview.allowedHosts`**, a
   DNS-rebinding guard. A container hostname or a reverse proxy sends exactly such a header, and
   `Blocked request. This host is not allowed.` is a well-known Docker failure mode
   ([vite#19411](https://github.com/vitejs/vite/issues/19411),
   [preview options](https://vite.dev/config/preview-options)).
2. The Vite docs are explicit that preview is for checking a build locally, not for serving.

A ~100-line static server removes both problems *and* drops `node_modules` from the runtime image
entirely, which `vite preview` cannot do since it needs Vite installed.

---

## 4. Build wiring

- Add **esbuild** as an explicit devDependency. It is already present as a Vite transitive
  dependency, but relying on that is fragile.
- Bundle the server:
  `esbuild server/serve.ts --bundle --platform=node --format=esm --outfile=dist-server/serve.mjs`
- Scripts: `build` becomes `typecheck && vite build && build:server`; add `build:server`; add
  `start` = `node dist-server/serve.mjs`.
- `tsconfig.json` `include` gains `server`.

---

## 5. The container

### `Dockerfile` — two stages

- **build**: `node:22.20-alpine`. Pin the minor version; `node:22` drifts, and reproducibility is the
  entire reason for doing this. `npm ci`, then `npm run build`.
- **runtime**: same base, copying only `dist/` and `dist-server/`. **No `node_modules`.** Runs as the
  image's built-in non-root `node` user. `HEALTHCHECK` hits `/api/library` using Node 22's global
  `fetch`, so the image needs neither curl nor wget installed.

### `.dockerignore`

Excludes `node_modules`, `dist`, `dist-server`, `.git`, `.claude`, and — critically — **`data/`**.
Two independent reasons:

- It keeps 21 MB of a client's construction drawings out of the build context and out of any image
  that might get distributed. **Never bake customer drawings into a shippable image.**
- Excluding `node_modules` avoids the Rollup/esbuild optional-dependency failure that occurs when a
  Windows-built `node_modules` is copied into a Linux image. `npm ci` inside the build stage installs
  the correct platform binaries.

### `compose.yaml`

One `app` service: `./data:/data:ro` bind-mounted (read-only — the app only ever reads), port 5173,
`DATA_DIR=/data`.

Plus a **commented-out `cv` service** and the proxy configuration, marking where the detection
backend from FUTURE_WORK.md plugs in. Leaving the slot defined now is cheap; discovering the
deployment needs restructuring later is not.

---

## 6. GitHub

- **`.gitattributes`** with `* text=auto eol=lf`. The repo was authored on Windows and git already
  warns about CRLF conversion on every file. Without this, a future shell script or config arrives at
  a Linux container with CRLF line endings and fails confusingly.
- **`.github/workflows/ci.yml`** — on push and PR: `npm ci`, `npm run build`, then `docker build`.
  This is the real answer to "will it run on another computer": a clean Ubuntu runner that has never
  seen the project builds it from scratch on every commit. **Green CI is the proof.**
- **README**: clone-to-running for both paths, plus a short version of §1 so the tooling decision is
  recorded rather than re-argued later.

### One thing to get right

A fresh clone has an **empty** `data/` directory — it is gitignored, and deliberately so. The file
list already handles this (*"No documents yet. Drop a PDF or PNG into the data folder and refresh"*),
but the README must say to copy drawings in, and the empty case should be verified rather than
assumed.

---

## 7. Files to create or change

| File | Change |
|---|---|
| `server/libraryMiddleware.ts` | New — shared `/api/library` + `/data/*` handler, Vite-free |
| `server/serve.ts` | New — production HTTP server |
| `plugins/dataLibrary.ts` | Shrinks to a Vite wrapper; adds the `DATA_DIR` override |
| `Dockerfile`, `.dockerignore`, `compose.yaml` | New |
| `.gitattributes`, `.github/workflows/ci.yml` | New |
| `package.json`, `tsconfig.json` | Scripts, esbuild dependency, `server` in `include` |
| `README.md` | Distribution instructions and the tooling rationale |

---

## 8. Verification checklist

Locally, before anything is pushed:

1. `npm run build` — typecheck, Vite build and server bundle all clean.
2. `npm start` outside a container: `/api/library` returns the library, `/test` deep-links, and
   `curl -r 0-99` on the PDF returns **206** with a correct `Content-Range`.
3. `docker compose up --build`, then against the container:
   - `curl localhost:5173/api/library` lists the mounted drawings
   - `curl -r 0-99 localhost:5173/data/skanska-drawing-set.pdf` returns **206** — this proves Range
     survives the container, which is what stops pdf.js pulling all 21 MB before the first page paints
   - `curl localhost:5173/test` returns the app HTML, not a 404
   - `curl localhost:5173/data/../package.json` is rejected
4. `docker image ls` shows ≈60 MB, and `docker run --rm <image> ls node_modules` **fails** — proving
   no dependencies shipped.
5. Point the mount at an **empty** directory; confirm the UI shows the empty-library message rather
   than an error.
6. Drive the containerized app in a browser: load a drawing, draw a box, confirm the exemplar chip
   renders — the same end-to-end path verified when the viewer was built.
7. `docker stop` returns promptly rather than hanging for 10 seconds, confirming SIGTERM handling.

Then push and confirm the GitHub Actions run is green on a clean runner.
