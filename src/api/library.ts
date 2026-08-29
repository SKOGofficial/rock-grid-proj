/**
 * Client for the document library.
 *
 * Summary:
 *   One function against one endpoint. It is a separate module purely so that swapping the
 *   folder-on-disk library for a real service later touches exactly one file.
 */

import type { LibraryFile } from '../types'

interface LibraryResponse {
  directory: string
  files: LibraryFile[]
}

/**
 * List the documents currently in the library.
 *
 * Parameters:
 *   signal: optional abort signal, so a component unmounting cancels the request.
 * Returns:
 *   Promise of the library directory path and its files, sorted by name.
 * Raises:
 *   Throws if the endpoint is unreachable or returns a non-2xx status.
 * Summary:
 *   Reads live from disk on every call, so dropping a file into `data/` and hitting refresh in
 *   the file list is enough to make it appear.
 */
export async function fetchLibrary(signal?: AbortSignal): Promise<LibraryResponse> {
  const response = await fetch('/api/library', { signal })
  if (!response.ok) {
    throw new Error(`Library unavailable (HTTP ${response.status})`)
  }
  return (await response.json()) as LibraryResponse
}
