/**
 * The TIA console bar: state, elapsed time, one-click actions, details.
 *
 * It is a `conversation.input.dock` occupant, so it lives above the composer and
 * is visible in a brand-new session — the place where the normal command card
 * cannot appear (a blank session renders the Hero, not the timeline).
 *
 * Actions dispatch the existing `/tia-…` commands through the session face, so
 * there is one implementation of "open/save/compile/close" and every click is
 * auditable as a `command/run`. State comes from the session's own event window,
 * which is also where model tool calls and typed commands land; the refresh
 * button re-syncs with the controller via `/tia-info`.
 *
 * @module dsh-ui-tia-console/TiaBar
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { firstLine, foldTiaState, formatElapsed } from './model.js'

/** Stable empty window used before the session binding exists. */
const EMPTY_WINDOW = Object.freeze({ entries: [], hasMore: false, revision: -1, change: null })

/**
 * @param {object} props - injected face plus the slot's standard props.
 * @param {(key: string, values?: object) => string} props.t - namespace-bound translate.
 * @param {() => { getSnapshot: () => object, subscribe: (listener: () => void) => () => void } | undefined} props.eventSource - session event window.
 * @param {(line: string) => Promise<unknown>} props.runCommand - dispatch one command line.
 * @returns {import('react').JSX.Element} the bar.
 */
export function TiaBar({ t, eventSource, runCommand }) {
  const source = eventSource()
  const subscribe = useCallback(
    (listener) => (source === undefined ? () => {} : source.subscribe(listener)),
    [source],
  )
  const getSnapshot = useCallback(
    () => (source === undefined ? EMPTY_WINDOW : source.getSnapshot()),
    [source],
  )
  const window = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_WINDOW)

  const state = useMemo(() => foldTiaState(window.entries), [window])
  const busy = state.operation !== null
  const project = state.project
  const hasProject = project !== null

  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState(false)
  const [admissionError, setAdmissionError] = useState(null)

  useEffect(() => {
    if (!busy) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [busy, state.operation?.startedAt])

  const dispatch = useCallback(
    (line) => {
      setAdmissionError(null)
      Promise.resolve(runCommand(line)).then(
        (result) => {
          if (result !== undefined && result !== null && result.ok === false) {
            setAdmissionError(result.error?.message ?? 'the command was not admitted')
          }
        },
        (error) => setAdmissionError(error instanceof Error ? error.message : String(error)),
      )
    },
    [runCommand],
  )

  const elapsed = busy ? formatElapsed(now - state.operation.startedAt) : null

  let label
  if (busy) label = `${t(state.operation.label)}…`
  else if (state.phase === 'unknown') label = t('state.unknown')
  else if (state.phase === 'unavailable') label = t('state.unavailable')
  else if (hasProject) label = `${t('state.open')} · ${project.name ?? t('state.openUnknown')}`
  else label = t('state.idle')

  const dot = busy
    ? 'run'
    : state.phase === 'unavailable'
      ? 'error'
      : admissionError !== null || state.lastError !== null
        ? 'warn'
        : hasProject
          ? 'ok'
          : 'idle'

  const canOpen = !busy && !hasProject
  const canAct = !busy && hasProject

  const compile = state.compile
  const compileBadge =
    !busy && hasProject && compile !== null
      ? t('badge.compiled', { errors: compile.errors, warnings: compile.warnings })
      : null

  const tooltip = state.lastError?.text ?? admissionError ?? undefined

  return (
    <div className="tiac-root" role="group" aria-label={t('aria.status')}>
      <div className="tiac-row">
        <span className="tiac-dot" data-state={dot} aria-hidden="true" />
        <span className="tiac-text" title={tooltip}>
          {label}
          {elapsed === null ? null : <span className="tiac-elapsed"> {elapsed}</span>}
        </span>
        {compileBadge === null ? null : (
          <span className="tiac-badge" data-error={compile.errors > 0 ? 'true' : 'false'}>
            {compileBadge}
          </span>
        )}
        <span className="tiac-actions">
          <button type="button" className="tiac-btn" disabled={!canOpen} onClick={() => dispatch('/tia-open')}>
            {t('action.open')}
          </button>
          <button type="button" className="tiac-btn" disabled={!canAct} onClick={() => dispatch('/tia-save')}>
            {t('action.save')}
          </button>
          <button type="button" className="tiac-btn" disabled={!canAct} onClick={() => dispatch('/tia-compile')}>
            {t('action.compile')}
          </button>
          <button type="button" className="tiac-btn" disabled={!canAct} onClick={() => dispatch('/tia-close')}>
            {t('action.close')}
          </button>
          <button type="button" className="tiac-btn" disabled={busy} onClick={() => dispatch('/tia-info')}>
            {t('action.refresh')}
          </button>
        </span>
        <button
          type="button"
          className="tiac-chevron"
          aria-label={expanded ? t('aria.collapse') : t('aria.expand')}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '▾' : '▸'}
        </button>
      </div>

      {expanded ? (
        <div className="tiac-body">
          {hasProject ? (
            <>
              <div className="tiac-kv">
                <span>{t('detail.project')}</span>
                <b>{project.name ?? t('value.unknown')}</b>
              </div>
              <div className="tiac-kv">
                <span>{t('detail.path')}</span>
                <code>{project.path ?? t('value.unknown')}</code>
              </div>
              <div className="tiac-kv">
                <span>{t('detail.modified')}</span>
                <span>
                  {project.modified === true
                    ? t('value.yes')
                    : project.modified === false
                      ? t('value.no')
                      : t('value.unknown')}
                </span>
              </div>
            </>
          ) : (
            <div className="tiac-note">{t('detail.projectNone')}</div>
          )}

          {compile === null ? null : (
            <div className="tiac-kv">
              <span>{t('detail.compile')}</span>
              <span>
                {compile.errors} err / {compile.warnings} warn
                {compile.state === null || compile.state === undefined ? '' : ` · ${compile.state}`}
                {state.updatedAt === 0 ? '' : ` · ${new Date(compile.at).toLocaleTimeString()}`}
              </span>
            </div>
          )}

          {state.lastError === null ? null : (
            <div className="tiac-error">
              {t('detail.lastError')}: {state.lastError.text}
            </div>
          )}
          {admissionError === null ? null : <div className="tiac-error">{admissionError}</div>}
          {state.lastResult === null ? null : (
            <div className="tiac-result">
              {t('detail.lastResult')}: {firstLine(state.lastResult.text)}
            </div>
          )}
          <div className="tiac-note">{t('detail.scope')}</div>
        </div>
      ) : null}
    </div>
  )
}
