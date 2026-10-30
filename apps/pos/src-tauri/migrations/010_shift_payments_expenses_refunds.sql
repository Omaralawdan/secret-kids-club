-- Explicitly attribute every payment to the cash session that received it.
ALTER TABLE local_payments ADD COLUMN cash_session_id TEXT REFERENCES local_cash_sessions(id);

-- Backfill historical payments to the session that was open when they were recorded.
UPDATE local_payments
SET cash_session_id = (
  SELECT s.id FROM local_cash_sessions s
  WHERE s.opened_at <= local_payments.created_at
    AND (s.closed_at IS NULL OR s.closed_at >= local_payments.created_at)
  ORDER BY s.opened_at DESC LIMIT 1
)
WHERE cash_session_id IS NULL;

CREATE INDEX IF NOT EXISTS local_payments_cash_session_idx
ON local_payments(cash_session_id, method, status, created_at);

CREATE TABLE IF NOT EXISTS local_expenses (
  id TEXT PRIMARY KEY,
  cash_session_id TEXT NOT NULL REFERENCES local_cash_sessions(id),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  category TEXT NOT NULL,
  reason TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('cash','instapay','wallet')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_refunds (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES local_payments(id),
  cash_session_id TEXT NOT NULL REFERENCES local_cash_sessions(id),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  reason TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('cash','instapay','wallet')),
  refunded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS local_refunds_cash_session_idx
ON local_refunds(cash_session_id, method, created_at);
