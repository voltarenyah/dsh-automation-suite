import test from 'node:test'
import assert from 'node:assert/strict'

import {
  callKey,
  emptyState,
  objectHint,
  planComplete,
  planStart,
  readTodos,
  stateFromLog,
  taskContent,
  TRACKED_TOOLS,
} from '../lib/bridge.js'
import { apply } from '../lib/index.js'

/** A fake host context plus a fake session wired the way the bridge expects. */
function createHarness() {
  const listeners = new Map()
  const ctx = {
    listeners,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(event, listener) {
      listeners.set(event, listener)
    },
  }
  const session = {
    log: [],
    append(type, data) {
      const event = { type, data }
      this.log.push(event)
      listeners.get('session/event')?.(this, event)
      return event
    },
  }
  apply(ctx)
  return { ctx, session }
}

let nextCall = 0

/** Run one tool through the real listener pair the bridge registered. */
async function runTool(harness, name, args, result = { isError: false }) {
  nextCall += 1
  const exec = {
    name,
    callId: `call-${nextCall}`,
    arguments: args,
    agent: { session: harness.session },
  }
  await harness.ctx.listeners.get('tools/execute')(exec, async () => result)
  const decision = await harness.ctx.listeners.get('tools/post-execute')(exec, result, async () => ({
    kind: 'accept',
  }))
  return { exec, decision }
}

/** @returns the latest todo list the bridge or model wrote. */
function latestTodos(session) {
  for (let index = session.log.length - 1; index >= 0; index -= 1) {
    const event = session.log[index]
    if (event.type === 'todo/write') return event.data.todos
  }
  return null
}

test('a TIA tool with no model list creates and settles one item', async () => {
  const harness = createHarness()
  await runTool(harness, 'open_project', { project_path: 'C:\\work\\Demo.ap17' })

  const writes = harness.session.log.filter((event) => event.type === 'todo/write')
  assert.equal(writes.length, 2, 'one write when the operation starts, one when it settles')
  assert.deepEqual(writes[0].data.todos, [
    { content: 'TIA · open_project · Demo.ap17', status: 'in_progress' },
  ])
  assert.deepEqual(writes[1].data.todos, [
    { content: 'TIA · open_project · Demo.ap17', status: 'completed' },
  ])
})

test('a model-authored list is never edited', async () => {
  const harness = createHarness()
  harness.session.append('todo/write', {
    todos: [{ content: 'TIA · 打开工程', status: 'in_progress' }],
  })
  const before = harness.session.log.length

  await runTool(harness, 'export_blocks', { device: 'Sino_PEI' })

  assert.equal(harness.session.log.length, before, 'the bridge must not append to a model list')
  assert.deepEqual(latestTodos(harness.session), [
    { content: 'TIA · 打开工程', status: 'in_progress' },
  ])
})

test('a model-owned list that forgot the tool name gets one settlement reminder', async () => {
  const harness = createHarness()
  harness.session.append('todo/write', {
    todos: [{ content: 'TIA · export_blocks · Sino_PEI', status: 'in_progress' }],
  })

  const { decision } = await runTool(harness, 'export_blocks', { device: 'Sino_PEI' })

  assert.equal(decision.additionalContexts.length, 1)
  const reminder = decision.additionalContexts[0]
  assert.equal(reminder.source.kind, 'tia-todo-bridge')
  assert.match(reminder.content[0].text, /export_blocks/u)
  assert.match(reminder.content[0].text, /todo_write/u)
})

test('a model-owned list already marked completed gets no reminder', async () => {
  const harness = createHarness()
  harness.session.append('todo/write', {
    todos: [{ content: 'TIA · export_blocks · Sino_PEI', status: 'completed' }],
  })

  const { decision } = await runTool(harness, 'export_blocks', { device: 'Sino_PEI' })
  assert.equal(decision.additionalContexts, undefined)
})

test('a bridge-owned list settles itself and adds no model message', async () => {
  const harness = createHarness()
  const { decision } = await runTool(harness, 'export_blocks', { device: 'Sino_PEI' })
  assert.equal(decision.additionalContexts, undefined)
  assert.equal(latestTodos(harness.session)[0].status, 'completed')
})

test('a failed operation settles with a failure suffix instead of spinning', async () => {
  const harness = createHarness()
  await runTool(harness, 'compile_plc', { device: 'Sino_PEI' }, { isError: true })

  assert.deepEqual(latestTodos(harness.session), [
    { content: 'TIA · compile_plc · Sino_PEI（失败）', status: 'completed' },
  ])
})

