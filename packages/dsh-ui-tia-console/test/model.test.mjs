/**
 * The console's event fold, driven with fixtures shaped exactly like the
 * session events the browser receives. No DOM, no React, no host.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  errorCodeOf,
  firstLine,
  foldTiaState,
  formatElapsed,
  parseCompileText,
  parseProjectText,
} from '../src/client/model.js'

/** Wrap events the way the session event window does. */
function windowOf(...events) {
  return events.map((event) => ({ type: 'event', event }))
}

function commandRun(id, name, time = 1000) {
  return { type: 'command/run', time, data: { commandId: id, name, args: '' } }
}

function commandDone(id, kind, text, time = 2000) {
  return { type: 'command/done', time, data: { commandId: id, kind, text } }
}

function toolCall(id, name, time = 1000) {
  return { type: 'tool/call', time, data: { callId: id, name, arguments: '{}' } }
}

function toolResult(id, isError, text, time = 2000) {
  return {
    type: 'tool/result',
    time,
    data: {
      message: {
        content: [{ content: [{ type: 'text', text }], isError }],
        source: { callId: id },
      },
    },
  }
}

const OPENED =
  'Opened Create Project Test2 — 1 PLC software, 1155 block(s), visible TIA Portal\n' +
  'Project: Create Project Test2 (C:\\work\\tia\\Create Project Test2.ap17)'

const CLOSED = 'Closed Create Project Test2 — saved; TIA Portal shut down\nProject: Create Project Test2'

test('a fresh window is unknown', () => {
  const state = foldTiaState([])
  assert.equal(state.phase, 'unknown')
  assert.equal(state.operation, null)
  assert.equal(state.project, null)
})

test('a running /tia-open shows opening and its start time', () => {
  const state = foldTiaState(windowOf(commandRun('c1', 'tia-open', 5000)))
  assert.equal(state.phase, 'opening')
  assert.equal(state.operation.name, 'tia-open')
  assert.equal(state.operation.label, 'op.open')
  assert.equal(state.operation.startedAt, 5000)
})

test('a successful /tia-open opens the project and drops stale compile state', () => {
  const state = foldTiaState(
    windowOf(
      commandRun('c0', 'tia-compile', 1000),
      commandDone('c0', 'success', 'Compile state: Success, errors: 0, warnings: 1', 2000),
      commandRun('c1', 'tia-open', 3000),
      commandDone('c1', 'success', OPENED, 4000),
    ),
  )
  assert.equal(state.phase, 'open')
  assert.equal(state.operation, null)
  assert.equal(state.project.name, 'Create Project Test2')
  assert.equal(state.project.path, 'C:\\work\\tia\\Create Project Test2.ap17')
  assert.equal(state.project.since, 4000)
  assert.equal(state.compile, null)
})

test('a model open_project is reflected the same way', () => {
  const state = foldTiaState(
    windowOf(
      toolCall('t1', 'open_project', 1000),
      toolResult('t1', false, 'OpenProject succeeded.\nProject: Line1 (C:\\p\\Line1.ap17)', 2500),
    ),
  )
  assert.equal(state.phase, 'open')
  assert.equal(state.project.name, 'Line1')
  assert.equal(state.project.path, 'C:\\p\\Line1.ap17')
})

test('a successful /tia-close returns to idle and forgets the project', () => {
  const state = foldTiaState(
    windowOf(
      commandRun('c1', 'tia-open', 1000),
      commandDone('c1', 'success', OPENED, 2000),
      commandRun('c2', 'tia-close', 3000),
      commandDone('c2', 'success', CLOSED, 4000),
    ),
  )
  assert.equal(state.phase, 'idle')
  assert.equal(state.project, null)
})

test('a compile result is parsed from the command text', () => {
  const state = foldTiaState(
    windowOf(
      commandRun('c1', 'tia-open', 1000),
      commandDone('c1', 'success', OPENED, 2000),
      commandRun('c2', 'tia-compile', 3000),
      commandDone('c2', 'success', 'Compile Sino_PEI: no errors (10 warning(s))\nCompile state: Warning, errors: 0, warnings: 10, messages: 60', 4000),
    ),
  )
  assert.equal(state.phase, 'open')
  assert.deepEqual(state.compile, { at: 4000, state: 'Warning', errors: 0, warnings: 10 })
})

