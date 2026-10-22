/**
 * A deliberately broken protocol peer.
 *
 * The engine's transport failures — a protocol mismatch, a handshake that never
 * arrives, a request that is never answered, a process that dies mid-request — are
 * exactly the ones a *correct* engine never produces, so the real executable
 * cannot exercise them. This stub can, and the client is pointed at it with
 * `launchArgs` (the same seam the TIA Openness plugin documents for its controller stub).
 *
 * It is a Node script, so the client launches it as
 * `<node executable> <this file> <mode>`: the client's spawn takes an executable
 * and an argument list, and `node.exe` with no arguments would serve its REPL
 * instead of a protocol.
 *
 * Modes:
 *
 *   ready              a healthy peer: ready frame, then one `result` per request
 *   mismatch           a ready frame announcing protocol 2 instead of 1
 *   unknown-operations a ready frame that forgot two of the three operations
 *   silent             never writes the ready frame, but stays alive
 *   stall              writes ready, then never answers a request
 *   die                writes ready, then exits on the first request
 *
 * Usage: `node test/helpers/stub-engine.mjs <mode>`
 */

import { createInterface } from 'node:readline'

const mode = process.argv[2] ?? 'ready'

/** @param {object} frame */
function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

const operations = mode === 'unknown-operations' ? ['GetSchema'] : ['GetSchema', 'Ingest', 'Query', 'Update']

if (mode !== 'silent') {
  send({
    type: 'ready',
    protocol: mode === 'mismatch' ? 2 : 1,
    engine: 'Stub.Engine',
    runtime: process.versions.node,
    processArchitecture: process.arch === 'x64' ? 'x64' : 'x86',
    pid: process.pid,
    operations,
  })
}

if (mode !== 'silent') {
  // Keep a human note on stderr like the real engine does, so the client's stderr
  // capture is exercised by the same stub.
  process.stderr.write(`Stub.Engine: ready in mode ${mode}\n`)
}

let served = 0

const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  if (line.trim().length === 0) return
  served += 1
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }

  if (mode === 'stall') return
  if (mode === 'die') {
    // Delayed on purpose: the client must see the write succeed and then the
    // process disappear, which is the "died mid-request" case, not a failed write.
    setTimeout(() => process.exit(3), 50)
    return
  }

  send({
    type: 'result',
    protocol: 1,
    id: request.id,
    operation: request.operation,
    ok: true,
    durationMs: 1,
    data: { served, operation: request.operation, params: request.params },
  })
})

reader.on('close', () => process.exit(0))
