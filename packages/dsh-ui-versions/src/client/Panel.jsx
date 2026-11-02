/**
 * The Versions tab body.
 *
 * Data arrives through the injected `readTextFile` face (the host's
 * `workspaceFiles.readBytes`), which reads `<workspace>/.dsh/versions-view.json`.
 * That file is produced by `@voltarenyah/dsh-engineering-context` after every
 * commit, replay and annotation, so the panel never parses SQLite and never
 * needs the store schema.
 *
 * The layout is single-column by default (a right-sidebar tab is narrow) and
 * becomes two columns when the pane is widened, with the block timeline on the
 * right.
 *
 * @module dsh-ui-versions/client/Panel
 */

import { useEffect, useMemo, useState } from 'react'

import { VIEW_FILE, filterVersions, formatDate, parseView, shortSha, timelineFor } from '../model'

/** Faces the toolbar can filter on. */
const FACES = ['Code', 'Interface', 'Comments', 'Properties']

/**
 * Join an absolute base with a forward-slash relative path.
 *
 * @param {string} base - workspace root.
 * @param {string} rel - relative path.
 * @returns {string} an absolute path with forward slashes.
 */
function joinPath(base, rel) {
  return `${base.replace(/[\\/]+$/, '')}/${rel.replace(/^[\\/]+/, '')}`
}

/**
 * Placeholder replacement for the framework's translate seat.
 *
 * @param {(key: string) => string} t - bound translator.
 * @param {string} key - dictionary key.
 * @param {Record<string, unknown>} [vars] - placeholders.
 * @returns {string} the translated text.
 */
