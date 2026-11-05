-- Preserve the customer-facing payment method while keeping legacy SQLite CHECK constraints compatible.
ALTER TABLE local_payments ADD COLUMN method_label TEXT;
ALTER TABLE local_expenses ADD COLUMN method_label TEXT;
ALTER TABLE local_refunds ADD COLUMN method_label TEXT;
