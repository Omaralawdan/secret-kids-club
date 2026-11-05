ALTER TABLE local_child_memberships ADD COLUMN sale_id TEXT REFERENCES local_sales(id);
CREATE INDEX IF NOT EXISTS local_child_memberships_sale_idx ON local_child_memberships(sale_id);
