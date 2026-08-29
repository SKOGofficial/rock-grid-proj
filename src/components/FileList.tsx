/**
 * The library panel: every document currently sitting in `data/`.
 *
 * Summary:
 *   Reads `GET /api/library`, which is a live directory read - so Refresh is enough to pick up a
 *   file that was just dropped into the folder. No upload flow, no index to rebuild.
 */

import { useCallback, useEffect, useState } from 'react'

import { fetchLibrary } from '../api/library'
import { formatBytes } from '../lib/geometry'
import type { LibraryFile } from '../types'

interface FileListProps {
  activeFileName: string | null
  onSelectFile: (file: LibraryFile) => void
}

/**
 * Render the library panel.
 *
 * Parameters:
 *   props: see `FileListProps`.
 * Returns:
 *   The panel element.
 * Raises:
 *   Nothing; fetch failures render as an inline message.
 * Summary:
 *   Fetches once on mount and on demand. The footer names the directory on disk, because the
 *   whole point of this design is that the user can go put files there.
 */
export function FileList({ activeFileName, onSelectFile }: FileListProps) {
  const [files, setFiles] = useState<LibraryFile[]>([])
  const [directory, setDirectory] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    fetchLibrary(controller.signal)
      .then((response) => {
        setFiles(response.files)
        setDirectory(response.directory)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [reloadNonce])

  const refresh = useCallback(() => setReloadNonce((value) => value + 1), [])

  return (
    <aside className="file-panel">
      <div className="file-panel__head">
        <span className="file-panel__title">Library</span>
        <button type="button" className="tool-button" onClick={refresh} disabled={loading}>
          {loading ? 'Loading' : 'Refresh'}
        </button>
      </div>

      <div className="file-panel__list">
        {error && <p className="file-panel__empty">{error}</p>}
        {!error && !loading && files.length === 0 && (
          <p className="file-panel__empty">
            No documents yet. Drop a PDF or PNG into the data folder and refresh.
          </p>
        )}
        {files.map((file) => {
          const active = file.name === activeFileName
          return (
            <button
              type="button"
              key={file.name}
              className={'file-item' + (active ? ' file-item--active' : '')}
              onClick={() => onSelectFile(file)}
              title={file.name}
            >
              <span className="file-item__badge">{file.ext.replace('.', '').toUpperCase()}</span>
              <span>
                <span className="file-item__name">{file.name}</span>
                <br />
                <span className="file-item__meta">{formatBytes(file.sizeBytes)}</span>
              </span>
            </button>
          )
        })}
      </div>

      {directory && (
        <p className="file-panel__note">
          Served live from <code>{directory}</code>
        </p>
      )}
    </aside>
  )
}
