-- Defense-in-depth write guards for the local POS database.
-- These guards complement Rust command authorization; they do not provide row-level read isolation.
CREATE TRIGGER IF NOT EXISTS require_operator_for_visit_update
BEFORE UPDATE ON local_visits
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%' OR u.role_codes_json LIKE '%cashier%')
)
BEGIN SELECT RAISE(ABORT,'تسجيل الدخول بصلاحية تشغيلية مطلوب لتعديل الزيارة.'); END;

CREATE TRIGGER IF NOT EXISTS require_operator_for_child_insert
BEFORE INSERT ON local_visit_children
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%' OR u.role_codes_json LIKE '%cashier%')
)
BEGIN SELECT RAISE(ABORT,'تسجيل الدخول بصلاحية تشغيلية مطلوب.'); END;

CREATE TRIGGER IF NOT EXISTS require_operator_for_child_update
BEFORE UPDATE ON local_visit_children
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%' OR u.role_codes_json LIKE '%cashier%')
)
BEGIN SELECT RAISE(ABORT,'تسجيل الدخول بصلاحية تشغيلية مطلوب.'); END;

CREATE TRIGGER IF NOT EXISTS require_operator_for_child_delete
BEFORE DELETE ON local_visit_children
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%' OR u.role_codes_json LIKE '%cashier%')
)
BEGIN SELECT RAISE(ABORT,'تسجيل الدخول بصلاحية تشغيلية مطلوب.'); END;

CREATE TRIGGER IF NOT EXISTS require_operator_for_child_pricing_insert
BEFORE INSERT ON local_visit_child_pricing
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%' OR u.role_codes_json LIKE '%cashier%')
)
BEGIN SELECT RAISE(ABORT,'تسجيل الدخول بصلاحية تشغيلية مطلوب لتسجيل الأسعار.'); END;

CREATE TRIGGER IF NOT EXISTS require_operator_for_child_pricing_update
BEFORE UPDATE ON local_visit_child_pricing
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%' OR u.role_codes_json LIKE '%cashier%')
)
BEGIN SELECT RAISE(ABORT,'تسجيل الدخول بصلاحية تشغيلية مطلوب لتعديل الأسعار.'); END;

CREATE TRIGGER IF NOT EXISTS require_operator_for_guardian_insert
BEFORE INSERT ON local_guardians
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%' OR u.role_codes_json LIKE '%cashier%')
)
BEGIN SELECT RAISE(ABORT,'تسجيل الدخول بصلاحية تشغيلية مطلوب لإدارة العملاء.'); END;

CREATE TRIGGER IF NOT EXISTS require_operator_for_guardian_update
BEFORE UPDATE ON local_guardians
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%' OR u.role_codes_json LIKE '%cashier%')
)
BEGIN SELECT RAISE(ABORT,'تسجيل الدخول بصلاحية تشغيلية مطلوب لإدارة العملاء.'); END;

CREATE TRIGGER IF NOT EXISTS require_operator_for_payment_insert
BEFORE INSERT ON local_payments
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%' OR u.role_codes_json LIKE '%cashier%')
)
BEGIN SELECT RAISE(ABORT,'تسجيل الدخول بصلاحية تشغيلية مطلوب لتسجيل المدفوعات.'); END;

CREATE TRIGGER IF NOT EXISTS require_manager_for_payment_update
BEFORE UPDATE ON local_payments
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%')
)
BEGIN SELECT RAISE(ABORT,'تعديل المدفوعات يتطلب صلاحية مدير.'); END;

CREATE TRIGGER IF NOT EXISTS require_admin_for_payment_delete
BEFORE DELETE ON local_payments
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1 AND u.role_codes_json LIKE '%admin%'
)
BEGIN SELECT RAISE(ABORT,'حذف المدفوعات يتطلب صلاحية المدير.'); END;

CREATE TRIGGER IF NOT EXISTS require_operator_for_shift_insert
BEFORE INSERT ON local_cash_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%' OR u.role_codes_json LIKE '%cashier%')
)
BEGIN SELECT RAISE(ABORT,'تسجيل الدخول بصلاحية تشغيلية مطلوب لفتح الوردية.'); END;

CREATE TRIGGER IF NOT EXISTS require_operator_for_shift_update
BEFORE UPDATE ON local_cash_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%' OR u.role_codes_json LIKE '%cashier%')
)
BEGIN SELECT RAISE(ABORT,'تسجيل الدخول بصلاحية تشغيلية مطلوب لتعديل الوردية.'); END;

CREATE TRIGGER IF NOT EXISTS require_admin_for_pricing_delete
BEFORE DELETE ON local_pricing_rules
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1 AND u.role_codes_json LIKE '%admin%'
)
BEGIN SELECT RAISE(ABORT,'حذف قواعد الأسعار متاح للمدير فقط.'); END;
