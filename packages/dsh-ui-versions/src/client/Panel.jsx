/**
 * The Versions tab body.
 *
 * Data arrives through the injected `readTextFile` face (the host's
 * `workspaceFiles.readBytes`), which reads `<workspace>/.dsh/versions-view.json`.
 * That file is produced by `@voltarenyah/dsh-engineering-context` after every
 * commit, replay and annotation, so the panel never parses SQLite and never
 * needs the store schema.
 *
 * Three deliberate choices, all from using the tab in the real app:
 *
 *  - the panel is one scroll container with a sticky header, so a short window
 *    scrolls instead of clipping (the seat above us is `overflow: hidden`);
 *  - fingerprints are compact pills ("Code change") whose tooltip carries the
 *    before → after pair — four lines of 17-digit checksums per change are
 *    unreadable at sidebar width;
 *  - the two columns of the wide layout are split by a draggable divider,
 *    because the history column is usually the wider one but not always.
 *
 * @module dsh-ui-versions/client/Panel
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { VIEW_FILE, filterVersions, formatDate, parseView, shortSha, timelineFor } from '../model'

/** Faces the toolbar can filter on. */
const FACES = ['Code', 'Interface', 'Comments', 'Properties']

/** Narrowest the split may pull either column. */
const MIN_RATIO = 0.25
const MAX_RATIO = 0.75

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
 * The before → after pair of one face, for a pill's tooltip.
 *
 * @param {string} face - face name.
 * @param {Record<string,string>|null} before - fingerprints before the change.
 * @param {Record<string,string>|null} after - fingerprints after the change.
 * @returns {string} `Code CVt2YE+d0L → E4pUnyy/ld`, or `Code —` when unchanged.
 */
function fingerprintTitle(face, before, after) {
  const from = shortSha(before?.[face])
  const to = shortSha(after?.[face])
  if (from === to) return `${face} —`
  return `${face} ${from} → ${to}`
}

/**
 * One changed face, as a pill whose tooltip holds the fingerprints.
 *
 * @param {{ face: string, label: string, before: Record<string,string>|null, after: Record<string,string>|null, change: string }} props
 */
function FacePill({ face, label, before, after, change }) {
  return (
    <span
      className={`vsn-pill face-${face.toLowerCase()} change-${change}`}
      title={fingerprintTitle(face, before, after)}
    >
      {label}
    </span>
  )
}

/**
 * A select-shaped dropdown drawn with the panel's own tokens.
 *
 * The native `<select>` popup is painted by the OS: in the app's dark theme it
 * came out as light text on a light list (unreadable). A listbox of our own
 * keeps the popup inside the theme.
 *
 * @param {{ value: string, options: { value: string, label: string }[], onChange: (value: string) => void, label: string }} props
 */
function Dropdown({ value, options, onChange, label }) {
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  const current = options.find((option) => option.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return undefined
    const close = (event) => {
      if (box.current !== null && !box.current.contains(event.target)) setOpen(false)
    }
    const escape = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  return (
    <div className="vsn-select" ref={box}>
      <button
        type="button"
        className="vsn-select-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(!open)}
      >
        <span>{current?.label}</span>
        <span className="caret">▾</span>
      </button>
      {open ? (
        <ul className="vsn-menu" role="listbox" aria-label={label}>
          {options.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={option.value === value ? 'selected' : ''}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
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
  const [ratio, setRatio] = useState(0.62)

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

  // Pointer drag on the divider: the split is a fraction of the body width, so
  // it survives a window resize. Bounds keep both columns readable.
  const drag = (event) => {
    const track = event.currentTarget.parentElement
    if (track === null) return
    const rect = track.getBoundingClientRect()
    const move = (moveEvent) => {
      const next = (moveEvent.clientX - rect.left) / rect.width
      setRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, next)))
    }
    const stop = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
      document.body.style.cursor = ''
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
    document.body.style.cursor = 'col-resize'
    event.preventDefault()
  }

  return (
    <div className="vsn-root">
      <div className="vsn-sticky">
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
          <Dropdown
            label={t('allFaces')}
            value={face}
            onChange={setFace}
            options={[
              { value: '', label: t('allFaces') },
              ...FACES.map((name) => ({ value: name, label: name })),
            ]}
          />
          {view.problems.length > 0 ? (
            <Dropdown
              label={t('allProblems')}
              value={problem}
              onChange={setProblem}
              options={[
                { value: '', label: t('allProblems') },
                ...view.problems.map((name) => ({ value: name, label: name })),
              ]}
            />
          ) : null}
        </div>
      </div>

      <div className="vsn-body" style={{ '--vsn-split': `${Math.round(ratio * 100)}%` }}>
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
                              <span className="plus">+{event.linesAdded ?? 0}</span>
                              <span className="minus">-{event.linesRemoved ?? 0}</span>
                            </span>
                          </div>
                          <div className="vsn-pills">
                            {event.faces.map((name) => (
                              <FacePill
                                key={name}
                                face={name}
                                label={tv(t, 'faceChange', { face: name })}
                                before={event.before}
                                after={event.after}
                                change={event.change}
                              />
                            ))}
                          </div>
                          {event.reason ? (
                            <div className="vsn-reason">
                              <span className="label">{t('reason')}</span>
                              {event.reason.split('\n')[0].slice(0, 160)}
                            </div>
                          ) : null}
                          {event.problem ? (
                            <div className="vsn-reason">
                              <span className="label">{t('problem')}</span>
                              <span className="vsn-tag problem">{event.problem}</span>
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

        <div
          className="vsn-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('resize')}
          onPointerDown={drag}
        />

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
                <div className="vsn-pills">
                  {entry.faces.map((name) => (
                    <FacePill
                      key={name}
                      face={name}
                      label={tv(t, 'faceChange', { face: name })}
                      before={entry.before}
                      after={entry.after}
                      change="modified"
                    />
                  ))}
                </div>
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
