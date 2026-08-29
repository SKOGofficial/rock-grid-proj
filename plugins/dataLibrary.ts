/**
 * Vite plugin that exposes the `data/` directory - the document "database" - to the browser.
 *
 * Summary:
 *   The library is deliberately just a folder on disk. This plugin is the thinnest possible
 *   layer that lets the browser see it, and it is the seam where a real backend service will
 *   eventually be substituted: swap these two routes for a proxy and nothing in `src/` changes.
 *
 *     GET /api/library   -> JSON listing of the supported files currently in `data/`
 *     GET /data/<name>   -> the file bytes, with HTTP Range support
 *
 *   Range support is not optional. pdf.js issues partial requests so it can render page 1 of a
 *   215-page, 20 MB drawing set without downloading the whole thing first; without a 206 path
 *   here, opening a document blocks on the full transfer.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect, Plugin } from 'vite'

/** Extensions the viewer knows how to rasterize. Anything else in `data/` is ignored. */
const SUPPORTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

export interface DataLibraryOptions {
  /** Directory to serve, relative to the project root. Defaults to `data`. */
  directory?: string
}

/**
 * Serialize a JSON body onto a response.
 *
 * Parameters:
 *   res: the Node response to write to.
 *   status: HTTP status code.
 *   body: any JSON-serializable value.
 * Returns:
 *   void
 * Raises:
 *   Nothing.
 * Summary:
 *   Small helper so the route handlers below stay readable.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Resolve a request path to a real file inside the library directory.
 *
 * Parameters:
 *   root: absolute path of the library directory.
 *   requestPath: the URL path after `/data/`, still percent-encoded.
 * Returns:
 *   The absolute file path, or `null` if the request escapes the library directory or names
 *   an unsupported extension.
 * Raises:
 *   Nothing.
 * Summary:
 *   Path-traversal guard. Decoding happens first, then the resolved path is checked to still
 *   sit under `root`, so an encoded `../../etc/passwd` cannot reach outside the folder.
 */
function resolveLibraryFile(root: string, requestPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null

  const absolute = path.resolve(root, '.' + path.posix.normalize('/' + decoded))
  const relative = path.relative(root, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  if (!SUPPORTED_EXTENSIONS.includes(path.extname(absolute).toLowerCase())) return null
  return absolute
}

/**
 * Parse a single-range `Range: bytes=a-b` header.
 *
 * Parameters:
 *   header: the raw Range header value, or undefined.
 *   size: total size of the file in bytes.
 * Returns:
 *   Inclusive `{ start, end }` byte offsets, `null` when no usable range was requested, or
 *   the string `unsatisfiable` when the range falls outside the file.
 * Raises:
 *   Nothing.
 * Summary:
 *   Only the single-range form is handled, which is all pdf.js ever sends. Multipart ranges
 *   fall back to a full-body response.
 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const rawStart = match[1]
  const rawEnd = match[2]
  if (rawStart === '' && rawEnd === '') return null

  let start: number
  let end: number
  if (rawStart === '') {
    // Suffix form: `bytes=-500` means the last 500 bytes.
    const suffixLength = Number(rawEnd)
    if (suffixLength <= 0) return 'unsatisfiable'
    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return 'unsatisfiable'
  }
  return { start, end }
}

/**
 * Build the connect middleware that backs both library routes.
 *
 * Parameters:
 *   root: absolute path of the library directory.
 * Returns:
 *   A connect-style middleware function.
 * Raises:
 *   Nothing; filesystem errors are turned into 404 or 500 JSON responses.
 * Summary:
 *   Shared by the dev server and the preview server so `npm run preview` behaves like `npm run dev`.
 */
function createMiddleware(root: string): Connect.NextHandleFunction {
  return async (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const isRead = req.method === 'GET' || req.method === 'HEAD'

    if (url.pathname === '/api/library') {
      if (!isRead) return next()
      try {
        const entries = await fsp.readdir(root, { withFileTypes: true })
        const supported = entries.filter(
          (entry) =>
            entry.isFile() && SUPPORTED_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()),
        )
        const files = await Promise.all(
          supported.map(async (entry) => {
            const stats = await fsp.stat(path.join(root, entry.name))
            const ext = path.extname(entry.name).toLowerCase()
            return {
              name: entry.name,
              url: '/data/' + encodeURIComponent(entry.name),
              ext,
              kind: ext === '.pdf' ? 'pdf' : 'image',
              sizeBytes: stats.size,
              modifiedAt: stats.mtime.toISOString(),
            }
          }),
        )
        files.sort((a, b) => a.name.localeCompare(b.name))
        sendJson(res, 200, { directory: root, files })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          sendJson(res, 200, { directory: root, files: [] })
          return
        }
        sendJson(res, 500, { error: (error as Error).message })
      }
      return
    }

    if (url.pathname.startsWith('/data/')) {
      if (!isRead) return next()
      const filePath = resolveLibraryFile(root, url.pathname.slice('/data/'.length))
      if (!filePath) {
        sendJson(res, 404, { error: 'Not found' })
        return
      }

      let stats: fs.Stats
      try {
        stats = await fsp.stat(filePath)
      } catch {
        sendJson(res, 404, { error: 'Not found' })
        return
      }
      if (!stats.isFile()) {
        sendJson(res, 404, { error: 'Not found' })
        return
      }

      const contentType =
        MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
      res.setHeader('Content-Type', contentType)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Cache-Control', 'no-cache')

      const range = parseRange(req.headers.range, stats.size)
      if (range === 'unsatisfiable') {
        res.statusCode = 416
        res.setHeader('Content-Range', 'bytes */' + stats.size)
        res.end()
        return
      }

      if (range) {
        res.statusCode = 206
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stats.size}`)
        res.setHeader('Content-Length', String(range.end - range.start + 1))
      } else {
        res.statusCode = 200
        res.setHeader('Content-Length', String(stats.size))
      }

      if (req.method === 'HEAD') {
        res.end()
        return
      }

      const stream = range
        ? fs.createReadStream(filePath, { start: range.start, end: range.end })
        : fs.createReadStream(filePath)
      stream.on('error', () => res.destroy())
      res.on('close', () => stream.destroy())
      stream.pipe(res)
      return
    }

    next()
  }
}

/**
 * Create the data-library Vite plugin.
 *
 * Parameters:
 *   options.directory: library folder relative to the project root (default `data`).
 * Returns:
 *   A Vite `Plugin` registering the library routes on the dev and preview servers.
 * Raises:
 *   Nothing.
 * Summary:
 *   Registered from `vite.config.ts`. The middleware is installed before Vite's own handlers so
 *   `/data/*` is never mistaken for a source-module request.
 */
export function dataLibrary(options: DataLibraryOptions = {}): Plugin {
  const directory = options.directory ?? 'data'
  let root = ''

  return {
    name: 'oneshot-takeoff:data-library',
    configResolved(config) {
      root = path.resolve(config.root, directory)
    },
    configureServer(server) {
      server.middlewares.use(createMiddleware(root))
    },
    configurePreviewServer(server) {
      server.middlewares.use(createMiddleware(root))
    },
  }
}
