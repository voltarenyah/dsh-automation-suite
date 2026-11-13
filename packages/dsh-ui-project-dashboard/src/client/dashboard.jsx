/**
 * The dashboard page: one datasheet row per registered workspace — status,
 * tags, 14-day activity, session count, last activity and actions.
 *
 * All workspace/session data comes from the host's standard root hooks; tags
 * come from the plugin's own endpoint. The layout is the Signal Deck page:
 * masthead with search/filter, a telemetry strip over the visible rows, a
 * register of workspace rows, and a storage note in the footer.
 *
 * Layout follows the host theme through the `--dsw-*` tokens in `style.js`;
 * the page never forces a light or dark palette of its own.
 *
 * @module dsh-ui-project-dashboard/client/dashboard
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  UNTAGGED,
  buildRows,
  decorateRows,
  filterRows,
  normalizeTagInput,
  summarize,
  tagTree,
} from './model.js'
import { loadDefaultWorkspace, loadTags, mutateTags, pruneDefaultWorkspace } from './tags-api.js'

/** Stable colours for tag roots, so the same tree reads the same everywhere. */
const TAG_HUES = ['#4f8dff', '#3fbf8f', '#e28a2d', '#9b7bff', '#2fbdb3', '#e06767', '#8fa3b8']

/** Two-digit zero padding for counters in the datasheet. */
function pad2(value) {
  return String(Math.max(0, value)).padStart(2, '0')
}

/**
 * Colour for one tag path, derived from its root segment.
 *
 * @param {string} tag - tag path.
 * @returns {string} a CSS colour.
 */
function tagColor(tag) {
  const root = tag.split('/')[0] ?? ''
  let hash = 0
  for (const character of root) hash = (hash * 31 + character.codePointAt(0)) % 100000
  return TAG_HUES[hash % TAG_HUES.length]
}

/** Last path segment, which is what a tag pill shows. */
function leafOf(tag) {
  const parts = tag.split('/')
  return parts[parts.length - 1]
}

/**
 * Relative time for a millisecond timestamp.
 *
 * @param {unknown} value - epoch milliseconds (sessions) or ISO text (workspaces).
 * @param {number} now - reference time.
 * @param {Function} t - bound translator.
 * @returns {string} a short label.
 */
function relativeTime(value, now, t) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value))
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const diff = Math.max(0, now - ms)
  const minute = 60e3
  if (diff < minute) return t('time.justNow')
  const minutes = Math.floor(diff / minute)
  if (minutes < 60) return t('time.minutes', { n: minutes })
  const hours = Math.floor(diff / (60 * minute))
  if (hours < 24) return t('time.hours', { n: hours })
  const days = Math.floor(diff / (24 * 60 * minute))
  if (days < 30) return t('time.days', { n: days })
  return exactTime(ms)
}

/**
 * Absolute local timestamp under the session row's relative label.
 *
 * @param {unknown} value - epoch milliseconds.
 * @returns {string} short date-time text.
 */
function exactTime(value) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value))
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(ms)
  } catch {
    return '—'
  }
}

/** Local calendar key, so daylight-saving shifts cannot drop a session. */
function dayKey(ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/**
 * 14 daily buckets ending today, counting each timestamp once.
 *
 * @param {readonly number[]} times - session timestamps.
 * @param {number} now - reference time.
 * @param {number} [count] - bucket count.
 * @returns {Array<{ key: string, label: string, count: number }>} one entry per day.
 */
function daySeries(times, now, count = 14) {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const days = []
  let formatter
  try {
    formatter = new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' })
  } catch {
    formatter = null
  }
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)
    days.push({
      key: dayKey(date.getTime()),
      label: formatter !== null ? formatter.format(date) : `${date.getMonth() + 1}/${date.getDate()}`,
      count: 0,
    })
  }
  const byKey = new Map(days.map((day) => [day.key, day]))
  for (const time of times) {
    if (!Number.isFinite(time) || time <= 0) continue
    const bucket = byKey.get(dayKey(time))
    if (bucket !== undefined) bucket.count += 1
  }
  return days
}

/** Group the flat tag tree into roots and their descendants. */
function groupTree(tree) {
  const roots = tree.filter((node) => node.depth === 0)
  return roots.map((root) => ({
    node: root,
    children: tree.filter((node) => node.path.startsWith(`${root.path}/`)),
  }))
}

