/**
 * The Changes tab body.
 *
 * Renders the status route's payload: a header, the summary line, one row per
 * file with its badge and `+N/−M`, and the error states the route's codes map
 * to. The commit area lands in P2; the list is read-only by design.
 *
 * Data path: `props.fetchStatus(signal)` → `GET /changes/api/status`, the
 * plugin's own host route. No `workspaceFiles`, no new remote, no file reads.
 *
 * @module dsh-ui-changes/client/Panel
 */

import { useEffect, useRef, useState } from 'react'

/** Badge class per porcelain letter. */
const BADGE = { M: 'mod', A: 'add', D: 'del', R: 'ren', C: 'add', '?': 'new', '!': 'conflict' }

/**
 * Route codes that deserve their own sentence instead of the generic one.
 * Anything else falls back to `error.failed` with the code interpolated.
 */
const ERROR_KEYS = {
  'changes/not-a-repository': 'error.notRepo',
  'changes/no-git-service': 'error.noService',
  'changes/session-unknown': 'error.sessionUnknown',
  'changes/timeout': 'error.timeout',
}

/**
 * Replace `{name}` placeholders in one translated sentence.
 *
 * @param {(key: string) => string} t - bound translator.
 * @param {string} key - dictionary key.
 * @param {Record<string, unknown>} vars - placeholder values.
 * @returns {string} the resolved text.
 */
function fill(t, key, vars) {
  let text = t(key)
  for (const [name, value] of Object.entries(vars)) text = text.replace(`{${name}}`, String(value))
  return text
}

/**
 * @param {string | null} head - full commit hash, or null.
 * @returns {string} the seven-character prefix used by git's own output.
 */
function shortHead(head) {
  return typeof head === 'string' && head.length >= 7 ? head.slice(0, 7) : ''
}

/**
 * @param {string} code - the route's error code.
 * @returns {string} the dictionary key that explains it.
 */
function errorKeyOf(code) {
  const known = ERROR_KEYS[code]
  if (known !== undefined) return known
  return String(code).startsWith('http/') ? 'error.http' : 'error.failed'
}

/**
 * One list row.
 *
 * @param {{ file: any }} props - one `ChangedFile` from the payload.
 */
function Row({ file }) {
  const badge = BADGE[file.code] ?? 'mod'
  return (
    <div className="chg-row" role="listitem" title={file.path}>
      <span className={`chg-badge ${badge}`}>{file.code}</span>
      <span className="chg-path">{file.renamedFrom === null || file.renamedFrom === undefined
        ? file.path
        : `${file.renamedFrom} → ${file.path}`}</span>
      {file.adds === null || file.adds === undefined ? null : <span className="chg-adds">+{file.adds}</span>}
      {file.dels === null || file.dels === undefined ? null : <span className="chg-dels">−{file.dels}</span>}
    </div>
  )
}

/**
 * The tab body.
 *
 * @param {object} props - framework props plus the injected face.
 */
export function Panel(props) {
  const { t, sessionId } = props
  const [state, setState] = useState({ status: 'loading', data: null, code: '' })
  const ticket = useRef(0)
  const controller = useRef(null)

  const load = async () => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (typeof props.fetchStatus !== 'function') {
      setState({ status: 'error', data: null, code: 'changes/no-route' })
      return
    }
    // A refresh supersedes the request in flight; the older answer must not
    // overwrite the newer one.
    controller.current?.abort?.()
    const next = typeof AbortController === 'function' ? new AbortController() : null
    controller.current = next
    const mine = ++ticket.current
    setState((previous) => ({ status: 'loading', data: previous.data, code: '' }))
    const answer = await props.fetchStatus(next === null ? undefined : next.signal)
    if (mine !== ticket.current) return
    if (answer?.ok === true) setState({ status: 'ready', data: answer.value, code: '' })
    else setState({ status: 'error', data: null, code: answer?.code ?? 'changes/unknown' })
  }

  useEffect(() => {
    load()
    return () => {
      ticket.current += 1
      controller.current?.abort?.()
    }
  }, [])

  // The working tree changes without any event this panel can subscribe to
  // (the user edits in an editor, a tool writes a file), so the panel refreshes
  // itself while it is visible — and only then. `document.hidden` stops the
  // timer's work, a hidden tab's cost stays at zero, and every request aborts
  // the previous one.
  useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      load()
    }
    const timer = setInterval(tick, 5000)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', tick)
    if (typeof window !== 'undefined') window.addEventListener('focus', tick)
    return () => {
      clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', tick)
      if (typeof window !== 'undefined') window.removeEventListener('focus', tick)
    }
  }, [])

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return (
      <div className="chg-root">
        <div className="chg-empty">{t('noSession')}</div>
      </div>
    )
  }

  const data = state.data
  const head = data === null ? '' : shortHead(data.head)
  const summary =
    data === null
      ? ''
      : fill(t, head.length > 0 ? 'summary' : 'summaryNoHead', {
          branch: data.branch,
          head,
          files: data.totals.files,
          adds: data.totals.adds,
          dels: data.totals.dels,
        })

  return (
    <div className="chg-root">
      <div className="chg-head">
        <span className="chg-title">{t('title')}</span>
        <button type="button" className="chg-icon" onClick={load}>
          {t('refresh')}
        </button>
      </div>

      {state.status === 'loading' && data === null ? <div className="chg-hint">{t('loading')}</div> : null}

      {state.status === 'error' ? (
        <div className="chg-error">
          {fill(t, errorKeyOf(state.code), { code: state.code })}
        </div>
      ) : null}

      {data !== null ? (
        <>
          <div className="chg-summary">{summary}</div>
          {data.files.length === 0 ? (
            <div className="chg-empty">{t('clean')}</div>
          ) : (
            <div className="chg-list" role="list">
              {data.files.map((file) => (
                <Row key={file.path} file={file} />
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
