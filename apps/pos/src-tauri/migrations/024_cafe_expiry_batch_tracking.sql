-- Link each sale stock movement to the exact expiry batches consumed by it.
-- This lets a valid, unserved cancellation restore the original batch quantities.
CREATE TABLE IF NOT EXISTS local_stock_movement_batches (
  id TEXT PRIMARY KEY,
  movement_id TEXT NOT NULL REFERENCES local_stock_movements(id),
  batch_id TEXT NOT NULL REFERENCES local_expiry_batches(id),
  quantity_milli INTEGER NOT NULL CHECK(quantity_milli > 0),
  UNIQUE(movement_id, batch_id)
);
CREATE INDEX IF NOT EXISTS local_stock_movement_batches_movement_idx
  ON local_stock_movement_batches(movement_id);
