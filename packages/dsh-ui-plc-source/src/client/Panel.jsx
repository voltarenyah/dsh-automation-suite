/**
 * The PLC Blocks tab body: one flat, filterable list of every object the
 * exporter wrote under `source/`, plus the objects it refused.
 *
 * Data path: list `source/` for devices, then read each device's
 * `_tia-openness-manifest.json` in one `readBytes` call (773 KB for a 1376-object
 * export, well under the 32 MiB whole-file cap). The manifest is the only place
 * `simaticType` exists, which is why the type filter needs it, and the only place
 * the refused objects are named at all. Directory layout is never rendered: the
 * list is flat by requirement.
 *
 * Interaction: a click selects a row (selection is reserved for later features),
 * and the context menu carries the actions — currently "open the source file",
 * which is what the click used to do. Opening reuses the shipped document
 * preview through a `dsh-resource://file/...` address.
 *
 * All view state (filters, query, selection, scroll offset, and the loaded rows
 * as a view cache) lives in the slot store, so switching to another sidebar tab
 * and back neither loses the setup nor re-reads a manifest.
 *
 * Copy goes through the framework's `t` seat, which means every string is
 * resolved during render and therefore follows the app's language setting.
 *
 * @module dsh-ui-plc-source/Panel
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import {
  ALL,
  MANIFEST_FILE,
  SOURCE_DIRECTORY,
  UNKNOWN_TYPE,
  deviceOptions,
  errorCopy,
  filterRows,
  joinPath,
  parseManifest,
  relativeUnder,
  resourceAddress,
  rowKey,
  sizeLabel,
  sortRows,
  typeOptions,
} from '../model'
import { EMPTY_VIEW } from './store'

/** Rows rendered before the list asks for a narrower filter. */
const RENDER_LIMIT = 2000

/** Bounds of the fallback directory walk for a device with no readable manifest. */
const WALK_MAX_DEPTH = 8
const WALK_MAX_ROWS = 5000

/** Badge key per object family when the manifest gives no type. */
const KIND_BADGE = { block: 'badge.block', type: 'badge.type', tagTable: 'badge.tagTable', file: 'badge.file' }

/** Bucket used when the framework hands over no tab record (never in practice). */
const FALLBACK_TAB_ID = 'plc-blocks'

/** Identity fallback for the translate seat; keys pass through unchanged. */
const identity = (key) => key

/**
 * Flatten one device directory by listing it level by level. Used only when the
 * manifest is missing or unreadable.
 *
 * @param {object} options - walk inputs.
 * @param {(path: string, signal?: AbortSignal) => Promise<any>} options.listDirectory
 * @param {AbortSignal | undefined} options.signal - aborts with the tab.
 * @param {string} options.deviceDirectory - absolute device directory.
 * @param {string} options.device - device name stamped on the rows.
 * @returns {Promise<{ rows: any[], truncated: boolean }>}
 */
async function walkDevice({ listDirectory, signal, deviceDirectory, device }) {
  const rows = []
  let truncated = false
  const queue = [{ path: deviceDirectory, depth: 0 }]
  while (queue.length > 0) {
    if (signal?.aborted === true) break
    const current = queue.shift()
    const listed = await listDirectory(current.path, signal)
    if (listed.ok !== true) {
      truncated = true
      continue
    }
    if (listed.truncated === true) truncated = true
    for (const entry of listed.entries) {
      if (entry.type === 'directory') {
        if (current.depth < WALK_MAX_DEPTH) queue.push({ path: joinPath(current.path, entry.name), depth: current.depth + 1 })
        else truncated = true
        continue
      }
      if (entry.type !== 'file') continue
      rows.push({
        device,
        kind: 'file',
        simaticType: UNKNOWN_TYPE,
        name: entry.name,
        ...(typeof entry.size === 'number' ? { bytes: entry.size } : {}),
        verified: true,
        file: joinPath(current.path, entry.name),
      })
      if (rows.length >= WALK_MAX_ROWS) {
        truncated = true
        queue.length = 0
        break
      }
    }
  }
  return { rows, truncated }
}

