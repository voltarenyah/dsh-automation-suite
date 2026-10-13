/**
 * Stub controllers used by the protocol tests.
 *
 * The real controller cannot produce a stuck, exiting or protocol-mismatched
 * child without a broken TIA Portal installation, so the transport tests launch
 * these stubs instead (`ControllerOptions.launchArgs`). Each stub is a normal
 * Node script reading newline-delimited JSON on stdin.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'tia-openness-stub-'))

function stub(name, body) {
  const path = join(directory, `${name}.mjs`)
  writeFileSync(path, body, 'utf8')
  return path
}

const readline = `
import { createInterface } from 'node:readline'
const lines = createInterface({ input: process.stdin })
`

const frame = `
function frame(object) {
  process.stdout.write(JSON.stringify(object) + '\\n')
}
`

/** Reports readiness and then answers every request with a fixed failure. */
export const answeringStub = stub(
  'answering',
  `${readline}${frame}
frame({ type: 'ready', protocol: 1, controller: 'stub', controllerVersion: '0', pid: process.pid, openness: { available: true } })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  frame({
    type: 'result',
    protocol: 1,
    id: request.id,
    operation: request.operation,
    ok: false,
    durationMs: 1,
    error: { code: 'unsupported_operation', message: 'the stub refuses everything', details: { echo: request.params } },
  })
})
`,
)

/** Reports readiness, then prints output that is not a protocol frame. */
export const noisyStub = stub(
  'noisy',
  `${readline}${frame}
process.stdout.write('this line is not JSON at all\\n')
frame({ type: 'ready', protocol: 2, controller: 'stub', controllerVersion: '0', pid: process.pid, openness: {} })
lines.on('line', () => {
  process.stdout.write('{ "type": "result", broken\\n')
})
`,
)

/** Reports readiness and then never answers again. */
export const silentStub = stub(
  'silent',
  `${readline}${frame}
frame({ type: 'ready', protocol: 1, controller: 'stub', controllerVersion: '0', pid: process.pid, openness: {} })
lines.on('line', () => { /* deliberately never answers */ })
`,
)

/** Exits without ever reporting readiness. */
export const crashingStub = stub(
  'crashing',
  `process.stderr.write('stub: cannot start\\n')
process.exit(3)
`,
)

/** Exits in the middle of a request. */
export const dyingStub = stub(
  'dying',
  `${readline}${frame}
frame({ type: 'ready', protocol: 1, controller: 'stub', controllerVersion: '0', pid: process.pid, openness: {} })
lines.on('line', () => {
  process.stderr.write('stub: dying now\\n')
  process.exit(9)
})
`,
)

/** Emits progress frames before the result, as the real controller does. */
export const progressStub = stub(
  'progress',
  `${readline}${frame}
frame({ type: 'ready', protocol: 1, controller: 'stub', controllerVersion: '0', pid: process.pid, openness: {} })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  frame({ type: 'progress', id: request.id, phase: 'export', message: 'working' })
  frame({ type: 'result', protocol: 1, id: request.id, operation: request.operation, ok: true, durationMs: 2, data: { stub: true }, changes: [], diagnostics: [] })
})
`,
)
