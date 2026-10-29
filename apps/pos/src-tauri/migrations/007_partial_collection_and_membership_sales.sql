-- Permit partial actual collection (e.g. waived overtime) while keeping receivables separate,
-- and allow confirmed payments for completed membership-package sales.
DROP TRIGGER IF EXISTS guard_payment_insert;
CREATE TRIGGER guard_payment_insert
BEFORE INSERT ON local_payments
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%' OR u.role_codes_json LIKE '%cashier%')
    AND NEW.status='confirmed' AND NEW.amount_minor>0
    AND (
      (NEW.visit_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM local_visits v WHERE v.id=NEW.visit_id AND v.status='completed'
          AND NEW.amount_minor<=v.final_amount_minor
      ))
      OR
      (NEW.sale_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM local_sales s2 WHERE s2.id=NEW.sale_id AND s2.status='completed'
          AND NEW.amount_minor<=s2.total_minor
      ))
    )
)
BEGIN SELECT RAISE(ABORT,'لا يمكن تسجيل تحصيل إلا لمبلغ موجب على زيارة أو عملية بيع مكتملة.'); END;