test('two operations in one turn get two independently settled items', async () => {
  const harness = createHarness()
  await runTool(harness, 'open_project', { project_path: 'C:\\work\\Demo.ap17' })
  await runTool(harness, 'export_blocks', { device: 'Sino_PEI' })

  const todos = latestTodos(harness.session)
  assert.equal(todos.length, 2)
  assert.equal(todos[0].content, 'TIA · open_project · Demo.ap17')
  assert.equal(todos[0].status, 'completed')
  assert.equal(todos[1].content, 'TIA · export_blocks · Sino_PEI')
  assert.equal(todos[1].status, 'completed')
})

test('a quick read-only query does not create a todo item', async () => {
  const harness = createHarness()
  await runTool(harness, 'project_info', {})
  assert.equal(harness.session.log.length, 0)
})

test('turn/start resets the bridge state, matching the todos projection', async () => {
  const harness = createHarness()
  await runTool(harness, 'open_project', { project_path: 'C:\\work\\Demo.ap17' })

  harness.session.append('turn/start', {})
  await runTool(harness, 'compile_plc', { device: 'Sino_PEI' })

  assert.deepEqual(latestTodos(harness.session), [
    { content: 'TIA · compile_plc · Sino_PEI', status: 'completed' },
  ])
})

test('renaming the same operation in one turn keeps contents unique', async () => {
  const harness = createHarness()
  await runTool(harness, 'export_blocks', { device: 'Sino_PEI' })
  await runTool(harness, 'export_blocks', { device: 'Sino_PEI' })

  const contents = latestTodos(harness.session).map((item) => item.content)
  assert.deepEqual(contents, [
    'TIA · export_blocks · Sino_PEI',
    'TIA · export_blocks · Sino_PEI · 2',
  ])
})

test('objectHint prefers the most specific key and shortens paths', () => {
  assert.equal(objectHint('open_project', { project_path: 'C:\\a\\b\\Plant.ap17' }), 'Plant.ap17')
  assert.equal(objectHint('export_blocks', { device: 'Sino_PEI' }), 'Sino_PEI')
  assert.equal(objectHint('export_blocks', {}), null)
  const long = 'x'.repeat(80)
  const hint = objectHint('export_blocks', { device: long })
  assert.equal(hint.length, 48)
  assert.equal(hint.endsWith('…'), true)
})

test('taskContent appends a counter when the base is already present', () => {
  assert.equal(taskContent('compile_plc', { device: 'Sino_PEI' }, []), 'TIA · compile_plc · Sino_PEI')
  assert.equal(
    taskContent('compile_plc', { device: 'Sino_PEI' }, ['TIA · compile_plc · Sino_PEI']),
    'TIA · compile_plc · Sino_PEI · 2',
  )
})

test('readTodos rejects malformed payloads and unknown statuses', () => {
  assert.deepEqual(readTodos({ todos: [] }), [])
  assert.equal(readTodos({ todos: [{ content: '', status: 'done' }] }), null)
  assert.equal(readTodos({}), null)
  assert.equal(readTodos(null), null)
})

test('stateFromLog resets at turn/start and otherwise takes the latest list', () => {
  const state = stateFromLog([
    { type: 'todo/write', data: { todos: [{ content: 'old', status: 'completed' }] } },
    { type: 'turn/start', data: {} },
    { type: 'todo/write', data: { todos: [{ content: 'new', status: 'in_progress' }] } },
  ])
  assert.equal(state.owner, 'model')
  assert.deepEqual(state.todos, [{ content: 'new', status: 'in_progress' }])
})

test('the tracked set covers the required TIA and version operations only', () => {
  for (const name of [
    'open_project',
    'export_blocks',
    'import_blocks',
    'compile_plc',
    'project_diff',
    'create_engineering_project',
    'knowledge_ingest',
  ]) {
    assert.equal(TRACKED_TOOLS.has(name), true, `${name} must be tracked`)
  }
  for (const name of ['project_info', 'list_plc_objects', 'controller_status', 'knowledge_query']) {
    assert.equal(TRACKED_TOOLS.has(name), false, `${name} must stay out of the todo list`)
  }
})

test('the pure plan keeps callKey stable and refuses a second start for the same call', () => {
  const exec = { name: 'open_project', callId: 'c1', arguments: { project: 'Demo.ap17' } }
  assert.equal(callKey(exec), 'c1')
  const state = emptyState()
  const first = planStart(state, exec)
  assert.notEqual(first, null)
  state.todos = first.todos
  state.owner = 'bridge'
  state.pending.set(first.key, first.content)
  assert.equal(planStart(state, exec), null)
  assert.notEqual(planComplete(state, 'c1', false), null)
})
