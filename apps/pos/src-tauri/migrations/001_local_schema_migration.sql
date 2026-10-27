-- SQLite local-first schema for the single Windows POS device.
-- Use foreign_keys=ON and WAL mode. Run each business operation and its outbox insert in one transaction.

CREATE TABLE IF NOT EXISTS local_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO local_meta(key,value) VALUES ('schema_version','1');
INSERT OR IGNORE INTO local_meta(key,value) VALUES ('device_id','');
INSERT OR IGNORE INTO local_meta(key,value) VALUES ('last_successful_sync_at','');

CREATE TABLE IF NOT EXISTS local_users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role_codes_json TEXT NOT NULL DEFAULT '[]',
  permissions_json TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  last_authenticated_at TEXT
);

CREATE TABLE IF NOT EXISTS local_guardians (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS local_guardians_phone_idx ON local_guardians(phone);

CREATE TABLE IF NOT EXISTS local_children (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  date_of_birth TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_visits (
  id TEXT PRIMARY KEY,
  visit_number_local INTEGER NOT NULL UNIQUE,
  guardian_id TEXT,
  guardian_name_snapshot TEXT NOT NULL,
  guardian_relation TEXT NOT NULL,
  guardian_phone_snapshot TEXT NOT NULL,
  child_count INTEGER NOT NULL CHECK(child_count > 0),
  checked_in_at TEXT NOT NULL,
  checked_out_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','completed','cancelled')),
  pricing_type TEXT NOT NULL CHECK(pricing_type IN ('fixed','hourly','offer','membership')),
  amount_before_discount_minor INTEGER NOT NULL DEFAULT 0 CHECK(amount_before_discount_minor >= 0),
  discount_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK(discount_amount_minor >= 0),
  final_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK(final_amount_minor >= 0),
  cashier_user_id TEXT NOT NULL,
  sync_state TEXT NOT NULL DEFAULT 'pending' CHECK(sync_state IN ('pending','synced','failed')),
  created_at TEXT NOT NULL,
  CHECK(checked_out_at IS NULL OR checked_out_at >= checked_in_at)
);
CREATE INDEX IF NOT EXISTS local_visits_status_idx ON local_visits(status, checked_in_at);

CREATE TABLE IF NOT EXISTS local_visit_children (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL REFERENCES local_visits(id),
  child_id TEXT,
  child_name_snapshot TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_inventory_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT,
  item_kind TEXT NOT NULL CHECK(item_kind IN ('ingredient','ready_product','packaging','other')),
  base_unit TEXT NOT NULL,
  sale_price_minor INTEGER CHECK(sale_price_minor IS NULL OR sale_price_minor >= 0),
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS local_recipes (
  id TEXT PRIMARY KEY,
  sellable_item_id TEXT NOT NULL UNIQUE REFERENCES local_inventory_items(id),
  name TEXT NOT NULL,
  yield_quantity_milli INTEGER NOT NULL DEFAULT 1000 CHECK(yield_quantity_milli > 0)
);
CREATE TABLE IF NOT EXISTS local_recipe_ingredients (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES local_recipes(id),
  inventory_item_id TEXT NOT NULL REFERENCES local_inventory_items(id),
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli > 0),
  UNIQUE(recipe_id, inventory_item_id)
);
CREATE TABLE IF NOT EXISTS local_stock_movements (
  id TEXT PRIMARY KEY,
  inventory_item_id TEXT NOT NULL REFERENCES local_inventory_items(id),
  movement_type TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli > 0),
  unit_cost_minor INTEGER,
  sale_id TEXT,
  reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sync_state TEXT NOT NULL DEFAULT 'pending' CHECK(sync_state IN ('pending','synced','failed'))
);
CREATE INDEX IF NOT EXISTS local_stock_item_date_idx ON local_stock_movements(inventory_item_id, created_at);

CREATE TABLE IF NOT EXISTS local_sales (
  id TEXT PRIMARY KEY,
  sale_number_local INTEGER NOT NULL UNIQUE,
  visit_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('completed','voided','partially_refunded','refunded')),
  subtotal_minor INTEGER NOT NULL CHECK(subtotal_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK(discount_minor >= 0),
  total_minor INTEGER NOT NULL CHECK(total_minor >= 0),
  cashier_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sync_state TEXT NOT NULL DEFAULT 'pending' CHECK(sync_state IN ('pending','synced','failed'))
);
CREATE TABLE IF NOT EXISTS local_sale_items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES local_sales(id),
  item_type TEXT NOT NULL CHECK(item_type IN ('cafe_product','play_entry','other')),
  inventory_item_id TEXT,
  description_snapshot TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli > 0),
  unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK(line_total_minor >= 0)
);
CREATE TABLE IF NOT EXISTS local_payments (
  id TEXT PRIMARY KEY,
  sale_id TEXT REFERENCES local_sales(id),
  visit_id TEXT REFERENCES local_visits(id),
  method TEXT NOT NULL CHECK(method IN ('cash','instapay','wallet')),
  status TEXT NOT NULL CHECK(status IN ('pending','confirmed','failed','refunded')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  external_reference TEXT,
  received_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sync_state TEXT NOT NULL DEFAULT 'pending' CHECK(sync_state IN ('pending','synced','failed'))
);
CREATE TABLE IF NOT EXISTS local_cash_sessions (
  id TEXT PRIMARY KEY,
  opening_float_minor INTEGER NOT NULL CHECK(opening_float_minor >= 0),
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_by TEXT,
  closed_at TEXT,
  counted_cash_minor INTEGER,
  expected_cash_minor INTEGER,
  variance_minor INTEGER,
  sync_state TEXT NOT NULL DEFAULT 'pending' CHECK(sync_state IN ('pending','synced','failed'))
);

-- Transactional outbox: one row per operation sent to the central sync endpoint.
CREATE TABLE IF NOT EXISTS sync_outbox (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','synced','failed')),
  acknowledged_at TEXT,
  UNIQUE(operation_type, entity_id)
);
CREATE INDEX IF NOT EXISTS sync_outbox_pending_idx ON sync_outbox(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS local_audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  reason TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