/** Small stroked icons shared by the page and the editor. */
function Icon({ name, size = 12 }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  }
  if (name === 'search') {
    return (
      <svg {...common}>
        <circle cx="10.5" cy="10.5" r="6.2" />
        <path d="M15.2 15.2 20 20" />
      </svg>
    )
  }
  if (name === 'x') {
    return (
      <svg {...common}>
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    )
  }
  if (name === 'tag') {
    return (
      <svg {...common}>
        <path d="M4 5.5h16l-6.4 7.4v5.2l-3.2 1.6v-6.8Z" />
      </svg>
    )
  }
  if (name === 'chevron') {
    return (
      <svg {...common}>
        <path d="M9 5l7 7-7 7" />
      </svg>
    )
  }
  if (name === 'info') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8.2" />
        <path d="M12 11v5" />
        <circle cx="12" cy="8.1" r="0.9" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M12 5.2v13.6M5.2 12h13.6" />
    </svg>
  )
}

/** One telemetry stat. */
function Stat({ label, value, meta, tone }) {
  return (
    <div className="pd-stat">
      <span className="pd-stat-label">{label}</span>
      <span className={`pd-stat-value${tone === 'live' ? ' is-live' : tone === 'wait' ? ' is-wait' : ''}`}>{value}</span>
      <span className="pd-stat-meta">{meta}</span>
    </div>
  )
}

/** Aggregate 14-day activity bars. */
function SignalChart({ rows, now, t }) {
  const times = []
  for (const row of rows) for (const time of row.sessionTimes ?? []) times.push(time)
  const days = daySeries(times, now)
  const total = days.reduce((sum, day) => sum + day.count, 0)
  const max = Math.max(1, ...days.map((day) => day.count))
  const aria = t('signalAria', { n: total })
  const gap = 5
  const barWidth = (300 - 4 - gap * 13) / 14
  return (
    <svg
      className="pd-signal-chart"
      viewBox="0 0 300 48"
      preserveAspectRatio="none"
      role="img"
      aria-label={aria}
    >
      <title>{aria}</title>
      <line className="pd-chart-line" x1="0" x2="300" y1="46" y2="46" strokeWidth="1" />
      {days.map((day, index) => {
        const height = day.count > 0 ? 5 + (day.count / max) * 33 : 2
        return (
          <rect
            key={day.key}
            x={2 + index * (barWidth + gap)}
            y={46 - height}
            width={barWidth}
            height={height}
            rx="1"
            className={`pd-chart-bar${day.count === 0 ? ' is-zero' : ''}${index === days.length - 1 ? ' is-today' : ''}`}
          >
            <title>{`${day.label} · ${day.count}`}</title>
          </rect>
        )
      })}
    </svg>
  )
}

/** Per-workspace 14-day activity bars. */
function SparkBars({ times, now, t }) {
  const days = daySeries(times, now)
  const total = days.reduce((sum, day) => sum + day.count, 0)
  const max = Math.max(1, ...days.map((day) => day.count))
  const aria = t('signalAria', { n: total })
  return (
    <div className="pd-spark-bars" role="img" aria-label={aria}>
      {days.map((day, index) => {
        const height = day.count > 0 ? 4 + (day.count / max) * 22 : 2
        return (
          <span
            key={day.key}
            className={`pd-spark-bar${day.count === 0 ? ' is-zero' : ''}${index === days.length - 1 ? ' is-today' : ''}`}
            style={{ height: `${height}px` }}
            title={`${day.label} · ${day.count}`}
          />
        )
      })}
    </div>
  )
}

/** One tag pill: filter shortcut plus remove control. */
function TagPill({ row, tag, active, busy, t, onFilter, onRemove }) {
  return (
    <span className={`pd-tag-pill${active ? ' is-on' : ''}`}>
      <button
        type="button"
        className="pd-tag-main"
        title={t('filterBy', { tag })}
        aria-label={t('filterBy', { tag })}
        onClick={() => onFilter(tag)}
      >
        <span className="pd-tag-mark" style={{ background: tagColor(tag) }} aria-hidden="true" />
        <span className="pd-tag-leaf">{leafOf(tag)}</span>
      </button>
      <button
        type="button"
        className="pd-tag-x"
        title={t('removeTag', { tag })}
        aria-label={t('removeTag', { tag })}
        disabled={busy}
        onClick={() => onRemove(tag)}
      >
        <Icon name="x" size={10} />
      </button>
    </span>
  )
}

