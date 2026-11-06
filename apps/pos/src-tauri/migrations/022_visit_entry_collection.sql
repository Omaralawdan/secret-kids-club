-- Record the single, idempotent kids-area entry sale on the visit.
-- The amount is collected at check-in; checkout must never collect it again.
ALTER TABLE local_visits ADD COLUMN entry_sale_id TEXT REFERENCES local_sales(id);
CREATE UNIQUE INDEX IF NOT EXISTS local_visits_entry_sale_idx
  ON local_visits(entry_sale_id)
  WHERE entry_sale_id IS NOT NULL;
