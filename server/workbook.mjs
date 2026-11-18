export const DATA_JSON = 'Vendor Inventory v1.json'
export const DATA_SHEET = 'Vendor Inventory v1.xls'

function xmlText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]))
}

function cell(value, kind) {
  if (kind === 'number' && Number.isFinite(Number(value))) {
    return `<Cell><Data ss:Type="Number">${Number(value)}</Data></Cell>`
  }
  return `<Cell><Data ss:Type="String">${xmlText(value)}</Data></Cell>`
}

function sheet(name, headers, rows) {
  const head = `<Row>${headers.map((header) => `<Cell ss:StyleID="Header"><Data ss:Type="String">${xmlText(header)}</Data></Cell>`).join('')}</Row>`
  const body = rows.map((row) => `<Row>${row.map((entry) => cell(entry.value, entry.kind)).join('')}</Row>`).join('')
  return `<Worksheet ss:Name="${xmlText(name)}"><Table>${head}${body}</Table></Worksheet>`
}

function byName(left, right) {
  return String(left).localeCompare(String(right), undefined, { sensitivity: 'base' })
}

export function workbookXml(data) {
  const sites = new Map((data.sites ?? []).map((site) => [site.id, site.name]))
  const items = new Map((data.items ?? []).map((item) => [item.id, item]))
  const onHand = new Map()

  for (const move of data.movements ?? []) {
    const key = `${move.siteId}:${move.itemId}`
    const qty = Number(move.qty) || 0
    const delta = move.direction === 'in' ? qty : -qty
    onHand.set(key, (onHand.get(key) ?? 0) + delta)
  }

  const shelf = []
  for (const [key, qty] of onHand) {
    if (qty === 0) continue
    const [siteId, itemId] = key.split(':').map(Number)
    const item = items.get(itemId)
    if (!item) continue
    shelf.push({
      site: sites.get(siteId) ?? '',
      vendor: item.vendor ?? '',
      model: item.model ?? '',
      barcode: item.barcode ?? '',
      description: item.description ?? '',
      onHand: qty,
    })
  }
  shelf.sort((a, b) => byName(a.vendor, b.vendor) || byName(a.site, b.site) || byName(a.description, b.description) || byName(a.barcode, b.barcode))

  const scans = (data.movements ?? []).map((move) => {
    const item = items.get(move.itemId) ?? {}
    return {
      when: move.scannedAt ?? '',
      site: sites.get(move.siteId) ?? '',
      direction: move.direction === 'out' ? 'Out' : 'In',
      vendor: item.vendor ?? '',
      model: item.model ?? '',
      barcode: item.barcode ?? '',
      description: item.description ?? '',
      qty: Number(move.qty) || 0,
      ticket: move.ticket ?? '',
    }
  }).sort((a, b) => byName(a.site, b.site) || byName(a.vendor, b.vendor) || byName(a.when, b.when) || byName(a.barcode, b.barcode))

  const itemRows = [...(data.items ?? [])].sort((a, b) => byName(a.vendor, b.vendor) || byName(a.description, b.description) || byName(a.barcode, b.barcode))
  const siteRows = [...(data.sites ?? [])].sort((a, b) => byName(a.name, b.name))

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="Header"><Font ss:Bold="1"/></Style></Styles>
${sheet('On hand', ['Site', 'Vendor', 'Model', 'Barcode', 'Description', 'On hand'], shelf.map((row) => [
    { value: row.site },
    { value: row.vendor },
    { value: row.model },
    { value: row.barcode },
    { value: row.description },
    { value: row.onHand, kind: 'number' },
  ]))}
${sheet('Scans', ['When', 'Site', 'Direction', 'Vendor', 'Model', 'Barcode', 'Description', 'Qty', 'Ticket'], scans.map((row) => [
    { value: row.when },
    { value: row.site },
    { value: row.direction },
    { value: row.vendor },
    { value: row.model },
    { value: row.barcode },
    { value: row.description },
    { value: row.qty, kind: 'number' },
    { value: row.ticket },
  ]))}
${sheet('Items', ['Barcode', 'Description', 'Model', 'Vendor'], itemRows.map((row) => [
    { value: row.barcode },
    { value: row.description },
    { value: row.model ?? '' },
    { value: row.vendor },
  ]))}
${sheet('Sites', ['Site'], siteRows.map((row) => [{ value: row.name }]))}
</Workbook>
`
}