/** One workspace row. */
function Row({ row, index, t, busy, now, filters, onFilter, onRemove, onAdd, onNew }) {
  const stateClass = row.running > 0 ? ' is-running' : row.pending > 0 ? ' is-waiting' : ''
  return (
    <article className={`pd-ws${stateClass}`} data-workspace={row.id} style={{ '--i': String(index) }}>
      <span className="pd-ws-index">{pad2(index + 1)}</span>
      <div className="pd-ws-ident">
        <div className="pd-ws-title-row">
          <h2 className="pd-ws-title" title={row.title}>{row.title || '—'}</h2>
          {row.running > 0 ? (
            <span className="pd-state-chip is-run">
              <span className="pd-state-dot" />
              {t('runningN', { n: row.running })}
            </span>
          ) : null}
          {row.pending > 0 ? (
            <span className="pd-state-chip is-wait">
              <span className="pd-state-dot" />
              {t('pendingN', { n: row.pending })}
            </span>
          ) : null}
        </div>
        <div className="pd-ws-tags">
          {row.tags.length === 0 ? <span className="pd-ws-no-tags">{t('noTags')}</span> : null}
          {row.tags.map((tag) => (
            <TagPill
              key={tag}
              row={row}
              tag={tag}
              active={filters.includes(tag)}
              busy={busy}
              t={t}
              onFilter={onFilter}
              onRemove={onRemove}
            />
          ))}
          <button
            type="button"
            className="pd-tag-add"
            data-pd-tag-add="1"
            disabled={busy}
            aria-label={t('addTagFor', { title: row.title })}
            onClick={onAdd}
          >
            {t('addTag')}
          </button>
        </div>
      </div>
      <div className="pd-ws-spark">
        <SparkBars times={row.sessionTimes ?? []} now={now} t={t} />
      </div>
      <div className="pd-ws-sessions">
        <span className="pd-cell-label">{t('sesLabel')}</span>
        <span className="pd-cell-value">{row.sessions}</span>
      </div>
      <div className="pd-ws-last">
        <span className="pd-cell-label">{t('lastLabel')}</span>
        <span className="pd-cell-value">{relativeTime(row.lastAt, now, t)}</span>
        <span className="pd-cell-meta">{exactTime(row.lastAt)}</span>
      </div>
      <div className="pd-ws-actions">
        <button
          type="button"
          className="pd-new-session"
          title={t('newSessionFor', { title: row.title })}
          aria-label={t('newSessionFor', { title: row.title })}
          onClick={onNew}
        >
          <Icon name="plus" size={12} />
          <span>{t('newSession')}</span>
        </button>
      </div>
    </article>
  )
}

