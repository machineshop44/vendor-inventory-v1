import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { DATA_JSON, DATA_SHEET, workbookXml } from './workbook.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(root, 'data')
fs.mkdirSync(dataDir, { recursive: true })

function documentsDir() {
  if (process.platform === 'win32') {
    try {
      const output = execFileSync('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
        '/v',
        'Personal',
      ], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      const match = /Personal\s+REG_\w+\s+(.+)/i.exec(output)
      const folder = match?.[1]?.trim()
      if (folder) return folder
    } catch {
      // Use the usual Documents folder when the shell path cannot be read.
    }
  }
  return path.join(os.homedir(), 'Documents')
}

const documents = documentsDir()
fs.mkdirSync(documents, { recursive: true })

export const dbPath = path.join(dataDir, 'inventory.db')
export const jsonPath = path.join(documents, DATA_JSON)
export const sheetPath = path.join(documents, DATA_SHEET)

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys = ON')
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA busy_timeout = 3000')
db.exec(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8'))

const itemColumns = db.prepare('PRAGMA table_info(items)').all()
if (!itemColumns.some((column) => column.name === 'model')) {
  db.exec("ALTER TABLE items ADD COLUMN model TEXT NOT NULL DEFAULT ''")
}

const movementColumns = db.prepare('PRAGMA table_info(movements)').all()
if (!movementColumns.some((column) => column.name === 'ticket')) {
  db.exec("ALTER TABLE movements ADD COLUMN ticket TEXT NOT NULL DEFAULT ''")
}

export class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra ?? {}
  }
}

function nowLocal() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function cleanText(value, max, label) {
  if (typeof value !== 'string') return ''
  const clean = value.replace(/\s+/g, ' ').trim()
  if (clean.length > max) throw new HttpError(400, `${label} is too long.`)
  return clean
}

function cleanBarcode(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim()
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The transaction is already closed.
    }
    throw err
  }
}

function mustSite(siteId) {
  const id = Number(siteId)
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Pick a site.')
  const site = db.prepare('SELECT id, name FROM sites WHERE id = ?').get(id)
  if (!site) throw new HttpError(400, 'That site is not in the list. Pick another.')
  return site
}

