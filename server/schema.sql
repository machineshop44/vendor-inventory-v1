CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  barcode TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'each',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  qty INTEGER NOT NULL CHECK (qty > 0),
  scanned_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_movements_site_item ON movements (site_id, item_id);
CREATE INDEX IF NOT EXISTS idx_movements_scanned ON movements (scanned_at);
