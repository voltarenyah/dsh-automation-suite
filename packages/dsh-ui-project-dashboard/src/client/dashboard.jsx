/**
 * The dashboard page: rows for every registered workspace, multi-level tags,
 * search, tag filtering, and the ledger. All workspace/session data comes from
 * the host's standard root hooks; tags come from the plugin's own endpoint.
 *
 * P1 scope: rows, tags, search/filter, actions. The four engineering tiles are
 * placeholders until P2 reads the per-workspace derived views.
 *
 * @module dsh-ui-project-dashboard/client/dashboard
 */

import { Fragment, createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  buildRows,
  decorateRows,
  filterRows,
  normalizeTagInput,
  summarize,
  tagTree,
} from './model.js'
import { loadDefaultWorkspace, loadTags, mutateTags, pruneDefaultWorkspace } from './tags-api.js'

/** Stable colours for tag roots, so the same tree reads the same everywhere. */
const TAG_HUES = ['#4176e6', '#22c55e', '#f59e0b', '#8b5cf6', '#14b8a6', '#f25a5a', '#64748b']

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
  return new Date(ms).toLocaleDateString()
}

/** Locale-independent number formatting for counters. */
const numberFormat = new Intl.NumberFormat('zh-CN')

/**
 * One ledger tile.
 *
 * @param {{ label: string, value: string, unit?: string, meta: string, muted?: boolean }} props - tile content.
 */
function LedgerCell(props) {
  return createElement(
    'div',
    { className: 'pd-ledger-cell' },
    createElement('span', { className: 'pd-ledger-label' }, props.label),
    createElement(
      'span',
      { className: 'pd-ledger-value' },
      createElement('span', null, props.value),
      props.unit !== undefined ? createElement('span', { className: 'pd-unit' }, props.unit) : null,
    ),
    createElement('span', { className: 'pd-ledger-meta', title: props.meta }, props.meta),
  )
}

/**
 * One workspace row.
 *
 * @param {{ row: object, index: number, t: Function, busy: boolean, onFilter: Function, onRemove: Function, onAdd: Function, onNew: Function, now: number }} props - row and callbacks.
 */
function Row(props) {
  const { row, index, t, busy, onFilter, onRemove, onAdd, onNew, now } = props
  const facts = []
  facts.push(createElement('span', { key: 'sessions' }, t('row.sessions', { n: row.sessions })))
  if (row.archived > 0) facts.push(createElement('span', { key: 'archived', className: 'pd-sep' }, '·'), createElement('span', { key: 'archived-n' }, t('row.archived', { n: row.archived })))
  if (row.blank > 0) facts.push(createElement('span', { key: 'blank', className: 'pd-sep' }, '·'), createElement('span', { key: 'blank-n' }, t('row.blank', { n: row.blank })))

  return createElement(
    'article',
    { className: 'pd-ws', 'data-workspace': row.id },
    createElement(
      'div',
      { className: 'pd-ws-head' },
      createElement('span', { className: 'pd-index' }, String(index + 1).padStart(2, '0')),
      createElement(
        'div',
        { className: 'pd-ws-main' },
        createElement(
          'div',
          { className: 'pd-ws-title-row' },
          row.running > 0 ? createElement('span', { className: 'pd-dot is-live', title: t('row.running', { n: row.running }) }) : null,
          row.pending > 0 ? createElement('span', { className: 'pd-dot is-wait', title: t('row.pending', { n: row.pending }) }) : null,
          createElement('span', { className: 'pd-ws-title', title: row.path }, row.title),
        ),
        createElement(
          'div',
          { className: 'pd-ws-facts' },
          createElement('span', { className: 'pd-clock', 'aria-hidden': 'true' }, '◷'),
          createElement('span', null, relativeTime(row.lastAt, now, t)),
          createElement('span', { className: 'pd-sep' }, '·'),
          ...facts,
        ),
      ),
    ),
    createElement(
      'div',
      { className: 'pd-ws-strip' },
      createElement(
        'div',
        { className: 'pd-tags' },
        row.tags.length === 0 ? createElement('span', { className: 'pd-tags-empty' }, t('row.noTags')) : null,
        ...row.tags.map((tag) =>
          createElement(
            'span',
            { className: 'pd-tag', key: tag },
            createElement('button', {
              type: 'button',
              className: 'pd-tag-main',
              title: t('row.filterBy', { tag }),
              onClick: () => onFilter(tag),
            }, createElement('span', { className: 'pd-tag-dot', style: { background: tagColor(tag) } }), createElement('span', { className: 'pd-tag-text' }, tag)),
            createElement('button', {
              type: 'button',
              className: 'pd-tag-x',
              title: t('row.removeTag'),
              'aria-label': t('row.removeTag'),
              disabled: busy,
              onClick: () => onRemove(tag),
            }, '×'),
          ),
        ),
        createElement('button', {
          type: 'button',
          className: 'pd-tag-add',
          'data-pd-tag-add': '1',
          disabled: busy,
          onClick: onAdd,
        }, t('row.addTag')),
      ),
      createElement(
        'span',
        { className: 'pd-actions' },
        createElement(
          'button',
          { type: 'button', className: 'pd-new', title: t('row.newSession'), 'aria-label': t('row.newSession'), onClick: onNew },
          plusIcon(),
          createElement('span', null, t('row.newSession')),
        ),
      ),
    ),
  )
}

