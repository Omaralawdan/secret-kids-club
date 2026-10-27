CREATE TABLE IF NOT EXISTS local_pricing_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pricing_type TEXT NOT NULL
    CHECK (pricing_type IN ('fixed','hourly','offer')),
  calculation_type TEXT NOT NULL
    CHECK (calculation_type IN ('fixed','percent','free_minutes')),
  amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  duration_minutes INTEGER,
  free_minutes INTEGER NOT NULL DEFAULT 0 CHECK (free_minutes >= 0),
  priority INTEGER NOT NULL DEFAULT 100,
  valid_from TEXT,
  valid_until TEXT,
  weekdays_json TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_discount_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  discount_type TEXT NOT NULL
    CHECK (discount_type IN ('fixed','percent')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  applies_to TEXT NOT NULL
    CHECK (applies_to IN ('child','group')),
  auto_apply INTEGER NOT NULL DEFAULT 1,
  can_combine INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,
  valid_from TEXT,
  valid_until TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_membership_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  included_minutes INTEGER NOT NULL CHECK (included_minutes > 0),
  validity_days INTEGER NOT NULL DEFAULT 30 CHECK (validity_days > 0),
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_child_memberships (
  id TEXT PRIMARY KEY,
  child_id TEXT REFERENCES local_children(id),
  child_name_snapshot TEXT NOT NULL,
  guardian_phone_snapshot TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES local_membership_plans(id),
  purchased_at TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  included_minutes INTEGER NOT NULL CHECK (included_minutes > 0),
  used_minutes INTEGER NOT NULL DEFAULT 0
    CHECK (used_minutes >= 0 AND used_minutes <= included_minutes),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','expired','used','cancelled')),
  sync_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (sync_state IN ('pending','synced','failed'))
);

CREATE INDEX IF NOT EXISTS local_child_memberships_lookup_idx
ON local_child_memberships(child_name_snapshot, guardian_phone_snapshot, status);

CREATE TABLE IF NOT EXISTS local_visit_child_pricing (
  id TEXT PRIMARY KEY,
  visit_child_id TEXT NOT NULL UNIQUE
    REFERENCES local_visit_children(id),
  pricing_type TEXT NOT NULL
    CHECK (pricing_type IN ('fixed','hourly','offer','membership')),
  pricing_rule_id TEXT REFERENCES local_pricing_rules(id),
  membership_id TEXT REFERENCES local_child_memberships(id),
  base_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (base_amount_minor >= 0),
  discount_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (discount_amount_minor >= 0),
  final_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (final_amount_minor >= 0),
  duration_minutes INTEGER NOT NULL DEFAULT 0
    CHECK (duration_minutes >= 0),
  included_minutes INTEGER NOT NULL DEFAULT 0
    CHECK (included_minutes >= 0),
  calculation_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_visit_applied_discounts (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL REFERENCES local_visits(id),
  discount_rule_id TEXT REFERENCES local_discount_rules(id),
  discount_name_snapshot TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  applied_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS local_pricing_rules_active_idx
ON local_pricing_rules(is_active, priority);

CREATE INDEX IF NOT EXISTS local_discount_rules_active_idx
ON local_discount_rules(is_active, priority);

CREATE INDEX IF NOT EXISTS local_visit_child_pricing_visit_idx
ON local_visit_child_pricing(visit_child_id);
