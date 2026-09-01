/**
 * Start the detection service from the project's virtualenv.
 *
 * A wrapper rather than a bare npm script because the interpreter lives at a different path on
 * Windows than elsewhere, and because a missing venv should say so plainly instead of failing
 * with "command not found".
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const python =
  process.platform === 'win32' ? 'cv/.venv/Scripts/python.exe' : 'cv/.venv/bin/python'

if (!existsSync(python)) {
  console.error(`No virtualenv at ${python}.\n\nCreate it first:\n  python -m venv cv/.venv\n  ${python} -m pip install -r cv/requirements.txt\n\nSee cv/README.md.`)
  process.exit(1)
}

spawn(python, ['-m', 'uvicorn', 'cv.app.main:app', '--host', '127.0.0.1', '--port', '8000'], {
  stdio: 'inherit',
}).on('exit', (code) => process.exit(code ?? 0))