function tv(t, key, vars) {
  let text = t(key)
  for (const [name, value] of Object.entries(vars ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}

/**
 * One changed fingerprint, as a label/value pair.
 *
 * @param {{ face: string, before: Record<string,string>|null, after: Record<string,string>|null }} props
 */
function Fingerprint({ face, before, after }) {
  return (
    <div className="vsn-fp">
      <span>{face}</span>
      <span className="val">
        <span className="a">{shortSha(before?.[face])}</span>
        <span className="arrow">→</span>
        <span className="b">{shortSha(after?.[face])}</span>
      </span>
    </div>
  )
}

/**
 * The tab body.
 *
 * @param {object} props - framework props plus the injected face.
 */
export function Panel(props) {
  const { sessionId, t } = props
  const readSessions = typeof props.useSessions === 'function' ? props.useSessions : () => undefined
  const cwd = readSessions((sessions) => sessions?.byId?.[sessionId]?.cwd)

  const [state, setState] = useState({ status: 'loading', view: null, code: '' })
  const [query, setQuery] = useState('')
  const [face, setFace] = useState('')
  const [problem, setProblem] = useState('')
  const [open, setOpen] = useState(() => new Set())
  const [block, setBlock] = useState('')

  const lang = (typeof document !== 'undefined' && document.documentElement.lang) || 'zh'
  const i18nLang = lang.startsWith('en') ? 'en' : 'zh'

  const load = async () => {
    if (typeof cwd !== 'string' || cwd.length === 0) {
      setState({ status: 'no-workspace', view: null, code: '' })
      return
    }
    if (typeof props.readTextFile !== 'function') {
      setState({ status: 'error', view: null, code: 'workspaceFiles' })
      return
    }
    setState({ status: 'loading', view: null, code: '' })
    const answer = await props.readTextFile(joinPath(cwd, VIEW_FILE))
    if (answer?.ok !== true) {
      setState({ status: 'error', view: null, code: answer?.code ?? 'read' })
      return
    }
    const parsed = parseView(answer.text)
    if (!parsed.ok) {
      setState({ status: 'error', view: null, code: parsed.code })
      return
    }
    setState({ status: 'ready', view: parsed.view, code: '' })
  }

  useEffect(() => {
    load()
    // The only input is the workspace root; a tab switch keeps the component's
    // state, and the refresh button is the explicit re-read.
  }, [cwd])

  const rows = useMemo(
    () => (state.view === null ? [] : filterVersions(state.view, { query, face, problem })),
    [state.view, query, face, problem],
  )
  const timeline = useMemo(
    () => (state.view === null || block.length === 0 ? [] : timelineFor(state.view, block)),
    [state.view, block],
  )

  if (state.status === 'loading') {
    return (
      <div className="vsn-root">
        <div className="vsn-empty">{t('loading')}</div>
      </div>
    )
  }
  if (state.status === 'no-workspace') {
    return (
      <div className="vsn-root">
        <div className="vsn-hint">{t('noWorkspace')}</div>
      </div>
    )
  }
  if (state.status === 'error' || state.view === null) {
    const isRead = state.code === 'workspace-file/not-found' || state.code === 'ENOENT'
    return (
      <div className="vsn-root">
        <div className="vsn-error">
          {isRead ? t('noView') : tv(t, 'readFailed', { code: state.code })}
        </div>
        <div className="vsn-hint">
          <button className="vsn-icon" onClick={load}>
            {t('retry')}
          </button>
        </div>
      </div>
    )
  }

  const view = state.view
  const toggle = (commit) => {
    const next = new Set(open)
    if (next.has(commit)) next.delete(commit)
    else next.add(commit)
    setOpen(next)
  }

  return (
    <div className="vsn-root">
      <div className="vsn-head">
        <span className="vsn-title">{t('title')}</span>
        <span className="vsn-device">{view.device}</span>
        <span className="vsn-spacer" />
        <button className="vsn-icon" onClick={load} title={t('refresh')}>
          ⟳
        </button>
      </div>

      <div className="vsn-toolbar">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('search')} />
        <select value={face} onChange={(event) => setFace(event.target.value)} aria-label={t('allFaces')}>
          <option value="">{t('allFaces')}</option>
          {FACES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        {view.problems.length > 0 ? (
          <select value={problem} onChange={(event) => setProblem(event.target.value)} aria-label={t('allProblems')}>
            <option value="">{t('allProblems')}</option>
            {view.problems.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <div className="vsn-body">
        <div className="vsn-panel">
          <div className="vsn-panel-head">
            <span>{t('history')}</span>
            <span className="vsn-count">
              {rows.length} / {view.versions.length}
            </span>
          </div>
          {rows.length === 0 ? (
            <div className="vsn-empty">{t('noMatch')}</div>
          ) : (
            rows.map((version) => {
              const isOpen = open.has(version.commit)
              return (
                <div key={version.commit} className={isOpen ? 'vsn-vrow open' : 'vsn-vrow'}>
                  <div className="vsn-vline" onClick={() => toggle(version.commit)}>
                    <span className="vsn-sha">{shortSha(version.commit)}</span>
                    <span className="vsn-subj" title={version.subject}>
                      {version.subject}
                    </span>
                    <span className="vsn-meta">
                      <span className="vsn-date">{formatDate(version.date, i18nLang)}</span>
                      <span className="vsn-cs">
                        {version.checksumPrev ? version.checksumPrev : '—'}
                        <span className="arrow">→</span>
                        <span className="now">{version.checksum ?? '—'}</span>
                      </span>
                      <span className="vsn-badge plain">
                        {version.events.length === 0
                          ? t('baseline')
                          : tv(t, 'blocks', { n: version.events.length })}
                      </span>
                    </span>
                  </div>
                  <div className="vsn-events">
                    {version.events.length === 0 ? (
                      <div className="vsn-reason">
                        <span className="label">{t('noChange')}</span>
                        {t('baselineNote')}
                      </div>
                    ) : (
                      version.events.map((event) => (
                        <div key={event.key} className="vsn-event">
                          <div className="vsn-event-head">
                            <span className={`vsn-badge change-${event.change}`}>{t(event.change)}</span>
                            <button className="vsn-blk" onClick={() => setBlock(event.key)}>
                              {event.key}
                            </button>
                            <span className="vsn-delta">
                              +{event.linesAdded ?? 0} -{event.linesRemoved ?? 0}
                            </span>
                            <span className="vsn-spacer" />
                            {event.faces.map((name) => (
                              <span key={name} className="vsn-face">
                                {name}
                              </span>
                            ))}
                          </div>
                          {event.faces.map((name) => (
                            <Fingerprint key={name} face={name} before={event.before} after={event.after} />
                          ))}
                          {event.reason ? (
                            <div className="vsn-reason">
                              <span className="label">{t('reason')}</span>
                              {event.reason.split('\n')[0].slice(0, 160)}
                            </div>
                          ) : null}
                          {event.problem ? (
                            <div className="vsn-reason">
                              <span className="label">{t('problem')}</span>
                              {event.problem}
                            </div>
                          ) : null}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="vsn-panel vsn-detail">
          <div className="vsn-panel-head">
            <span>{t('timeline')}</span>
            <span className="vsn-count">{tv(t, 'changesCount', { n: timeline.length })}</span>
          </div>
          {timeline.length === 0 ? (
            <div className="vsn-empty">{t('pickBlock')}</div>
          ) : (
            timeline.map((entry) => (
              <div key={`${entry.block}:${entry.seq}`} className="vsn-tl">
                <div className="vsn-tl-head">
                  <span className="seq">#{entry.seq}</span>
                  <span className="vsn-sha">{shortSha(entry.commit)}</span>
                  <span className="date">{formatDate(entry.date, i18nLang)}</span>
                </div>
                <div className="vsn-tl-subj" title={entry.subject}>
                  {entry.subject}
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '3px 0' }}>
                  {entry.faces.map((name) => (
                    <span key={name} className="vsn-face">
                      {name}
                    </span>
                  ))}
                </div>
                {entry.faces.map((name) => (
                  <Fingerprint key={name} face={name} before={entry.before} after={entry.after} />
                ))}
                {entry.reason ? (
                  <div className="vsn-reason">
                    <span className="label">{t('reason')}</span>
                    {entry.reason.split('\n')[0].slice(0, 180)}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
