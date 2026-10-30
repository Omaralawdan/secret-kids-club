-- Explicitly attribute every payment to the cash session that received it.
ALTER TABLE local_payments ADD COLUMN cash_session_id TEXT REFERENCES local_cash_sessions(id);

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