/** The tag filter dropdown. */
function FilterPanel({ groups, filters, totalCount, untaggedCount, collapsed, t, onPick, onExpand, onClear, onDone }) {
  const isOn = (path) => filters.includes(path)
  return (
    <div className="pd-filter-panel" id="pd-filter-panel" role="group" aria-label={t('filter.title')}>
      <div className="pd-filter-head">
        <span>{t('filter.title')}</span>
        {filters.length > 0 ? (
          <button type="button" className="pd-filter-clear" onClick={onClear}>
            {t('filter.clear')}
          </button>
        ) : null}
      </div>
      <div className="pd-filter-list">
        <button
          type="button"
          className={`pd-index-row pd-index-all${filters.length === 0 ? ' is-on' : ''}`}
          aria-pressed={filters.length === 0}
          onClick={onClear}
        >
          <span className="pd-index-mark" aria-hidden="true" />
          <span className="pd-index-label">{t('filter.all')}</span>
          <span className="pd-index-n">{pad2(totalCount)}</span>
        </button>
        {groups.length === 0 && untaggedCount === 0 ? (
          <div className="pd-filter-empty">{t('filter.empty')}</div>
        ) : null}
        <div className="pd-tag-tree">
          {groups.map(({ node, children }, groupIndex) => {
            const expanded = collapsed[node.path] !== true
            const childrenId = `pd-tag-children-${groupIndex}`
            return (
              <div className="pd-tag-root" key={node.path}>
                <div className="pd-tag-root-row">
                  <button
                    type="button"
                    className="pd-tag-root-toggle"
                    aria-expanded={expanded}
                    aria-controls={childrenId}
                    aria-label={node.path}
                    onClick={() => onExpand(node.path)}
                  >
                    <Icon name="chevron" size={11} />
                  </button>
                  <button
                    type="button"
                    className={`pd-index-row${isOn(node.path) ? ' is-on' : ''}`}
                    aria-pressed={isOn(node.path)}
                    title={node.path}
                    onClick={() => onPick(node.path)}
                  >
                    <span className="pd-index-mark" style={{ background: tagColor(node.path) }} aria-hidden="true" />
                    <span className="pd-index-label">{node.label}</span>
                    <span className="pd-index-n">{node.count}</span>
                  </button>
                </div>
                <div className="pd-tag-children" id={childrenId} hidden={!expanded}>
                  {children.map((child) => (
                    <button
                      type="button"
                      key={child.path}
                      className={`pd-index-row pd-tag-child${isOn(child.path) ? ' is-on' : ''}`}
                      aria-pressed={isOn(child.path)}
                      title={child.path}
                      onClick={() => onPick(child.path)}
                    >
                      <span className="pd-index-label">{child.label}</span>
                      <span className="pd-index-n">{child.count}</span>
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
          {untaggedCount > 0 ? (
            <button
              type="button"
              className={`pd-index-row${isOn(UNTAGGED) ? ' is-on' : ''}`}
              aria-pressed={isOn(UNTAGGED)}
              onClick={() => onPick(UNTAGGED)}
            >
              <span className="pd-index-mark is-muted" aria-hidden="true" />
              <span className="pd-index-label">{t('filter.untagged')}</span>
              <span className="pd-index-n">{untaggedCount}</span>
            </button>
          ) : null}
        </div>
      </div>
      <div className="pd-filter-foot">
        <span className="pd-filter-foot-note">{t('filter.hint')}</span>
        <button type="button" className="pd-filter-done" onClick={onDone}>
          {t('filter.done')}
        </button>
      </div>
    </div>
  )
}

/** A default-workspace or tag-store notice. */
function Notice({ tone, title, copy, action, onAction }) {
  return (
    <div className={`pd-notice-bar${tone === 'warn' ? ' is-warn' : ''}`} role="status">
      <div className="pd-notice-head">
        <span className="pd-notice-dot" aria-hidden="true" />
        <span>{title}</span>
      </div>
      {copy !== undefined ? <p className="pd-notice-copy">{copy}</p> : null}
      {action !== undefined ? (
        <button type="button" className="pd-notice-action" onClick={onAction}>
          <Icon name="x" size={11} />
          <span>{action}</span>
        </button>
      ) : null}
    </div>
  )
}

/** Empty register body, with a clear action when filters hide every row. */
function EmptyState({ kind, t, onClear }) {
  return (
    <div className="pd-empty">
      <p className="pd-empty-title">{kind === 'none' ? t('empty.none') : t('empty.filtered')}</p>
      <p className="pd-empty-hint">{kind === 'none' ? t('empty.noneHint') : t('empty.filteredHint')}</p>
      {kind === 'filtered' ? (
        <button type="button" className="pd-empty-action" onClick={onClear}>
          {t('empty.clear')}
        </button>
      ) : null}
    </div>
  )
}

/**
 * The page component mounted into the root `main` seat.
 *
 * @param {any} props - standard kit (`t`, `useWorkspaces`, `useSessions`, `useSessionStatus`) plus the inject face.
 */
export function Dashboard(props) {
  const { t } = props
  const useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : (selector) => selector({ items: [], archivedSessionIds: [] })
  const useSessions = typeof props.useSessions === 'function' ? props.useSessions : (selector) => selector({ ids: [], byId: {} })
  const useSessionStatus = typeof props.useSessionStatus === 'function' ? props.useSessionStatus : (selector) => selector(new Map())

  const items = useWorkspaces((state) => state?.items ?? [])
  const archivedIds = useWorkspaces((state) => state?.archivedSessionIds ?? [])
  const sessions = useSessions((state) => state)
  const statuses = useSessionStatus((state) => state)

  const [tagDoc, setTagDoc] = useState({ phase: 'loading', revision: 0, corrupt: false, workspaces: {}, error: null })
  const [defaultWs, setDefaultWs] = useState({ phase: 'loading', id: null, registered: false })
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState([])
  const [panelOpen, setPanelOpen] = useState(false)
  const [collapsed, setCollapsed] = useState({})
  const [editor, setEditor] = useState(null)
  const [editorInput, setEditorInput] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [notice, setNotice] = useState(null)

  const revisionRef = useRef(0)
  const noticeTimer = useRef(undefined)
  const rootRef = useRef(null)
  const searchRef = useRef(null)
  const filterButtonRef = useRef(null)
  const filterWrapRef = useRef(null)
  const editorRef = useRef(null)
  const editorTriggerRef = useRef(null)

  const notify = useCallback((text, tone = 'info') => {
    setNotice({ text, tone })
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 2800)
  }, [])

  const acceptDocument = useCallback((document) => {
    revisionRef.current = document.revision
    setTagDoc({ phase: 'ready', revision: document.revision, corrupt: document.corrupt === true, workspaces: document.workspaces ?? {}, error: null })
  }, [])

  const load = useCallback(
    async (signal) => {
      try {
        const document = await loadTags(signal)
        acceptDocument(document)
      } catch (error) {
        if (signal?.aborted) return
        setTagDoc((current) => ({ ...current, phase: 'error', error: error?.code ?? 'network' }))
      }
    },
    [acceptDocument],
  )

  const loadDefault = useCallback(async (signal) => {
    try {
      const status = await loadDefaultWorkspace(signal)
      setDefaultWs({ phase: 'ready', id: status.id, registered: status.registered })
    } catch (error) {
      if (signal?.aborted) return
      setDefaultWs((current) => ({ ...current, phase: 'error' }))
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    loadDefault(controller.signal)
    return () => controller.abort()
  }, [load, loadDefault])

  const closeEditor = useCallback((returnFocus = false) => {
    if (returnFocus) {
      try { editorTriggerRef.current?.focus() } catch { /* trigger may be gone */ }
    }
    setEditor(null)
  }, [])

  const closeFilter = useCallback((returnFocus = false) => {
    setPanelOpen(false)
    if (returnFocus) {
      try { filterButtonRef.current?.focus() } catch { /* ignore */ }
    }
  }, [])

  // Outside pointer and Escape close the popovers; Escape returns focus.
  useEffect(() => {
    if (!panelOpen && editor === null) return undefined
    const onPointerDown = (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (panelOpen && !(filterWrapRef.current?.contains(target)) && !target.closest('.pd-filter-panel')) setPanelOpen(false)
      if (editor !== null && !(editorRef.current?.contains(target)) && !target.closest('[data-pd-tag-add]')) closeEditor(false)
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      if (editor !== null) {
        closeEditor(true)
        return
      }
      if (panelOpen) closeFilter(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [panelOpen, editor, closeEditor, closeFilter])

  // `/` focuses search when the page, not a field, has focus.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== '/' || event.defaultPrevented) return
      const target = event.target
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select?.()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!panelOpen && editor === null) return undefined
    const onResize = () => {
      setPanelOpen(false)
      closeEditor(false)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [panelOpen, editor, closeEditor])

  useEffect(() => () => clearTimeout(noticeTimer.current), [])

  // This distribution has no "default workspace": hide it even if the shell
  // created one, and offer the one-click unregister below.
  const visibleItems = useMemo(
    () => (defaultWs.id === null ? items : items.filter((workspace) => workspace.workspaceId !== defaultWs.id)),
    [items, defaultWs.id],
  )
  const rows = useMemo(() => buildRows(visibleItems, sessions, statuses, archivedIds), [visibleItems, sessions, statuses, archivedIds])
  const decorated = useMemo(() => {
    const withTags = decorateRows(rows, tagDoc.workspaces)
    return [...withTags].sort((left, right) => right.lastAt - left.lastAt || left.title.localeCompare(right.title, 'zh-CN'))
  }, [rows, tagDoc.workspaces])
  const visible = useMemo(() => filterRows(decorated, query, filters), [decorated, query, filters])
  const tree = useMemo(() => tagTree(decorated), [decorated])
  const groups = useMemo(() => groupTree(tree), [tree])
  const totals = useMemo(() => summarize(visible), [visible])
  const untaggedCount = useMemo(() => decorated.filter((row) => row.tags.length === 0).length, [decorated])

  const runAction = useCallback(
    (fn) => {
      try {
        const result = fn()
        if (result !== null && typeof result === 'object' && typeof result.catch === 'function') {
          result.catch(() => notify(t('act.unavailable'), 'warn'))
        }
      } catch {
        notify(t('act.unavailable'), 'warn')
      }
    },
    [notify, t],
  )

  const runMutation = useCallback(
    async (operation, successText) => {
      setBusyId(operation.workspaceId)
      try {
        const result = await mutateTags({ ...operation, expectedRevision: revisionRef.current })
        acceptDocument({ revision: result.revision, corrupt: false, workspaces: result.workspaces })
        if (successText !== undefined) notify(successText)
      } catch (error) {
        if (error?.code === 'tags/conflict') {
          try {
            const document = await loadTags()
            acceptDocument(document)
            const result = await mutateTags({ ...operation, expectedRevision: revisionRef.current })
            acceptDocument({ revision: result.revision, corrupt: false, workspaces: result.workspaces })
            notify(t('tags.conflict'), 'warn')
          } catch (again) {
            notify(t('tags.saveFailed', { code: again?.code ?? 'network' }), 'warn')
          }
        } else if (error?.code === 'network') {
          notify(t('tags.network'), 'warn')
        } else {
          notify(t('tags.saveFailed', { code: error?.code ?? 'unknown' }), 'warn')
        }
      } finally {
        setBusyId(null)
      }
    },
    [acceptDocument, notify, t],
  )

  const toggleFilter = useCallback((tag) => {
    setFilters((current) => (current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]))
  }, [])

  const pickFilter = useCallback(
    (tag) => {
      toggleFilter(tag)
      if (window.matchMedia('(max-width: 640px)').matches) setPanelOpen(false)
    },
    [toggleFilter],
  )

  const toggleExpanded = useCallback((root) => {
    setCollapsed((current) => ({ ...current, [root]: current[root] !== true }))
  }, [])

  const addTag = useCallback(
    (workspaceId, raw) => {
      const tag = normalizeTagInput(raw)
      if (tag === null) return { ok: false, error: t('editor.invalid') }
      const existing = tagDoc.workspaces?.[workspaceId]?.tags ?? []
      if (existing.includes(tag)) return { ok: false, error: t('editor.exists', { tag }) }
      runMutation({ workspaceId, op: 'add', tag }, t('tag.added', { tag }))
      return { ok: true }
    },
    [runMutation, t, tagDoc.workspaces],
  )

  const removeTag = useCallback(
    (workspaceId, tag) => {
      runMutation({ workspaceId, op: 'remove', tag }, t('tag.removed', { tag }))
    },
    [runMutation, t],
  )

  const removeDefault = useCallback(async () => {
    try {
      const result = await pruneDefaultWorkspace()
      setDefaultWs((current) => ({ ...current, registered: false }))
      notify(result.deleted ? t('default.removed') : t('default.absent'))
    } catch (error) {
      notify(t('default.failed', { code: error?.code ?? 'network' }), 'warn')
    }
  }, [notify, t])

  const openEditor = useCallback((workspaceId, element) => {
    setPanelOpen(false)
    const rect = element.getBoundingClientRect()
    const width = Math.min(300, window.innerWidth - 16)
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)
    const top = Math.min(rect.bottom + 6, window.innerHeight - 268)
    setEditorInput('')
    editorTriggerRef.current = element
    setEditor({ workspaceId, left, top, error: null })
  }, [])

  const submitEditor = useCallback(() => {
    if (editor === null) return
    const result = addTag(editor.workspaceId, editorInput)
    if (result.ok) {
      setEditor(null)
      return
    }
    setEditor((current) => (current === null ? current : { ...current, error: result.error }))
  }, [addTag, editor, editorInput])

  const suggestions = useMemo(() => {
    if (editor === null) return []
    const current = new Set(tagDoc.workspaces?.[editor.workspaceId]?.tags ?? [])
    const needle = editorInput.trim().toLowerCase()
    const pool = new Set()
    for (const row of decorated) for (const tag of row.tags) if (!current.has(tag)) pool.add(tag)
    return [...pool]
      .filter((tag) => needle.length === 0 || tag.toLowerCase().includes(needle))
      .slice(0, 6)
  }, [decorated, editor, editorInput, tagDoc.workspaces])

  const now = Date.now()
  const tagsReady = tagDoc.phase === 'ready'
  const shownCount = visible.length
  const totalCount = visibleItems.length
  const resultText = t('registerCount', { shown: pad2(shownCount), total: pad2(totalCount) })

  const activeChips =
    filters.length === 0 ? null : (
      <div className="pd-filter-chips" aria-live="polite">
        <span className="pd-filter-chips-label">{t('filter.tags')}</span>
        {filters.map((tag) => (
          <span className="pd-chip" key={tag}>
            <span
              className={`pd-chip-mark${tag === UNTAGGED ? ' is-muted' : ''}`}
              style={tag === UNTAGGED ? undefined : { background: tagColor(tag) }}
              aria-hidden="true"
            />
            <span className="pd-chip-label">{tag === UNTAGGED ? t('filter.untagged') : tag}</span>
            <button
              type="button"
              className="pd-chip-x"
              aria-label={t('filter.remove', { tag: tag === UNTAGGED ? t('filter.untagged') : tag })}
              onClick={() => toggleFilter(tag)}
            >
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        <button type="button" className="pd-chip-clear" onClick={() => setFilters([])}>
          {t('filter.clearAll')}
        </button>
      </div>
    )

  const defaultNotice = defaultWs.registered ? (
    <Notice
      tone="warn"
      title={t('default.title')}
      copy={t('default.copy')}
      action={t('default.remove')}
      onAction={removeDefault}
    />
  ) : null

  const tagNotice =
    tagDoc.phase === 'error' ? (
      <Notice
        tone="warn"
        title={t('tags.error', { code: tagDoc.error ?? 'network' })}
        action={t('tags.retry')}
        onAction={() => load()}
      />
    ) : tagDoc.corrupt ? (
      <Notice tone="warn" title={t('tags.corruptTitle')} copy={t('tags.corrupt')} />
    ) : null

  let board
  if (visibleItems.length === 0) {
    board = <EmptyState kind="none" t={t} />
  } else if (visible.length === 0) {
    board = (
      <EmptyState
        kind="filtered"
        t={t}
        onClear={() => {
          setQuery('')
          setFilters([])
        }}
      />
    )
  } else {
    board = visible.map((row, index) => (
      <Row
        key={row.id}
        row={row}
        index={index}
        t={t}
        busy={busyId === row.id || !tagsReady}
        now={now}
        filters={filters}
        onFilter={pickFilter}
        onRemove={(tag) => removeTag(row.id, tag)}
        onAdd={(event) => openEditor(row.id, event.currentTarget)}
        onNew={() => runAction(() => props.newSession?.(row.id))}
      />
    ))
  }

  const editorElement =
    editor === null ? null : (
      <div
        className="pd-editor"
        ref={editorRef}
        style={{ left: `${editor.left}px`, top: `${editor.top}px` }}
        role="dialog"
        aria-label={t('editor.title')}
      >
        <label className="pd-editor-label" htmlFor="pd-tag-input">
          {t('editor.title')}
        </label>
        <input
          id="pd-tag-input"
          className="pd-editor-input"
          type="text"
          value={editorInput}
          placeholder={t('editor.placeholder')}
          autoFocus
          autoComplete="off"
          spellCheck="false"
          onChange={(event) => {
            setEditorInput(event.target.value)
            setEditor((current) => (current === null ? current : { ...current, error: null }))
          }}
          onKeyDown={(event) => {
            if (event.isComposing) return
            if (event.key === 'Enter') {
              event.preventDefault()
              submitEditor()
            }
          }}
        />
        {editor.error !== null ? (
          <p className="pd-editor-error" role="alert">
            {editor.error}
          </p>
        ) : null}
        {suggestions.length > 0 ? (
          <div className="pd-editor-suggest">
            {suggestions.map((tag) => (
              <button
                type="button"
                key={tag}
                onClick={() => {
                  const result = addTag(editor.workspaceId, tag)
                  if (result.ok) setEditor(null)
                  else setEditor((current) => (current === null ? current : { ...current, error: result.error }))
                }}
              >
                <span className="pd-tag-mark" style={{ background: tagColor(tag) }} aria-hidden="true" />
                {tag}
              </button>
            ))}
          </div>
        ) : null}
        <p className="pd-editor-hint">{t('editor.hint')}</p>
      </div>
    )

  return (
    <div
      className="pd-root"
      data-dsh-panel="project-dashboard"
      ref={rootRef}
      onScroll={() => closeEditor(false)}
    >
      <div className="pd-page">
        <header className="pd-masthead">
          <div className="pd-masthead-top">
            <div className="pd-kicker">
              <span className="pd-kicker-mark" aria-hidden="true" />
              <span>{t('kicker')}</span>
            </div>
            <div className="pd-tools">
              <label className="pd-search-field">
                <span className="pd-search-cap">{t('searchCap')}</span>
                <span className="pd-search">
                  <span className="pd-search-icon">
                    <Icon name="search" size={15} />
                  </span>
                  <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    placeholder={t('search.placeholder')}
                    aria-label={t('search.placeholder')}
                    autoComplete="off"
                    spellCheck="false"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <span className="pd-search-kbd" aria-hidden="true">
                    /
                  </span>
                  {query.length > 0 ? (
                    <button
                      type="button"
                      className="pd-search-clear"
                      aria-label={t('search.clear')}
                      onClick={() => setQuery('')}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  ) : null}
                </span>
              </label>
              <div className="pd-filter-wrap" ref={filterWrapRef}>
                <span className="pd-filter-cap">{t('filterCap')}</span>
                <button
                  type="button"
                  className="pd-filter-btn"
                  ref={filterButtonRef}
                  aria-expanded={panelOpen}
                  aria-controls="pd-filter-panel"
                  onClick={() => setPanelOpen((open) => !open)}
                >
                  <Icon name="tag" size={13} />
                  <span>{t('filter.tags')}</span>
                  {filters.length > 0 ? <span className="pd-badge">{filters.length}</span> : null}
                  <span className="pd-filter-caret" aria-hidden="true">
                    <Icon name="chevron" size={9} />
                  </span>
                </button>
                {panelOpen ? (
                  <FilterPanel
                    groups={groups}
                    filters={filters}
                    totalCount={totalCount}
                    untaggedCount={untaggedCount}
                    collapsed={collapsed}
                    t={t}
                    onPick={pickFilter}
                    onExpand={toggleExpanded}
                    onClear={() => setFilters([])}
                    onDone={() => closeFilter(true)}
                  />
                ) : null}
              </div>
              <span className="pd-result">{resultText}</span>
            </div>
          </div>
          <div className="pd-masthead-main">
            <h1 className="pd-title">{t('title')}</h1>
            <p className="pd-sub">{t('subtitle')}</p>
          </div>
          {activeChips}
        </header>

        {defaultNotice}
        {tagNotice}

        <section className="pd-telemetry" aria-label={t('registerTitle')}>
          <Stat label={t('statWorkspaces')} value={pad2(totals.workspaces)} meta={t('wsMeta', { n: totalCount })} />
          <Stat
            label={t('statSessions')}
            value={pad2(totals.sessions)}
            meta={t('sessionsMeta', { archived: totals.archived, running: totals.running, pending: totals.pending })}
          />
          <Stat
            label={t('statRunning')}
            value={pad2(totals.running)}
            meta={totals.running > 0 ? t('runningMeta', { n: totals.running }) : t('noRunning')}
            tone={totals.running > 0 ? 'live' : undefined}
          />
          <Stat
            label={t('statWaiting')}
            value={pad2(totals.pending)}
            meta={totals.pending > 0 ? t('waitingMeta', { n: totals.pending }) : t('noWaiting')}
            tone={totals.pending > 0 ? 'wait' : undefined}
          />
          <div className="pd-signal">
            <div className="pd-signal-head">
              <span>{t('activity')}</span>
              <span className="pd-signal-span">{t('days14')}</span>
            </div>
            <SignalChart rows={visible} now={now} t={t} />
            <span className="pd-signal-foot">{t('localSessions')}</span>
          </div>
        </section>

        <div className="pd-register-head">
          <span className="pd-register-title">{t('registerTitle')}</span>
          <span className="pd-register-note">{t('registerNote')}</span>
          <span className="pd-register-count">{resultText}</span>
        </div>

        <div className="pd-cols" aria-hidden="true">
          <span>{t('colIndex')}</span>
          <span>{t('colWorkspace')}</span>
          <span>{t('colActivity')}</span>
          <span>{t('colSessions')}</span>
          <span>{t('colLast')}</span>
          <span />
        </div>

        <section className="pd-board" aria-label={t('registerTitle')}>
          {board}
        </section>

        <footer className="pd-page-foot">
          <details>
            <summary>
              <Icon name="info" size={12} />
              <span>{t('store.label')}</span>
            </summary>
            <p>{t('store.copy')}</p>
          </details>
        </footer>
      </div>

      {editorElement}

      {notice === null ? null : (
        <div className={`pd-toast${notice.tone === 'warn' ? ' is-warn' : ''}`} role="status" aria-live="polite">
          {notice.text}
        </div>
      )}
    </div>
  )
}
