/**
 * The Drawing tab body.
 *
 * **One surface only: the PDF viewer.** The sheet list above it sets the page,
 * and `drawing_show` does the same plus leaves a one-line caption. The browser's
 * own viewer is used for scrolling through the whole set, zoom and search; it
 * cannot be drawn over, so the hit box stays in `.dsh/drawing-view.json` and the
 * panel only reports it as text.
 *
 * Jumping to a page means **re-mounting** the iframe: changing only the
 * `#page=` fragment of an already loaded PDF is a same-document navigation that
 * the viewer ignores. The blob URL is kept, so a jump re-parses the document but
 * never re-reads the file from disk. The URL also carries an explicit numeric
 * zoom (page width / pane width): the embedded viewer otherwise sometimes opens
 * a document at its minimum zoom instead of fitting the pane.
 *
 * All data is read from the workspace through `readTextFile` / `readBytes`; the
 * panel fetches nothing over the network and knows no routes.
 *
 * @module dsh-drawing/client/Panel
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { getView, setView, subscribeView } from './store.js'
import { fitZoom, pickDocument, pdfSrc, resolvePage, viewDocument } from './view-state.js'

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
  /** A page the user (or the agent) asked for; `null` means "derive it". */
  const [targetPage, setTargetPage] = useState(null)
  const [pdfUrl, setPdfUrl] = useState(null)
  const [pdfState, setPdfState] = useState('idle')
  const [error, setError] = useState(null)
  const [lookedIn, setLookedIn] = useState(null)
  const pdfUrlRef = useRef(null)
  const viewerRef = useRef(null)
  /** Pane width in CSS pixels, measured once when the viewer is laid out. */
  const [viewerWidth, setViewerWidth] = useState(0)

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
      // Prefer whatever the agent last showed, then the first indexed drawing.
      const first = pickDocument(documents, getView(sessionId))
      setSelectedFile(first?.file ?? null)
      setPhase(documents.length === 0 ? 'empty' : 'ready')
    })()
    return () => {
      cancelled = true
    }
  }, [cwd, readJsonFile, sessionId])

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

  // ---- follow the agent ----------------------------------------------------
  // A new `drawing_show` selects its document and turns the viewer to its page.
  // Only a new view (new `ts`, hence new object identity) triggers this, so a
  // reader who browses away is not pulled back by a re-render.
  useEffect(() => {
    if (view === null || typeof view !== 'object') return
    const documents = Array.isArray(manifest?.documents) ? manifest.documents : []
    const file = viewDocument(view, documents)
    if (file === undefined) return
    setSelectedFile(file)
    setTargetPage(Number.isInteger(view.page) ? view.page : null)
  }, [view, manifest])

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

  // ---- the PDF blob for the one viewer -------------------------------------
  // One blob URL per document. Switching documents must replace it: the old
  // guard (`if (pdfUrlRef.current === null)`) kept showing the previous PDF.
  useEffect(() => {
    const path = document?.pdf
    if (typeof path !== 'string' || path === '') {
      if (pdfUrlRef.current !== null) {
        URL.revokeObjectURL(pdfUrlRef.current)
        pdfUrlRef.current = null
      }
      setPdfUrl(null)
      setPdfState('idle')
      return undefined
    }
    if (pdfUrlRef.current !== null) {
      URL.revokeObjectURL(pdfUrlRef.current)
      pdfUrlRef.current = null
    }
    setPdfUrl(null)
    setPdfState('loading')
    let cancelled = false
    void (async () => {
      const bytes = await props.readBytes(path)
      if (cancelled) return
      if (bytes === undefined) {
        setPdfState('error')
        return
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
      pdfUrlRef.current = url
      setPdfUrl(url)
      setPdfState('ready')
    })()
    return () => {
      cancelled = true
    }
  }, [document?.pdf, props.readBytes])

  useEffect(
    () => () => {
      if (pdfUrlRef.current !== null) URL.revokeObjectURL(pdfUrlRef.current)
    },
    [],
  )

  // ---- measure the pane once ----------------------------------------------
  // Used to turn a page of known width into an explicit PDF zoom: the embedded
  // viewer can otherwise open a document at its minimum zoom (25%).
  useEffect(() => {
    if (viewerWidth > 0) return undefined
    const element = viewerRef.current
    if (element === null) return undefined
    let timer
    let observer
    const measure = () => {
      const width = element.clientWidth
      if (width < 120) return
      setViewerWidth(width)
      observer?.disconnect()
    }
    observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(measure, 150)
    })
    observer.observe(element)
    timer = setTimeout(measure, 150)
    return () => {
      clearTimeout(timer)
      observer?.disconnect()
    }
  }, [profile, viewerWidth])

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

  const pages = document?.pages ?? profile?.pages ?? null
  const currentPage = resolvePage({
    targetPage,
    view,
    documentFile: selectedFile,
    sheets,
    pages,
  })
  const pageSheet = sheets.find((entry) => entry.page === currentPage)
  const frameWidth = typeof pageSheet?.frame?.width === 'number' ? pageSheet.frame.width : 842
  const zoom = fitZoom(frameWidth, viewerWidth) ?? 100

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
  const located =
    view !== null &&
    typeof view === 'object' &&
    selectedFile !== null &&
    view.document === selectedFile &&
    // Only while the viewer is on the page the agent located: once the reader
    // browses elsewhere the note would describe something no longer on screen.
    currentPage === view.page
  const locatedWhere =
    view?.sheet === null || view?.sheet === undefined ? (view?.title ?? '') : `${t('sheet')} ${view.sheet}`
  const caption = located && typeof view?.caption === 'string' && view.caption !== '' ? ` · ${view.caption}` : ''

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
              // Re-derive from that document's own agent view / first sheet.
              setTargetPage(null)
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
              {profile.pages} {t('pages')} · {sheets.length} {t('sheets')} · p{currentPage}
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
                    currentPage === sheet.page ? ' dsh-drawing__row--active' : ''
                  }`}
                  title={`${sheet.template} · p${sheet.page}`}
                  onClick={() => setTargetPage(sheet.page)}
                >
                  <span className="dsh-drawing__no">{sheet.sheet ?? '—'}</span>
                  <span className="dsh-drawing__name">{sheet.title ?? ''}</span>
                </div>
              ))}
            </div>

            <div className="dsh-drawing__viewer" ref={viewerRef}>
              {pdfUrl !== null ? (
                <iframe
                  // A page jump is a navigation the viewer only honours on load;
                  // a fresh key is what makes `#page=N` take effect every time.
                  key={`${selectedFile}:${currentPage}:${zoom}`}
                  className="dsh-drawing__frame"
                  src={pdfSrc(pdfUrl, currentPage, zoom)}
                  title={`${selectedFile ?? 'drawing'} page ${currentPage}`}
                />
              ) : (
                <div className="dsh-drawing__muted">
                  {pdfState === 'error' ? t('pdfError') : pdfState === 'loading' ? t('loadingPdf') : t('hint')}
                </div>
              )}
            </div>
          </div>

          <div className="dsh-drawing__foot dsh-drawing__muted">
            {located
              ? `${t('agentView')}：${locatedWhere} · p${view.page}${caption}`
              : t('hint')}
          </div>
        </>
      )}
    </div>
  )
}
