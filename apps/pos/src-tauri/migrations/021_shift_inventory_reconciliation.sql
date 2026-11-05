-- Capture stock at shift opening and reconcile every active inventory item at shift close.
CREATE TABLE IF NOT EXISTS local_shift_inventory_opening (
  cash_session_id TEXT NOT NULL REFERENCES local_cash_sessions(id),
  inventory_item_id TEXT NOT NULL REFERENCES local_inventory_items(id),
  item_name_snapshot TEXT NOT NULL,
  opening_quantity_milli INTEGER NOT NULL CHECK(opening_quantity_milli >= 0),
  PRIMARY KEY(cash_session_id, inventory_item_id)
);

CREATE TABLE IF NOT EXISTS local_shift_inventory_counts (
  id TEXT PRIMARY KEY,
  cash_session_id TEXT NOT NULL REFERENCES local_cash_sessions(id),
  inventory_item_id TEXT NOT NULL REFERENCES local_inventory_items(id),
  item_name_snapshot TEXT NOT NULL,
  opening_quantity_milli INTEGER NOT NULL,
  sold_quantity_milli INTEGER NOT NULL DEFAULT 0,
  purchase_quantity_milli INTEGER NOT NULL DEFAULT 0,
  addition_quantity_milli INTEGER NOT NULL DEFAULT 0,
  waste_quantity_milli INTEGER NOT NULL DEFAULT 0,
  return_out_quantity_milli INTEGER NOT NULL DEFAULT 0,
  other_out_quantity_milli INTEGER NOT NULL DEFAULT 0,
  expected_quantity_milli INTEGER NOT NULL,
  counted_quantity_milli INTEGER NOT NULL CHECK(counted_quantity_milli >= 0),
  variance_quantity_milli INTEGER NOT NULL,
  reason TEXT,
  counted_by TEXT NOT NULL,
  counted_at TEXT NOT NULL,
  UNIQUE(cash_session_id, inventory_item_id)
);
CREATE INDEX IF NOT EXISTS local_shift_inventory_counts_shift_idx
  ON local_shift_inventory_counts(cash_session_id, counted_at);
