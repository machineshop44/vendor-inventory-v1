import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import {
  HttpError,
  createSite,
  dbPath,
  listSites,
  clearInventory,
  deleteSite,
  exportData,
  importData,
  renameSite,
  inventoryCsv,
  removeInventory,
  report,
  reportCsv,
  scan,
  siteView,
  undo,
  updateItem,
} from './db.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const prod = process.argv.includes('--prod')
const port = 8787

function send(handler) {
  return (req, res) => {
    try {
      const result = handler(req, res)
      if (!res.headersSent) res.json(result ?? null)
    } catch (err) {
      if (err instanceof HttpError) {
        const payload = { error: err.message, ...err.extra }
        if (err.code) payload.code = err.code
        res.status(err.status).json(payload)
        return
      }
      console.error(err)
      res.status(500).json({ error: 'Something went wrong. The scan was not saved.' })
    }
  }
}

function scopeQuery(req) {
  const siteId = req.query.siteId
  return {
    siteId: siteId == null || siteId === '' ? null : siteId,
    sort: req.query.sort,
  }
}

function monthQuery(req) {
  return {
    month: req.query.month,
    ...scopeQuery(req),
  }
}

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '4mb' }))

app.get('/api/share', send(() => ({ urls: shareUrls(port).filter((url) => !url.includes('127.0.0.1')) })))

app.get('/api/sites', send(() => listSites()))

app.post('/api/sites', send((req) => createSite(req.body?.name)))

app.patch('/api/sites/:id', send((req) => renameSite(req.params.id, req.body?.name)))

app.delete('/api/sites/:id', send((req) => deleteSite(req.params.id)))

app.post('/api/sites/:id/clear', send((req) => clearInventory(req.params.id)))

app.post('/api/inventory/remove', send((req) => removeInventory(req.body?.siteId, req.body?.itemIds)))

app.get('/api/export', send((_req, res) => {
  const data = exportData()
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="vendor-inventory-v1.json"')
  res.send(`${JSON.stringify(data, null, 2)}\n`)
}))

app.post('/api/import', send((req) => importData(req.body)))

app.get('/api/site-view', send((req) => siteView(req.query.siteId)))

app.post('/api/scan', send((req) => scan(req.body ?? {})))

app.post('/api/undo', send((req) => undo(req.body?.movementId)))

app.patch('/api/items/:id', send((req) => updateItem(req.params.id, req.body ?? {})))

app.get('/vendor-inventory-v1.html', (_req, res) => {
  res.sendFile(path.join(root, 'Vendor Inventory v1.html'))
})

app.get('/api/inventory.csv', send((req, res) => {
  const data = inventoryCsv(scopeQuery(req))
  const slug = data.siteName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site'
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="vendor-inventory-v1-${slug}.csv"`)
  res.send(data.csv)
}))

app.get('/api/report', send((req) => report(monthQuery(req))))

app.get('/api/report.csv', send((req, res) => {
  const query = monthQuery(req)
  const csv = reportCsv(query)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="vendor-inventory-v1-${query.month}.csv"`)
  res.send(csv)
}))

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

if (prod) {
  const dist = path.join(root, 'dist')
  app.use(express.static(dist))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'))
  })
} else {
  const { createServer } = await import('vite')
  const vite = await createServer({
    root,
    server: { middlewareMode: true },
    appType: 'spa',
  })
  app.use(vite.middlewares)
}

function shareUrls(listenPort) {
  const urls = [`http://127.0.0.1:${listenPort}`]
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|Virtual|Loopback|Bluetooth|OpenVPN|Surfshark|Hyper-V/i.test(name)) continue
    for (const entry of entries ?? []) {
      const ipv4 = entry.family === 4 || entry.family === 'IPv4'
      if (!ipv4 || entry.internal) continue
      if (entry.address.startsWith('169.254.')) continue
      urls.push(`http://${entry.address}:${listenPort}`)
    }
  }
  return urls
}

const server = app.listen(port, '0.0.0.0', () => {
  console.log('Vendor Inventory v1')
  for (const url of shareUrls(port)) console.log(`  ${url}`)
  console.log(`Database               ${dbPath}`)
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use.`)
    process.exit(1)
  }
  throw err
})
