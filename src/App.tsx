import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, api } from './lib/api.ts'
import { beep } from './lib/beep.ts'
import { currentMonth, formatMonth, formatWhen } from './lib/format.ts'
import type { Item, Mode, Report, ScanResult, ShelfRow, Site, SiteView, UndoResult } from './lib/types.ts'
import { downloadPrint } from './lib/print-doc.ts'
import { APP, APP_TITLE } from './lib/version.ts'

const SITE_KEY = 'vendor-inventory-v1-site'

type Page = 'scan' | 'report'

type Result =
  | { kind: 'idle' }
  | { kind: 'need_details'; barcode: string }
  | { kind: 'confirm_return'; barcode: string; item: Item }
  | { kind: 'error'; message: string; barcode: string }
  | { kind: 'ok'; scan: ScanResult }
  | { kind: 'undone'; undo: UndoResult }

type PartFields = {
  description: string
  model: string
  vendor: string
}

export default function App() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [sites, setSites] = useState<Site[]>([])
  const [siteId, setSiteId] = useState<number | null>(null)
  const [page, setPage] = useState<Page>('scan')
  const [shareUrls, setShareUrls] = useState<string[]>([])
  const [dataVersion, setDataVersion] = useState(0)

  useEffect(() => {
    let cancel = false
    api<Site[]>('/api/sites')
      .then((next) => {
        if (cancel) return
        setSites(next)
        const saved = Number(localStorage.getItem(SITE_KEY))
        const pick = next.find((site) => site.id === saved) ?? next[0]
        setSiteId(pick?.id ?? null)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (cancel) return
        setLoadError(err instanceof Error ? err.message : 'The inventory did not open.')
        setStatus('error')
      })
    return () => {
      cancel = true
    }
  }, [])

  useEffect(() => {
    if (siteId != null) localStorage.setItem(SITE_KEY, String(siteId))
  }, [siteId])

  useEffect(() => {
    api<{ urls: string[] }>('/api/share')
      .then((data) => setShareUrls(data.urls))
      .catch(() => setShareUrls([]))
  }, [])

  const site = sites.find((item) => item.id === siteId) ?? null

  async function createSite(name: string) {
    const created = await api<Site>('/api/sites', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
    setSites((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)))
    setSiteId(created.id)
    setPage('scan')
  }

  async function renameSite(name: string) {
    if (siteId == null) return
    const updated = await api<Site>(`/api/sites/${siteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
    setSites((current) => current
      .map((item) => (item.id === updated.id ? updated : item))
      .sort((a, b) => a.name.localeCompare(b.name)))
  }

  async function deleteSite() {
    if (siteId == null) return
    await api(`/api/sites/${siteId}`, { method: 'DELETE' })
    const next = sites.filter((item) => item.id !== siteId)
    setSites(next)
    setSiteId(next[0]?.id ?? null)
    setPage('scan')
  }

  async function importFile(payload: unknown) {
    await api('/api/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    const next = await api<Site[]>('/api/sites')
    setSites(next)
    const saved = Number(localStorage.getItem(SITE_KEY))
    const pick = next.find((item) => item.id === saved) ?? next[0]
    setSiteId(pick?.id ?? null)
    setPage('scan')
    setDataVersion((version) => version + 1)
  }

  return (
    <div className="page">
      <header className="topbar">
        <h1>{APP.displayName} <span>v{APP.semver}</span></h1>
      </header>
      <main>
        {status === 'loading' && <p className="quiet">Opening the inventory…</p>}
        {status === 'error' && <p className="form-error">{loadError}</p>}
        {status === 'ready' && <DataBar hasData={sites.length > 0} onImport={importFile} />}
        {status === 'ready' && sites.length === 0 && <Welcome onCreate={createSite} />}
        {status === 'ready' && site && (
          <Workspace
            site={site}
            sites={sites}
            page={page}
            dataVersion={dataVersion}
            onPage={setPage}
            onSite={setSiteId}
            onCreate={createSite}
            onRename={renameSite}
            onDelete={deleteSite}
          />
        )}
      </main>
      <footer>
        <div>{APP_TITLE}</div>
        {shareUrls.length > 0 && (
          <div>Other computers on this Wi-Fi open {shareUrls.join('  ')}</div>
        )}
      </footer>
    </div>
  )
}

function Welcome({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setError('Enter a site name.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await onCreate(name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Try that again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="welcome" onSubmit={submit}>
      <h2>Name the site</h2>
      <p>This is the place the parts are stored. You can add other sites later.</p>
      <label className="field">
        <span>Site name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} autoFocus maxLength={60} />
      </label>
      {error && <p className="form-error">{error}</p>}
      <button className="btn" type="submit" disabled={busy}>Create site</button>
    </form>
  )
}

function DataBar({ hasData, onImport }: { hasData: boolean, onImport: (data: unknown) => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [sheetPath, setSheetPath] = useState('')

  useEffect(() => {
    api<{ sheet: string }>('/api/data-file')
      .then((info) => setSheetPath(info.sheet))
      .catch(() => setSheetPath(''))
  }, [])

  async function onFile(file: File | undefined) {
    if (!file) return
    setError('')
    setPending(null)
    try {
      const data = JSON.parse(await file.text()) as unknown
      if (!data || typeof data !== 'object' || (data as { app?: string }).app !== 'Vendor Inventory') {
        setError('That file is not a Vendor Inventory export.')
        return
      }
      if (hasData) setPending(data)
      else await onImport(data)
    } catch (err) {
      setError(err instanceof SyntaxError || !(err instanceof Error) ? 'That file could not be read.' : err.message)
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="data-bar no-print">
      <a className="btn ghost" href="/api/export">Export data</a>
      <button type="button" className="btn ghost" onClick={() => inputRef.current?.click()}>Import data</button>
      <a className="btn ghost" href="/vendor-inventory-v1.html" download={`${APP_TITLE}.html`}>Download app</a>
      <input
        ref={inputRef}
        className="file-input"
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => void onFile(event.target.files?.[0])}
      />
      {pending != null && (
        <div className="confirm-line">
          <p>Replace the inventory on this computer with this file?</p>
          <button
            className="btn danger"
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              setError('')
              void onImport(pending)
                .then(() => setPending(null))
                .catch((err: unknown) => setError(err instanceof Error ? err.message : 'The file was not imported.'))
                .finally(() => setBusy(false))
            }}
          >
            Replace inventory
          </button>
          <button className="btn ghost" type="button" onClick={() => setPending(null)}>Cancel</button>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <p className="file-note">
        Every scan is saved on this computer. A refresh keeps the list.
        {sheetPath
          ? ` The Excel file is created in My Documents: ${sheetPath}`
          : ' The Excel file is created in My Documents.'}
      </p>
    </div>
  )
}

function Workspace({
  site,
  sites,
  page,
  dataVersion,
  onPage,
  onSite,
  onCreate,
  onRename,
  onDelete,
}: {
  site: Site
  sites: Site[]
  page: Page
  dataVersion: number
  onPage: (page: Page) => void
  onSite: (id: number) => void
  onCreate: (name: string) => Promise<void>
  onRename: (name: string) => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <>
      <SiteBar site={site} sites={sites} onSite={onSite} onCreate={onCreate} onRename={onRename} onDelete={onDelete} />
      <nav className="tabs no-print" aria-label="Sections">
        <button type="button" aria-current={page === 'scan' ? 'page' : undefined} onClick={() => onPage('scan')}>
          Scan
        </button>
        <button type="button" aria-current={page === 'report' ? 'page' : undefined} onClick={() => onPage('report')}>
          Monthly report
        </button>
      </nav>
      {page === 'scan'
        ? <ScanPage key={`${site.id}-${dataVersion}`} site={site} />
        : <ReportPage key={`${site.id}-${dataVersion}`} site={site} sites={sites} />}
    </>
  )
}

function SiteBar({
  site,
  sites,
  onSite,
  onCreate,
  onRename,
  onDelete,
}: {
  site: Site
  sites: Site[]
  onSite: (id: number) => void
  onCreate: (name: string) => Promise<void>
  onRename: (name: string) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [editor, setEditor] = useState<null | { mode: 'add' | 'rename'; name: string }>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!editor) return
    if (!editor.name.trim()) {
      setError('Enter a site name.')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (editor.mode === 'add') await onCreate(editor.name)
      else await onRename(editor.name)
      setEditor(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Try that again.')
    } finally {
      setBusy(false)
    }
  }

  async function removeSite() {
    setBusy(true)
    setError('')
    try {
      await onDelete()
      setConfirmDelete(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The site was not deleted.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="site-bar no-print">
      {confirmDelete ? (
        <div className="confirm-line">
          <p>Delete {site.name}? The site and every scan recorded there are removed.</p>
          <button className="btn danger" type="button" disabled={busy} onClick={() => void removeSite()}>Delete site</button>
          <button className="btn ghost" type="button" onClick={() => { setConfirmDelete(false); setError('') }}>Cancel</button>
        </div>
      ) : editor ? (
        <form className="site-edit" onSubmit={submit}>
          <label className="field">
            <span>{editor.mode === 'add' ? 'New site' : 'Rename site'}</span>
            <input
              value={editor.name}
              onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              autoFocus
              maxLength={60}
            />
          </label>
          <button className="btn" type="submit" disabled={busy}>Save</button>
          <button className="btn ghost" type="button" onClick={() => { setEditor(null); setError('') }}>Cancel</button>
        </form>
      ) : (
        <div className="site-pick">
          <label className="field grow">
            <span>Site</span>
            <select value={site.id} onChange={(event) => onSite(Number(event.target.value))}>
              {sites.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn ghost" onClick={() => { setEditor({ mode: 'add', name: '' }); setError('') }}>
            Add site
          </button>
          <button type="button" className="btn ghost" onClick={() => { setEditor({ mode: 'rename', name: site.name }); setError('') }}>
            Rename
          </button>
          <button type="button" className="btn ghost" onClick={() => { setConfirmDelete(true); setError('') }}>
            Delete site
          </button>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  )
}

function ScanPage({ site }: { site: Site }) {
  const barcodeRef = useRef<HTMLInputElement>(null)
  const lock = useRef(false)
  const [mode, setMode] = useState<Mode>('in')
  const [barcode, setBarcode] = useState('')
  const [result, setResult] = useState<Result>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<SiteView | null>(null)
  const [viewError, setViewError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    setResult({ kind: 'idle' })
    setBarcode('')
    setView(null)
  }, [site.id])

  useEffect(() => {
    let cancel = false
    api<SiteView>(`/api/site-view?siteId=${site.id}`)
      .then((data) => {
        if (!cancel && data.site.id === site.id) {
          setView(data)
          setViewError('')
        }
      })
      .catch((err: unknown) => {
        if (!cancel) setViewError(err instanceof Error ? err.message : 'This site did not load.')
      })
    return () => {
      cancel = true
    }
  }, [site.id, refreshKey])

  useEffect(() => {
    if (result.kind === 'need_details' || result.kind === 'confirm_return') return
    if (result.kind === 'ok' && result.scan.direction === 'out') return
    barcodeRef.current?.focus()
  }, [result.kind, site.id])

  function chooseMode(next: Mode) {
    setMode(next)
    setResult((current) => (current.kind === 'need_details' ? { kind: 'idle' } : current))
  }

  async function onScan(event: FormEvent) {
    event.preventDefault()
    if (lock.current) return
    const code = barcode.trim()
    if (!code) {
      setResult({ kind: 'error', message: 'Scan or type a barcode.', barcode: '' })
      beep('bad')
      return
    }
    lock.current = true
    setBusy(true)
    setBarcode('')
    try {
      const scan = await api<ScanResult>('/api/scan', {
        method: 'POST',
        body: JSON.stringify({ siteId: site.id, barcode: code, direction: mode }),
      })
      setResult({ kind: 'ok', scan })
      setRefreshKey((key) => key + 1)
      beep(scan.direction)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'need_details') {
        setResult({ kind: 'need_details', barcode: code })
        beep('ask')
      } else if (err instanceof ApiError && err.code === 'confirm_return' && err.item) {
        setResult({ kind: 'confirm_return', barcode: code, item: err.item })
        beep('ask')
      } else {
        setResult({
          kind: 'error',
          message: err instanceof Error ? err.message : 'The scan was not saved.',
          barcode: code,
        })
        beep('bad')
      }
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  async function onCreateItem(fields: PartFields) {
    if (result.kind !== 'need_details') return
    const scan = await api<ScanResult>('/api/scan', {
      method: 'POST',
      body: JSON.stringify({
        siteId: site.id,
        barcode: result.barcode,
        direction: 'in',
        ...fields,
      }),
    })
    setResult({ kind: 'ok', scan })
    setRefreshKey((key) => key + 1)
    beep('in')
  }

  async function onPutBack() {
    if (result.kind !== 'confirm_return' || lock.current) return
    lock.current = true
    setBusy(true)
    try {
      const scan = await api<ScanResult>('/api/scan', {
        method: 'POST',
        body: JSON.stringify({ siteId: site.id, barcode: result.barcode, direction: 'in', putBack: true }),
      })
      setResult({ kind: 'ok', scan })
      setRefreshKey((key) => key + 1)
      beep('in')
    } catch (err) {
      setResult({
        kind: 'error',
        message: err instanceof Error ? err.message : 'The scan was not saved.',
        barcode: result.barcode,
      })
      beep('bad')
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  async function onUndo() {
    if (result.kind !== 'ok' || lock.current) return
    lock.current = true
    setBusy(true)
    try {
      const undone = await api<UndoResult>('/api/undo', {
        method: 'POST',
        body: JSON.stringify({ movementId: result.scan.movementId }),
      })
      setResult({ kind: 'undone', undo: undone })
      setRefreshKey((key) => key + 1)
    } catch (err) {
      setResult({
        kind: 'error',
        message: err instanceof Error ? err.message : 'The undo did not save.',
        barcode: result.scan.item.barcode,
      })
      beep('bad')
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  async function onSaveItem(itemIds: number[], fields: PartFields) {
    await Promise.all(itemIds.map((itemId) => api(`/api/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    })))
    setRefreshKey((key) => key + 1)
  }

  async function onRemove(itemIds: number[]) {
    await api('/api/inventory/remove', {
      method: 'POST',
      body: JSON.stringify({ siteId: site.id, itemIds }),
    })
    setResult({ kind: 'idle' })
    setRefreshKey((key) => key + 1)
  }

  async function onClear() {
    await api(`/api/sites/${site.id}/clear`, { method: 'POST' })
    setResult({ kind: 'idle' })
    setRefreshKey((key) => key + 1)
  }

  return (
    <div className="scan-page">
      <div className="mode" role="radiogroup" aria-label="What are you doing?">
        <button
          type="button"
          className="mode-btn in"
          role="radio"
          aria-checked={mode === 'in'}
          onClick={() => chooseMode('in')}
        >
          Receiving
          <small>Into inventory</small>
        </button>
        <button
          type="button"
          className="mode-btn out"
          role="radio"
          aria-checked={mode === 'out'}
          onClick={() => chooseMode('out')}
        >
          Using
          <small>Out of inventory</small>
        </button>
      </div>

      <form className="scan-row" onSubmit={onScan} autoComplete="off">
        <label className="field">
          <span>Barcode</span>
          <input
            ref={barcodeRef}
            className="barcode-input"
            value={barcode}
            onChange={(event) => {
              setBarcode(event.target.value)
              setResult((current) => (current.kind === 'need_details' ? { kind: 'idle' } : current))
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={64}
            placeholder="Scan or type"
          />
        </label>
        <button className={`btn btn-scan ${mode === 'in' ? 'receive' : 'use'}`} type="submit" disabled={busy}>
          {mode === 'in' ? 'Add to inventory' : 'Take out'}
        </button>
      </form>
      <p className="hint">Click the barcode box, then scan. The scanner presses Enter for you.</p>

      <div aria-live="polite">
        {result.kind === 'ok' && (
          <section className={`banner ok ${result.scan.direction}`}>
            <p className="eyebrow">{result.scan.direction === 'in' ? 'Added to inventory' : 'Taken out of inventory'}</p>
            <h2>{result.scan.item.description}</h2>
            <p className="result-meta">{result.scan.item.vendor}{result.scan.item.model ? ` · ${result.scan.item.model}` : ''}</p>
            <p className="mono">{result.scan.item.barcode}</p>
            <p className="eyebrow">{result.scan.direction === 'in' ? 'In inventory at' : 'Taken out of'} {result.scan.siteName}</p>
            {result.scan.direction === 'out' && (
              <TicketForm movementId={result.scan.movementId} onSaved={() => setRefreshKey((key) => key + 1)} />
            )}
            <button type="button" className="btn ghost" onClick={onUndo} disabled={busy}>Undo this scan</button>
          </section>
        )}
        {result.kind === 'undone' && (
          <section className="banner undone">
            <p className="eyebrow">Undone</p>
            <h2>{result.undo.item.description}</h2>
            <p className="eyebrow">On hand now at {result.undo.siteName}</p>
            <p className="onhand-now">{result.undo.onHand}</p>
          </section>
        )}
        {result.kind === 'error' && (
          <section className="banner bad">
            <p className="eyebrow">Not saved</p>
            <h2>{result.message}</h2>
            {result.barcode && <p className="mono">{result.barcode}</p>}
          </section>
        )}
        {result.kind === 'confirm_return' && (
          <section className="new-part">
            <p className="eyebrow">Already scanned</p>
            <h2>{result.item.description}</h2>
            <p className="result-meta">{result.item.vendor}{result.item.model ? ` · ${result.item.model}` : ''}</p>
            <p className="mono">{result.barcode}</p>
            <p>This barcode was taken out. Was it not actually used?</p>
            <div className="row-actions">
              <button type="button" className="btn receive" onClick={onPutBack} disabled={busy}>Put back into inventory</button>
              <button type="button" className="btn ghost" onClick={() => setResult({ kind: 'idle' })}>Leave it out</button>
            </div>
          </section>
        )}
        {result.kind === 'need_details' && (
          <NewPartForm
            barcode={result.barcode}
            onSave={onCreateItem}
            onCancel={() => setResult({ kind: 'idle' })}
          />
        )}
      </div>

      {viewError && <p className="form-error">{viewError}</p>}
      {!view && !viewError && <p className="quiet">Loading this site…</p>}
      {view && view.latest.length > 0 && (
        <section className="latest">
          <h2>Last scans at {site.name}</h2>
          <ul>
            {view.latest.map((row) => (
              <li key={row.id}>
                <span className={`pill ${row.direction}`}>{row.direction === 'in' ? 'In' : 'Out'}</span>
                <span>
                  <strong>{row.description}</strong>
                  <small>{row.vendor}{row.ticket ? ` · Ticket ${row.ticket}` : ''}</small>
                </span>
                <time>{formatWhen(row.scannedAt)}</time>
              </li>
            ))}
          </ul>
        </section>
      )}
      {view && (
        <Shelf
          siteName={site.name}
          rows={view.shelf}
          canClear={view.shelf.length > 0 || view.latest.length > 0}
          onSave={onSaveItem}
          onRemove={onRemove}
          onClear={onClear}
        />
      )}
    </div>
  )
}

function NewPartForm({
  barcode,
  onSave,
  onCancel,
}: {
  barcode: string
  onSave: (fields: PartFields) => Promise<void>
  onCancel: () => void
}) {
  const [description, setDescription] = useState('')
  const [model, setModel] = useState('')
  const [vendor, setVendor] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!description.trim() || !vendor.trim()) {
      setError('Enter what it is and the vendor.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await onSave({ description, model, vendor })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The part was not saved.')
      setBusy(false)
    }
  }

  return (
    <form className="new-part" onSubmit={submit}>
      <p className="eyebrow">New part</p>
      <h2>First time for this barcode</h2>
      <p className="mono">{barcode}</p>
      <p className="hint">Each barcode is one item. Use the same description or model number for matching parts so they group on the list.</p>
      <label className="field">
        <span>What is it?</span>
        <input value={description} onChange={(event) => setDescription(event.target.value)} autoFocus maxLength={200} />
      </label>
      <label className="field">
        <span>Model number</span>
        <input value={model} onChange={(event) => setModel(event.target.value)} maxLength={80} />
      </label>
      <label className="field">
        <span>Vendor</span>
        <input value={vendor} onChange={(event) => setVendor(event.target.value)} maxLength={120} />
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="row-actions">
        <button className="btn receive" type="submit" disabled={busy}>Save and add to inventory</button>
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function Shelf({
  siteName,
  rows,
  canClear,
  onSave,
  onRemove,
  onClear,
}: {
  siteName: string
  rows: ShelfRow[]
  canClear: boolean
  onSave: (itemIds: number[], fields: PartFields) => Promise<void>
  onRemove: (itemIds: number[]) => Promise<void>
  onClear: () => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [removing, setRemoving] = useState<ShelfRow | null>(null)
  const [clearing, setClearing] = useState(false)
  const [actionError, setActionError] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const needle = query.trim().toLowerCase()
  const visible = rows.filter((row) => !needle
    || row.barcode.toLowerCase().includes(needle)
    || row.description.toLowerCase().includes(needle)
    || row.model.toLowerCase().includes(needle)
    || row.vendor.toLowerCase().includes(needle))
  const groups = groupProducts(visible)

  return (
    <section className="shelf">
      <div className="shelf-head">
        <div>
          <h2>On hand at {siteName}</h2>
          {canClear && (
            <div className="row-actions downloads">
              <button type="button" className="btn ghost" onClick={() => { setClearing(true); setRemoving(null); setActionError('') }}>
                Clear inventory
              </button>
            </div>
          )}
        </div>
        {rows.length > 0 && (
          <label className="field search-field">
            <span>Find</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Vendor, part, or barcode"
            />
          </label>
        )}
      </div>
      {clearing && (
        <div className="new-part">
          <h2>Clear the inventory at {siteName}?</h2>
          <p>The site stays. Every scan at this site is removed.</p>
          {actionError && <p className="form-error">{actionError}</p>}
          <div className="row-actions">
            <button
              type="button"
              className="btn danger"
              disabled={actionBusy}
              onClick={() => {
                setActionBusy(true)
                setActionError('')
                void onClear()
                  .then(() => setClearing(false))
                  .catch((err: unknown) => setActionError(err instanceof Error ? err.message : 'The inventory was not cleared.'))
                  .finally(() => setActionBusy(false))
              }}
            >
              Clear inventory
            </button>
            <button type="button" className="btn ghost" onClick={() => { setClearing(false); setActionError('') }}>Cancel</button>
          </div>
        </div>
      )}
      {removing && (
        <div className="new-part">
          <h2>Remove this barcode from {siteName}?</h2>
          <p>{removing.description}</p>
          <p className="mono">{removing.barcode}</p>
          <p>It comes off this site. If it is not at another site, it can be scanned in again.</p>
          {actionError && <p className="form-error">{actionError}</p>}
          <div className="row-actions">
            <button
              type="button"
              className="btn danger"
              disabled={actionBusy}
              onClick={() => {
                setActionBusy(true)
                setActionError('')
                void onRemove([removing.itemId])
                  .then(() => setRemoving(null))
                  .catch((err: unknown) => setActionError(err instanceof Error ? err.message : 'That barcode was not removed.'))
                  .finally(() => setActionBusy(false))
              }}
            >
              Remove
            </button>
            <button type="button" className="btn ghost" onClick={() => { setRemoving(null); setActionError('') }}>Cancel</button>
          </div>
        </div>
      )}
      {rows.length === 0 && (
        <p className="empty">Nothing at {siteName} yet. Stay on Receiving and scan the first part.</p>
      )}
      {rows.length > 0 && visible.length === 0 && <p className="empty">Nothing matches.</p>}
      {groups.map((group) => (
        <article key={group.key} className={editingKey === group.key ? 'part editing' : 'part'}>
          {editingKey === group.key ? (
            <EditPart
              description={group.description}
              model={group.model}
              vendor={group.vendor}
              onCancel={() => setEditingKey(null)}
              onSave={async (fields) => {
                await onSave(group.rows.map((row) => row.itemId), fields)
                setEditingKey(null)
              }}
            />
          ) : (
            <>
              <div>
                <p className="part-name">{group.description}</p>
                <p className="part-code">{group.vendor}{group.model ? ` · Model ${group.model}` : ''}</p>
                <ul className="barcode-list">
                  {group.rows.map((row) => (
                    <li key={row.itemId} className="barcode-line">
                      <span className="mono">{row.barcode}</span>
                      <button type="button" className="link" onClick={() => { setRemoving(row); setClearing(false); setActionError('') }}>
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" className="link" onClick={() => setEditingKey(group.key)}>Correct</button>
              </div>
              <p className="part-qty">{group.count}</p>
            </>
          )}
        </article>
      ))}
    </section>
  )
}

function norm(value: string) {
  return value.trim().toLowerCase()
}

function mostCommon(values: string[]) {
  const counts = new Map<string, number>()
  for (const value of values) {
    const key = value.trim()
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

function groupProducts(rows: ShelfRow[]) {
  const parent = rows.map((_, index) => index)
  const find = (index: number): number => {
    let cursor = index
    while (parent[cursor] !== cursor) cursor = parent[cursor]
    return cursor
  }
  const union = (left: number, right: number) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[leftRoot] = rightRoot
  }
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const sameDescription = norm(rows[i].description) !== '' && norm(rows[i].description) === norm(rows[j].description)
      const sameModel = norm(rows[i].model) !== '' && norm(rows[i].model) === norm(rows[j].model)
      if (sameDescription || sameModel) union(i, j)
    }
  }
  const buckets = new Map<number, ShelfRow[]>()
  rows.forEach((row, index) => {
    const root = find(index)
    const list = buckets.get(root) ?? []
    list.push(row)
    buckets.set(root, list)
  })
  return [...buckets.values()].map((list) => ({
    key: list.map((row) => row.itemId).sort((a, b) => a - b).join('-'),
    description: mostCommon(list.map((row) => row.description)),
    model: mostCommon(list.map((row) => row.model)),
    vendor: mostCommon(list.map((row) => row.vendor)),
    rows: [...list].sort((a, b) => a.barcode.localeCompare(b.barcode)),
    count: list.reduce((sum, row) => sum + row.onHand, 0),
  })).sort((a, b) => a.vendor.localeCompare(b.vendor, undefined, { sensitivity: 'base' })
    || a.description.localeCompare(b.description, undefined, { sensitivity: 'base' })
    || a.model.localeCompare(b.model, undefined, { sensitivity: 'base' }))
}

function EditPart({
  description: initialDescription,
  model: initialModel,
  vendor: initialVendor,
  onSave,
  onCancel,
}: {
  description: string
  model: string
  vendor: string
  onSave: (fields: PartFields) => Promise<void>
  onCancel: () => void
}) {
  const [description, setDescription] = useState(initialDescription)
  const [model, setModel] = useState(initialModel)
  const [vendor, setVendor] = useState(initialVendor)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onSave({ description, model, vendor })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The change was not saved.')
      setBusy(false)
    }
  }

  return (
    <form className="edit-part" onSubmit={submit}>
      <label className="field">
        <span>What is it?</span>
        <input value={description} onChange={(event) => setDescription(event.target.value)} autoFocus maxLength={200} />
      </label>
      <label className="field">
        <span>Model number</span>
        <input value={model} onChange={(event) => setModel(event.target.value)} maxLength={80} />
      </label>
      <label className="field">
        <span>Vendor</span>
        <input value={vendor} onChange={(event) => setVendor(event.target.value)} maxLength={120} />
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="row-actions">
        <button className="btn" type="submit" disabled={busy}>Save</button>
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function TicketForm({ movementId, onSaved }: { movementId: number, onSaved: () => void }) {
  const [ticket, setTicket] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const saved = await api<{ ticket: string }>(`/api/movements/${movementId}`, {
        method: 'PATCH',
        body: JSON.stringify({ ticket }),
      })
      setNote(saved.ticket ? `Saved ticket ${saved.ticket}` : 'No ticket number saved.')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The ticket number was not saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ticket-form" onSubmit={save}>
      <label className="field">
        <span>Ticket # used on</span>
        <input
          value={ticket}
          onChange={(event) => setTicket(event.target.value)}
          maxLength={40}
          placeholder="Optional"
          autoFocus
        />
      </label>
      <button className="btn ghost" type="submit" disabled={busy}>Save ticket</button>
      {note && <p className="hint">{note}</p>}
      {error && <p className="form-error">{error}</p>}
    </form>
  )
}

function ReportPage({ site, sites }: { site: Site, sites: Site[] }) {
  const [month, setMonth] = useState(currentMonth)
  const [scope, setScope] = useState<number | 'all'>(site.id)
  const [sort, setSort] = useState<'vendor' | 'description'>('vendor')
  const [data, setData] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const allSites = scope === 'all'
  const sortMode = allSites ? 'vendor' : sort
  const scopeId = allSites ? null : scope

  useEffect(() => {
    let cancel = false
    const query = new URLSearchParams({ month, sort: sortMode })
    if (scopeId != null) query.set('siteId', String(scopeId))
    api<Report>(`/api/report?${query}`)
      .then((report) => {
        if (!cancel) {
          setData(report)
          setError('')
        }
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : 'The report did not load.')
      })
    return () => {
      cancel = true
    }
  }, [month, scopeId, sortMode])

  return (
    <section className="report">
      <div className="report-head no-print">
        <div>
          <h2>Monthly report</h2>
          <p className="hint">
            On hand, what came in, and what was used. This comes from the scans.
            {allSites ? ' All sites stay organized by vendor name.' : ''}
          </p>
        </div>
        <div className="report-controls">
          <label className="field">
            <span>Month</span>
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
          </label>
          <label className="field">
            <span>Site</span>
            <select
              value={allSites ? '' : String(scope)}
              onChange={(event) => setScope(Number(event.target.value))}
            >
              {allSites && <option value="">All sites</option>}
              {sites.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn ghost" aria-pressed={allSites} onClick={() => setScope('all')}>
            All sites
          </button>
          <label className="field">
            <span>Sort</span>
            <select
              value={sortMode}
              disabled={allSites}
              onChange={(event) => setSort(event.target.value === 'description' ? 'description' : 'vendor')}
            >
              <option value="vendor">Vendor name</option>
              <option value="description">Description</option>
            </select>
          </label>
          <button type="button" className="btn ghost" disabled={!data} onClick={() => data && downloadPrint(data, 'inventory')}>Download inventory</button>
          <button type="button" className="btn ghost" disabled={!data} onClick={() => data && downloadPrint(data, 'month')}>Download month</button>
          <button type="button" className="btn ghost" onClick={() => window.print()}>Print</button>
        </div>
      </div>
      <h2 className="print-only">
        {formatMonth(month)} · {allSites ? 'All sites' : (sites.find((item) => item.id === scope)?.name ?? site.name)}
      </h2>
      {error && <p className="form-error">{error}</p>}
      {!data && !error && <p className="quiet">Loading the report…</p>}
      {data && data.rows.length === 0 && (
        <p className="empty">Nothing was on hand and nothing moved in {formatMonth(month)} at {data.siteName}.</p>
      )}
      {data && data.rows.length > 0 && (
        <>
          <p className="quiet">
            {formatMonth(data.month)} · {data.siteName} · {data.rows.length} lines
            · Organized by {data.sort === 'description' ? 'description' : 'vendor name'}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Site</th>
                  <th>Vendor</th>
                  <th>Model</th>
                  <th>Barcode</th>
                  <th>Description</th>
                  <th className="num">Started with</th>
                  <th className="num">Received</th>
                  <th className="num">Used</th>
                  <th className="num">On hand</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={`${row.site}-${row.barcode}`}>
                    <td>{row.site}</td>
                    <td>{row.vendor}</td>
                    <td>{row.model}</td>
                    <td className="mono">{row.barcode}</td>
                    <td>{row.description}</td>
                    <td className="num">{row.startOnHand}</td>
                    <td className="num">{row.received}</td>
                    <td className="num">{row.used}</td>
                    <td className="num">{row.endOnHand}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
