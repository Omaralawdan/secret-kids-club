-- Authentication, shift controls, payment attribution, and automatic financial audit.
ALTER TABLE local_users ADD COLUMN username TEXT;
ALTER TABLE local_users ADD COLUMN password_salt TEXT;
ALTER TABLE local_users ADD COLUMN password_hash TEXT;
ALTER TABLE local_users ADD COLUMN created_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS local_users_username_unique ON local_users(username COLLATE NOCASE) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS local_session (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  actor_user_id TEXT,
  authenticated_at TEXT
);
INSERT OR IGNORE INTO local_session(singleton_id, actor_user_id, authenticated_at) VALUES (1, NULL, NULL);

CREATE TABLE IF NOT EXISTS local_cash_sessions (
  id TEXT PRIMARY KEY,
  opening_float_minor INTEGER NOT NULL CHECK(opening_float_minor >= 0),
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_by TEXT,
  closed_at TEXT,
  counted_cash_minor INTEGER,
  expected_cash_minor INTEGER,
  variance_minor INTEGER,
  sync_state TEXT NOT NULL DEFAULT 'pending' CHECK(sync_state IN ('pending','synced','failed'))
);

CREATE TRIGGER IF NOT EXISTS audit_visit_insert AFTER INSERT ON local_visits
BEGIN
  INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,after_json,created_at)
  VALUES (lower(hex(randomblob(16))),COALESCE((SELECT actor_user_id FROM local_session WHERE singleton_id=1),'system'),'check_in','visit',NEW.id,
    json_object('visit_number',NEW.visit_number_local,'guardian',NEW.guardian_name_snapshot,'phone',NEW.guardian_phone_snapshot,'amount_before_discount_minor',NEW.amount_before_discount_minor,'status',NEW.status),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS audit_visit_update AFTER UPDATE ON local_visits
WHEN OLD.status <> NEW.status OR OLD.final_amount_minor <> NEW.final_amount_minor OR OLD.discount_amount_minor <> NEW.discount_amount_minor OR OLD.checked_out_at IS NOT NEW.checked_out_at
BEGIN
  INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,before_json,after_json,created_at)
  VALUES (lower(hex(randomblob(16))),COALESCE((SELECT actor_user_id FROM local_session WHERE singleton_id=1),'system'),
    CASE WHEN OLD.status='active' AND NEW.status='completed' THEN 'check_out' ELSE 'financial_or_visit_update' END,'visit',NEW.id,
    json_object('status',OLD.status,'final_amount_minor',OLD.final_amount_minor,'discount_amount_minor',OLD.discount_amount_minor,'checked_out_at',OLD.checked_out_at),
    json_object('status',NEW.status,'final_amount_minor',NEW.final_amount_minor,'discount_amount_minor',NEW.discount_amount_minor,'checked_out_at',NEW.checked_out_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS audit_pricing_update AFTER UPDATE ON local_visit_child_pricing
WHEN OLD.base_amount_minor <> NEW.base_amount_minor OR OLD.discount_amount_minor <> NEW.discount_amount_minor OR OLD.overtime_amount_minor <> NEW.overtime_amount_minor OR OLD.final_amount_minor <> NEW.final_amount_minor OR OLD.calculation_json <> NEW.calculation_json
BEGIN
  INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,before_json,after_json,created_at)
  VALUES (lower(hex(randomblob(16))),COALESCE((SELECT actor_user_id FROM local_session WHERE singleton_id=1),'system'),'financial_change','visit_child_pricing',NEW.visit_child_id,
    json_object('base_amount_minor',OLD.base_amount_minor,'discount_amount_minor',OLD.discount_amount_minor,'overtime_amount_minor',OLD.overtime_amount_minor,'final_amount_minor',OLD.final_amount_minor),
    json_object('base_amount_minor',NEW.base_amount_minor,'discount_amount_minor',NEW.discount_amount_minor,'overtime_amount_minor',NEW.overtime_amount_minor,'final_amount_minor',NEW.final_amount_minor),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS audit_payment_insert AFTER INSERT ON local_payments
BEGIN
  INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,after_json,created_at)
  VALUES (lower(hex(randomblob(16))),COALESCE((SELECT actor_user_id FROM local_session WHERE singleton_id=1),'system'),'payment_recorded','payment',NEW.id,
    json_object('visit_id',NEW.visit_id,'method',NEW.method,'status',NEW.status,'amount_minor',NEW.amount_minor,'received_by',NEW.received_by),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS audit_cash_session_insert AFTER INSERT ON local_cash_sessions
BEGIN
  INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,after_json,created_at)
  VALUES (lower(hex(randomblob(16))),COALESCE((SELECT actor_user_id FROM local_session WHERE singleton_id=1),'system'),'shift_opened','cash_session',NEW.id,
    json_object('opening_float_minor',NEW.opening_float_minor,'opened_by',NEW.opened_by),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS audit_cash_session_update AFTER UPDATE ON local_cash_sessions
WHEN OLD.closed_at IS NOT NEW.closed_at OR OLD.counted_cash_minor IS NOT NEW.counted_cash_minor
BEGIN
  INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,before_json,after_json,created_at)
  VALUES (lower(hex(randomblob(16))),COALESCE((SELECT actor_user_id FROM local_session WHERE singleton_id=1),'system'),'shift_closed_or_reconciled','cash_session',NEW.id,
    json_object('closed_at',OLD.closed_at,'counted_cash_minor',OLD.counted_cash_minor,'expected_cash_minor',OLD.expected_cash_minor,'variance_minor',OLD.variance_minor),
    json_object('closed_at',NEW.closed_at,'counted_cash_minor',NEW.counted_cash_minor,'expected_cash_minor',NEW.expected_cash_minor,'variance_minor',NEW.variance_minor),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS require_login_for_visit_insert BEFORE INSERT ON local_visits
WHEN NOT EXISTS (SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id WHERE s.singleton_id=1 AND u.is_active=1 AND (u.role_codes_json LIKE '%admin%' OR u.role_codes_json LIKE '%manager%' OR u.role_codes_json LIKE '%cashier%'))
BEGIN SELECT RAISE(ABORT,'تسجيل الدخول بصلاحية كاشير أو مدير مطلوب لتسجيل الزيارة.'); END;
CREATE TRIGGER IF NOT EXISTS require_admin_for_pricing_insert BEFORE INSERT ON local_pricing_rules
WHEN NOT EXISTS (SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id WHERE s.singleton_id=1 AND u.is_active=1 AND u.role_codes_json LIKE '%admin%')
BEGIN SELECT RAISE(ABORT,'تعديل الأسعار متاح للمدير فقط.'); END;
CREATE TRIGGER IF NOT EXISTS require_admin_for_pricing_update BEFORE UPDATE ON local_pricing_rules
WHEN NOT EXISTS (SELECT 1 FROM local_session s JOIN local_users u ON u.id=s.actor_user_id WHERE s.singleton_id=1 AND u.is_active=1 AND u.role_codes_json LIKE '%admin%')
BEGIN SELECT RAISE(ABORT,'تعديل الأسعار متاح للمدير فقط.'); END;
CREATE TRIGGER IF NOT EXISTS audit_payment_update AFTER UPDATE ON local_payments
WHEN OLD.method<>NEW.method OR OLD.status<>NEW.status OR OLD.amount_minor<>NEW.amount_minor OR OLD.external_reference IS NOT NEW.external_reference
BEGIN
 INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,before_json,after_json,created_at)
 VALUES(lower(hex(randomblob(16))),COALESCE((SELECT actor_user_id FROM local_session WHERE singleton_id=1),'system'),'payment_changed','payment',NEW.id,
 json_object('method',OLD.method,'status',OLD.status,'amount_minor',OLD.amount_minor,'external_reference',OLD.external_reference),
 json_object('method',NEW.method,'status',NEW.status,'amount_minor',NEW.amount_minor,'external_reference',NEW.external_reference),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS audit_payment_delete AFTER DELETE ON local_payments
BEGIN
 INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,before_json,created_at)
 VALUES(lower(hex(randomblob(16))),COALESCE((SELECT actor_user_id FROM local_session WHERE singleton_id=1),'system'),'payment_deleted','payment',OLD.id,
 json_object('method',OLD.method,'status',OLD.status,'amount_minor',OLD.amount_minor,'received_by',OLD.received_by),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS audit_discount_insert AFTER INSERT ON local_visit_applied_discounts
BEGIN
 INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,after_json,created_at)
 VALUES(lower(hex(randomblob(16))),COALESCE((SELECT actor_user_id FROM local_session WHERE singleton_id=1),'system'),'discount_applied','discount',NEW.id,
 json_object('visit_id',NEW.visit_id,'discount_name',NEW.discount_name_snapshot,'amount_minor',NEW.amount_minor,'applied_by',NEW.applied_by),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
