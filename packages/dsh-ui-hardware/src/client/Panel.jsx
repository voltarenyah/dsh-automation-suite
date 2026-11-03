/**
 * The Hardware tab's body.
 *
 * One idea carries the layout: the slots are a physical rack strip, not a table.
 * The station head names the device, the strip shows every slot as its printed
 * face, and the selected slot opens its order number, address window and channel
 * counts. Network and signals demote to two supporting columns so the page has a
 * focal point instead of four equal cards.
 *
 * Data arrives through the injected `readTextFile` face (the host's
 * `workspaceFiles.readBytes`), which reads `<workspace>/.dsh/hardware-view.json`.
 *
 * @module dsh-ui-hardware/client/Panel
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  ROLE_ORDER,
  VIEW_FILE,
  addressLabel,
  filterDevices,
  formatBytes,
  groupPaths,
  isFailsafe,
  moduleFace,
  parseView,
  shortSha,
  slotOf,
} from '../model.js'

const ROLE_BADGE = { controller: 'PLC', io: 'IO', drive: 'DRV', thirdParty: 'GSD', network: 'NET', hmi: 'HMI', other: 'DEV' }
const MIN_RATIO = 0.18
const MAX_RATIO = 0.62

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

/** `1 slot` / `3 slots` in English, no plural morpheme in Chinese. */
function countLabel(n, word, lang) {
  return `${n} ${word}${lang === 'en' && n !== 1 && !word.endsWith('s') ? 's' : ''}`
}

/** One device row in the rail. */
function RailRow({ device, active, onPick, t, lang }) {
  const missing = device.status === 'missing'
  return (
    <button className="hwv-dev" type="button" aria-current={active ? 'true' : 'false'} onClick={() => onPick(device)}>
      <span className="hwv-badge" data-role={device.role}>
        {ROLE_BADGE[device.role] ?? 'DEV'}
      </span>
      <span className="hwv-dev-main">
        <span className="hwv-dev-name">
          <span className={missing ? 'hwv-dot warn' : 'hwv-dot'} /> {device.name}
        </span>
        <span className="hwv-dev-sub mono">{device.orderNumber ?? device.typeName ?? '—'}</span>
      </span>
      <span className="hwv-dev-meta">
        {device.ip ?? '—'}
        <br />
        {missing ? t('missing.tag') : countLabel(device.kpis.modules, t('slots'), lang)}
      </span>
    </button>
  )
}

/** One cell of the rack strip. */
function SlotCell({ module, index, active, onPick, t }) {
  return (
    <button
      className="hwv-slot"
      type="button"
      aria-current={active ? 'true' : 'false'}
      title={`${module.name} · ${module.typeName ?? ''} · ${module.orderNumber ?? ''}`}
      style={{ animationDelay: `${Math.min(index, 12) * 18}ms` }}
      onClick={() => onPick(module.slot)}
    >
      <span className="hwv-slot-n">
        <span className="mono">{module.slot ?? '—'}</span>
        {isFailsafe(module) ? <i>F</i> : null}
      </span>
      <span className="hwv-slot-v">{moduleFace(module)}</span>
      <span className="hwv-slot-t">{module.name}</span>
    </button>
  )
}

/** The selected slot's detail block. */
function SlotDetail({ device, slot, t }) {
  const module = slotOf(device, slot)
  if (module === null) return <div className="hwv-empty">{t('empty.slots')}</div>
  const counts = module.channels
  const channels = counts === null ? null : counts
  return (
    <div className="hwv-slot-detail">
      <div className="hwv-slot-title">
        <span className="t">
          {t('slot.label')} {module.slot ?? '—'}
        </span>
        <span className="m mono">{module.name}</span>
        {module.typeName !== null && module.typeName !== module.name ? <span className="m">{module.typeName}</span> : null}
        {module.deviceItemType !== null ? <span className="hwv-chip">{module.deviceItemType}</span> : null}
        {isFailsafe(module) ? <span className="hwv-chip is-warn">F</span> : null}
      </div>
      <dl className="hwv-kv">
        <dt>{t('field.order')}</dt>
        <dd className="mono">{module.orderNumber ?? '—'}</dd>
        <dt>{t('field.window')}</dt>
        <dd className="mono">
          {module.addresses.length === 0 ? '—' : module.addresses.map(addressLabel).join(' · ')}
        </dd>
        {channels !== null && channels.di + channels.do + channels.ai + channels.ao > 0 ? (
          <>
            <dt>{t('field.channels')}</dt>
            <dd>
              DI {channels.di} · DO {channels.do} · AI {channels.ai} · AO {channels.ao}
            </dd>
          </>
        ) : null}
        {module.firmware !== null ? (
          <>
            <dt>{t('field.firmware')}</dt>
            <dd>{module.firmware}</dd>
          </>
        ) : null}
      </dl>
    </div>
  )
}

