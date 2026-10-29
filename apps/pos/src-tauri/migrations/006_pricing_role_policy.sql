-- Correct the original admin-only pricing triggers to match the documented admin/manager policy.
-- Use quoted role tokens so substring matches cannot grant privileges.
DROP TRIGGER IF EXISTS require_admin_for_pricing_insert;
DROP TRIGGER IF EXISTS require_admin_for_pricing_update;
DROP TRIGGER IF EXISTS require_admin_for_pricing_delete;

CREATE TRIGGER require_manager_for_pricing_insert
BEFORE INSERT ON local_pricing_rules
WHEN NOT EXISTS (
  SELECT 1
  FROM local_session s
  JOIN local_users u ON u.id = s.actor_user_id
  WHERE s.singleton_id = 1
    AND u.is_active = 1
    AND (
      instr(u.role_codes_json, '"admin"') > 0
      OR instr(u.role_codes_json, '"manager"') > 0
    )
)
BEGIN
  SELECT RAISE(ABORT, 'إنشاء قواعد الأسعار يتطلب صلاحية المدير أو مدير الوردية.');
END;

CREATE TRIGGER require_manager_for_pricing_update
BEFORE UPDATE ON local_pricing_rules
WHEN NOT EXISTS (
  SELECT 1
  FROM local_session s
  JOIN local_users u ON u.id = s.actor_user_id
  WHERE s.singleton_id = 1
    AND u.is_active = 1
    AND (
      instr(u.role_codes_json, '"admin"') > 0
      OR instr(u.role_codes_json, '"manager"') > 0
    )
)
BEGIN
  SELECT RAISE(ABORT, 'تعديل قواعد الأسعار يتطلب صلاحية المدير أو مدير الوردية.');
END;

CREATE TRIGGER require_admin_for_pricing_delete
BEFORE DELETE ON local_pricing_rules
WHEN NOT EXISTS (
  SELECT 1
  FROM local_session s
  JOIN local_users u ON u.id = s.actor_user_id
  WHERE s.singleton_id = 1
    AND u.is_active = 1
    AND instr(u.role_codes_json, '"admin"') > 0
)
BEGIN
  SELECT RAISE(ABORT, 'حذف قواعد الأسعار متاح لمدير النظام فقط.');
END;