test('a compile result is parsed from a model tool result too', () => {
  const state = foldTiaState(
    windowOf(
      toolCall('t1', 'compile_plc', 1000),
      toolResult('t1', false, 'Compile state: Error, errors: 3, warnings: 0, messages: 4', 2000),
    ),
  )
  assert.equal(state.compile.errors, 3)
  assert.equal(state.compile.state, 'Error')
})

test('a save records when it happened', () => {
  const state = foldTiaState(
    windowOf(
      commandRun('c1', 'tia-open', 1000),
      commandDone('c1', 'success', OPENED, 2000),
      commandRun('c2', 'tia-save', 3000),
      commandDone('c2', 'success', 'Saved Create Project Test2 in place (modified before save: yes)', 4000),
    ),
  )
  assert.equal(state.savedAt, 4000)
})

test('project_not_open clears the project state and keeps the error', () => {
  const state = foldTiaState(
    windowOf(
      commandRun('c1', 'tia-open', 1000),
      commandDone('c1', 'success', OPENED, 2000),
      commandRun('c2', 'tia-save', 3000),
      commandDone('c2', 'error', 'SaveProject FAILED.\nError code: project_not_open\nReason: No project is open.', 4000),
    ),
  )
  assert.equal(state.phase, 'idle')
  assert.equal(state.project, null)
  assert.equal(state.lastError.code, 'project_not_open')
})

test('a missing controller marks the bar unavailable', () => {
  const state = foldTiaState(
    windowOf(
      commandRun('c1', 'tia-open', 1000),
      commandDone('c1', 'error', 'OpenProject FAILED.\nError code: controller_not_found\nReason: no exe', 2000),
    ),
  )
  assert.equal(state.phase, 'unavailable')
})

test('project_already_open means a project is open even when the name is unknown', () => {
  const state = foldTiaState(
    windowOf(
      commandRun('c1', 'tia-open', 1000),
      commandDone('c1', 'error', 'OpenProject FAILED.\nError code: project_already_open\nReason: already open', 2000),
    ),
  )
  assert.equal(state.phase, 'open')
  assert.notEqual(state.project, null)
  assert.equal(state.project.name, null)
})

test('/tia-info refreshes a known project without losing its open time', () => {
  const state = foldTiaState(
    windowOf(
      commandRun('c1', 'tia-open', 1000),
      commandDone('c1', 'success', OPENED, 2000),
      commandRun('c2', 'tia-info', 3000),
      commandDone('c2', 'success', 'Project Create Project Test2 — 1 PLC software, modified', 4000),
    ),
  )
  assert.equal(state.project.since, 2000)
  assert.equal(state.project.name, 'Create Project Test2')
})

test('/tia-info refreshing a controller with no project is not an error', () => {
  const state = foldTiaState(
    windowOf(
      commandRun('c1', 'tia-info', 1000),
      commandDone('c1', 'error', 'ProjectInfo FAILED.\nError code: project_not_open\nReason: No project is open.', 2000),
    ),
  )
  assert.equal(state.phase, 'idle')
  assert.equal(state.project, null)
  assert.equal(state.lastError, null)
  assert.equal(state.lastResult.kind, 'error')
})

test('a queued second operation becomes the visible one after the first settles', () => {
  const state = foldTiaState(
    windowOf(
      commandRun('c1', 'tia-open', 1000),
      commandRun('c2', 'tia-compile', 1500),
      commandDone('c1', 'success', OPENED, 2000),
    ),
  )
  assert.equal(state.phase, 'compiling')
  assert.equal(state.operation.name, 'tia-compile')
  assert.equal(state.operation.startedAt, 1500)
})

test('transient entries and unknown operations are ignored', () => {
  const state = foldTiaState([
    { type: 'transient', event: { type: 'assistant/live-chunk' } },
    { type: 'event', event: commandRun('c1', 'compact', 1000) },
  ])
  assert.equal(state.phase, 'unknown')
  assert.equal(state.operation, null)
})

test('helpers parse the shapes the renderers produce', () => {
  assert.deepEqual(parseProjectText('Project: Line1 (C:\\p\\Line1.ap17)'), {
    name: 'Line1',
    path: 'C:\\p\\Line1.ap17',
  })
  assert.deepEqual(parseCompileText('Compile state: Success, errors: 0, warnings: 2'), {
    state: 'Success',
    errors: 0,
    warnings: 2,
  })
  assert.equal(errorCodeOf('Error code: project_not_open\nReason: x'), 'project_not_open')
  assert.equal(firstLine('a\nb'), 'a')
  assert.equal(formatElapsed(42_000), '42s')
  assert.equal(formatElapsed(102_000), '1:42')
})