/** The station sheet for one device. */
function Sheet({ device, slot, onPickSlot, rackRef, t, lang }) {
  if (device.status === 'missing') {
    return (
      <div className="hwv-sheet-in">
        <div className="hwv-station">
          <div className="hwv-station-id">
            <h1 className="hwv-station-name">{device.name}</h1>
            <div className="hwv-station-mlfb">
              {t('missing.tag')}
              {device.profinetName === null ? '' : ` · ${device.profinetName}`}
            </div>
            <div className="hwv-chips">
              {device.ip === null ? null : <span className="hwv-chip mono"><b>{device.ip}</b></span>}
              {device.subnet === null ? null : (
                <span className="hwv-chip">
                  {t('field.subnet')} <b>{device.subnet}</b>
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="hwv-note">
          <span className="tag">{t('missing.tag')}</span>
          <span>{t('missing.hint')}</span>
        </div>
      </div>
    )
  }

  const tagSide = device.role === 'controller'
  const signals = tagSide ? device.tagSignals : device.signals
  const shown = signals.slice(0, 8)

  return (
    <div className="hwv-sheet-in">
      <div className="hwv-station">
        <div className="hwv-station-id">
          <h1 className="hwv-station-name">{device.name}</h1>
          <div className="hwv-station-mlfb">{device.typeName ?? ''}</div>
          <div className="hwv-chips">
            {device.orderNumber === null ? null : (
              <span className="hwv-chip mono">
                <b>{device.orderNumber}</b>
              </span>
            )}
            {device.firmware === null ? null : (
              <span className="hwv-chip">
                {t('field.firmware')} <b>{device.firmware}</b>
              </span>
            )}
            {device.groupPath === null ? null : (
              <span className="hwv-chip">
                {t('field.group')} <b>{device.groupPath}</b>
              </span>
            )}
            {device.ip === null ? null : (
              <span className="hwv-chip mono">
                {t('field.interface')} {device.interface ?? '—'} · <b>{device.ip}</b>
              </span>
            )}
            {device.profinetName === null ? null : (
              <span className="hwv-chip mono">
                {t('field.profinet')} <b>{device.profinetName}</b>
              </span>
            )}
            {device.subnet === null ? null : (
              <span className="hwv-chip">
                {t('field.subnet')} <b>{device.subnet}</b>
              </span>
            )}
            {device.kpis.di + device.kpis.do + device.kpis.ai + device.kpis.ao > 0 ? (
              <span className="hwv-chip is-ok">
                DI {device.kpis.di} · DO {device.kpis.do} · AI {device.kpis.ai} · AO {device.kpis.ao}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="hwv-rack-label">
        {t('rack.label')} <span className="mono">{countLabel(device.modules.length, t('slots'), lang)}</span>
      </div>
      <div className="hwv-rack" ref={rackRef}>
        {device.modules.map((module, index) => (
          <SlotCell
            key={`${module.slot ?? index}-${module.name}`}
            module={module}
            index={index}
            active={slotOf(device, slot) === module}
            onPick={onPickSlot}
            t={t}
          />
        ))}
      </div>

      <SlotDetail device={device} slot={slot} t={t} />

      <div className="hwv-cols">
        <div>
          {device.ip === null && device.profinetName === null ? null : (
            <>
              <div className="hwv-sec-head">{t('network')}</div>
              <ul className="hwv-list-mini">
                <li>
                  <span className="l">{t('field.interface')}</span>
                  <span className="r mono">{device.interface ?? '—'}</span>
                </li>
                <li>
                  <span className="l">{t('field.ip')}</span>
                  <span className="r mono">{device.ip ?? '—'}</span>
                </li>
                {device.mask === null ? null : (
                  <li>
                    <span className="l">{t('field.mask')}</span>
                    <span className="r mono">{device.mask}</span>
                  </li>
                )}
                <li>
                  <span className="l">{t('field.profinet')}</span>
                  <span className="r mono">{device.profinetName ?? '—'}</span>
                </li>
                <li>
                  <span className="l">{t('field.subnet')}</span>
                  <span className="r">{device.subnet ?? '—'}</span>
                </li>
              </ul>
            </>
          )}
        </div>
        <div>
          <div className="hwv-sec-head">
            {tagSide ? t('signals.from') : t('signals')} <span>{signals.length} {t('signals.count')}</span>
          </div>
          {signals.length === 0 ? (
            <div className="hwv-empty" style={{ padding: '6px 0' }}>{t('signals.none')}</div>
          ) : (
            <>
              <ul className="hwv-list-mini">
                {shown.map((signal, index) => (
                  <li key={`${signal.channel ?? index}-${signal.tag ?? ''}`}>
                    <span className="l mono">
                      {signal.channel ?? '—'} → {signal.tag ?? '—'}
                    </span>
                    <span className="r mono">{signal.address ?? ''}</span>
                  </li>
                ))}
              </ul>
              {signals.length > shown.length ? (
                <div className="hwv-dev-sub" style={{ paddingTop: 4 }}>{tv(t, 'signals.more', { n: shown.length })}</div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * @param {object} props - the framework's seat: translate, file reader, view path.
 */
export function Panel(props) {
  const { sessionId, t, readTextFile, viewPath } = props
  const readSessions = typeof props.useSessions === 'function' ? props.useSessions : () => undefined
  const cwd = readSessions((sessions) => sessions?.byId?.[sessionId]?.cwd)

  const [state, setState] = useState({ status: 'loading', view: null, code: '' })
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState(null)
  const [groupOpen, setGroupOpen] = useState(false)
  const [view, setView] = useState('devices')
  const [deviceName, setDeviceName] = useState(null)
  const [slot, setSlot] = useState(null)
  const [ratio, setRatio] = useState(0.34)
  const rackRef = useRef(null)

  const lang = (typeof document !== 'undefined' && document.documentElement.lang) || 'zh'
  const i18nLang = lang.startsWith('en') ? 'en' : 'zh'

  const load = useCallback(async () => {
    if (typeof cwd !== 'string' || cwd.length === 0) {
      setState({ status: 'empty', view: null, code: 'no-workspace' })
      return
    }
    if (typeof readTextFile !== 'function') {
      setState({ status: 'error', view: null, code: 'workspaceFiles' })
      return
    }
    setState({ status: 'loading', view: null, code: '' })
    const answer = await readTextFile(joinPath(cwd, viewPath ?? VIEW_FILE))
    if (answer?.ok !== true) {
      setState({ status: 'empty', view: null, code: answer?.code ?? 'read' })
      return
    }
    const parsed = parseView(answer.text)
    if (parsed === null) {
      setState({ status: 'error', view: null, code: 'parse' })
      return
    }
    setState({ status: 'ready', view: parsed, code: '' })
  }, [cwd, readTextFile, viewPath])

  useEffect(() => {
    load()
  }, [load])

  const data = state.view
  const devices = useMemo(() => (data === null ? [] : filterDevices(data, query, group)), [data, query, group])
  const device = data === null ? null : data.devices.find((d) => d.name === deviceName) ?? devices[0] ?? null

  // Flag the rack strip only while it actually overflows, so the fade is a hint
  // rather than decoration.
  useEffect(() => {
    const rail = rackRef.current
    if (!rail) return
    const check = () => rail.classList.toggle('is-scroll', rail.scrollWidth > rail.clientWidth + 2)
    check()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null
    observer?.observe(rail)
    return () => observer?.disconnect()
  }, [data, device?.name, view])

  const pick = (next) => {
    setDeviceName(next.name)
    setSlot(null)
  }

  function body() {
    if (state.status === 'loading') return <div className="hwv-empty">{t('state.loading')}</div>
    if (state.status === 'error') {
      return (
        <div className="hwv-empty">
          <b>{t('state.error.title')}</b>
          <div>{t('state.error.body')}</div>
          <button className="hwv-act" type="button" style={{ marginTop: 8 }} onClick={load}>
            {t('state.action')}
          </button>
        </div>
      )
    }
    if (data === null) {
      return (
        <div className="hwv-empty">
          <b>{t('state.empty.title')}</b>
          <div>{t('state.empty.body')}</div>
          <button className="hwv-act" type="button" style={{ marginTop: 8 }} onClick={load}>
            {t('state.action')}
          </button>
        </div>
      )
    }

    if (view === 'network') {
      return (
        <div className="hwv-sheet-in">
          <div className="hwv-chips" style={{ marginBottom: 12 }}>
            <span className="hwv-chip">{t('links.port')} <b>{data.links.port}</b></span>
            <span className="hwv-chip">{t('links.subnet')} <b>{data.links.subnet}</b></span>
            <span className="hwv-chip">{t('links.io')} <b>{data.links.ioSystem}</b></span>
          </div>
          {data.networks.subnets.map((subnet) => (
            <div key={subnet.name} style={{ marginBottom: 14 }}>
              <div className="hwv-sec-head">
                {subnet.name} <span>{subnet.nodes.length}{subnet.type === null ? '' : ` · ${subnet.type}`}</span>
              </div>
              <div className="hwv-tablewrap">
                <table className="hwv-table">
                  <thead>
                    <tr>
                      <th>{t('table.device')}</th>
                      <th>{t('field.interface')}</th>
                      <th>{t('table.address')}</th>
                      <th>{t('field.mask')}</th>
                      <th>{t('field.profinet')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subnet.nodes.map((node, index) => (
                      <tr key={`${node.device ?? index}`}>
                        <td>{node.device ?? '—'}</td>
                        <td className="type">{node.interface ?? '—'}</td>
                        <td className="ord">{node.ip ?? '—'}</td>
                        <td className="ord">{node.subnetMask ?? '—'}</td>
                        <td className="ord">{node.profinetName ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )
    }

    if (view === 'signals') {
      const needle = query.trim().toLowerCase()
      const rows = []
      for (const entry of data.devices) {
        for (const signal of entry.signals) {
          const haystack = `${entry.name} ${signal.module ?? ''} ${signal.channel ?? ''} ${signal.tag ?? ''} ${signal.address ?? ''}`.toLowerCase()
          if (needle.length > 0 && !haystack.includes(needle)) continue
          rows.push({ device: entry.name, ...signal })
        }
      }
      const shown = rows.slice(0, 200)
      return (
        <div className="hwv-sheet-in">
          <div className="hwv-sec-head">
            {t('signals')} <span>{rows.length} {t('signals.count')}</span>
          </div>
          <div className="hwv-tablewrap">
            <table className="hwv-table">
              <thead>
                <tr>
                  <th>{t('table.device')}</th>
                  <th>{t('table.slot')}</th>
                  <th>{t('table.module')}</th>
                  <th>{t('table.channel')}</th>
                  <th>{t('table.tag')}</th>
                  <th>{t('table.address')}</th>
                  <th>{t('table.type')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row, index) => (
                  <tr key={`${row.device}-${row.channel ?? index}-${row.tag ?? ''}`}>
                    <td>{row.device}</td>
                    <td className="ord">{row.slot ?? '—'}</td>
                    <td className="ord">{row.module ?? '—'}</td>
                    <td className="ord">{row.channel ?? '—'}</td>
                    <td>{row.tag ?? '—'}</td>
                    <td className="ord">{row.address ?? '—'}</td>
                    <td className="type">{row.dataType ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > shown.length ? (
            <div className="hwv-dev-sub" style={{ paddingTop: 6 }}>
              {tv(t, 'signals.more', { n: shown.length })} / {rows.length}
            </div>
          ) : null}
        </div>
      )
    }

    if (device === null) return <div className="hwv-empty">{t('empty.search')}</div>
    return <Sheet device={device} slot={slot} onPickSlot={setSlot} rackRef={rackRef} t={t} lang={i18nLang} />
  }

  const stats = data === null ? [] : [
    [t('stat.devices'), data.counts.devices, false],
    [t('stat.modules'), data.counts.modules, false],
    [t('stat.channels'), data.counts.channels.total, false],
    [t('stat.subnets'), data.networks.subnets.length, false],
    [t('stat.signals'), data.content.signals, false],
    [t('stat.missing'), data.devices.filter((d) => d.status === 'missing').length,
      data.devices.some((d) => d.status === 'missing')],
  ]

  return (
    <div className="hwv-root" data-pane={device === null ? 'list' : 'detail'}>
      <div className="hwv-top">
        <div className="hwv-bar">
          <span className="hwv-mark">{t('tab.title')}</span>
          <span className="hwv-sep" />
          <span className="hwv-proj mono">{data?.project ?? ''}</span>
          <span className="hwv-spacer" />
          <button className="hwv-act" type="button" onClick={load}>{t('action.refresh')}</button>
        </div>
        <div className="hwv-filter">
          <input
            className="hwv-search"
            value={query}
            placeholder={t('search.placeholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="hwv-select">
            <button type="button" onClick={() => setGroupOpen((open) => !open)}>
              <span>{group ?? t('group.all')}</span>
              <span className="hwv-caret">▼</span>
            </button>
            {groupOpen ? (
              <ul className="hwv-menu">
                <li>
                  <button type="button" onClick={() => { setGroup(null); setGroupOpen(false) }}>
                    {t('group.all')}
                    <span className="n">{data?.devices.length ?? 0}</span>
                  </button>
                </li>
                {(data === null ? [] : groupPaths(data)).map((path) => (
                  <li key={path}>
                    <button type="button" onClick={() => { setGroup(path); setGroupOpen(false) }}>
                      {path.split('/').pop()}
                      <span className="n">{data.devices.filter((d) => d.groupPath === path).length}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="hwv-seg">
            {['devices', 'network', 'signals'].map((name) => (
              <button
                key={name}
                type="button"
                aria-selected={view === name ? 'true' : 'false'}
                onClick={() => setView(name)}
              >
                {t(`view.${name}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="hwv-stats">
          {stats.map(([label, value, warn]) => (
            <div key={String(label)} className={warn ? 'hwv-stat warn' : 'hwv-stat'}>
              <b>{value}</b>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>

      <div
        className="hwv-main"
        style={{
          gridTemplateColumns:
            view === 'devices' ? `minmax(200px, calc(${(ratio * 100).toFixed(1)}% - 4px)) 9px minmax(0,1fr)` : undefined,
        }}
      >
        <aside className="hwv-rail" style={{ display: view === 'devices' ? undefined : 'none' }}>
          {ROLE_ORDER.map((role) => {
            const rows = devices.filter((entry) => entry.role === role)
            if (rows.length === 0) return null
            return (
              <div className="hwv-rail-group" key={role}>
                <div className="hwv-rail-head">
                  {t(`role.${role}`)} <span>{rows.length}</span>
                </div>
                {rows.map((entry) => (
                  <RailRow
                    key={entry.name}
                    device={entry}
                    active={device !== null && device.name === entry.name}
                    onPick={pick}
                    t={t}
                    lang={i18nLang}
                  />
                ))}
              </div>
            )
          })}
        </aside>
        {view === 'devices' ? (
          <div
            className="hwv-grip"
            role="separator"
            aria-orientation="vertical"
            tabIndex={0}
            onPointerDown={(event) => {
              const target = event.currentTarget
              target.setPointerCapture(event.pointerId)
              target.dataset.drag = '1'
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.dataset.drag !== '1') return
              const box = event.currentTarget.parentElement?.getBoundingClientRect()
              if (!box) return
              const next = (event.clientX - box.left) / box.width
              setRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, next)))
            }}
            onPointerUp={(event) => {
              const target = event.currentTarget
              delete target.dataset.drag
              target.releasePointerCapture(event.pointerId)
            }}
          />
        ) : null}
        <section className="hwv-sheet">{body()}</section>
      </div>

      <div className="hwv-foot">
        <span>{t('footer.snapshot')}</span>
        <span>
          {t('footer.checksum')} <span className="mono">{shortSha(data?.aml.sha256)}</span>
        </span>
        <span>
          {t('footer.size')} <span className="mono">{formatBytes(data?.aml.bytes)}</span>
        </span>
        <span className="mono">CAEX {data?.aml.schemaVersion ?? '—'}</span>
        <span>
          {t('footer.generated')} <span className="mono">{data?.generatedAt ?? '—'}</span>
        </span>
      </div>
    </div>
  )
}
