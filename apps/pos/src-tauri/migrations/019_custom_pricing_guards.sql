-- Honor the app's per-employee pricing permission instead of role-only admin guards.
DROP TRIGGER IF EXISTS require_admin_for_pricing_insert;
DROP TRIGGER IF EXISTS require_admin_for_pricing_update;
DROP TRIGGER IF EXISTS require_admin_for_pricing_rule_delete;

CREATE TRIGGER require_pricing_permission_for_insert
BEFORE INSERT ON local_pricing_rules
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s
  JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (
      u.role_codes_json LIKE '%admin%'
      OR u.role_codes_json LIKE '%manager%'
      OR u.permissions_json LIKE '%"pricing"%'
      OR u.permissions_json LIKE '%"all"%'
    )
)
BEGIN SELECT RAISE(ABORT,'تعديل الأسعار يتطلب صلاحية إعداد الأسعار.'); END;

CREATE TRIGGER require_pricing_permission_for_update
BEFORE UPDATE ON local_pricing_rules
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s
  JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (
      u.role_codes_json LIKE '%admin%'
      OR u.role_codes_json LIKE '%manager%'
      OR u.permissions_json LIKE '%"pricing"%'
      OR u.permissions_json LIKE '%"all"%'
    )
)
BEGIN SELECT RAISE(ABORT,'تعديل الأسعار يتطلب صلاحية إعداد الأسعار.'); END;

CREATE TRIGGER require_pricing_permission_for_delete
BEFORE DELETE ON local_pricing_rules
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s
  JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (
      u.role_codes_json LIKE '%admin%'
      OR u.role_codes_json LIKE '%manager%'
      OR u.permissions_json LIKE '%"pricing"%'
      OR u.permissions_json LIKE '%"all"%'
    )
)
BEGIN SELECT RAISE(ABORT,'حذف قواعد الأسعار يتطلب صلاحية إعداد الأسعار.'); END;
