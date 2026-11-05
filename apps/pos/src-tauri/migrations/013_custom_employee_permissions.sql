-- Allow managers to customize only the operational permissions of staff.
DROP TRIGGER IF EXISTS require_admin_for_user_privilege_update;
CREATE TRIGGER require_admin_for_user_identity_update
BEFORE UPDATE OF username,password_salt,password_hash,role_codes_json,is_active ON local_users
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1 AND instr(u.role_codes_json,'"admin"')>0
)
BEGIN SELECT RAISE(ABORT,'تعديل الحسابات والأدوار يتطلب مدير النظام.'); END;

CREATE TRIGGER require_manager_for_user_permissions_update
BEFORE UPDATE OF permissions_json ON local_users
WHEN NOT EXISTS (
  SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id
  WHERE s.singleton_id=1 AND u.is_active=1
    AND (instr(u.role_codes_json,'"admin"')>0 OR instr(u.role_codes_json,'"manager"')>0)
)
BEGIN SELECT RAISE(ABORT,'تخصيص صلاحيات الموظفين يتطلب المدير أو مدير الوردية.'); END;
