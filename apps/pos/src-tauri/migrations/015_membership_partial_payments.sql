-- Older installed databases may have created this table before purchased_at was part of its schema.
ALTER TABLE local_child_memberships ADD COLUMN purchased_at TEXT;
UPDATE local_child_memberships
SET purchased_at = COALESCE(purchased_at, starts_at)
WHERE purchased_at IS NULL;

ALTER TABLE local_child_memberships ADD COLUMN sale_id TEXT REFERENCES local_sales(id);
CREATE INDEX IF NOT EXISTS local_child_memberships_sale_idx ON local_child_memberships(sale_id);

-- Link memberships created by earlier builds to their original package sale where an exact receipt line exists.
UPDATE local_child_memberships
SET sale_id = (
  SELECT s.id
  FROM local_sales s
  JOIN local_sale_items si ON si.sale_id=s.id
  WHERE si.description_snapshot =
    'Membership package: ' ||
    (SELECT p.name FROM local_membership_plans p WHERE p.id=local_child_memberships.plan_id) ||
    ' - ' || local_child_memberships.child_name_snapshot
  ORDER BY ABS(julianday(s.created_at)-julianday(local_child_memberships.purchased_at))
  LIMIT 1
)
WHERE sale_id IS NULL;
