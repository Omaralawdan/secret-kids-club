-- Add an explicit overtime rate to each membership plan.
-- Existing plans receive zero so old records are not assigned an invented price.
ALTER TABLE local_membership_plans
ADD COLUMN overtime_rate_minor INTEGER NOT NULL DEFAULT 0
CHECK (overtime_rate_minor >= 0);
