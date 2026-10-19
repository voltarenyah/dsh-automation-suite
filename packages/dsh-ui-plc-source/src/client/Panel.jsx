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
 * and back neither loses the setup nor re-reads a manifest. Every write goes
 * through the registration's store actions; nothing here calls a service.
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
  errorText,
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

/** Badge text per object family when the manifest gives no type. */
const KIND_BADGE = { block: '块', type: 'UDT', tagTable: '表', file: '文件' }

/** Bucket used when the framework hands over no tab record (never in practice). */
const FALLBACK_TAB_ID = 'plc-blocks'

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
 * framework hooks, the store and the two I/O callbacks come from the
 * registration.
 *
 * @param {object} props - framework props (tab, sessions, store, injected face).
 */
export function Panel(props) {
  const readTab = typeof props.useTabInfo === 'function' ? props.useTabInfo : () => undefined
  const readSessions = typeof props.useSessions === 'function' ? props.useSessions : () => undefined
  // A stable fallback keeps the hook call unconditional; the real store is
  // always present because the registration declares one.
  const useView = typeof props.useStore === 'function' ? props.useStore : () => EMPTY_VIEW
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
        collectedNotes.push(
          `${name}：清单不可用（${errorText(parsed.code)}）` +
            `${walked.rows.length === 0 ? '，目录也没有可列的文件' : `，已改用目录列举（${walked.rows.length} 个文件）`}` +
            `${walked.truncated ? '，结果被截断' : ''}。`,
        )
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
    const open_ = tab?.actions?.openResource
    if (typeof open_ !== 'function') return
    if (typeof cwd !== 'string' || cwd.length === 0) return
    const relative = relativeUnder(cwd, row.file)
    if (relative === null || relative.length === 0) return
    try {
      // A viewer claims the address; when none does the sidebar throws, and an
      // unopenable file must not take the list down with it.
      open_(resourceAddress(sessionId, relative))
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
      <span className="plps-title">PLC Blocks</span>
      <span className="plps-count">
        {status === 'ready' ? `${visible.length} / ${rows.length}` : SOURCE_DIRECTORY + '/'}
      </span>
      <button
        type="button"
        className="plps-btn"
        onClick={() => setReloads((value) => value + 1)}
        disabled={status === 'loading'}
        title="重新读取 source/"
      >
        {status === 'loading' ? '读取中…' : '刷新'}
      </button>
      <div className="plps-filters">
        <select
          className="plps-select"
          value={device}
          onChange={(event) => set(tabId, { device: event.target.value })}
          aria-label="按 device 筛选"
          disabled={deviceChoices.length === 0}
        >
          <option value={ALL}>全部 device（{rows.length}）</option>
          {deviceChoices.map((choice) => (
            <option key={choice.value} value={choice.value}>{`${choice.value}（${choice.count}）`}</option>
          ))}
        </select>
        <select
          className="plps-select"
          value={type}
          onChange={(event) => set(tabId, { type: event.target.value })}
          aria-label="按类型筛选"
          disabled={typeChoices.length === 0}
        >
          <option value={ALL}>全部类型（{rows.length}）</option>
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
          placeholder="搜索名称或编号"
          aria-label="按名称或编号搜索"
        />
        {query.length === 0 ? null : (
          <button
            type="button"
            className="plps-btn plps-clear"
            onClick={() => set(tabId, { query: '' })}
            title="清除搜索"
          >
            清除
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
        {status === 'no-workspace' ? (
          <div className="plps-hint">这个会话没有工作区目录，无法定位 source/。</div>
        ) : null}
        {status === 'loading' ? <div className="plps-hint">正在读取 source/…</div> : null}
        {status === 'failed' ? <div className="plps-error">{errorText(view.errorCode || 'gateway/internal')}</div> : null}
        {status === 'ready' && rows.length === 0 ? (
          <div className="plps-hint">source/ 里没有找到任何 device 目录。</div>
        ) : null}
        {status === 'ready' && rows.length > 0 && visible.length === 0 ? (
          <div className="plps-hint">当前筛选没有匹配的对象。</div>
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
              title={row.refused === true ? `TIA 拒绝导出：${row.reason ?? '未给出原因'}` : row.file}
            >
              <span className="plps-badge">
                {row.refused === true
                  ? '拒绝'
                  : row.simaticType === UNKNOWN_TYPE
                    ? KIND_BADGE[row.kind]
                    : row.simaticType}
              </span>
              <span className="plps-name">{row.name}</span>
              {row.number === undefined ? null : <span className="plps-meta">#{row.number}</span>}
              {row.language === undefined ? null : <span className="plps-meta">{row.language}</span>}
              {row.refused === true || row.verified ? null : (
                <span className="plps-warn" title="写后读回校验未通过">⚠</span>
              )}
              <span className="plps-meta">{sizeLabel(row.bytes)}</span>
              {device === ALL && deviceChoices.length > 1 ? <span className="plps-device">{row.device}</span> : null}
            </button>
          )
        })}
        {visible.length > shown.length ? (
          <div className="plps-hint">只显示了前 {shown.length} 条，请用上面的筛选或搜索收窄范围。</div>
        ) : null}
        {refused > 0 ? (
          <div className="plps-note">
            {refused} 个对象被 TIA 拒绝导出，已按名字列在末尾（标「拒绝」，悬停看原因）；它们没有文件，右键菜单里的「打开源文件」对它们不可用。
          </div>
        ) : null}
        {notes.map((note) => (
          <div className="plps-note" key={note}>{note}</div>
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
            title={menuCanOpen ? menuRow.file : '这个对象没有导出文件'}
            onClick={() => {
              setMenu(null)
              open(menuRow)
            }}
          >
            打开源文件
          </button>
          {menuCanOpen ? null : (
            <div className="plps-menu-note">
              {menuRow.refused === true ? 'TIA 拒绝导出，没有文件' : '没有文件路径'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