/** @returns the "new session" glyph. */
function plusIcon() {
  return createElement(
    'svg',
    { viewBox: '0 0 24 24', width: 11, height: 11, fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', 'aria-hidden': 'true' },
    createElement('path', { d: 'M12 5.2v13.6M5.2 12h13.6' }),
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
  const [editor, setEditor] = useState(null)
  const [editorInput, setEditorInput] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [notice, setNotice] = useState(null)

  const revisionRef = useRef(0)
  const noticeTimer = useRef(undefined)
  const rootRef = useRef(null)

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

  // Close the tag popovers on an outside pointer or Escape.
  useEffect(() => {
    if (!panelOpen && editor === null) return undefined
    const onPointerDown = (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('.pd-tag-filter') || target.closest('.pd-tag-editor') || target.closest('[data-pd-tag-add]')) return
      setPanelOpen(false)
      setEditor(null)
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      setPanelOpen(false)
      setEditor(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [panelOpen, editor])

  useEffect(() => () => clearTimeout(noticeTimer.current), [])

  // This distribution has no "default workspace": hide it even if the shell
  // created one, and offer the one-click unregister below.
  const visibleItems = useMemo(
    () => (defaultWs.id === null ? items : items.filter((workspace) => workspace.workspaceId !== defaultWs.id)),
    [items, defaultWs.id],
  )
  const rows = useMemo(() => buildRows(visibleItems, sessions, statuses, archivedIds), [visibleItems, sessions, statuses, archivedIds])
  const decorated = useMemo(() => decorateRows(rows, tagDoc.workspaces), [rows, tagDoc.workspaces])
  const visible = useMemo(() => filterRows(decorated, query, filters), [decorated, query, filters])
  const tree = useMemo(() => tagTree(decorated), [decorated])
  const totals = useMemo(() => summarize(visible), [visible])

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

  const addTag = useCallback(
    (workspaceId, raw) => {
      const tag = normalizeTagInput(raw)
      if (tag === null) {
        notify(t('tag.invalid'), 'warn')
        return false
      }
      const existing = (tagDoc.workspaces?.[workspaceId]?.tags ?? [])
      if (existing.includes(tag)) {
        notify(t('tag.exists', { tag }), 'warn')
        return false
      }
      runMutation({ workspaceId, op: 'add', tag }, t('tag.added', { tag }))
      return true
    },
    [notify, runMutation, t, tagDoc.workspaces],
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
    const rect = element.getBoundingClientRect()
    const width = 280
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 12)
    const top = Math.min(rect.bottom + 6, window.innerHeight - 230)
    setEditorInput('')
    setEditor({ workspaceId, left, top })
  }, [])

  const submitEditor = useCallback(() => {
    if (editor === null) return
    if (addTag(editor.workspaceId, editorInput)) setEditor(null)
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

  const toolbar = createElement(
    'div',
    { className: 'pd-toolbar', role: 'search' },
    createElement(
      'label',
      { className: 'pd-search' },
      createElement('span', { className: 'pd-search-icon', 'aria-hidden': 'true' }, '⌕'),
      createElement('input', {
        type: 'search',
        value: query,
        placeholder: t('search.placeholder'),
        'aria-label': t('search.placeholder'),
        onChange: (event) => setQuery(event.target.value),
      }),
      query.length > 0
        ? createElement('button', { type: 'button', className: 'pd-search-clear', 'aria-label': t('search.clear'), onClick: () => setQuery('') }, '×')
        : null,
    ),
    createElement(
      'div',
      { className: 'pd-tag-filter' },
      createElement(
        'button',
        {
          type: 'button',
          className: 'pd-filter-btn',
          'aria-expanded': panelOpen,
          onClick: () => setPanelOpen((open) => !open),
        },
        createElement(
          'svg',
          { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
          createElement('path', { d: 'M4 5.5h16l-6.4 7.4v5.2l-3.2 1.6v-6.8Z' }),
        ),
        t('filter.tags'),
        filters.length > 0 ? createElement('span', { className: 'pd-count' }, String(filters.length)) : null,
      ),
      panelOpen
        ? createElement(
            'div',
            { className: 'pd-tag-panel', role: 'group', 'aria-label': t('filter.title') },
            createElement(
              'div',
              { className: 'pd-panel-head' },
              createElement('span', null, t('filter.title')),
              createElement('button', { type: 'button', onClick: () => setFilters([]) }, t('filter.clear')),
            ),
            tree.length === 0
              ? createElement('div', { className: 'pd-panel-empty' }, t('filter.empty'))
              : tree.map((node) =>
                  createElement(
                    'button',
                    {
                      type: 'button',
                      key: node.path,
                      className: `pd-tree-row${filters.includes(node.path) ? ' is-on' : ''}`,
                      style: { paddingLeft: `${8 + node.depth * 14}px` },
                      title: node.path,
                      onClick: () => toggleFilter(node.path),
                    },
                    createElement('span', { className: 'pd-tag-dot', style: { background: tagColor(node.path) } }),
                    createElement('span', { className: 'pd-tree-label' }, node.label),
                    createElement('span', { className: 'pd-tree-count' }, String(node.count)),
                  ),
                ),
          )
        : null,
    ),
    createElement(
      'div',
      { className: 'pd-active-filters' },
      filters.map((tag) =>
        createElement(
          'span',
          { className: 'pd-filter-chip', key: tag },
          createElement('span', { className: 'pd-tag-dot', style: { background: tagColor(tag) } }),
          tag,
          createElement('button', { type: 'button', 'aria-label': t('filter.remove', { tag }), onClick: () => toggleFilter(tag) }, '×'),
        ),
      ),
    ),
    createElement('span', { className: 'pd-result' }, t('result', { shown: shownCount, total: totalCount })),
  )

  const ledger = createElement(
    'section',
    { className: 'pd-ledger', 'aria-label': t('ledger.title') },
    createElement(LedgerCell, { label: t('ledger.workspaces'), value: numberFormat.format(totals.workspaces), meta: t('ledger.workspacesMeta', { n: totalCount }) }),
    createElement(LedgerCell, { label: t('ledger.sessions'), value: numberFormat.format(totals.sessions), meta: t('ledger.sessionsMeta', { archived: totals.archived, running: totals.running, pending: totals.pending }) }),
    createElement(LedgerCell, { label: t('ledger.blocks'), value: '—', meta: t('ledger.p2') }),
    createElement(LedgerCell, { label: t('ledger.io'), value: '—', meta: t('ledger.p2') }),
    createElement(LedgerCell, { label: t('ledger.versions'), value: '—', meta: t('ledger.p2') }),
    createElement(LedgerCell, { label: t('ledger.drawings'), value: '—', meta: t('ledger.p2') }),
  )

  let board
  if (visibleItems.length === 0) {
    board = createElement(
      'div',
      { className: 'pd-empty' },
      createElement('p', null, t('empty.none')),
      createElement('p', { className: 'pd-empty-hint' }, t('empty.noneHint')),
    )
  } else if (visible.length === 0) {
    board = createElement(
      'div',
      { className: 'pd-empty' },
      createElement('p', null, t('empty.filtered')),
      createElement('p', { className: 'pd-empty-hint' }, t('empty.filteredHint')),
      createElement(
        'button',
        { type: 'button', className: 'pd-btn', onClick: () => { setQuery(''); setFilters([]) } },
        t('empty.clear'),
      ),
    )
  } else {
    board = visible.map((row, index) =>
      createElement(Row, {
        key: row.id,
        row,
        index,
        t,
        busy: busyId === row.id || !tagsReady,
        now,
        onFilter: toggleFilter,
        onRemove: (tag) => removeTag(row.id, tag),
        onAdd: (event) => openEditor(row.id, event.currentTarget),
        onNew: () => runAction(() => props.newSession?.(row.id)),
      }),
    )
  }

  const tagBanner =
    tagDoc.phase === 'error'
      ? createElement(
          'div',
          { className: 'pd-banner', role: 'status' },
          createElement('span', null, t('tags.error', { code: tagDoc.error ?? 'network' })),
          createElement(
            'button',
            { type: 'button', className: 'pd-btn pd-btn-sm', onClick: () => load() },
            t('tags.retry'),
          ),
        )
      : tagDoc.corrupt
        ? createElement('div', { className: 'pd-banner is-warn', role: 'status' }, t('tags.corrupt'))
        : null

  const defaultBanner = defaultWs.registered
    ? createElement(
        'div',
        { className: 'pd-banner', role: 'status' },
        createElement('span', null, t('default.banner')),
        createElement(
          'button',
          { type: 'button', className: 'pd-btn pd-btn-sm', onClick: removeDefault },
          t('default.remove'),
        ),
      )
    : null

  const editorElement =
    editor === null
      ? null
      : createElement(
          'div',
          { className: 'pd-tag-editor', style: { left: `${editor.left}px`, top: `${editor.top}px` }, role: 'dialog', 'aria-label': t('editor.title') },
          createElement('input', {
            type: 'text',
            value: editorInput,
            placeholder: t('editor.placeholder'),
            autoFocus: true,
            onChange: (event) => setEditorInput(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submitEditor()
              }
            },
          }),
          suggestions.length > 0
            ? createElement(
                'div',
                { className: 'pd-suggest' },
                suggestions.map((tag) =>
                  createElement(
                    'button',
                    { type: 'button', key: tag, onClick: () => { addTag(editor.workspaceId, tag); setEditor(null) } },
                    createElement('span', { className: 'pd-tag-dot', style: { background: tagColor(tag) } }),
                    tag,
                  ),
                ),
              )
            : null,
          createElement('div', { className: 'pd-editor-hint' }, t('editor.hint')),
        )

  return createElement(
    'div',
    { className: 'pd-root', 'data-dsh-panel': 'project-dashboard', ref: rootRef, onScroll: () => setEditor(null) },
    createElement(
      'div',
      { className: 'pd-page' },
      createElement(
        'header',
        { className: 'pd-head' },
        createElement('div', { className: 'pd-eyebrow' }, t('eyebrow')),
        createElement('h1', { className: 'pd-title' }, t('title')),
        createElement('p', { className: 'pd-sub' }, t('subtitle')),
      ),
      toolbar,
      tagBanner,
      defaultBanner,
      ledger,
      createElement('section', { className: 'pd-board', 'aria-label': t('board.title') }, board),
      createElement('footer', { className: 'pd-foot' }, t('footnote')),
    ),
    editorElement,
    notice === null
      ? null
      : createElement(
          'div',
          { className: `pd-toast${notice.tone === 'warn' ? ' is-warn' : ''}`, role: 'status' },
          notice.text,
        ),
  )
}
