CREATE TABLE IF NOT EXISTS local_coupons (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),
  discount_value INTEGER NOT NULL CHECK(discount_value > 0),
  max_discount_minor INTEGER,
  usage_limit INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count >= 0),
  starts_at TEXT,
  ends_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS local_coupons_active_idx ON local_coupons(is_active, code);
ALTER TABLE local_sales ADD COLUMN coupon_id TEXT REFERENCES local_coupons(id);
