import { formatMonth } from './format.ts'
import type { Report } from './types.ts'

function esc(value: string | number) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch] ?? ch))
}

export function downloadPrint(report: Report, kind: 'inventory' | 'month') {
  const rows = kind === 'inventory' ? report.rows.filter((row) => row.endOnHand !== 0) : report.rows
  const heading = `${formatMonth(report.month)} · ${report.siteName}`
  const organized = report.sort === 'description' ? 'description' : 'vendor name'
  const note = `${heading} · ${rows.length} lines · Organized by ${organized}`
  const body = rows.map((row) => `<tr>
    <td>${esc(row.site)}</td>
    <td>${esc(row.vendor)}</td>
    <td>${esc(row.model)}</td>
    <td class="mono">${esc(row.barcode)}</td>
    <td>${esc(row.description)}</td>
    <td class="num">${row.startOnHand}</td>
    <td class="num">${row.received}</td>
    <td class="num">${row.used}</td>
    <td class="num">${row.endOnHand}</td>
  </tr>`).join('')
  const empty = rows.length === 0
    ? `<p class="empty">Nothing was on hand and nothing moved in ${esc(formatMonth(report.month))} at ${esc(report.siteName)}.</p>`
    : ''
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Vendor Inventory v1 · ${esc(heading)}</title>
  <style>
    body { margin: 24px; color: #1a1a1a; font-family: "Segoe UI", sans-serif; font-size: 16px; line-height: 1.4; }
    h1 { margin: 0 0 8px; font-size: 28px; font-weight: 650; letter-spacing: -0.03em; }
    h2 { margin: 0 0 8px; font-size: 22px; font-weight: 650; }
    .quiet, .empty { color: #5c6570; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px 8px; border-bottom: 1px solid #d5d8de; text-align: left; vertical-align: baseline; }
    th { font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: #5c6570; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; font-family: Consolas, "Cascadia Mono", monospace; }
    .mono { font-family: Consolas, "Cascadia Mono", monospace; }
  </style>
</head>
<body>
  <h1>Vendor Inventory v1</h1>
  <h2>${esc(heading)}</h2>
  ${empty || `<p class="quiet">${esc(note)}</p>`}
  ${rows.length === 0 ? '' : `<table>
    <thead>
      <tr>
        <th>Site</th><th>Vendor</th><th>Model</th><th>Barcode</th><th>Description</th>
        <th class="num">Started with</th><th class="num">Received</th><th class="num">Used</th><th class="num">On hand</th>
      </tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`}
</body>
</html>
`
  const slug = report.siteName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site'
  const filename = kind === 'inventory'
    ? `vendor-inventory-v1-on-hand-${slug}-${report.month}.html`
    : `vendor-inventory-v1-${slug}-${report.month}.html`
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