/**
 * Tab body. Data arrives as derived props: `useTabInfo`/`useSessions` are
 * framework hooks, the store, the translate seat and the two I/O callbacks come
 * from the registration.
 *
 * @param {object} props - framework props (tab, sessions, store, t, injected face).
 */
export function Panel(props) {
  const readTab = typeof props.useTabInfo === 'function' ? props.useTabInfo : () => undefined
  const readSessions = typeof props.useSessions === 'function' ? props.useSessions : () => undefined
  // A stable fallback keeps the hook call unconditional; the real store is
  // always present because the registration declares one.
  const useView = typeof props.useStore === 'function' ? props.useStore : () => EMPTY_VIEW
  // The framework's translate seat is preferred; the bound function handed over
  // by the inject face has a stable identity per namespace, so either works and
  // neither captures a language.
  const t = typeof props.t === 'function' ? props.t : typeof props.translate === 'function' ? props.translate : identity
  const info = readTab()
  const tab = info?.tab
  const signal = tab?.signal
  const sessionId = props.sessionId
  const cwd = readSessions((sessions) => sessions?.byId?.[sessionId]?.cwd)
  const tabId = typeof tab?.id === 'string' && tab.id.length > 0 ? tab.id : FALLBACK_TAB_ID

  const io = useRef({ listDirectory: props.listDirectory, readTextFile: props.readTextFile })
  io.current = { listDirectory: props.listDirectory, readTextFile: props.readTextFile }

  const view = useView((state) => state?.byTab?.[tabId]) ?? EMPTY_VIEW
  const actions = props.actions ?? {}
  const set = typeof actions.set === 'function' ? actions.set : () => {}
  const forget = typeof actions.forget === 'function' ? actions.forget : () => {}
  const viewRef = useRef(view)
  viewRef.current = view

  const [reloads, setReloads] = useState(0)
  const [menu, setMenu] = useState(null)
  const bodyRef = useRef(null)
  const scrollRef = useRef(null)
  const restored = useRef(false)

  const rootPath = typeof cwd === 'string' && cwd.length > 0 ? joinPath(cwd, SOURCE_DIRECTORY) : null
  const { status, rows, refused, notes, device, type, query, selected } = view

  useEffect(() => {
    if (rootPath === null) {
      set(tabId, { status: 'no-workspace' })
      return undefined
    }
    // Rows cached by an earlier mount are as good as a fresh read; only an
    // explicit refresh (or a different root) re-reads the manifests.
    if (reloads === 0 && viewRef.current.status === 'ready') return undefined
    let cancelled = false
    set(tabId, { status: 'loading', rows: [], refused: 0, notes: [], errorCode: '' })

    const run = async () => {
      const listed = await io.current.listDirectory(rootPath, signal)
      if (cancelled || signal?.aborted === true) return
      if (listed.ok !== true) {
        set(tabId, { status: 'failed', errorCode: listed.code })
        return
      }
      const devices = listed.entries.filter((entry) => entry.type === 'directory').map((entry) => entry.name)
      const collected = []
      const collectedNotes = []
      let refusedCount = 0
      for (const name of devices) {
        if (cancelled || signal?.aborted === true) return
        const deviceDirectory = joinPath(rootPath, name)
        const read = await io.current.readTextFile(joinPath(deviceDirectory, MANIFEST_FILE), signal)
        if (cancelled || signal?.aborted === true) return
        const parsed = read.ok === true ? parseManifest(read.text, name) : { ok: false, code: read.code }
        if (parsed.ok === true) {
          collected.push(...parsed.rows)
          refusedCount += parsed.failures
          continue
        }
        const walked = await walkDevice({ listDirectory: io.current.listDirectory, signal, deviceDirectory, device: name })
        if (cancelled || signal?.aborted === true) return
        collected.push(...walked.rows)
        // Notes carry facts, not copy: the sentence is built during render so a
        // language switch re-renders it too.
        collectedNotes.push({ device: name, code: parsed.code, files: walked.rows.length, truncated: walked.truncated })
      }
      if (cancelled || signal?.aborted === true) return
      set(tabId, { status: 'ready', rows: collected, refused: refusedCount, notes: collectedNotes })
    }

    void run().catch(() => {
      if (!cancelled) set(tabId, { status: 'failed', errorCode: 'gateway/internal' })
    })
    return () => {
      cancelled = true
    }
  }, [rootPath, reloads, signal, tabId])

  // The tab record is gone (closed, or the plugin unloaded): drop its bucket.
  useEffect(() => {
    if (signal === undefined) return undefined
    const onAbort = () => forget(tabId)
    signal.addEventListener('abort', onAbort, { once: true })
    return () => signal.removeEventListener('abort', onAbort)
  }, [signal, tabId])

  // Scroll offsets are recorded while scrolling but written once, on unmount:
  // writing per event would re-render the list on every pixel.
  useEffect(
    () => () => {
      if (scrollRef.current !== null) set(tabId, { scrollTop: scrollRef.current })
    },
    [tabId],
  )

  useEffect(() => {
    if (restored.current) return
    if (status !== 'ready') return
    const element = bodyRef.current
    if (element !== null && typeof view.scrollTop === 'number' && view.scrollTop > 0) {
      element.scrollTop = view.scrollTop
    }
    restored.current = true
  }, [status, view.scrollTop])

  useEffect(() => {
    if (menu === null) return undefined
    const close = () => setMenu(null)
    const onKey = (event) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const deviceChoices = useMemo(() => deviceOptions(rows), [rows])
  const typeChoices = useMemo(() => typeOptions(rows), [rows])
  const visible = useMemo(
    () => sortRows(filterRows(rows, device, type, query)),
    [rows, device, type, query],
  )
  const shown = visible.length > RENDER_LIMIT ? visible.slice(0, RENDER_LIMIT) : visible

  const select = (row) => set(tabId, { selected: rowKey(row) })

  const open = (row) => {
    const openResource = tab?.actions?.openResource
    if (typeof openResource !== 'function') return
    if (typeof cwd !== 'string' || cwd.length === 0) return
    const relative = relativeUnder(cwd, row.file)
    if (relative === null || relative.length === 0) return
    try {
      // A viewer claims the address; when none does the sidebar throws, and an
      // unopenable file must not take the list down with it.
      openResource(resourceAddress(sessionId, relative))
    } catch {
      /* no viewer for this address: keep the list as it is */
    }
  }

  const openMenu = (event, row) => {
    event.preventDefault()
    select(row)
    const width = 220
    const height = 88
    setMenu({
      row,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    })
  }

  const menuRow = menu?.row ?? null
  const menuCanOpen = menuRow !== null && menuRow.refused !== true && menuRow.file.length > 0

  const head = (
    <div className="plps-head">
      <span className="plps-title">{t('tab.title')}</span>
      <span className="plps-count">
        {status === 'ready' ? `${visible.length} / ${rows.length}` : SOURCE_DIRECTORY + '/'}
      </span>
      <button
        type="button"
        className="plps-btn"
        onClick={() => setReloads((value) => value + 1)}
        disabled={status === 'loading'}
        title={t('action.refresh')}
      >
        {status === 'loading' ? t('action.refreshing') : t('action.refresh')}
      </button>
      <div className="plps-filters">
        <select
          className="plps-select"
          value={device}
          onChange={(event) => set(tabId, { device: event.target.value })}
          aria-label={t('filter.device.label')}
          disabled={deviceChoices.length === 0}
        >
          <option value={ALL}>{t('filter.device.all', { count: rows.length })}</option>
          {deviceChoices.map((choice) => (
            <option key={choice.value} value={choice.value}>{`${choice.value}（${choice.count}）`}</option>
          ))}
        </select>
        <select
          className="plps-select"
          value={type}
          onChange={(event) => set(tabId, { type: event.target.value })}
          aria-label={t('filter.type.label')}
          disabled={typeChoices.length === 0}
        >
          <option value={ALL}>{t('filter.type.all', { count: rows.length })}</option>
          {typeChoices.map((choice) => (
            <option key={choice.value} value={choice.value}>{`${choice.value}（${choice.count}）`}</option>
          ))}
        </select>
      </div>
      <div className="plps-filters">
        <input
          className="plps-search"
          type="search"
          value={query}
          onChange={(event) => set(tabId, { query: event.target.value })}
          placeholder={t('search.placeholder')}
          aria-label={t('search.label')}
        />
        {query.length === 0 ? null : (
          <button
            type="button"
            className="plps-btn plps-clear"
            onClick={() => set(tabId, { query: '' })}
            title={t('action.clear')}
          >
            {t('action.clear')}
          </button>
        )}
      </div>
    </div>
  )

  return (
    <div className="plps-root">
      {head}
      <div
        className="plps-body"
        ref={bodyRef}
        onScroll={(event) => {
          scrollRef.current = event.currentTarget.scrollTop
          if (menu !== null) setMenu(null)
        }}
      >
        {status === 'no-workspace' ? <div className="plps-hint">{t('hint.noWorkspace')}</div> : null}
        {status === 'loading' ? <div className="plps-hint">{t('hint.reading')}</div> : null}
        {status === 'failed' ? (
          <div className="plps-error">
            {t(errorCopy(view.errorCode || 'gateway/internal').key, {
              code: view.errorCode || 'gateway/internal',
            })}
          </div>
        ) : null}
        {status === 'ready' && rows.length === 0 ? <div className="plps-hint">{t('hint.noDevices')}</div> : null}
        {status === 'ready' && rows.length > 0 && visible.length === 0 ? (
          <div className="plps-hint">{t('hint.noMatch')}</div>
        ) : null}
        {shown.map((row) => {
          const key = rowKey(row)
          return (
            <button
              type="button"
              className={[
                'plps-row',
                row.refused === true ? 'plps-refused' : '',
                selected === key ? 'plps-selected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              key={key}
              onClick={() => select(row)}
              onContextMenu={(event) => openMenu(event, row)}
              onKeyDown={(event) => {
                if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                event.preventDefault()
                const rect = event.currentTarget.getBoundingClientRect()
                select(row)
                setMenu({ row, x: rect.left + 12, y: rect.top + 12 })
              }}
              aria-pressed={selected === key}
              title={
                row.refused === true
                  ? t('row.refusedTitle', { reason: row.reason ?? t('row.refusedNoReason') })
                  : row.file
              }
            >
              <span className="plps-badge">
                {row.refused === true
                  ? t('badge.refused')
                  : row.simaticType === UNKNOWN_TYPE
                    ? t(KIND_BADGE[row.kind] ?? 'badge.file')
                    : row.simaticType}
              </span>
              <span className="plps-name">{row.name}</span>
              {row.number === undefined ? null : <span className="plps-meta">#{row.number}</span>}
              {row.language === undefined ? null : <span className="plps-meta">{row.language}</span>}
              {row.refused === true || row.verified ? null : (
                <span className="plps-warn" title={t('row.verifyFailed')}>⚠</span>
              )}
              <span className="plps-meta">{sizeLabel(row.bytes)}</span>
              {device === ALL && deviceChoices.length > 1 ? <span className="plps-device">{row.device}</span> : null}
            </button>
          )
        })}
        {visible.length > shown.length ? (
          <div className="plps-hint">{t('hint.truncated', { shown: shown.length })}</div>
        ) : null}
        {refused > 0 ? <div className="plps-note">{t('note.refused', { count: refused })}</div> : null}
        {notes.map((note) => (
          <div className="plps-note" key={note.device}>
            {t('note.walked', {
              device: note.device,
              reason: t(errorCopy(note.code).key, { code: note.code }),
              detail:
                note.files === 0
                  ? t('note.walked.none')
                  : t('note.walked.files', { count: note.files }) +
                    (note.truncated ? t('note.walked.truncated') : ''),
            })}
          </div>
        ))}
      </div>
      {menuRow === null ? null : (
        <div
          className="plps-menu"
          role="menu"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            className="plps-menu-item"
            disabled={!menuCanOpen}
            title={menuCanOpen ? menuRow.file : t('menu.openTitle')}
            onClick={() => {
              setMenu(null)
              open(menuRow)
            }}
          >
            {t('menu.openFile')}
          </button>
          {menuCanOpen ? null : (
            <div className="plps-menu-note">
              {menuRow.refused === true ? t('menu.noFileRefused') : t('menu.noFile')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
