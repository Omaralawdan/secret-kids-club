-- Preserve manager overtime waivers and visit cancellation history.
ALTER TABLE local_visit_child_pricing
ADD COLUMN overtime_waived INTEGER NOT NULL DEFAULT 0 CHECK (overtime_waived IN (0,1));
ALTER TABLE local_visit_child_pricing ADD COLUMN overtime_waived_by TEXT;
ALTER TABLE local_visit_child_pricing ADD COLUMN overtime_waived_at TEXT;
ALTER TABLE local_visit_child_pricing ADD COLUMN overtime_waiver_reason TEXT;

ALTER TABLE local_visits ADD COLUMN cancelled_by TEXT;
ALTER TABLE local_visits ADD COLUMN cancelled_at TEXT;
ALTER TABLE local_visits ADD COLUMN cancellation_reason TEXT;
