-- Extend existing customer profiles without deleting existing data.
ALTER TABLE local_guardians
ADD COLUMN updated_at TEXT;

ALTER TABLE local_children
ADD COLUMN guardian_id TEXT REFERENCES local_guardians(id);

ALTER TABLE local_children
ADD COLUMN updated_at TEXT;

-- Preserve each child's individual checkout details.
ALTER TABLE local_visit_children
ADD COLUMN checked_out_at TEXT;

ALTER TABLE local_visit_children
ADD COLUMN actual_duration_minutes INTEGER NOT NULL DEFAULT 0
CHECK (actual_duration_minutes >= 0);

-- Store overtime and membership usage separately from the base price.
ALTER TABLE local_visit_child_pricing
ADD COLUMN overtime_minutes INTEGER NOT NULL DEFAULT 0
CHECK (overtime_minutes >= 0);

ALTER TABLE local_visit_child_pricing
ADD COLUMN overtime_amount_minor INTEGER NOT NULL DEFAULT 0
CHECK (overtime_amount_minor >= 0);

ALTER TABLE local_visit_child_pricing
ADD COLUMN overtime_collected INTEGER NOT NULL DEFAULT 0
CHECK (overtime_collected IN (0, 1));

ALTER TABLE local_visit_child_pricing
ADD COLUMN overtime_collection_note TEXT;

ALTER TABLE local_visit_child_pricing
ADD COLUMN membership_minutes_used INTEGER NOT NULL DEFAULT 0
CHECK (membership_minutes_used >= 0);

-- One usage record per child visit prevents accidental duplicate deductions.
CREATE TABLE IF NOT EXISTS local_membership_usage (
  id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL
    REFERENCES local_child_memberships(id),
  visit_child_id TEXT NOT NULL UNIQUE
    REFERENCES local_visit_children(id),
  minutes_used INTEGER NOT NULL CHECK (minutes_used >= 0),
  created_at TEXT NOT NULL,
  reversed_at TEXT
);

CREATE INDEX IF NOT EXISTS local_children_guardian_idx
ON local_children(guardian_id);

CREATE INDEX IF NOT EXISTS local_memberships_phone_expiry_idx
ON local_child_memberships(guardian_phone_snapshot, expires_at, status);

CREATE INDEX IF NOT EXISTS local_membership_usage_membership_idx
ON local_membership_usage(membership_id, created_at);
