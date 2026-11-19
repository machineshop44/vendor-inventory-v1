import type { Report } from './types.ts'
import { APP_TITLE } from './version.ts'

function xmlText(value: string | number) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;',
    }[ch] ?? ch))
}

function cell(value: string | number, kind?: 'number') {
  if (kind === 'number' && Number.isFinite(Number(value))) {
    return `<Cell><Data ss:Type="Number">${Number(value)}</Data></Cell>`
  }
  return `<Cell><Data ss:Type="String">${xmlText(value)}</Data></Cell>`
}

function worksheet(name: string, headers: string[], rows: { value: string | number, kind?: 'number' }[][]) {
  const head = `<Row>${headers.map((header) => `<Cell ss:StyleID="Header"><Data ss:Type="String">${xmlText(header)}</Data></Cell>`).join('')}</Row>`
  const body = rows.map((row) => `<Row>${row.map((entry) => cell(entry.value, entry.kind)).join('')}</Row>`).join('')
  return `<Worksheet ss:Name="${xmlText(name)}"><Table>${head}${body}</Table></Worksheet>`
}

export function downloadReport(report: Report, kind: 'inventory' | 'month') {
  const rows = kind === 'inventory' ? report.rows.filter((row) => row.endOnHand !== 0) : report.rows
  const sheetRows = rows.map((row) => [
    { value: row.site },
    { value: row.vendor },
    { value: row.model },
    { value: row.barcode },
    { value: row.description },
    { value: row.startOnHand, kind: 'number' as const },
    { value: row.received, kind: 'number' as const },
    { value: row.used, kind: 'number' as const },
    { value: row.endOnHand, kind: 'number' as const },
  ])
  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="Header"><Font ss:Bold="1"/></Style></Styles>
${worksheet(kind === 'inventory' ? 'On hand' : 'Month', ['Site', 'Vendor', 'Model', 'Barcode', 'Description', 'Started with', 'Received', 'Used', 'On hand'], sheetRows)}
</Workbook>
`
  const slug = report.siteName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site'
  const filename = kind === 'inventory'
    ? `${APP_TITLE} on hand ${slug} ${report.month}.xls`
    : `${APP_TITLE} ${slug} ${report.month}.xls`
  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
