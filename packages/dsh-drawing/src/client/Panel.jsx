/**
 * The Drawing tab body.
 *
 * Two ways to look at a sheet:
 *
 *  - **agent view** — `drawing_show` rendered the page to a PNG and left a view
 *    state behind; the panel draws that image and overlays the hit box (both use
 *    the same display-space points, so the box lands on the element);
 *  - **browse view** — the user picks a sheet from the list and the panel hands
 *    the PDF to the browser's own viewer at `#page=N`.
 *
 * All data is read from the workspace through `readTextFile` / `readBytes`; the
 * panel fetches nothing over the network and knows no routes.
 *
 * @module dsh-drawing/client/Panel
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { getView, setView, subscribeView } from './store.js'

const MANIFEST = '.dsh/drawing-manifest.json'
const VIEW_FILE = '.dsh/drawing-view.json'

/** Join an absolute base with a forward-slash relative path. */
function joinPath(base, rel) {
  return `${String(base).replace(/[\\/]+$/, '').replace(/\\/g, '/')}/${rel}`
}

/**
 * @param {object} props - seat props injected by the shell.
 */
export function Panel(props) {
  const { sessionId } = props
  const t = props.t ?? ((key) => key)

  const readSessions = typeof props.useSessions === 'function' ? props.useSessions : () => undefined
  const cwd = readSessions((sessions) => sessions?.byId?.[sessionId]?.cwd)

  const [phase, setPhase] = useState('loading')
  const [manifest, setManifest] = useState(null)
  const [selectedFile, setSelectedFile] = useState(null)
  const [profile, setProfile] = useState(null)
  const [sheets, setSheets] = useState([])
  const [filter, setFilter] = useState('')
  const [cabinet, setCabinet] = useState(null)
  const [browsePage, setBrowsePage] = useState(null)
  const [imageUrl, setImageUrl] = useState(null)
  const [pdfUrl, setPdfUrl] = useState(null)
  const [error, setError] = useState(null)
  const [lookedIn, setLookedIn] = useState(null)
  const imageUrlRef = useRef(null)
  const pdfUrlRef = useRef(null)

  const view = useSyncExternalStore(
    useCallback((listener) => subscribeView(sessionId, listener), [sessionId]),
    useCallback(() => getView(sessionId), [sessionId]),
    () => undefined,
  )

  const readJsonFile = useCallback(
    async (path) => {
      const answer = await props.readTextFile(path)
      if (answer?.ok !== true) return undefined
      try {
        return JSON.parse(answer.text)
      } catch {
        return undefined
      }
    },
    [props.readTextFile],
  )

  // ---- manifest ------------------------------------------------------------
  useEffect(() => {
    if (typeof cwd !== 'string' || cwd === '') return undefined
    let cancelled = false
    void (async () => {
      // The host writes the manifest both beside the drawings and at the fixed
      // `.dsh/` path; try the fixed one first, then the drawing-directory copy
      // (a project may have moved or the plugin may be configured with `dir`).
      const candidates = [joinPath(cwd, MANIFEST), joinPath(cwd, 'drawing/manifest.json')]
      let value
      for (const path of candidates) {
        value = await readJsonFile(path)
        if (value !== undefined) break
      }
      if (cancelled) return
      if (value === undefined) {
        setManifest(null)
        setPhase('empty')
        setLookedIn(candidates.join(' · '))
        return
      }
      setManifest(value)
      const documents = Array.isArray(value.documents) ? value.documents : []
      const first = documents.find((entry) => entry.indexed === true) ?? documents[0] ?? null
      setSelectedFile(first === null ? null : first.file)
      setPhase(documents.length === 0 ? 'empty' : 'ready')
    })()
    return () => {
      cancelled = true
    }
  }, [cwd, readJsonFile])

  const document = useMemo(() => {
    const documents = Array.isArray(manifest?.documents) ? manifest.documents : []
    return documents.find((entry) => entry.file === selectedFile)
  }, [manifest, selectedFile])

  // ---- view state on mount -------------------------------------------------
  // The controller normally pushes the view as soon as `drawing_show` returns,
  // but the tab may be opened *after* the call (or mounted in a fresh page):
  // seed the store from the file so the last located sheet is still there.
  useEffect(() => {
    if (typeof cwd !== 'string' || cwd === '') return undefined
    let cancelled = false
    void (async () => {
      const value = await readJsonFile(joinPath(cwd, VIEW_FILE))
      if (cancelled || value === null || typeof value !== 'object') return
      const current = getView(sessionId)
      if (current !== undefined && current.ts === value.ts) return
      setView(sessionId, value)
    })()
    return () => {
      cancelled = true
    }
  }, [cwd, readJsonFile, sessionId])

  // ---- profile + sheet list ------------------------------------------------
  useEffect(() => {
    if (document === undefined || typeof document?.dir !== 'string') return undefined
    let cancelled = false
    void (async () => {
      const nextProfile = await readJsonFile(joinPath(document.dir, 'profile.json'))
      const nextSheets = await readJsonFile(joinPath(document.dir, 'index/sheets.json'))
      if (cancelled) return
      setProfile(nextProfile ?? null)
      setSheets(Array.isArray(nextSheets) ? nextSheets : [])
      setError(nextProfile === undefined ? t('noIndex') : null)
    })()
    return () => {
      cancelled = true
    }
  }, [document, readJsonFile, t])

  // ---- rendered page image (agent view) ------------------------------------
  useEffect(() => {
    const path = view?.image?.path
    if (typeof path !== 'string') {
      setImageUrl(null)
      return undefined
    }
    let cancelled = false
    void (async () => {
      const bytes = await props.readBytes(path)
      if (cancelled || bytes === undefined) return
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
      if (imageUrlRef.current !== null) URL.revokeObjectURL(imageUrlRef.current)
      imageUrlRef.current = url
      setImageUrl(url)
    })()
    return () => {
      cancelled = true
    }
  }, [view?.image?.path, props.readBytes])

  // ---- PDF blob for the browse view ---------------------------------------
  useEffect(() => {
    const path = document?.pdf
    if (browsePage === null || typeof path !== 'string') return undefined
    let cancelled = false
    void (async () => {
      const bytes = await props.readBytes(path)
      if (cancelled || bytes === undefined) return
      if (pdfUrlRef.current === null) {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
        pdfUrlRef.current = url
        setPdfUrl(url)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [browsePage, document?.pdf, props.readBytes])

  useEffect(
    () => () => {
      if (imageUrlRef.current !== null) URL.revokeObjectURL(imageUrlRef.current)
      if (pdfUrlRef.current !== null) URL.revokeObjectURL(pdfUrlRef.current)
    },
    [],
  )

  const cabinets = useMemo(() => {
    const rows = profile?.cabinets
    return Array.isArray(rows) ? rows.filter((row) => typeof row?.id === 'number') : []
  }, [profile])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return sheets
      .filter((sheet) => (cabinet === null ? true : sheet.cabinet === cabinet))
      .filter((sheet) => {
        if (needle === '') return true
        const number = sheet.sheet === null ? '' : String(sheet.sheet)
        return number.includes(needle) || String(sheet.title ?? '').toLowerCase().includes(needle)
      })
      .slice(0, 400)
  }, [sheets, filter, cabinet])

  if (typeof cwd !== 'string' || cwd === '') {
    return <div className="dsh-drawing">{t('error')}</div>
  }

  if (phase === 'empty') {
    return (
      <div className="dsh-drawing">
        <div className="dsh-drawing__title">{t('empty.title')}</div>
        <div className="dsh-drawing__muted">{t('empty.hint')}</div>
        {lookedIn === null ? null : (
          <div className="dsh-drawing__muted">
            {t('lookedIn')}: {lookedIn}
          </div>
        )}
      </div>
    )
  }

  if (phase === 'loading') {
    return <div className="dsh-drawing">{t('loading')}</div>
  }

  const documents = Array.isArray(manifest?.documents) ? manifest.documents : []
  const caveats = Array.isArray(profile?.caveats) ? profile.caveats : []
  const highlight = view?.highlight
  const displayWidth = view?.image?.displayWidth ?? 842
  const displayHeight = view?.image?.displayHeight ?? 595
  const onImageClick = () => {
    /* reserved: hit-testing inside the rendered sheet */
  }

  return (
    <div className="dsh-drawing">
      <div className="dsh-drawing__docs">
        {documents.map((entry) => (
          <button
            key={entry.file}
            type="button"
            className={`dsh-drawing__doc${entry.file === selectedFile ? ' dsh-drawing__doc--active' : ''}`}
            onClick={() => {
              setSelectedFile(entry.file)
              setBrowsePage(null)
            }}
          >
            {entry.file}
          </button>
        ))}
      </div>

      {profile === null ? (
        <div className="dsh-drawing__muted">{error ?? t('noIndex')}</div>
      ) : (
        <>
          <div className="dsh-drawing__title">
            {profile.project?.name ?? profile.document}
            <span className="dsh-drawing__muted">
              {profile.pages} {t('pages')} · {sheets.length} {t('sheets')}
            </span>
          </div>

          {caveats.length > 0 && (
            <div className="dsh-drawing__caveat">
              {t('caveats')}：{caveats.join('；')}
            </div>
          )}

          <div className="dsh-drawing__toolbar">
            <select
              className="dsh-drawing__input"
              value={cabinet === null ? '' : String(cabinet)}
              onChange={(event) => setCabinet(event.target.value === '' ? null : Number(event.target.value))}
            >
              <option value="">{t('allCabinets')}</option>
              {cabinets.map((row) => (
                <option key={row.id} value={String(row.id)}>
                  {`${row.id} · ${row.name} (${row.sheets})`}
                </option>
              ))}
            </select>
            <input
              className="dsh-drawing__input"
              placeholder={t('filter')}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>

          <div className="dsh-drawing__stage">
            <div className="dsh-drawing__list">
              {visible.map((sheet) => (
                <div
                  key={`${sheet.cabinet}:${sheet.page}`}
                  className={`dsh-drawing__row${
                    (browsePage === sheet.page || view?.page === sheet.page) ? ' dsh-drawing__row--active' : ''
                  }`}
                  title={`${sheet.template} · p${sheet.page}`}
                  onClick={() => setBrowsePage(sheet.page)}
                >
                  <span className="dsh-drawing__no">{sheet.sheet ?? '—'}</span>
                  <span className="dsh-drawing__name">{sheet.title ?? ''}</span>
                </div>
              ))}
            </div>

            <div className="dsh-drawing__viewer">
              {imageUrl !== null && browsePage === null ? (
                <div className="dsh-drawing__paper" onClick={onImageClick}>
                  <img className="dsh-drawing__page" src={imageUrl} alt={view?.title ?? 'drawing page'} />
                  {highlight !== null && highlight !== undefined && (
                    <span
                      className="dsh-drawing__hit"
                      title={view?.caption ?? ''}
                      style={{
                        left: `${(highlight.x / displayWidth) * 100}%`,
                        top: `${(highlight.y / displayHeight) * 100}%`,
                        width: `${(highlight.w / displayWidth) * 100}%`,
                        height: `${(highlight.h / displayHeight) * 100}%`,
                      }}
                    />
                  )}
                </div>
              ) : browsePage !== null && pdfUrl !== null ? (
                <iframe
                  className="dsh-drawing__frame"
                  src={`${pdfUrl}#page=${browsePage}`}
                  title={`page ${browsePage}`}
                />
              ) : (
                <div className="dsh-drawing__muted">
                  {browsePage !== null ? t('loading') : t('preview')}
                </div>
              )}
            </div>
          </div>

          <div className="dsh-drawing__foot dsh-drawing__muted">
            {view === undefined
              ? t('preview')
              : `${t('agentView')}: ${view.title ?? ''} · p${view.page}${view.caption === null ? '' : ` · ${view.caption}`}`}
          </div>
        </>
      )}
    </div>
  )
}