function onHandAt(siteId, itemId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN qty ELSE -qty END), 0) AS on_hand
    FROM movements
    WHERE site_id = ? AND item_id = ?
  `).get(siteId, itemId)
  return Number(row.on_hand)
}

function placesInStock(itemId) {
  return db.prepare(`
    SELECT s.name AS name,
      SUM(CASE m.direction WHEN 'in' THEN m.qty ELSE -m.qty END) AS on_hand
    FROM movements m
    JOIN sites s ON s.id = m.site_id
    WHERE m.item_id = ?
    GROUP BY s.id
  `).all(itemId)
    .map((row) => ({ name: row.name, onHand: Number(row.on_hand) }))
    .filter((row) => row.onHand > 0)
}

function publicItem(row) {
  return {
    id: row.id,
    barcode: row.barcode,
    description: row.description,
    model: row.model ?? '',
    vendor: row.vendor,
    unit: row.unit,
  }
}

export function listSites() {
  return db.prepare('SELECT id, name FROM sites ORDER BY name COLLATE NOCASE').all()
    .map((row) => ({ id: row.id, name: row.name }))
}

export function createSite(name) {
  const clean = cleanText(name, 60, 'Site name')
  if (!clean) throw new HttpError(400, 'Enter a site name.')
  try {
    const info = db.prepare('INSERT INTO sites (name, created_at) VALUES (?, ?)').run(clean, nowLocal())
    return { id: Number(info.lastInsertRowid), name: clean }
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'That site already exists.')
    throw err
  }
}

export function renameSite(siteId, name) {
  const site = mustSite(siteId)
  const clean = cleanText(name, 60, 'Site name')
  if (!clean) throw new HttpError(400, 'Enter a site name.')
  try {
    db.prepare('UPDATE sites SET name = ? WHERE id = ?').run(clean, site.id)
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'That site already exists.')
    throw err
  }
  return { id: site.id, name: clean }
}

function itemIdsAtSite(siteId) {
  return db.prepare('SELECT DISTINCT item_id AS id FROM movements WHERE site_id = ?').all(siteId)
    .map((row) => row.id)
}

function deleteOrphanItems(ids) {
  for (const id of ids) {
    const left = db.prepare('SELECT COUNT(*) AS n FROM movements WHERE item_id = ?').get(id)
    if (Number(left.n) === 0) db.prepare('DELETE FROM items WHERE id = ?').run(id)
  }
}

export function deleteSite(siteId) {
  const site = mustSite(siteId)
  return transaction(() => {
    const ids = itemIdsAtSite(site.id)
    db.prepare('DELETE FROM movements WHERE site_id = ?').run(site.id)
    deleteOrphanItems(ids)
    db.prepare('DELETE FROM sites WHERE id = ?').run(site.id)
    return { id: site.id, name: site.name }
  })
}

export function clearInventory(siteId) {
  const site = mustSite(siteId)
  return transaction(() => {
    const ids = itemIdsAtSite(site.id)
    db.prepare('DELETE FROM movements WHERE site_id = ?').run(site.id)
    deleteOrphanItems(ids)
    return { siteId: site.id, siteName: site.name, removed: ids.length }
  })
}

export function removeInventory(siteId, itemIds) {
  const site = mustSite(siteId)
  const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map((id) => Number(id)))]
    .filter((id) => Number.isInteger(id) && id > 0)
  if (ids.length === 0) throw new HttpError(400, 'Pick what to remove.')
  return transaction(() => {
    const found = ids.filter((id) => db.prepare(
      'SELECT 1 AS ok FROM movements WHERE site_id = ? AND item_id = ? LIMIT 1',
    ).get(site.id, id))
    if (found.length === 0) throw new HttpError(404, 'Those parts are not at this site.')
    for (const id of found) {
      db.prepare('DELETE FROM movements WHERE site_id = ? AND item_id = ?').run(site.id, id)
    }
    deleteOrphanItems(found)
    return { siteId: site.id, siteName: site.name, removed: found.length }
  })
}

export function exportData() {
  return {
    app: 'Vendor Inventory',
    versionLabel: 'v1',
    semver: '1.3.2',
    exportedAt: nowLocal(),
    sites: db.prepare('SELECT id, name, created_at FROM sites ORDER BY id').all().map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
    })),
    items: db.prepare('SELECT id, barcode, description, model, vendor, unit, created_at FROM items ORDER BY id').all()
      .map((row) => ({
        id: row.id,
        barcode: row.barcode,
        description: row.description,
        model: row.model ?? '',
        vendor: row.vendor,
        unit: row.unit,
        createdAt: row.created_at,
      })),
    movements: db.prepare('SELECT id, site_id, item_id, direction, qty, scanned_at, ticket FROM movements ORDER BY id').all()
      .map((row) => ({
        id: row.id,
        siteId: row.site_id,
        itemId: row.item_id,
        direction: row.direction,
        qty: row.qty,
        scannedAt: row.scanned_at,
        ticket: row.ticket ?? '',
      })),
  }
}

export function importData(payload) {
  if (!payload || typeof payload !== 'object' || payload.app !== 'Vendor Inventory') {
    throw new HttpError(400, 'That file is not a Vendor Inventory export.')
  }
  if (!Array.isArray(payload.sites) || !Array.isArray(payload.items) || !Array.isArray(payload.movements)) {
    throw new HttpError(400, 'That file is not a Vendor Inventory export.')
  }

  const sites = []
  const siteIds = new Set()
  const siteNames = new Set()
  for (const row of payload.sites) {
    const id = Number(row?.id)
    const name = cleanText(row?.name, 60, 'Site name')
    const nameKey = name.toLowerCase()
    if (!Number.isInteger(id) || id <= 0 || !name || siteIds.has(id) || siteNames.has(nameKey)) {
      throw new HttpError(400, 'That file has a site that cannot be read.')
    }
    siteIds.add(id)
    siteNames.add(nameKey)
    const createdAt = typeof row.createdAt === 'string' && row.createdAt ? row.createdAt : nowLocal()
    sites.push({ id, name, createdAt })
  }

  const items = []
  const itemIds = new Set()
  const barcodes = new Set()
  for (const row of payload.items) {
    const id = Number(row?.id)
    const barcode = cleanBarcode(row?.barcode ?? '')
    const description = cleanText(row?.description, 200, 'Description')
    const vendor = cleanText(row?.vendor, 120, 'Vendor')
    const model = cleanText(typeof row?.model === 'string' ? row.model : '', 80, 'Model number')
    const unit = cleanText(typeof row?.unit === 'string' && row.unit ? row.unit : 'each', 40, 'Unit') || 'each'
    const codeKey = barcode.toLowerCase()
    if (!Number.isInteger(id) || id <= 0 || !barcode || barcode.length > 64 || !description || !vendor
      || itemIds.has(id) || barcodes.has(codeKey)) {
      throw new HttpError(400, 'That file has a part that cannot be read.')
    }
    itemIds.add(id)
    barcodes.add(codeKey)
    const createdAt = typeof row.createdAt === 'string' && row.createdAt ? row.createdAt : nowLocal()
    items.push({ id, barcode, description, model, vendor, unit, createdAt })
  }

  const movements = []
  const movementIds = new Set()
  for (const row of payload.movements) {
    const id = Number(row?.id)
    const siteId = Number(row?.siteId)
    const itemId = Number(row?.itemId)
    const direction = row?.direction
    const qty = Number(row?.qty)
    const scannedAt = typeof row?.scannedAt === 'string' ? row.scannedAt : ''
    if (!Number.isInteger(id) || id <= 0 || movementIds.has(id) || !siteIds.has(siteId) || !itemIds.has(itemId)) {
      throw new HttpError(400, 'That file has a scan that cannot be read.')
    }
    if (direction !== 'in' && direction !== 'out') throw new HttpError(400, 'That file has a scan that cannot be read.')
    if (!Number.isInteger(qty) || qty <= 0) throw new HttpError(400, 'That file has a scan that cannot be read.')
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(scannedAt)) {
      throw new HttpError(400, 'That file has a scan that cannot be read.')
    }
    movementIds.add(id)
    const ticket = direction === 'out'
      ? cleanText(typeof row?.ticket === 'string' ? row.ticket : '', 40, 'Ticket number')
      : ''
    movements.push({ id, siteId, itemId, direction, qty, scannedAt, ticket })
  }

  return transaction(() => {
    db.exec('DELETE FROM movements')
    db.exec('DELETE FROM items')
    db.exec('DELETE FROM sites')
    const insertSite = db.prepare('INSERT INTO sites (id, name, created_at) VALUES (?, ?, ?)')
    for (const site of sites) insertSite.run(site.id, site.name, site.createdAt)
    const insertItem = db.prepare(`
      INSERT INTO items (id, barcode, description, model, vendor, unit, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const item of items) {
      insertItem.run(item.id, item.barcode, item.description, item.model, item.vendor, item.unit, item.createdAt)
    }
    const insertMove = db.prepare(`
      INSERT INTO movements (id, site_id, item_id, direction, qty, scanned_at, ticket)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const move of movements) {
      insertMove.run(move.id, move.siteId, move.itemId, move.direction, move.qty, move.scannedAt, move.ticket)
    }
    return { sites: sites.length, items: items.length, movements: movements.length }
  })
}

function sortMode(site, sort) {
  if (!site) return 'vendor'
  return sort === 'description' ? 'description' : 'vendor'
}

function byInventoryOrder(mode) {
  return (left, right) => {
    const vendor = left.vendor.localeCompare(right.vendor, undefined, { sensitivity: 'base' })
    const description = left.description.localeCompare(right.description, undefined, { sensitivity: 'base' })
    const siteName = left.site.localeCompare(right.site, undefined, { sensitivity: 'base' })
    const barcode = String(left.barcode).localeCompare(String(right.barcode))
    if (mode === 'description') return description || vendor || siteName || barcode
    return vendor || siteName || description || barcode
  }
}

export function siteView(siteId) {
  const site = mustSite(siteId)
  const shelf = db.prepare(`
    SELECT i.id, i.barcode, i.description, i.model, i.vendor, i.unit,
      SUM(CASE m.direction WHEN 'in' THEN m.qty ELSE -m.qty END) AS on_hand
    FROM movements m
    JOIN items i ON i.id = m.item_id
    WHERE m.site_id = ?
    GROUP BY i.id
  `).all(site.id)
    .map((row) => ({
      itemId: row.id,
      barcode: row.barcode,
      description: row.description,
      model: row.model ?? '',
      vendor: row.vendor,
      unit: row.unit,
      onHand: Number(row.on_hand),
    }))
    .filter((row) => row.onHand !== 0)
    .sort((a, b) => a.vendor.localeCompare(b.vendor, undefined, { sensitivity: 'base' })
      || a.description.localeCompare(b.description, undefined, { sensitivity: 'base' }))

  const latest = db.prepare(`
    SELECT m.id, m.direction, m.qty, m.scanned_at, m.ticket, i.barcode, i.description, i.vendor
    FROM movements m
    JOIN items i ON i.id = m.item_id
    WHERE m.site_id = ?
    ORDER BY m.id DESC
    LIMIT 5
  `).all(site.id).map((row) => ({
    id: row.id,
    direction: row.direction,
    qty: row.qty,
    scannedAt: row.scanned_at,
    barcode: row.barcode,
    description: row.description,
    vendor: row.vendor,
    ticket: row.ticket ?? '',
  }))

  return { site: { id: site.id, name: site.name }, shelf, latest }
}

function insertItem({ barcode, description, model, vendor, unit }) {
  const info = db.prepare(`
    INSERT INTO items (barcode, description, model, vendor, unit, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(barcode, description, model, vendor, unit, nowLocal())
  return db.prepare('SELECT id, barcode, description, model, vendor, unit FROM items WHERE id = ?')
    .get(Number(info.lastInsertRowid))
}

function insertMovement({ siteId, itemId, direction, qty }) {
  const info = db.prepare(`
    INSERT INTO movements (site_id, item_id, direction, qty, scanned_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(siteId, itemId, direction, qty, nowLocal())
  return Number(info.lastInsertRowid)
}

function scanResult(site, item, qty, direction, movementId) {
  return {
    movementId,
    qty,
    direction,
    onHand: onHandAt(site.id, item.id),
    siteId: site.id,
    siteName: site.name,
    item: publicItem(item),
  }
}

export function scan({ siteId, barcode, direction, description, vendor, model, putBack }) {
  const site = mustSite(siteId)
  const code = cleanBarcode(barcode)
  if (!code) throw new HttpError(400, 'Scan or type a barcode.')
  if (code.length > 64) throw new HttpError(400, 'That barcode is too long.')
  if (direction !== 'in' && direction !== 'out') throw new HttpError(400, 'Choose Receiving or Using.')
  const existing = db.prepare('SELECT id, barcode, description, model, vendor, unit FROM items WHERE barcode = ?').get(code)

  if (!existing && direction === 'out') {
    throw new HttpError(
      422,
      'This barcode is not in the list. If the part just arrived, switch to Receiving and scan it again.',
      'unknown',
    )
  }

  if (!existing && direction === 'in') {
    const desc = cleanText(description, 200, 'Description')
    const vend = cleanText(vendor, 120, 'Vendor')
    const modelName = cleanText(model, 80, 'Model number')
    if (!desc || !vend) {
      throw new HttpError(422, 'New part. Enter what it is and the vendor.', 'need_details')
    }
    return transaction(() => {
      const created = insertItem({ barcode: code, description: desc, model: modelName, vendor: vend, unit: 'each' })
      const movementId = insertMovement({ siteId: site.id, itemId: created.id, direction, qty: 1 })
      return scanResult(site, created, 1, direction, movementId)
    })
  }

  const places = placesInStock(existing.id)
  if (direction === 'in' && places.length > 0) {
    const names = places.map((place) => place.name).join(', ')
    throw new HttpError(409, `This barcode is already in inventory at ${names}.`, 'duplicate')
  }
  if (direction === 'in' && !putBack) {
    throw new HttpError(
      409,
      'This barcode was taken out. Put it back into inventory?',
      'confirm_return',
      { item: publicItem(existing) },
    )
  }
  if (direction === 'out') {
    const here = onHandAt(site.id, existing.id)
    if (here < 1) {
      if (places.length > 0) {
        throw new HttpError(409, `This barcode is in inventory at ${places[0].name}.`, 'wrong_site')
      }
      throw new HttpError(409, 'This barcode is already out of inventory.', 'already_out')
    }
  }

  return transaction(() => {
    const movementId = insertMovement({
      siteId: site.id,
      itemId: existing.id,
      direction,
      qty: 1,
    })
    return scanResult(site, existing, 1, direction, movementId)
  })
}

export function undo(movementId) {
  const id = Number(movementId)
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'That scan is already undone.')
  const mov = db.prepare(`
    SELECT m.id, m.site_id, m.item_id, m.direction, m.qty, s.name AS site_name,
      i.barcode, i.description, i.model, i.vendor, i.unit
    FROM movements m
    JOIN items i ON i.id = m.item_id
    JOIN sites s ON s.id = m.site_id
    WHERE m.id = ?
  `).get(id)
  if (!mov) throw new HttpError(404, 'That scan is already undone.')

  const onHand = onHandAt(mov.site_id, mov.item_id)
  const next = mov.direction === 'in' ? onHand - mov.qty : onHand + mov.qty
  if (next < 0) {
    throw new HttpError(409, 'That part was already taken out. Undo the take-out first.')
  }

  return transaction(() => {
    db.prepare('DELETE FROM movements WHERE id = ?').run(mov.id)
    const left = db.prepare('SELECT COUNT(*) AS n FROM movements WHERE item_id = ?').get(mov.item_id)
    if (Number(left.n) === 0) db.prepare('DELETE FROM items WHERE id = ?').run(mov.item_id)
    return {
      onHand: next,
      siteId: mov.site_id,
      siteName: mov.site_name,
      item: {
        id: mov.item_id,
        barcode: mov.barcode,
        description: mov.description,
        model: mov.model ?? '',
        vendor: mov.vendor,
        unit: mov.unit,
      },
    }
  })
}

export function setTicket(movementId, ticket) {
  const id = Number(movementId)
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'That scan is already undone.')
  const mov = db.prepare('SELECT id, direction FROM movements WHERE id = ?').get(id)
  if (!mov) throw new HttpError(404, 'That scan is already undone.')
  if (mov.direction !== 'out') throw new HttpError(400, 'A ticket number is only for a part taken out.')
  const clean = cleanText(typeof ticket === 'string' ? ticket : '', 40, 'Ticket number')
  db.prepare('UPDATE movements SET ticket = ? WHERE id = ?').run(clean, id)
  return { id, ticket: clean }
}

export function updateItem(itemId, { description, vendor, model }) {
  const id = Number(itemId)
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'That part is not in the list.')
  const item = db.prepare('SELECT id FROM items WHERE id = ?').get(id)
  if (!item) throw new HttpError(404, 'That part is not in the list.')
  const desc = cleanText(description, 200, 'Description')
  const vend = cleanText(vendor, 120, 'Vendor')
  const modelName = cleanText(model, 80, 'Model number')
  if (!desc) throw new HttpError(400, 'Enter what the part is.')
  if (!vend) throw new HttpError(400, 'Enter the vendor.')
  db.prepare('UPDATE items SET description = ?, model = ?, vendor = ? WHERE id = ?')
    .run(desc, modelName, vend, id)
  return db.prepare('SELECT id, barcode, description, model, vendor, unit FROM items WHERE id = ?').get(id)
}

function monthRange(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'Pick a month.')
  const [yearText, monthText] = month.split('-')
  const year = Number(yearText)
  const monthNumber = Number(monthText)
  if (monthNumber < 1 || monthNumber > 12) throw new HttpError(400, 'Pick a month.')
  const start = `${month}-01T00:00:00`
  const end = monthNumber === 12
    ? `${year + 1}-01-01T00:00:00`
    : `${year}-${String(monthNumber + 1).padStart(2, '0')}-01T00:00:00`
  return { start, end }
}

export function report({ siteId, month, sort }) {
  const { start, end } = monthRange(month)
  const site = siteId == null || siteId === '' ? null : mustSite(siteId)
  const mode = sortMode(site, sort)
  const params = [start, start, end, start, end, end]
  let siteClause = ''
  if (site) {
    siteClause = 'AND m.site_id = ?'
    params.push(site.id)
  }
  const rows = db.prepare(`
    SELECT
      s.name AS site,
      i.vendor AS vendor,
      i.model AS model,
      i.barcode AS barcode,
      i.description AS description,
      i.unit AS unit,
      SUM(CASE WHEN m.scanned_at < ? THEN CASE m.direction WHEN 'in' THEN m.qty ELSE -m.qty END ELSE 0 END) AS start_on_hand,
      SUM(CASE WHEN m.scanned_at >= ? AND m.scanned_at < ? AND m.direction = 'in' THEN m.qty ELSE 0 END) AS received,
      SUM(CASE WHEN m.scanned_at >= ? AND m.scanned_at < ? AND m.direction = 'out' THEN m.qty ELSE 0 END) AS used
    FROM movements m
    JOIN sites s ON s.id = m.site_id
    JOIN items i ON i.id = m.item_id
    WHERE m.scanned_at < ?
    ${siteClause}
    GROUP BY s.id, i.id
    ORDER BY s.name COLLATE NOCASE, i.vendor COLLATE NOCASE, i.description COLLATE NOCASE
  `).all(...params)
    .map((row) => {
      const startOnHand = Number(row.start_on_hand)
      const received = Number(row.received)
      const used = Number(row.used)
      return {
        site: row.site,
        vendor: row.vendor,
        model: row.model ?? '',
        barcode: row.barcode,
        description: row.description,
        unit: row.unit,
        startOnHand,
        received,
        used,
        endOnHand: startOnHand + received - used,
      }
    })
    .filter((row) => row.startOnHand !== 0 || row.received !== 0 || row.used !== 0)
    .sort(byInventoryOrder(mode))

  return {
    month,
    siteName: site ? site.name : 'All sites',
    sort: mode,
    rows,
  }
}

function csvText(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

function csvBarcode(value) {
  return `"=""${String(value ?? '').replaceAll('"', '""')}"""`
}

export function inventory({ siteId, sort }) {
  const site = siteId == null || siteId === '' ? null : mustSite(siteId)
  const mode = sortMode(site, sort)
  const params = []
  let siteClause = ''
  if (site) {
    siteClause = 'WHERE m.site_id = ?'
    params.push(site.id)
  }
  const rows = db.prepare(`
    SELECT
      s.name AS site,
      i.vendor AS vendor,
      i.model AS model,
      i.barcode AS barcode,
      i.description AS description,
      i.unit AS unit,
      SUM(CASE m.direction WHEN 'in' THEN m.qty ELSE -m.qty END) AS on_hand
    FROM movements m
    JOIN sites s ON s.id = m.site_id
    JOIN items i ON i.id = m.item_id
    ${siteClause}
    GROUP BY s.id, i.id
    ORDER BY s.name COLLATE NOCASE, i.vendor COLLATE NOCASE, i.description COLLATE NOCASE
  `).all(...params)
    .map((row) => ({
      site: row.site,
      vendor: row.vendor,
      model: row.model ?? '',
      barcode: row.barcode,
      description: row.description,
      unit: row.unit,
      onHand: Number(row.on_hand),
    }))
    .filter((row) => row.onHand !== 0)
    .sort(byInventoryOrder(mode))

  return {
    siteName: site ? site.name : 'All sites',
    sort: mode,
    rows,
  }
}

export function inventoryCsv(query) {
  const data = inventory(query)
  const header = ['Site', 'Vendor', 'Model', 'Barcode', 'Description', 'On hand']
  const lines = [
    header.map(csvText).join(','),
    ...data.rows.map((row) => [
      csvText(row.site),
      csvText(row.vendor),
      csvText(row.model),
      csvBarcode(row.barcode),
      csvText(row.description),
      row.onHand,
    ].join(',')),
  ]
  return { ...data, csv: `\uFEFF${lines.join('\r\n')}\r\n` }
}

export function reportCsv(query) {
  const data = report(query)
  const header = ['Site', 'Vendor', 'Model', 'Barcode', 'Description', 'Started with', 'Received', 'Used', 'On hand']
  const lines = [
    header.map(csvText).join(','),
    ...data.rows.map((row) => [
      csvText(row.site),
      csvText(row.vendor),
      csvText(row.model),
      csvBarcode(row.barcode),
      csvText(row.description),
      row.startOnHand,
      row.received,
      row.used,
      row.endOnHand,
    ].join(',')),
  ]
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

export function saveDataFiles() {
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
  const data = exportData()
  const json = `${JSON.stringify(data, null, 2)}\n`
  const sheet = workbookXml(data)
  const jsonTemp = `${jsonPath}.tmp`
  const sheetTemp = `${sheetPath}.tmp`
  fs.writeFileSync(jsonTemp, json)
  fs.writeFileSync(sheetTemp, sheet)
  fs.rmSync(jsonPath, { force: true })
  fs.rmSync(sheetPath, { force: true })
  fs.renameSync(jsonTemp, jsonPath)
  fs.renameSync(sheetTemp, sheetPath)
}

function readBackup(file) {
  if (!fs.existsSync(file)) return null
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(payload?.sites) || payload.sites.length === 0) return null
    return payload
  } catch (err) {
    console.error(`The data file was not loaded: ${file}`)
    console.error(err)
    return null
  }
}

function restoreDataFile() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM sites').get()
  if (Number(count.n) > 0) return
  const payload = readBackup(jsonPath) ?? readBackup(path.join(dataDir, DATA_JSON))
  if (!payload) return
  importData(payload)
  console.log(`Restored inventory from ${jsonPath}`)
}

restoreDataFile()
try {
  saveDataFiles()
} catch (err) {
  console.error('The Excel copy was not written.')
  console.error(err)
}
