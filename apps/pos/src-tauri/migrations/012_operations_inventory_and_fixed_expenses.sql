-- Operational extensions: café purchasing/counting, fixed expenses and cash drawer movements.
ALTER TABLE local_inventory_items ADD COLUMN barcode TEXT;
ALTER TABLE local_inventory_items ADD COLUMN purchase_price_minor INTEGER NOT NULL DEFAULT 0 CHECK(purchase_price_minor >= 0);
ALTER TABLE local_inventory_items ADD COLUMN minimum_stock_milli INTEGER NOT NULL DEFAULT 0 CHECK(minimum_stock_milli >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS local_inventory_barcode_unique ON local_inventory_items(barcode) WHERE barcode IS NOT NULL AND barcode <> '';

CREATE TABLE IF NOT EXISTS local_suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_stock_purchases (
  id TEXT PRIMARY KEY,
  supplier_id TEXT REFERENCES local_suppliers(id),
  document_number TEXT,
  total_cost_minor INTEGER NOT NULL CHECK(total_cost_minor >= 0),
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_stock_purchase_items (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES local_stock_purchases(id),
  inventory_item_id TEXT NOT NULL REFERENCES local_inventory_items(id),
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli > 0),
  unit_cost_minor INTEGER NOT NULL CHECK(unit_cost_minor >= 0),
  expiry_date TEXT
);
CREATE TABLE IF NOT EXISTS local_stock_counts (
  id TEXT PRIMARY KEY,
  inventory_item_id TEXT NOT NULL REFERENCES local_inventory_items(id),
  expected_quantity_milli INTEGER NOT NULL,
  counted_quantity_milli INTEGER NOT NULL CHECK(counted_quantity_milli >= 0),
  variance_quantity_milli INTEGER NOT NULL,
  reason TEXT,
  counted_by TEXT NOT NULL,
  counted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_monthly_expenses (
  id TEXT PRIMARY KEY,
  expense_name TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  expense_month TEXT NOT NULL,
  paid_at TEXT,
  payment_method TEXT NOT NULL CHECK(payment_method IN ('cash','instapay','wallet','visa','other')),
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(expense_name, expense_month)
);
CREATE INDEX IF NOT EXISTS local_monthly_expenses_month_idx ON local_monthly_expenses(expense_month);

CREATE TABLE IF NOT EXISTS local_cash_movements (
  id TEXT PRIMARY KEY,
  cash_session_id TEXT NOT NULL REFERENCES local_cash_sessions(id),
  movement_type TEXT NOT NULL CHECK(movement_type IN ('cash_added','cash_removed')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS local_cash_movements_shift_idx ON local_cash_movements(cash_session_id, created_at);

CREATE TABLE IF NOT EXISTS local_expiry_batches (
  id TEXT PRIMARY KEY,
  inventory_item_id TEXT NOT NULL REFERENCES local_inventory_items(id),
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli > 0),
  expiry_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS local_expiry_batches_date_idx ON local_expiry_batches(expiry_date, inventory_item_id);
