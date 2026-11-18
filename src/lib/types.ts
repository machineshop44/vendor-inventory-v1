export type Mode = 'in' | 'out'

export type Site = {
  id: number
  name: string
}

export type Item = {
  id: number
  barcode: string
  description: string
  model: string
  vendor: string
  unit: string
}

export type ShelfRow = {
  itemId: number
  barcode: string
  description: string
  model: string
  vendor: string
  unit: string
  onHand: number
}

export type ActivityRow = {
  id: number
  direction: Mode
  qty: number
  scannedAt: string
  barcode: string
  description: string
  vendor: string
  ticket: string
}

export type SiteView = {
  site: Site
  shelf: ShelfRow[]
  latest: ActivityRow[]
}

export type ScanResult = {
  movementId: number
  qty: number
  direction: Mode
  onHand: number
  siteId: number
  siteName: string
  item: Item
}

export type UndoResult = {
  onHand: number
  siteId: number
  siteName: string
  item: Item
}

export type ReportRow = {
  site: string
  vendor: string
  model: string
  barcode: string
  description: string
  unit: string
  startOnHand: number
  received: number
  used: number
  endOnHand: number
}

export type Report = {
  month: string
  siteName: string
  sort: 'vendor' | 'description'
  rows: ReportRow[]
}
