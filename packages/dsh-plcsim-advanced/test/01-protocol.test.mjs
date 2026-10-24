import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROTOCOL_VERSION,
  isOperation,
  isReadyFrame,
  isResultFrame,
  parseFrame,
} from '../lib/protocol.js'

test('the wire protocol exposes exactly the four runtime operations', () => {
  assert.equal(PROTOCOL_VERSION, 1)
  assert.equal(isOperation('Status'), true)
  assert.equal(isOperation('Instance'), true)
  assert.equal(isOperation('Run'), true)
  assert.equal(isOperation('Tags'), true)
  assert.equal(isOperation('Download'), false)
  assert.equal(isOperation('Nope'), false)
})

test('ready and result frames are recognized, other JSON is not', () => {
  const ready = parseFrame(
    JSON.stringify({ type: 'ready', protocol: 1, controller: 'c', version: '0.1.0', apiDir: 'x', api: {} }),
  )
  assert.equal(isReadyFrame(ready), true)

  const result = parseFrame(
    JSON.stringify({
      type: 'result',
      protocol: 1,
      id: '1',
      operation: 'Status',
      ok: true,
      data: {},
      error: null,
      durationMs: 1,
    }),
  )
  assert.equal(isResultFrame(result), true)

  assert.equal(isReadyFrame({ type: 'log', protocol: 1 }), false)
  assert.equal(isResultFrame({ type: 'ready', protocol: 1 }), false)
  assert.throws(() => parseFrame('[]'), /not a JSON object/)
})
