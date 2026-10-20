/**
 * Unit tests for the host half: what the model receives when a message cites a
 * block.
 *
 * The resolution is driven through an injected {@link MentionSource} instead of a
 * temporary directory, so these tests say nothing about `node:fs` — they pin the
 * decision logic: which messages are annotated, what a miss says, and that a
 * second look only happens when a name actually missed. `lib/index.js` is the
 * built module, the same one the Loader imports.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { annotateMessages, apply, forgetListings, resolveMentionContext } from '../lib/index.js'
import { parseManifest } from '../lib/model.js'

const MANIFEST = {
  blocks: [
    {
      name: 'SCP_IN',
      file: 'C:\\ws\\source\\Sino_PEI\\blocks\\1001_SCP_IN\\SCP_IN.xml',
      category: 'blocks',
      simaticType: 'FB',
      declaredNumber: '1001',
      programmingLanguage: 'SCL',
      verified: true,
    },
    {
      name: '00_Main',
      file: 'C:\\ws\\source\\Sino_PEI\\blocks\\00_Main.xml',
      category: 'blocks',
      simaticType: 'OB',
      declaredNumber: 1,
      verified: true,
    },
  ],
}

const ROWS = parseManifest(JSON.stringify(MANIFEST), 'Sino_PEI').rows

/** A source that records how often it was asked for a fresh listing. */
function fakeSource(rows = ROWS) {
  const state = { reads: 0, refreshes: 0, rows }
  return {
    state,
    source: {
      read: async () => {
        state.reads += 1
        return state.rows
      },
      refresh: async () => {
        state.refreshes += 1
        return state.rows
      },
    },
  }
}

/** @returns one direct user message citing `text`. */
const userMessage = (text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

describe('annotateMessages', () => {
  it('appends one context block to the message that cited a block', async () => {
    const { source } = fakeSource()
    const [annotated] = await annotateMessages([userMessage("look at @'SCP_IN' please")], 'C:\\ws', source)
    assert.equal(annotated.content.length, 2)
    assert.equal(annotated.content[0].text, "look at @'SCP_IN' please")
    assert.match(annotated.content[1].text, /## PLC blocks cited in this message/)
    assert.match(annotated.content[1].text, /name="SCP_IN" device="Sino_PEI" type="FB"/)
    assert.match(annotated.content[1].text, /file="source\/Sino_PEI\/blocks\/1001_SCP_IN\/SCP_IN\.xml"/)
  })

  it('leaves messages it has nothing to say about exactly as they were', async () => {
    const { source } = fakeSource()
    const plain = userMessage('no citation here')
    const injected = { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: "@'SCP_IN'" }] }
    const messages = [plain, injected]
    const annotated = await annotateMessages(messages, 'C:\\ws', source)
    // Identity, not equality: the caller relies on it to skip a decision rewrite,
    // and re-triggering on injected context would make a turn quote itself.
    assert.equal(annotated, messages)
  })

  it('does nothing without a workspace', async () => {
    const { source, state } = fakeSource()
    const messages = [userMessage("@'SCP_IN'")]
    assert.equal(await annotateMessages(messages, undefined, source), messages)
    assert.equal(state.reads, 0)
  })

  it('annotates every citing message, in message order', async () => {
    const { source } = fakeSource()
    const annotated = await annotateMessages(
      [userMessage("@'SCP_IN'"), userMessage('plain'), userMessage("@'00_Main'")],
      'C:\\ws',
      source,
    )
    assert.equal(annotated.length, 3)
    assert.equal(annotated[0].content.length, 2)
    assert.equal(annotated[1].content.length, 1)
    assert.equal(annotated[2].content.length, 2)
    assert.match(annotated[2].content[1].text, /name="00_Main"/)
  })
})

describe('resolveMentionContext', () => {
  it('re-reads the listing once when a cited name misses the cache', async () => {
    const { source, state } = fakeSource()
    const context = await resolveMentionContext('C:\\ws', ['NO_SUCH_BLOCK'], source)
    assert.equal(state.reads, 1)
    assert.equal(state.refreshes, 1)
    assert.match(context, /name="NO_SUCH_BLOCK" found="false"/)
  })

  it('does not re-read when every name is already known', async () => {
    const { source, state } = fakeSource()
    await resolveMentionContext('C:\\ws', ['SCP_IN'], source)
    assert.equal(state.refreshes, 0)
  })

  it('reports a block exported after the cache was filled', async () => {
    const { source, state } = fakeSource()
    assert.match(await resolveMentionContext('C:\\ws', ['LATE_BLOCK'], source), /found="false"/)
    state.rows = [...ROWS, { ...ROWS[0], name: 'LATE_BLOCK' }]
    assert.match(await resolveMentionContext('C:\\ws', ['LATE_BLOCK'], source), /name="LATE_BLOCK"/)
  })
})

describe('apply', () => {
  it('registers one prepended pre-step listener and passes rejections through', async () => {
    forgetListings()
    const seen = []
    const ctx = {
      on(event, listener, options) {
        seen.push({ event, options })
        this.listener = listener
      },
    }
    apply(ctx)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].event, 'agent/pre-step')
    assert.deepEqual(seen[0].options, { prepend: true })

    const rejection = { kind: 'reject' }
    assert.equal(await ctx.listener({}, async () => rejection), rejection)
  })

  it('never fails a turn when the source tree is unreadable', async () => {
    const warnings = []
    const ctx = {
      on(_event, listener) {
        this.listener = listener
      },
      logger: { warn: (message) => warnings.push(message) },
    }
    apply(ctx)
    const decision = { kind: 'enter', messages: [userMessage("@'SCP_IN'")] }
    // No workspace exists at this path, so the read throws and the decision stands.
    const result = await ctx.listener({ agent: { session: { header: { cwd: 'C:\\no-such-workspace-here' } } } }, async () => decision)
    assert.equal(result, decision)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /were not annotated/)
  })
})
