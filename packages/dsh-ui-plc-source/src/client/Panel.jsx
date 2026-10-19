/**
 * The PLC Blocks tab body: one flat, filterable list of every object the
 * exporter wrote under `source/`.
 *
 * Data path: list `source/` for devices, then read each device's
 * `_tia-openness-manifest.json` in one `readBytes` call (773 KB for a 1376-object
 * export, well under the 32 MiB whole-file cap). The manifest is the only place
 * `simaticType` exists, which is why the type filter needs it. Directory layout
 * is never rendered: the list is flat by requirement.
 *
 * A device whose manifest cannot be read falls back to walking its directory —
 * names and sizes only, type "unknown" — so a hand-made or partial tree still
 * browses. Every failure is a line of copy, never a blank panel.
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
  sizeLabel,
  sortRows,
  typeOptions,
} from '../model'

/** Rows rendered before the list asks for a narrower filter. */
const RENDER_LIMIT = 2000

/** Bounds of the fallback directory walk for a device with no readable manifest. */
const WALK_MAX_DEPTH = 8
const WALK_MAX_ROWS = 5000

/** Badge text per object family when the manifest gives no type. */
const KIND_BADGE = { block: '块', type: 'UDT', tagTable: '表', file: '文件' }

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
 * Tab body. All data arrives as derived props: `useTabInfo`/`useSessions` are
 * framework hooks, the two I/O callbacks come from the registration's inject face.
 *
 * @param {object} props - framework props (tab, sessions, injected face).
 */
export function Panel(props) {
  const readTab = typeof props.useTabInfo === 'function' ? props.useTabInfo : () => undefined
  const readSessions = typeof props.useSessions === 'function' ? props.useSessions : () => undefined
  const info = readTab()
  const tab = info?.tab
  const signal = tab?.signal
  const sessionId = props.sessionId
  const cwd = readSessions((sessions) => sessions?.byId?.[sessionId]?.cwd)

  // The inject face is read through a ref: its identity may change per render,
  // and an effect that depended on it would re-read every manifest in a loop.
  const io = useRef({ listDirectory: props.listDirectory, readTextFile: props.readTextFile })
  io.current = { listDirectory: props.listDirectory, readTextFile: props.readTextFile }

  const [status, setStatus] = useState({ phase: 'idle' })
  const [rows, setRows] = useState([])
  const [refused, setRefused] = useState(0)
  const [notes, setNotes] = useState([])
  const [device, setDevice] = useState(ALL)
  const [type, setType] = useState(ALL)
  const [query, setQuery] = useState('')
  const [reloads, setReloads] = useState(0)

  const rootPath = typeof cwd === 'string' && cwd.length > 0 ? joinPath(cwd, SOURCE_DIRECTORY) : null

  useEffect(() => {
    if (rootPath === null) {
      setStatus({ phase: 'no-workspace' })
      return undefined
    }
    let cancelled = false
    setStatus({ phase: 'loading' })
    setRows([])
    setRefused(0)
    setNotes([])
    setDevice(ALL)
    setType(ALL)
    setQuery('')

    const run = async () => {
      const listed = await io.current.listDirectory(rootPath, signal)
      if (cancelled || signal?.aborted === true) return
      if (listed.ok !== true) {
        setStatus({ phase: 'failed', code: listed.code })
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
      setRows(collected)
      setRefused(refusedCount)
      setNotes(collectedNotes)
      setStatus({ phase: 'ready' })
    }

    void run().catch(() => {
      if (!cancelled) setStatus({ phase: 'failed', code: 'gateway/internal' })
    })
    return () => {
      cancelled = true
    }
  }, [rootPath, reloads, signal])

  const deviceChoices = useMemo(() => deviceOptions(rows), [rows])
  const typeChoices = useMemo(() => typeOptions(rows), [rows])
  const visible = useMemo(
    () => sortRows(filterRows(rows, device, type, query)),
    [rows, device, type, query],
  )
  const shown = visible.length > RENDER_LIMIT ? visible.slice(0, RENDER_LIMIT) : visible

  const open = (file) => {
    const actions = tab?.actions
    if (actions === undefined || typeof actions.openResource !== 'function') return
    if (typeof cwd !== 'string' || cwd.length === 0) return
    const relative = relativeUnder(cwd, file)
    if (relative === null || relative.length === 0) return
    try {
      // A viewer claims the address; when none does the sidebar throws, and an
      // unopened file must not take the list down with it.
      actions.openResource(resourceAddress(sessionId, relative))
    } catch {
      /* no viewer for this address: keep the list as it is */
    }
  }

  const head = (
    <div className="plps-head">
      <span className="plps-title">PLC Blocks</span>
      <span className="plps-count">
        {status.phase === 'ready' ? `${visible.length} / ${rows.length}` : SOURCE_DIRECTORY + '/'}
      </span>
      <button
        type="button"
        className="plps-btn"
        onClick={() => setReloads((value) => value + 1)}
        disabled={status.phase === 'loading'}
        title="重新读取 source/"
      >
        {status.phase === 'loading' ? '读取中…' : '刷新'}
      </button>
      <div className="plps-filters">
        <select
          className="plps-select"
          value={device}
          onChange={(event) => setDevice(event.target.value)}
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
          onChange={(event) => setType(event.target.value)}
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
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称或编号"
          aria-label="按名称或编号搜索"
        />
        {query.length === 0 ? null : (
          <button type="button" className="plps-btn plps-clear" onClick={() => setQuery('')} title="清除搜索">
            清除
          </button>
        )}
      </div>
    </div>
  )

  return (
    <div className="plps-root">
      {head}
      <div className="plps-body">
        {status.phase === 'no-workspace' ? (
          <div className="plps-hint">这个会话没有工作区目录，无法定位 source/。</div>
        ) : null}
        {status.phase === 'loading' ? <div className="plps-hint">正在读取 source/…</div> : null}
        {status.phase === 'failed' ? <div className="plps-error">{errorText(status.code)}</div> : null}
        {status.phase === 'ready' && rows.length === 0 ? (
          <div className="plps-hint">source/ 里没有找到任何 device 目录。</div>
        ) : null}
        {status.phase === 'ready' && rows.length > 0 && visible.length === 0 ? (
          <div className="plps-hint">当前筛选没有匹配的对象。</div>
        ) : null}
        {shown.map((row, index) => (
          <button
            type="button"
            className={row.refused === true ? 'plps-row plps-refused' : 'plps-row'}
            key={`${row.device}\u0000${row.simaticType}\u0000${row.name}\u0000${index}`}
            onClick={row.refused === true ? undefined : () => open(row.file)}
            disabled={row.refused === true}
            title={
              row.refused === true
                ? `TIA 拒绝导出：${row.reason ?? '未给出原因'}\n${row.file}`
                : row.file
            }
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
        ))}
        {visible.length > shown.length ? (
          <div className="plps-hint">只显示了前 {shown.length} 条，请用上面的筛选取窄范围。</div>
        ) : null}
        {refused > 0 ? (
          <div className="plps-note">
            {refused} 个对象被 TIA 拒绝导出，已按名字列在末尾（标「拒绝」，悬停看原因）；它们没有文件，点不开。
          </div>
        ) : null}
        {notes.map((note) => (
          <div className="plps-note" key={note}>{note}</div>
        ))}
      </div>
    </div>
  )
}
