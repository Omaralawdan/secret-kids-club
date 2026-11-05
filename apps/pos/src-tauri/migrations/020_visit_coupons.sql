-- Store the applied coupon snapshot on a kids-area visit and allow authorized discount edits.
ALTER TABLE local_visits ADD COLUMN coupon_id TEXT REFERENCES local_coupons(id);
ALTER TABLE local_visits ADD COLUMN coupon_code_snapshot TEXT;

DROP TRIGGER IF EXISTS guard_visit_pricing_changes;
CREATE TRIGGER guard_visit_pricing_changes
BEFORE UPDATE OF base_amount_minor,discount_amount_minor,overtime_amount_minor,final_amount_minor ON local_visit_child_pricing
WHEN NOT EXISTS (
 SELECT 1 FROM local_session s
 JOIN local_users u ON u.id=s.actor_user_id
 JOIN local_visit_children vc ON vc.id=NEW.visit_child_id
 JOIN local_visits v ON v.id=vc.visit_id
 WHERE s.singleton_id=1 AND u.is_active=1 AND (
   u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%' OR
   (u.role_codes_json LIKE '%cashier%' AND json_extract(NEW.calculation_json,'$.checkoutCalculatedAt') IS NOT NULL) OR
   (v.status='active' AND (u.permissions_json LIKE '%"discounts"%' OR u.permissions_json LIKE '%"pricing"%' OR u.permissions_json LIKE '%"all"%' OR (u.role_codes_json LIKE '%cashier%' AND u.permissions_json NOT LIKE '%"__custom__"%')))
 )
)
BEGIN SELECT RAISE(ABORT,'تعديل الأسعار والخصومات يتطلب الصلاحية المناسبة.'); END;

DROP TRIGGER IF EXISTS guard_visit_financial_update;
CREATE TRIGGER guard_visit_financial_update
BEFORE UPDATE OF final_amount_minor,discount_amount_minor ON local_visits
WHEN NOT EXISTS (
 SELECT 1 FROM local_session s
 JOIN local_users u ON u.id=s.actor_user_id
 WHERE s.singleton_id=1 AND u.is_active=1 AND (
   u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%' OR
   (u.role_codes_json LIKE '%cashier%' AND OLD.status='active' AND NEW.status='completed') OR
   (OLD.status='active' AND NEW.status='active' AND (u.permissions_json LIKE '%"discounts"%' OR u.permissions_json LIKE '%"pricing"%' OR u.permissions_json LIKE '%"all"%' OR (u.role_codes_json LIKE '%cashier%' AND u.permissions_json NOT LIKE '%"__custom__"%')))
 )
)
BEGIN SELECT RAISE(ABORT,'تعديل إجمالي الزيارة أو الخصم يتطلب الصلاحية المناسبة.'); END;
