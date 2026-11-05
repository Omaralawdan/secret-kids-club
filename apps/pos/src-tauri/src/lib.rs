use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use rand::RngCore;

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn Error>> {
    // Must match tauri-plugin-sql's app_config_dir() + database filename.
    let path = app
        .path()
        .app_config_dir()?
        .join("secret-kids-club.db");

    if path.is_file() {
        return Ok(path);
    }

    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!(
            "The existing SQLite database used by the SQL plugin was not found: {}",
            path.display()
        ),
    )
    .into())
}

fn checkout_transaction(path: &Path, visit_child_id: &str) -> Result<(), Box<dyn Error>> {
    checkout_transaction_with_overtime(path, visit_child_id, true, None, false, None, None)
}

fn checkout_transaction_with_overtime(
    path: &Path,
    visit_child_id: &str,
    overtime_collected: bool,
    overtime_collection_note: Option<String>,
    overtime_waived: bool,
    overtime_waiver_reason: Option<String>,
    actor_user_id: Option<String>,
) -> Result<(), Box<dyn Error>> {
    let mut connection = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let record = tx
        .query_row(
            r#"
            SELECT
                v.id,
                v.status,
                v.checked_in_at,
                p.pricing_type,
                p.duration_minutes,
                p.base_amount_minor,
                p.discount_amount_minor,
                p.calculation_json,
                p.pricing_rule_id,
                p.membership_id,
                p.included_minutes
            FROM local_visit_children vc
            JOIN local_visits v ON v.id = vc.visit_id
            JOIN local_visit_child_pricing p ON p.visit_child_id = vc.id
            WHERE vc.id = ?
              AND vc.checked_out_at IS NULL
            "#,
            params![visit_child_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, i64>(10)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "Child is not active or has already checked out.",
            )
        })?;

    let (
        visit_id,
        visit_status,
        checked_in_at,
        pricing_type,
        booked_minutes,
        base_amount,
        discount_amount,
        calculation_json,
        pricing_rule_id,
        membership_id,
        included_minutes,
    ) = record;

    if visit_status != "active" {
        return Err(io::Error::other("The visit is not active.").into());
    }

    let check_in = DateTime::parse_from_rfc3339(&checked_in_at)?;
    let checkout_time = Utc::now();
    let elapsed_seconds = checkout_time
        .timestamp()
        .checked_sub(check_in.timestamp())
        .ok_or_else(|| io::Error::other("Checkout time calculation overflowed."))?
        .max(0);
    let actual_minutes = elapsed_seconds
        .checked_add(59)
        .ok_or_else(|| io::Error::other("Checkout duration calculation overflowed."))?
        / 60;

    let mut calculation: Value = serde_json::from_str(&calculation_json)?;
    if !calculation.is_object() {
        return Err(io::Error::other(
            "The child's saved pricing calculation is invalid.",
        )
        .into());
    }

    // Older visits can lack the hourly rate in their saved calculation snapshot.
    // Recover it from the linked pricing rule without changing the original visit.
    let saved_hourly_rate = calculation
        .get("hourlyRateMinor")
        .and_then(Value::as_i64)
        .filter(|rate| *rate >= 0);
    let recovered_hourly_rate = if pricing_type == "hourly" && saved_hourly_rate.is_none() {
        pricing_rule_id.as_deref().and_then(|rule_id| {
            tx.query_row(
                "SELECT amount_minor FROM local_pricing_rules WHERE id = ? AND pricing_type = 'hourly'",
                params![rule_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .ok()
            .flatten()
            .filter(|rate| *rate >= 0)
        })
    } else {
        None
    };
    let membership_overtime_rate = if pricing_type == "membership" {
        if let Some(id) = membership_id.as_deref() {
            tx.query_row(
                "SELECT p.overtime_rate_minor FROM local_child_memberships m JOIN local_membership_plans p ON p.id=m.plan_id WHERE m.id=?",
                params![id],
                |row| row.get::<_, i64>(0),
            ).optional()?.filter(|rate| *rate > 0)
        } else { None }
    } else { None };
    let hourly_rate = saved_hourly_rate.or(recovered_hourly_rate).or(membership_overtime_rate);
    if let Some(rate) = hourly_rate {
        calculation["hourlyRateMinor"] = json!(rate);
    }

    let overtime_minutes = if booked_minutes > 0 {
        actual_minutes.checked_sub(booked_minutes)
            .ok_or_else(|| io::Error::other("Overtime calculation overflowed."))?.max(0)
    } else { 0 };
    if overtime_minutes > 0 && hourly_rate.is_none() {
        return Err(io::Error::other("Overtime checkout cancelled: a valid manual hourly rate is required.").into());
    }
    let overtime_amount = if overtime_minutes > 0 {
        let rate = hourly_rate.ok_or_else(|| io::Error::other("Overtime rate is unavailable. Checkout was cancelled."))?;
        rate.checked_mul(overtime_minutes)
            .and_then(|amount| amount.checked_add(30))
            .ok_or_else(|| io::Error::other("Overtime amount overflowed."))? / 60
    } else { 0 };

    let membership_minutes_used = if pricing_type == "membership" {
        let membership_id = membership_id.as_deref().ok_or_else(|| io::Error::other("اشتراك الطفل غير محدد."))?;
        let membership: Option<(i64,i64,String,String)> = tx.query_row(
            "SELECT included_minutes, used_minutes, status, expires_at FROM local_child_memberships WHERE id=?",
            params![membership_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))
        ).optional()?;
        let (total_minutes, used_minutes, status, expires_at) = membership.ok_or_else(|| io::Error::other("الاشتراك غير موجود."))?;
        if status == "cancelled" { return Err(io::Error::other("تم إلغاء الاشتراك.").into()); }
        // Expiry and exhausted status never block settlement of a visit already in progress.
        let expired = DateTime::parse_from_rfc3339(&expires_at).map(|d| d <= checkout_time).unwrap_or(true);
        let available = total_minutes.saturating_sub(used_minutes).max(0);
        let consumed = actual_minutes.min(available);
        let new_used = used_minutes.saturating_add(consumed);
        let next_status = if new_used >= total_minutes { "used" } else if expired { "expired" } else { "active" };
        tx.execute("UPDATE local_child_memberships SET used_minutes=?, status=? WHERE id=?",params![new_used,next_status,membership_id])?;
        tx.execute("INSERT INTO local_membership_usage(id,membership_id,visit_child_id,minutes_used,created_at) VALUES(?,?,?,?,?)",params![uuid::Uuid::new_v4().to_string(),membership_id,visit_child_id,consumed,checkout_time.to_rfc3339()])?;
        consumed
    } else { 0 };
    calculation["membershipMinutesUsed"] = json!(membership_minutes_used);
    calculation["membershipIncludedMinutesAtCheckout"] = json!(included_minutes);
    if let Some(rate) = hourly_rate { calculation["hourlyRateMinor"] = json!(rate); }

    let base_final_amount = base_amount
        .checked_sub(discount_amount)
        .ok_or_else(|| io::Error::other("Base price calculation overflowed."))?
        .max(0);
    let charged_overtime_amount = if overtime_waived { 0 } else { overtime_amount };
    let final_child_amount = base_final_amount
        .checked_add(charged_overtime_amount)
        .ok_or_else(|| io::Error::other("Final child price overflowed."))?;
    let checkout_time_string =
        checkout_time.to_rfc3339_opts(SecondsFormat::Millis, true);

    calculation["actualDurationMinutes"] = json!(actual_minutes);
    calculation["overtimeMinutes"] = json!(overtime_minutes);
    calculation["overtimeAmountMinor"] = json!(overtime_amount);
    calculation["overtimeWaived"] = json!(overtime_waived);
    calculation["overtimeWaiverReason"] = json!(overtime_waiver_reason.as_deref().unwrap_or(""));
    calculation["checkoutCalculatedAt"] = json!(checkout_time_string);

    let child_update = tx.execute(
        r#"
        UPDATE local_visit_children
        SET checked_out_at = ?, actual_duration_minutes = ?
        WHERE id = ? AND checked_out_at IS NULL
        "#,
        params![checkout_time_string, actual_minutes, visit_child_id],
    )?;

    if child_update != 1 {
        return Err(io::Error::other(
            "The child was already checked out. No changes were saved.",
        )
        .into());
    }

    let pricing_update = tx.execute(
        r#"
        UPDATE local_visit_child_pricing
        SET overtime_minutes = ?,
            overtime_amount_minor = ?,
            membership_minutes_used = ?,
            final_amount_minor = ?,
            overtime_collected = ?,
            overtime_collection_note = ?,
            overtime_waived = ?,
            overtime_waived_by = ?,
            overtime_waived_at = ?,
            overtime_waiver_reason = ?,
            calculation_json = ?
        WHERE visit_child_id = ?
        "#,
        params![
            overtime_minutes,
            overtime_amount,
            membership_minutes_used,
            final_child_amount,
            if overtime_amount == 0 || overtime_collected || overtime_waived { 1 } else { 0 },
            if overtime_amount > 0 && !overtime_collected && !overtime_waived { overtime_collection_note.as_deref().unwrap_or("").trim() } else { "" },
            if overtime_waived { 1 } else { 0 },
            if overtime_waived { actor_user_id.as_deref().unwrap_or("") } else { "" },
            if overtime_waived { checkout_time_string.as_str() } else { "" },
            if overtime_waived { overtime_waiver_reason.as_deref().unwrap_or("").trim() } else { "" },
            serde_json::to_string(&calculation)?,
            visit_child_id
        ],
    )?;

    if pricing_update != 1 {
        return Err(io::Error::other(
            "Could not save the child's final price. Checkout was cancelled.",
        )
        .into());
    }
    if overtime_waived {
        tx.execute(
            "INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,reason,before_json,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'overtime_waived','visit_child',?,?,?,?,?)",
            params![
                actor_user_id.as_deref().unwrap_or(""),
                visit_child_id,
                overtime_waiver_reason.as_deref().unwrap_or("").trim(),
                json!({"overtime_amount_minor":overtime_amount,"waived":false}).to_string(),
                json!({"overtime_amount_minor":overtime_amount,"waived":true}).to_string(),
                checkout_time_string
            ],
        )?;
    }

    let remaining: i64 = tx.query_row(
        r#"
        SELECT COUNT(*)
        FROM local_visit_children
        WHERE visit_id = ? AND checked_out_at IS NULL
        "#,
        params![visit_id],
        |row| row.get(0),
    )?;

    if remaining == 0 {
        let total: i64 = tx.query_row(
            r#"
            SELECT COALESCE(SUM(p.final_amount_minor), 0)
            FROM local_visit_child_pricing p
            JOIN local_visit_children vc ON vc.id = p.visit_child_id
            WHERE vc.visit_id = ?
            "#,
            params![visit_id],
            |row| row.get(0),
        )?;

        let visit_update = tx.execute(
            r#"
            UPDATE local_visits
            SET checked_out_at = ?,
                status = 'completed',
                final_amount_minor = ?
            WHERE id = ? AND status = 'active'
            "#,
            params![checkout_time_string, total, visit_id],
        )?;

        if visit_update != 1 {
            return Err(io::Error::other(
                "Could not complete the visit. Checkout was cancelled.",
            )
            .into());
        }
        let booking_id: Option<String> = tx.query_row(
            "SELECT booking_id FROM local_visits WHERE id=?",
            params![visit_id],
            |row| row.get(0),
        )?;
        if let Some(booking_id) = booking_id {
            tx.execute(
                "UPDATE local_bookings SET status='completed' WHERE id=? AND status IN ('booked','confirmed')",
                params![booking_id],
            )?;
        }

        let requested_method = calculation.get("paymentMethod").and_then(Value::as_str).unwrap_or("cash");
        let payment_method_label = if ["cash","instapay","wallet","visa","other"].contains(&requested_method) { requested_method } else { "cash" };
        let payment_method = if ["cash","instapay","wallet"].contains(&payment_method_label) { payment_method_label } else { "wallet" };
        let collected_total: i64 = tx.query_row(
            "SELECT COALESCE(SUM(MAX(0, p.final_amount_minor - CASE WHEN p.overtime_collected=0 THEN p.overtime_amount_minor ELSE 0 END)),0) FROM local_visit_child_pricing p JOIN local_visit_children vc ON vc.id=p.visit_child_id WHERE vc.visit_id=?",
            params![visit_id], |row| row.get(0)
        )?;
        if collected_total > 0 {
            let actor: String = tx.query_row("SELECT COALESCE(actor_user_id,'system') FROM local_session WHERE singleton_id=1", [], |row| row.get(0))?;
            let shift_id: String = tx.query_row(
                "SELECT id FROM local_cash_sessions WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",
                [], |row| row.get(0)
            ).optional()?.ok_or_else(|| io::Error::other("افتح وردية قبل تسجيل أي تحصيل."))?;
            tx.execute(
                "INSERT INTO local_payments(id,visit_id,method,method_label,status,amount_minor,received_by,created_at,cash_session_id) VALUES(lower(hex(randomblob(16))),? ,?,?, 'confirmed',?,?,?,?)",
                params![visit_id, payment_method, payment_method_label, collected_total, actor, checkout_time_string, shift_id],
            )?;
        }
    }

    // All child, pricing, and final-visit updates commit together.
    tx.commit()?;
    Ok(())
}

#[tauri::command]
fn checkout_child(
    app: tauri::AppHandle,
    visit_child_id: String,
    overtime_collected: bool,
    overtime_collection_note: Option<String>,
    overtime_waived: bool,
    overtime_waiver_reason: Option<String>,
) -> Result<(), String> {
    if visit_child_id.trim().is_empty() {
        return Err("Missing child visit ID.".to_string());
    }

    if !overtime_collected && overtime_collection_note.as_deref().unwrap_or("").trim().is_empty() && !overtime_waived { return Err("يجب تسجيل سبب عدم تحصيل الوقت الإضافي.".into()); }
    if overtime_waived && overtime_waiver_reason.as_deref().unwrap_or("").trim().is_empty() { return Err("يجب تسجيل سبب إعفاء الوقت الإضافي.".into()); }
    let db = auth_db(&app)?;
    let (actor, _) = if overtime_waived { require_permission(&db,"overtime_waive")?; require_role(&db, &["admin", "manager", "cashier"])? } else { require_role(&db, &["admin", "manager", "cashier"])? };
    drop(db);

    let path = database_path(&app).map_err(|error| error.to_string())?;
    checkout_transaction_with_overtime(&path, &visit_child_id, overtime_collected, overtime_collection_note, overtime_waived, overtime_waiver_reason, Some(actor)).map_err(|error| error.to_string())
}


fn auth_db(app: &tauri::AppHandle) -> Result<Connection, String> {
 let path=database_path(app).map_err(|e|e.to_string())?; Connection::open(path).map_err(|e|e.to_string())
}
fn hash_password(password:&str,salt:&[u8])->String { let mut out=[0u8;32]; pbkdf2_hmac::<Sha256>(password.as_bytes(),salt,600_000,&mut out); hex::encode(out) }
fn active_user(db: &Connection) -> Result<(String, Vec<String>), String> {
    let (id, roles_json): (String, String) = db
        .query_row(
            "SELECT u.id, u.role_codes_json FROM local_session s
             JOIN local_users u ON u.id = s.actor_user_id
             WHERE s.singleton_id = 1 AND u.is_active = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "لا يوجد مستخدم نشط مسجل الدخول.".to_string())?;

    let roles: Vec<String> = serde_json::from_str(&roles_json)
        .map_err(|_| "إعدادات صلاحيات المستخدم غير صالحة؛ تواصل مع المدير.".to_string())?;
    if roles.is_empty() || roles.iter().any(|role| !["admin", "manager", "cashier", "viewer"].contains(&role.as_str())) {
        return Err("إعدادات صلاحيات المستخدم غير صالحة؛ تواصل مع المدير.".to_string());
    }
    Ok((id, roles))
}
fn require_role(db:&Connection,allowed:&[&str])->Result<(String,Vec<String>),String>{let(id,roles)=active_user(db)?;if roles.iter().any(|r|allowed.contains(&r.as_str())){Ok((id,roles))}else{Err("ليس لديك صلاحية لتنفيذ هذه العملية.".into())}}
fn require_permission(db:&Connection,permission:&str)->Result<(String,Vec<String>),String>{
 let(id,roles)=active_user(db)?;
 if roles.iter().any(|r|r=="admin"){return Ok((id,roles))}
 let stored:String=db.query_row("SELECT permissions_json FROM local_users WHERE id=?",params![id],|r|r.get(0)).map_err(|e|e.to_string())?;
 let parsed:Vec<String>=serde_json::from_str(&stored).unwrap_or_default();
 let allowed=if parsed.iter().any(|p|p=="all"){true}else if parsed.iter().any(|p|p=="__custom__"){parsed.iter().any(|p|p==permission)}else if roles.iter().any(|r|r=="manager"){["reception","active","packages","cafe","reports","shift","pricing","bookings","overtime_waive","discounts"].contains(&permission)}else if roles.iter().any(|r|r=="cashier"){["reception","active","packages","cafe","shift","bookings","discounts"].contains(&permission)}else if roles.iter().any(|r|r=="viewer"){permission=="reports"}else{false};
 if allowed{Ok((id,roles))}else{Err("هذه الوظيفة غير مفعّلة في صلاحيات حسابك.".into())}
}
#[tauri::command]
fn auth_status(app:tauri::AppHandle)->Result<Value,String>{
 let db=auth_db(&app)?;
 let count:i64=db.query_row("SELECT COUNT(*) FROM local_users WHERE username IS NOT NULL AND password_hash IS NOT NULL",[],|r|r.get(0)).map_err(|e|e.to_string())?;
 // Read the current local session without mutating it. The previous implementation
 // silently logged the user out whenever the UI rechecked authentication status.
 let user:Option<(String,String,String,String)>=db.query_row(
  "SELECT u.id,u.display_name,u.role_codes_json,u.permissions_json FROM local_session s JOIN local_users u ON u.id=s.actor_user_id WHERE s.singleton_id=1 AND u.is_active=1",
  [],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))
 ).optional().map_err(|e|e.to_string())?;
 let user_json=user.map(|(id,name,roles,permissions)|json!({"id":id,"name":name,"roles":roles,"permissions":permissions}));
 Ok(json!({"needsSetup":count==0,"user":user_json}))
}
#[tauri::command]
fn setup_first_admin(app:tauri::AppHandle,username:String,display_name:String,password:String)->Result<Value,String>{
 if username.trim().len()<3||display_name.trim().is_empty()||password.chars().count()<12{return Err("اسم المستخدم 3 أحرف على الأقل وكلمة المرور 12 حرفًا على الأقل.".into())}
 let mut db=auth_db(&app)?;let tx=db.transaction().map_err(|e|e.to_string())?;let count:i64=tx.query_row("SELECT COUNT(*) FROM local_users WHERE username IS NOT NULL AND password_hash IS NOT NULL",[],|r|r.get(0)).map_err(|e|e.to_string())?;if count>0{return Err("تم إعداد المدير بالفعل.".into())}
 let mut salt=[0u8;16];rand::thread_rng().fill_bytes(&mut salt);let id=uuid::Uuid::new_v4().to_string();let now=Utc::now().to_rfc3339();
 tx.execute("INSERT INTO local_users(id,display_name,role_codes_json,permissions_json,is_active,last_authenticated_at,username,password_salt,password_hash,created_at) VALUES(?,?,'[\"admin\"]','[\"all\"]',1,?,?,?,?,?)",params![id,display_name.trim(),now,username.trim(),hex::encode(salt),hash_password(&password,&salt),now]).map_err(|e|e.to_string())?;
 tx.execute("UPDATE local_session SET actor_user_id=?,authenticated_at=? WHERE singleton_id=1",params![id,now]).map_err(|e|e.to_string())?;tx.commit().map_err(|e|e.to_string())?;Ok(json!({"id":id,"name":display_name.trim(),"roles":"[\"admin\"]","permissions":"[\"all\"]"}))
}
#[tauri::command]
fn login_user(app:tauri::AppHandle,username:String,password:String)->Result<Value,String>{
 let mut db=auth_db(&app)?;let row:Option<(String,String,String,String,i64)>=db.query_row("SELECT id,display_name,password_salt,password_hash,is_active FROM local_users WHERE username=? COLLATE NOCASE",params![username.trim()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(|e|e.to_string())?;
 let(id,name,salt,expected,active)=row.ok_or("اسم المستخدم أو كلمة المرور غير صحيحة.")?;let salt=hex::decode(salt).map_err(|e|e.to_string())?;if active!=1||hash_password(&password,&salt)!=expected{return Err("اسم المستخدم أو كلمة المرور غير صحيحة.".into())}
 let now=Utc::now().to_rfc3339();let tx=db.transaction().map_err(|e|e.to_string())?;tx.execute("UPDATE local_session SET actor_user_id=?,authenticated_at=? WHERE singleton_id=1",params![id,now]).map_err(|e|e.to_string())?;tx.execute("UPDATE local_users SET last_authenticated_at=? WHERE id=?",params![now,id]).map_err(|e|e.to_string())?;tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,created_at) VALUES(lower(hex(randomblob(16))),?,'login','user',?,?)",params![id,id,now]).map_err(|e|e.to_string())?;tx.commit().map_err(|e|e.to_string())?;
 let (roles,permissions):(String,String)=db.query_row("SELECT role_codes_json,permissions_json FROM local_users WHERE id=?",params![id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;Ok(json!({"id":id,"name":name,"roles":roles,"permissions":permissions}))
}
#[tauri::command]
fn logout_user(app:tauri::AppHandle)->Result<(),String>{let db=auth_db(&app)?;db.execute("UPDATE local_session SET actor_user_id=NULL,authenticated_at=NULL WHERE singleton_id=1",[]).map_err(|e|e.to_string())?;Ok(())}
#[tauri::command]
fn change_own_password(app:tauri::AppHandle,current_password:String,new_password:String)->Result<(),String>{
 if new_password.chars().count()<12{return Err("كلمة المرور الجديدة يجب أن تكون 12 حرفًا على الأقل.".into())}
 let mut db=auth_db(&app)?;let(id,_)=active_user(&db)?;let(salt,expected):(String,String)=db.query_row("SELECT password_salt,password_hash FROM local_users WHERE id=?",params![id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;let salt=hex::decode(salt).map_err(|e|e.to_string())?;if hash_password(&current_password,&salt)!=expected{return Err("كلمة المرور الحالية غير صحيحة.".into())}
 let mut new_salt=[0u8;16];rand::thread_rng().fill_bytes(&mut new_salt);let now=Utc::now().to_rfc3339();let tx=db.transaction().map_err(|e|e.to_string())?;tx.execute("UPDATE local_users SET password_salt=?,password_hash=? WHERE id=?",params![hex::encode(new_salt),hash_password(&new_password,&new_salt),id]).map_err(|e|e.to_string())?;tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,created_at) VALUES(lower(hex(randomblob(16))),?,'password_changed','user',?,?)",params![id,id,now]).map_err(|e|e.to_string())?;tx.commit().map_err(|e|e.to_string())?;Ok(())
}
#[tauri::command]
fn admin_list_users(app:tauri::AppHandle)->Result<Vec<Value>,String>{
 let db=auth_db(&app)?;require_role(&db,&["admin","manager"])?;let mut st=db.prepare("SELECT id,username,display_name,role_codes_json,permissions_json,is_active,created_at,last_authenticated_at FROM local_users ORDER BY display_name").map_err(|e|e.to_string())?;
 let rows=st.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"username":r.get::<_,Option<String>>(1)?,"name":r.get::<_,String>(2)?,"roles":r.get::<_,String>(3)?,"permissions":r.get::<_,String>(4)?,"active":r.get::<_,i64>(5)?,"createdAt":r.get::<_,Option<String>>(6)?,"lastLogin":r.get::<_,Option<String>>(7)?}))).map_err(|e|e.to_string())?;rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}
#[tauri::command]
fn admin_set_user_permissions(app:tauri::AppHandle,user_id:String,permissions:Vec<String>)->Result<(),String>{
 let allowed=["reception","active","packages","cafe","reports","shift","pricing","settings","bookings"];
 if permissions.iter().any(|p|!allowed.contains(&p.as_str())){return Err("تم إرسال صلاحية غير معروفة.".into())}
 let mut db=auth_db(&app)?;let(actor,_)=require_role(&db,&["admin","manager"])?;require_permission(&db,"cafe")?;let tx=db.transaction().map_err(|e|e.to_string())?;
 let before:String=tx.query_row("SELECT permissions_json FROM local_users WHERE id=?",params![user_id],|r|r.get(0)).map_err(|_|"الموظف غير موجود.".to_string())?;
 let mut saved=permissions.clone();saved.push("__custom__".to_string());tx.execute("UPDATE local_users SET permissions_json=? WHERE id=?",params![json!(saved).to_string(),user_id]).map_err(|e|e.to_string())?;
 tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,before_json,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'user_permissions_changed','user',?,?,?,?)",params![actor,user_id,before,json!(saved).to_string(),Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
 tx.commit().map_err(|e|e.to_string())?;Ok(())
}
#[tauri::command]
fn admin_create_user(app:tauri::AppHandle,username:String,display_name:String,password:String,role:String)->Result<(),String>{
 if username.trim().len()<3||display_name.trim().is_empty()||password.chars().count()<12{return Err("أدخل اسم مستخدم واسم موظف وكلمة مرور 12 حرفًا على الأقل.".into())}if !["admin","manager","cashier","viewer"].contains(&role.as_str()){return Err("الدور غير صالح.".into())}
 let mut db=auth_db(&app)?;let(actor,roles)=require_role(&db,&["admin","manager"])?;if roles.iter().any(|r|r=="manager")&&!roles.iter().any(|r|r=="admin")&&!["cashier","viewer"].contains(&role.as_str()){return Err("مدير الوردية يمكنه إنشاء كاشير أو مستخدم تقارير فقط.".into())}let mut salt=[0u8;16];rand::thread_rng().fill_bytes(&mut salt);let id=uuid::Uuid::new_v4().to_string();let now=Utc::now().to_rfc3339();let tx=db.transaction().map_err(|e|e.to_string())?;
 tx.execute("INSERT INTO local_users(id,username,display_name,password_salt,password_hash,role_codes_json,permissions_json,is_active,created_at) VALUES(?,?,?,?,?,?,?,1,?)",params![id,username.trim(),display_name.trim(),hex::encode(salt),hash_password(&password,&salt),json!([role]).to_string(),if role=="admin"{"[\"all\"]"}else{"[]"},now]).map_err(|e|e.to_string())?;
 tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'user_created','user',?,?,?)",params![actor,id,json!({"username":username,"name":display_name,"role":role}).to_string(),now]).map_err(|e|e.to_string())?;tx.commit().map_err(|e|e.to_string())?;Ok(())
}
#[tauri::command]
fn admin_set_user_active(app:tauri::AppHandle,user_id:String,is_active:bool)->Result<(),String>{
 let mut db=auth_db(&app)?;let(actor,_)=require_role(&db,&["admin"])?;let(current,_)=active_user(&db)?;if current==user_id&&!is_active{return Err("لا يمكنك إيقاف حسابك أثناء تسجيل الدخول.".into())}
 let now=Utc::now().to_rfc3339();let tx=db.transaction().map_err(|e|e.to_string())?;let before:i64=tx.query_row("SELECT is_active FROM local_users WHERE id=?",params![user_id],|r|r.get(0)).map_err(|e|e.to_string())?;tx.execute("UPDATE local_users SET is_active=? WHERE id=?",params![if is_active{1}else{0},user_id]).map_err(|e|e.to_string())?;tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,before_json,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'user_status_changed','user',?,?,?,?)",params![actor,user_id,json!({"is_active":before}).to_string(),json!({"is_active":is_active}).to_string(),now]).map_err(|e|e.to_string())?;tx.commit().map_err(|e|e.to_string())?;Ok(())
}
#[tauri::command]
fn admin_reset_user_password(app: tauri::AppHandle, user_id: String, new_password: String) -> Result<(), String> {
    if new_password.chars().count() < 12 { return Err("كلمة المرور يجب أن تكون 12 حرفًا على الأقل.".into()); }
    let mut db=auth_db(&app)?; require_permission(&db,"pricing")?; let (actor,_)=require_role(&db,&["admin","manager","cashier"])?;
    let mut salt=[0u8;16]; rand::thread_rng().fill_bytes(&mut salt);
    let tx=db.transaction().map_err(|e|e.to_string())?;
    let exists:i64=tx.query_row("SELECT COUNT(*) FROM local_users WHERE id=?",params![user_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if exists!=1 { return Err("حساب الموظف غير موجود.".into()); }
    tx.execute("UPDATE local_users SET password_salt=?,password_hash=? WHERE id=?",params![hex::encode(salt),hash_password(&new_password,&salt),user_id]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,created_at) VALUES(lower(hex(randomblob(16))),?,'admin_password_reset','user',?,?)",params![actor,user_id,Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?; Ok(())
}
#[tauri::command]
fn admin_update_user_role(app: tauri::AppHandle, user_id: String, role: String) -> Result<(), String> {
    if !["admin","manager","cashier","viewer"].contains(&role.as_str()) { return Err("الدور غير صالح.".into()); }
    let mut db=auth_db(&app)?; require_permission(&db,"pricing")?; let (actor,_)=require_role(&db,&["admin","manager","cashier"])?; let (current,_)=active_user(&db)?;
    if current==user_id && role!="admin" { return Err("لا يمكنك إزالة صلاحية مدير النظام من حسابك الحالي.".into()); }
    let tx=db.transaction().map_err(|e|e.to_string())?;
    let before:String=tx.query_row("SELECT role_codes_json FROM local_users WHERE id=?",params![user_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    tx.execute("UPDATE local_users SET role_codes_json=?,permissions_json=? WHERE id=?",params![json!([role]).to_string(),if role=="admin"{"[\"all\"]"}else{"[]"},user_id]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,before_json,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'user_role_changed','user',?,?,?,?)",params![actor,user_id,json!({"roles":before}).to_string(),json!({"role":role}).to_string(),Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?; Ok(())
}
#[tauri::command]
fn admin_delete_user(app: tauri::AppHandle, user_id: String) -> Result<(), String> {
    let mut db=auth_db(&app)?; require_permission(&db,"pricing")?; let (actor,_)=require_role(&db,&["admin","manager","cashier"])?; let (current,_)=active_user(&db)?;
    if current==user_id { return Err("لا يمكنك حذف الحساب الذي تستخدمه حاليًا.".into()); }
    let tx=db.transaction().map_err(|e|e.to_string())?;
    let active_shift:i64=tx.query_row("SELECT COUNT(*) FROM local_cash_sessions WHERE closed_at IS NULL AND opened_by=?",params![user_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if active_shift>0 { return Err("لا يمكن حذف مستخدم فتح وردية ما زالت مفتوحة؛ أغلق الوردية أولًا.".into()); }
    let before:String=tx.query_row("SELECT json_object('username',COALESCE(username,''),'name',display_name,'roles',role_codes_json) FROM local_users WHERE id=?",params![user_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,before_json,created_at) VALUES(lower(hex(randomblob(16))),?,'user_deleted','user',?,?,?)",params![actor,user_id,before,Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    tx.execute("DELETE FROM local_users WHERE id=?",params![user_id]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?; Ok(())
}
#[tauri::command]
fn delete_pricing_rule(app: tauri::AppHandle, rule_id: String) -> Result<(), String> {
    let mut db=auth_db(&app)?; let (actor,_)=require_role(&db,&["admin"])?;
    let tx=db.transaction().map_err(|e|e.to_string())?;
    let name:String=tx.query_row("SELECT name FROM local_pricing_rules WHERE id=?",params![rule_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    let used:i64=tx.query_row("SELECT COUNT(*) FROM local_visit_child_pricing WHERE pricing_rule_id=?",params![rule_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if used>0 {
      tx.execute("UPDATE local_pricing_rules SET is_active=0 WHERE id=?",params![rule_id]).map_err(|e|e.to_string())?;
    } else {
      tx.execute("DELETE FROM local_pricing_rules WHERE id=?",params![rule_id]).map_err(|e|e.to_string())?;
    }
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'pricing_rule_removed','pricing_rule',?,?,?)",params![actor,rule_id,json!({"name":name,"usedHistorically":used>0,"active":false}).to_string(),Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?; Ok(())
}

#[tauri::command]
fn create_pricing_rule(
    app: tauri::AppHandle,
    name: String,
    pricing_type: String,
    amount_minor: i64,
    duration_minutes: i64,
) -> Result<(), String> {
    let clean_name = name.trim();
    if clean_name.is_empty() || clean_name.chars().count() > 100 {
        return Err("اسم قاعدة السعر مطلوب ويجب ألا يتجاوز 100 حرف.".into());
    }
    if !["fixed", "hourly", "offer"].contains(&pricing_type.as_str()) {
        return Err("نوع التسعير غير صالح.".into());
    }
    if amount_minor < 0 {
        return Err("السعر لا يمكن أن يكون سالبًا.".into());
    }
    if duration_minutes < 25 || duration_minutes > 720 { return Err("مدة الحجز يجب أن تكون من 25 دقيقة إلى 12 ساعة.".into()); }

    let mut db = auth_db(&app)?;
    require_permission(&db,"pricing")?;
    let (actor, _) = require_role(&db, &["admin", "manager", "cashier"])?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO local_pricing_rules
         (id, name, pricing_type, calculation_type, amount_minor,
          duration_minutes, free_minutes, priority, weekdays_json,
          is_active, created_at)
         VALUES (?, ?, ?, 'fixed', ?, ?, 0, 100, '[]', 1, ?)",
        params![id, clean_name, pricing_type, amount_minor, duration_minutes, now],
    ).map_err(|e| e.to_string())?;
    // The database audit trigger records this insert exactly once.
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_active_cash_shift(app: tauri::AppHandle) -> Result<Value, String> {
    let db = auth_db(&app)?;
    require_permission(&db,"shift")?;
    require_role(&db, &["admin", "manager", "cashier"])?;
    let shift: Option<Value> = db.query_row(
        "SELECT s.id,s.opening_float_minor,s.opened_at,COALESCE(u.display_name,s.opened_by),
          COALESCE((SELECT SUM(p.amount_minor) FROM local_payments p WHERE p.cash_session_id=s.id AND COALESCE(p.method_label,p.method)='cash' AND p.status='confirmed'),0),
          COALESCE((SELECT SUM(p.amount_minor) FROM local_payments p WHERE p.cash_session_id=s.id AND p.method<>'cash' AND p.status='confirmed'),0),
          COALESCE((SELECT SUM(e.amount_minor) FROM local_expenses e WHERE e.cash_session_id=s.id AND e.method='cash'),0),
          COALESCE((SELECT SUM(r.amount_minor) FROM local_refunds r WHERE r.cash_session_id=s.id AND r.method='cash'),0),
          COALESCE((SELECT SUM(m.amount_minor) FROM local_cash_movements m WHERE m.cash_session_id=s.id AND m.movement_type='cash_added'),0),
          COALESCE((SELECT SUM(m.amount_minor) FROM local_cash_movements m WHERE m.cash_session_id=s.id AND m.movement_type='cash_removed'),0),
          COALESCE((SELECT SUM(p.amount_minor) FROM local_payments p WHERE p.cash_session_id=s.id AND p.visit_id IS NOT NULL AND p.method='cash' AND p.status='confirmed'),0),
          COALESCE((SELECT SUM(p.amount_minor) FROM local_payments p WHERE p.cash_session_id=s.id AND p.visit_id IS NOT NULL AND COALESCE(p.method_label,p.method)='instapay' AND p.status='confirmed'),0),
          COALESCE((SELECT SUM(p.amount_minor) FROM local_payments p WHERE p.cash_session_id=s.id AND p.visit_id IS NOT NULL AND COALESCE(p.method_label,p.method)='wallet' AND p.status='confirmed'),0),
          COALESCE((SELECT SUM(p.amount_minor) FROM local_payments p WHERE p.cash_session_id=s.id AND p.sale_id IS NOT NULL AND p.method='cash' AND p.status='confirmed'),0),
          COALESCE((SELECT SUM(p.amount_minor) FROM local_payments p WHERE p.cash_session_id=s.id AND p.sale_id IS NOT NULL AND p.method='instapay' AND p.status='confirmed'),0),
          COALESCE((SELECT SUM(p.amount_minor) FROM local_payments p WHERE p.cash_session_id=s.id AND p.sale_id IS NOT NULL AND COALESCE(p.method_label,p.method)='wallet' AND p.status='confirmed'),0),
          COALESCE((SELECT SUM(p.amount_minor) FROM local_payments p WHERE p.cash_session_id=s.id AND p.visit_id IS NOT NULL AND COALESCE(p.method_label,p.method)='visa' AND p.status='confirmed'),0),
          COALESCE((SELECT SUM(p.amount_minor) FROM local_payments p WHERE p.cash_session_id=s.id AND p.visit_id IS NOT NULL AND COALESCE(p.method_label,p.method)='other' AND p.status='confirmed'),0),
          COALESCE((SELECT SUM(p.amount_minor) FROM local_payments p WHERE p.cash_session_id=s.id AND p.sale_id IS NOT NULL AND COALESCE(p.method_label,p.method)='visa' AND p.status='confirmed'),0),
          COALESCE((SELECT SUM(p.amount_minor) FROM local_payments p WHERE p.cash_session_id=s.id AND p.sale_id IS NOT NULL AND COALESCE(p.method_label,p.method)='other' AND p.status='confirmed'),0)
         FROM local_cash_sessions s LEFT JOIN local_users u ON u.id=s.opened_by
         WHERE s.closed_at IS NULL ORDER BY s.opened_at DESC LIMIT 1",
        [], |row| {
            let opening:i64=row.get(1)?; let cash:i64=row.get(4)?; let electronic:i64=row.get(5)?;
            let expenses:i64=row.get(6)?; let refunds:i64=row.get(7)?; let additions:i64=row.get(8)?; let removals:i64=row.get(9)?; let kids_cash:i64=row.get(10)?; let kids_instapay:i64=row.get(11)?; let kids_wallet:i64=row.get(12)?; let cafe_cash:i64=row.get(13)?; let cafe_instapay:i64=row.get(14)?; let cafe_wallet:i64=row.get(15)?; let kids_visa:i64=row.get(16)?; let kids_other:i64=row.get(17)?; let cafe_visa:i64=row.get(18)?; let cafe_other:i64=row.get(19)?;
            Ok(json!({"id":row.get::<_,String>(0)?,"openingFloatMinor":opening,"openedAt":row.get::<_,String>(2)?,"openedBy":row.get::<_,String>(3)?,"cashSalesMinor":cash,"electronicSalesMinor":electronic,"cashExpensesMinor":expenses,"cashRefundsMinor":refunds,"cashAdditionsMinor":additions,"cashRemovalsMinor":removals,"kidsAreaCashMinor":kids_cash,"kidsAreaInstapayMinor":kids_instapay,"kidsAreaWalletMinor":kids_wallet,"cafeCashMinor":cafe_cash,"cafeInstapayMinor":cafe_instapay,"cafeWalletMinor":cafe_wallet,"kidsAreaVisaMinor":kids_visa,"kidsAreaOtherMinor":kids_other,"cafeVisaMinor":cafe_visa,"cafeOtherMinor":cafe_other,"expectedCashMinor":opening.saturating_add(cash).saturating_add(additions).saturating_sub(removals).saturating_sub(expenses).saturating_sub(refunds)}))
        }
    ).optional().map_err(|e| e.to_string())?;
    Ok(shift.unwrap_or(Value::Null))
}

#[tauri::command]
fn open_cash_shift(app:tauri::AppHandle,opening_float_minor:i64)->Result<Value,String>{
 if opening_float_minor<0{return Err("رصيد بداية الوردية غير صحيح.".into())}
 let mut db=auth_db(&app)?;
    require_permission(&db,"shift")?;
 let(actor,_)=require_role(&db,&["admin","manager","cashier"])?;
 let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
 let count:i64=tx.query_row("SELECT COUNT(*) FROM local_cash_sessions WHERE closed_at IS NULL",[],|r|r.get(0)).map_err(|e|e.to_string())?;
 if count>0{return Err("هناك وردية مفتوحة بالفعل.".into())}
 let id=uuid::Uuid::new_v4().to_string();let now=Utc::now().to_rfc3339();
 tx.execute("INSERT INTO local_cash_sessions(id,opening_float_minor,opened_by,opened_at) VALUES(?,?,?,?)",params![id,opening_float_minor,actor,now]).map_err(|e|e.to_string())?;
 tx.commit().map_err(|e|e.to_string())?;
 Ok(json!({"id":id,"openedAt":now}))
}
#[tauri::command]
fn close_cash_shift(app:tauri::AppHandle,counted_cash_minor:i64,variance_reason:String)->Result<Value,String>{
 if counted_cash_minor<0{return Err("النقدية المعدودة غير صحيحة.".into())}
 let mut db=auth_db(&app)?;
    require_permission(&db,"shift")?;
 let(actor,_)=require_role(&db,&["admin","manager","cashier"])?;
 let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
 let shift:Option<(String,i64,String)>=tx.query_row("SELECT id,opening_float_minor,opened_at FROM local_cash_sessions WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
 let(id,float,_opened)=shift.ok_or("لا توجد وردية مفتوحة.")?;
 let active_visits:i64=tx.query_row("SELECT COUNT(*) FROM local_visits WHERE status='active'",[],|r|r.get(0)).map_err(|e|e.to_string())?;
 if active_visits>0 { return Err("لا يمكن إغلاق الوردية وهناك أطفال لم يتم تسجيل خروجهم بعد.".into()); }
 let now=Utc::now().to_rfc3339();
 let sales:i64=tx.query_row("SELECT COALESCE(SUM(amount_minor),0) FROM local_payments WHERE cash_session_id=? AND method='cash' AND status='confirmed'",params![id],|r|r.get(0)).map_err(|e|e.to_string())?;
 let expenses:i64=tx.query_row("SELECT COALESCE(SUM(amount_minor),0) FROM local_expenses WHERE cash_session_id=? AND method='cash'",params![id],|r|r.get(0)).map_err(|e|e.to_string())?;
 let refunds:i64=tx.query_row("SELECT COALESCE(SUM(amount_minor),0) FROM local_refunds WHERE cash_session_id=? AND method='cash'",params![id],|r|r.get(0)).map_err(|e|e.to_string())?;
 let additions:i64=tx.query_row("SELECT COALESCE(SUM(amount_minor),0) FROM local_cash_movements WHERE cash_session_id=? AND movement_type='cash_added'",params![id],|r|r.get(0)).map_err(|e|e.to_string())?;
 let removals:i64=tx.query_row("SELECT COALESCE(SUM(amount_minor),0) FROM local_cash_movements WHERE cash_session_id=? AND movement_type='cash_removed'",params![id],|r|r.get(0)).map_err(|e|e.to_string())?;
 let expected=float.checked_add(sales).and_then(|v|v.checked_add(additions)).and_then(|v|v.checked_sub(removals)).and_then(|v|v.checked_sub(expenses)).and_then(|v|v.checked_sub(refunds)).ok_or("قيمة النقدية المتوقعة تجاوزت الحد المسموح.")?;
 let variance=counted_cash_minor.checked_sub(expected).ok_or("فرق النقدية تجاوز الحد المسموح.")?;
 if variance != 0 && variance_reason.trim().is_empty() { return Err("يجب تسجيل سبب العجز أو الزيادة قبل إغلاق الوردية.".into()); }
 let changed=tx.execute("UPDATE local_cash_sessions SET closed_by=?,closed_at=?,counted_cash_minor=?,expected_cash_minor=?,variance_minor=?,variance_reason=? WHERE id=? AND closed_at IS NULL",params![actor,now,counted_cash_minor,expected,variance,variance_reason.trim(),id]).map_err(|e|e.to_string())?;
 if changed!=1{return Err("تم إغلاق الوردية بالفعل أو تغيرت حالتها.".into())}
 tx.commit().map_err(|e|e.to_string())?;
 Ok(json!({"id":id,"expectedCashMinor":expected,"countedCashMinor":counted_cash_minor,"varianceMinor":variance,"closedAt":now}))
}
#[tauri::command]
fn admin_audit_log(app:tauri::AppHandle,limit:i64)->Result<Vec<Value>,String>{
 let db=auth_db(&app)?;require_role(&db,&["admin","manager"])?;let mut st=db.prepare("SELECT a.created_at,COALESCE(u.display_name,a.actor_user_id),a.action,a.entity_type,a.entity_id,a.reason,a.before_json,a.after_json FROM local_audit_log a LEFT JOIN local_users u ON u.id=a.actor_user_id ORDER BY a.created_at DESC LIMIT ?").map_err(|e|e.to_string())?;let rows=st.query_map(params![limit.clamp(1,5000)],|r|Ok(json!({"createdAt":r.get::<_,String>(0)?,"actor":r.get::<_,String>(1)?,"action":r.get::<_,String>(2)?,"entityType":r.get::<_,String>(3)?,"entityId":r.get::<_,Option<String>>(4)?,"reason":r.get::<_,Option<String>>(5)?,"before":r.get::<_,Option<String>>(6)?,"after":r.get::<_,Option<String>>(7)?}))).map_err(|e|e.to_string())?;rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}

#[tauri::command]
fn update_membership_overtime_rate(app: tauri::AppHandle, plan_id: String, overtime_rate_minor: i64) -> Result<(), String> {
    if plan_id.trim().is_empty() || overtime_rate_minor <= 0 { return Err("أدخل سعر ساعة إضافي صحيحًا.".into()); }
    let mut db = auth_db(&app)?;
    require_permission(&db,"pricing")?;
    let (actor, _) = require_role(&db, &["admin","manager","cashier"])?;
    let now = Utc::now().to_rfc3339();
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let previous: i64 = tx.query_row("SELECT overtime_rate_minor FROM local_membership_plans WHERE id=?",params![plan_id],|r|r.get(0)).map_err(|_| "الباقة غير موجودة.".to_string())?;
    tx.execute("UPDATE local_membership_plans SET overtime_rate_minor=? WHERE id=?",params![overtime_rate_minor,plan_id]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,reason,before_json,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'membership_overtime_rate_changed','membership_plan',?, 'تحديث سعر ساعة الإضافي',?,?,?)",params![actor,plan_id,json!({"overtime_rate_minor":previous}).to_string(),json!({"overtime_rate_minor":overtime_rate_minor}).to_string(),now]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_refundable_payments(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let db = auth_db(&app)?;
    require_role(&db, &["admin", "manager", "cashier"])?;
    let mut statement = db.prepare(
        "SELECT p.id,p.amount_minor,COALESCE(p.method_label,p.method),p.created_at,p.visit_id,p.sale_id,
          COALESCE(v.visit_number_local,0),COALESCE(s.sale_number_local,0),
          p.amount_minor-COALESCE((SELECT SUM(r.amount_minor) FROM local_refunds r WHERE r.payment_id=p.id),0)
         FROM local_payments p
         LEFT JOIN local_visits v ON v.id=p.visit_id
         LEFT JOIN local_sales s ON s.id=p.sale_id
         WHERE p.status='confirmed' AND p.amount_minor>COALESCE((SELECT SUM(r.amount_minor) FROM local_refunds r WHERE r.payment_id=p.id),0)
         ORDER BY p.created_at DESC LIMIT 200"
    ).map_err(|e| e.to_string())?;
    let rows = statement.query_map([], |row| Ok(json!({
        "id":row.get::<_,String>(0)?,"amountMinor":row.get::<_,i64>(1)?,"method":row.get::<_,String>(2)?,
        "createdAt":row.get::<_,String>(3)?,"visitId":row.get::<_,Option<String>>(4)?,"saleId":row.get::<_,Option<String>>(5)?,
        "visitNumber":row.get::<_,i64>(6)?,"saleNumber":row.get::<_,i64>(7)?,"refundableMinor":row.get::<_,i64>(8)?
    }))).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn record_expense(app: tauri::AppHandle, amount_minor: i64, category: String, reason: String, method: String) -> Result<(), String> {
    if amount_minor <= 0 || category.trim().is_empty() || reason.trim().is_empty() { return Err("أدخل مبلغًا صحيحًا وتصنيفًا وسببًا للمصروف.".into()); }
    if !["cash","instapay","wallet","visa","other"].contains(&method.as_str()) { return Err("طريقة الدفع غير صحيحة.".into()); }
    let stored_method=if ["visa","other"].contains(&method.as_str()){"wallet"}else{method.as_str()};
    let mut db = auth_db(&app)?;
    require_permission(&db,"shift")?;
    let (actor, _) = require_role(&db, &["admin","manager","cashier"])?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let shift_id: String = tx.query_row("SELECT id FROM local_cash_sessions WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?.ok_or("افتح وردية قبل تسجيل المصروف.")?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    tx.execute("INSERT INTO local_expenses(id,cash_session_id,amount_minor,category,reason,method,method_label,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",params![id,shift_id,amount_minor,category.trim(),reason.trim(),stored_method,method,actor,now]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,reason,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'expense_recorded','expense',?,?,?,?)",params![actor,id,reason.trim(),json!({"amount_minor":amount_minor,"category":category,"method":method,"cash_session_id":shift_id}).to_string(),now]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;
    Ok(())
}

#[tauri::command]
fn record_refund(app: tauri::AppHandle, payment_id: String, amount_minor: i64, reason: String, admin_password: String) -> Result<(), String> {
    if payment_id.trim().is_empty() || amount_minor <= 0 || reason.trim().is_empty() { return Err("اختر عملية أصلية وأدخل مبلغ الاسترداد وسببه.".into()); }
    let mut db = auth_db(&app)?;
    require_permission(&db,"shift")?;
    let (actor, _) = require_role(&db, &["admin","manager","cashier"])?;
    if admin_password.is_empty(){return Err("كلمة مرور المدير مطلوبة لاعتماد الاسترداد.".into())}
    let mut admins=db.prepare("SELECT password_salt,password_hash FROM local_users WHERE is_active=1 AND instr(role_codes_json,'admin')>0").map_err(|e|e.to_string())?;
    let admin_rows=admins.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?;
    let mut approved=false;
    for row in admin_rows { let (salt,hash)=row.map_err(|e|e.to_string())?; let salt=hex::decode(salt).map_err(|e|e.to_string())?; if hash_password(&admin_password,&salt)==hash { approved=true; break; } }
    if !approved{return Err("كلمة مرور المدير غير صحيحة.".into())}
    drop(admins);
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let original: Option<(i64,String,Option<String>,Option<String>)> = tx.query_row(
        "SELECT amount_minor,method,method_label,sale_id FROM local_payments WHERE id=? AND status='confirmed'",
        params![payment_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))
    ).optional().map_err(|e|e.to_string())?;
    let (original_amount,method,method_label,sale_id) = original.ok_or("عملية التحصيل الأصلية غير متاحة للاسترداد.")?;
    let refunded: i64 = tx.query_row("SELECT COALESCE(SUM(amount_minor),0) FROM local_refunds WHERE payment_id=?",params![payment_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    let new_total = refunded.checked_add(amount_minor).ok_or("مبلغ الاسترداد تجاوز الحد المسموح.")?;
    if new_total > original_amount { return Err("مبلغ الاسترداد أكبر من المبلغ المتبقي من العملية الأصلية.".into()); }
    let shift_id: String = tx.query_row("SELECT id FROM local_cash_sessions WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?.ok_or("افتح وردية قبل تسجيل الاسترداد.")?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    tx.execute("INSERT INTO local_refunds(id,payment_id,cash_session_id,amount_minor,reason,method,method_label,refunded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",params![id,payment_id,shift_id,amount_minor,reason.trim(),method,method_label,actor,now]).map_err(|e|e.to_string())?;
    if let Some(sale_id) = sale_id {
        let paid_total:i64 = tx.query_row("SELECT COALESCE(SUM(amount_minor),0) FROM local_payments WHERE sale_id=? AND status IN ('confirmed','refunded')",params![sale_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        let refunded_total:i64 = tx.query_row("SELECT COALESCE(SUM(r.amount_minor),0) FROM local_refunds r JOIN local_payments p ON p.id=r.payment_id WHERE p.sale_id=?",params![sale_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        let sale_status = if refunded_total >= paid_total && paid_total > 0 { "refunded" } else if refunded_total > 0 { "partially_refunded" } else { "completed" };
        tx.execute("UPDATE local_sales SET status=? WHERE id=?",params![sale_status,sale_id]).map_err(|e|e.to_string())?;
    }
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,reason,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'refund_recorded','refund',?,?,?,?)",params![actor,id,reason.trim(),json!({"payment_id":payment_id,"amount_minor":amount_minor,"method":method,"cash_session_id":shift_id}).to_string(),now]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;
    Ok(())
}

#[tauri::command]
fn cancel_visit(app: tauri::AppHandle, visit_id: String, reason: String) -> Result<(), String> {
    if visit_id.trim().is_empty() { return Err("رقم الزيارة غير صالح.".into()); }
    if reason.trim().is_empty() { return Err("يجب تسجيل سبب إلغاء الزيارة.".into()); }
    let mut db = auth_db(&app)?;
    let (actor, _) = require_role(&db, &["admin", "manager", "cashier"])?;
    let now = Utc::now().to_rfc3339();
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let status: String = tx.query_row(
        "SELECT status FROM local_visits WHERE id=?",
        params![visit_id],
        |row| row.get(0),
    ).map_err(|_| "الزيارة غير موجودة.".to_string())?;
    if status == "cancelled" { return Err("الزيارة ملغاة بالفعل.".into()); }
    tx.execute(
        "UPDATE local_visits SET status='cancelled', cancelled_by=?, cancelled_at=?, cancellation_reason=? WHERE id=? AND status IN ('active','completed')",
        params![actor, now, reason.trim(), visit_id],
    ).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,reason,before_json,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'visit_cancelled','visit',?,?,?, ?,?)",
        params![actor, visit_id, reason.trim(), json!({"status":status}).to_string(), json!({"status":"cancelled","reason":reason.trim()}).to_string(), now],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}


#[tauri::command]
fn record_cash_movement(app: tauri::AppHandle, movement_type: String, amount_minor: i64, source: String, reason: String) -> Result<(), String> {
    if !["cash_added","cash_removed"].contains(&movement_type.as_str()) || amount_minor <= 0 || source.trim().is_empty() || reason.trim().is_empty() {
        return Err("أدخل نوع الحركة والمبلغ والمصدر والسبب بشكل صحيح.".into());
    }
    let mut db=auth_db(&app)?;
    require_permission(&db,"shift")?;
    let (actor,_)=require_role(&db,&["admin","manager"])?;
    let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let shift_id:String=tx.query_row("SELECT id FROM local_cash_sessions WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?.ok_or("لا توجد وردية مفتوحة.")?;
    let id=uuid::Uuid::new_v4().to_string();
    let now=Utc::now().to_rfc3339();
    tx.execute("INSERT INTO local_cash_movements(id,cash_session_id,movement_type,amount_minor,source,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",params![id,shift_id,movement_type,amount_minor,source.trim(),reason.trim(),actor,now]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,reason,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'cash_movement_recorded','cash_movement',?,?,?,?)",params![actor,id,reason.trim(),json!({"movement_type":movement_type,"amount_minor":amount_minor,"source":source,"cash_session_id":shift_id}).to_string(),now]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;
    Ok(())
}

#[tauri::command]
fn cancel_membership(app:tauri::AppHandle,membership_id:String,reason:String)->Result<(),String>{
    if membership_id.trim().is_empty()||reason.trim().is_empty(){return Err("سبب إلغاء الباقة مطلوب.".into())}
    let mut db=auth_db(&app)?;
    require_permission(&db,"packages")?;
    let(actor,_)=require_role(&db,&["admin","manager"])?;
    let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let status:String=tx.query_row("SELECT status FROM local_child_memberships WHERE id=?",params![membership_id],|r|r.get(0)).map_err(|_|"الاشتراك غير موجود.".to_string())?;
    if status=="cancelled"{return Err("هذا الاشتراك ملغي بالفعل.".into())}
    tx.execute("UPDATE local_child_memberships SET status='cancelled' WHERE id=?",params![membership_id]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,reason,created_at) VALUES(lower(hex(randomblob(16))),?,'membership_cancelled','membership',?,?,?)",params![actor,membership_id,reason.trim(),Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;Ok(())
}

#[tauri::command]
fn apply_visit_coupon(app: tauri::AppHandle, visit_id: String, coupon_code: String) -> Result<Value, String> {
    if visit_id.trim().is_empty() || coupon_code.trim().is_empty() { return Err("أدخل كود الخصم.".into()); }
    let mut db=auth_db(&app)?;
    require_permission(&db,"discounts")?;
    let (actor,_)=require_role(&db,&["admin","manager","cashier"])?;
    let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let (status,already_applied):(String,Option<String>)=tx.query_row(
        "SELECT status,coupon_id FROM local_visits WHERE id=?",
        params![visit_id],|r|Ok((r.get(0)?,r.get(1)?))
    ).optional().map_err(|e|e.to_string())?.ok_or("الزيارة غير موجودة.")?;
    if status!="active" { return Err("لا يمكن تطبيق كوبون على زيارة غير نشطة.".into()); }
    if already_applied.is_some() { return Err("تم تطبيق كوبون على هذه الزيارة بالفعل.".into()); }
    let code=coupon_code.trim().to_ascii_uppercase();
    let now=Utc::now().to_rfc3339();
    let coupon:Option<(String,String,i64,Option<i64>,Option<i64>,i64,Option<String>,Option<String>,i64)>=tx.query_row(
        "SELECT id,discount_type,discount_value,max_discount_minor,usage_limit,used_count,starts_at,ends_at,is_active FROM local_coupons WHERE code=? COLLATE NOCASE",
        params![code],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?))
    ).optional().map_err(|e|e.to_string())?;
    let (coupon_id,kind,value,cap,limit,used,start,end,active)=coupon.ok_or("كود الخصم غير موجود.")?;
    if active!=1 || limit.map(|n|used>=n).unwrap_or(false) { return Err("الكوبون غير نشط أو استنفد عدد مرات استخدامه.".into()); }
    if start.as_deref().map(|v|now.as_str()<v).unwrap_or(false)||end.as_deref().map(|v|now.as_str()>v).unwrap_or(false) { return Err("الكوبون خارج فترة الصلاحية.".into()); }
    let children={
        let mut st=tx.prepare("SELECT p.visit_child_id,p.base_amount_minor FROM local_visit_child_pricing p JOIN local_visit_children vc ON vc.id=p.visit_child_id WHERE vc.visit_id=? ORDER BY vc.rowid").map_err(|e|e.to_string())?;
        let rows=st.query_map(params![visit_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).map_err(|e|e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?
    };
    if children.is_empty() { return Err("لا توجد بيانات أسعار للأطفال في هذه الزيارة.".into()); }
    let subtotal=children.iter().try_fold(0i64,|sum,(_,base)|sum.checked_add(*base)).ok_or("إجمالي الزيارة أكبر من الحد المسموح.")?;
    if subtotal<=0 { return Err("لا يمكن تطبيق كوبون على زيارة قيمتها صفر.".into()); }
    let mut discount=if kind=="percent" { subtotal.checked_mul(value).ok_or("قيمة الخصم كبيرة جدًا.")?/10000 } else if kind=="fixed" { value.min(subtotal) } else { return Err("نوع الخصم غير صالح.".into()); };
    if let Some(maximum)=cap { discount=discount.min(maximum); }
    let mut allocations:Vec<i64>=Vec::with_capacity(children.len());
    for (_,base) in children.iter() { allocations.push(discount.checked_mul(*base).ok_or("قيمة توزيع الخصم كبيرة جدًا.")?/subtotal); }
    let assigned=allocations.iter().try_fold(0i64,|sum,v|sum.checked_add(*v)).ok_or("حساب الخصم تجاوز الحد المسموح.")?;
    let mut remaining=discount.saturating_sub(assigned);
    for (index,(_,base)) in children.iter().enumerate() {
        if remaining<=0 { break; }
        let capacity=base.saturating_sub(allocations[index]);
        let add=capacity.min(remaining);
        allocations[index]+=add;
        remaining-=add;
    }
    if remaining!=0 { return Err("تعذر توزيع قيمة الخصم على الأطفال بدقة.".into()); }
    for ((child_id,base),allocated) in children.iter().zip(allocations.iter()) {
        let final_amount=base.checked_sub(*allocated).ok_or("قيمة خصم الطفل غير صحيحة.")?;
        let calc_json:String=tx.query_row("SELECT calculation_json FROM local_visit_child_pricing WHERE visit_child_id=?",params![child_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        let mut calc:Value=serde_json::from_str(&calc_json).map_err(|e|e.to_string())?;
        if !calc.is_object() { return Err("بيانات التسعير المحفوظة غير صالحة.".into()); }
        calc["couponId"]=json!(coupon_id);
        calc["couponCode"]=json!(code);
        calc["couponDiscountMinor"]=json!(allocated);
        tx.execute(
            "UPDATE local_visit_child_pricing SET discount_amount_minor=?,final_amount_minor=?,calculation_json=? WHERE visit_child_id=?",
            params![allocated,final_amount,serde_json::to_string(&calc).map_err(|e|e.to_string())?,child_id]
        ).map_err(|e|e.to_string())?;
    }
    let final_total=subtotal.checked_sub(discount).ok_or("صافي الزيارة غير صحيح.")?;
    tx.execute(
        "UPDATE local_visits SET discount_amount_minor=?,final_amount_minor=?,coupon_id=?,coupon_code_snapshot=? WHERE id=? AND status='active'",
        params![discount,final_total,coupon_id,code,visit_id]
    ).map_err(|e|e.to_string())?;
    tx.execute("UPDATE local_coupons SET used_count=used_count+1 WHERE id=?",params![coupon_id]).map_err(|e|e.to_string())?;
    tx.execute(
        "INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,reason,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'visit_coupon_applied','visit',?,?,?,?)",
        params![actor,visit_id,code,json!({"coupon_id":coupon_id,"subtotal_minor":subtotal,"discount_minor":discount,"total_minor":final_total,"allocations":children.iter().zip(allocations.iter()).map(|((id,_),amount)|json!({"visit_child_id":id,"discount_minor":amount})).collect::<Vec<_>>() }).to_string(),now]
    ).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;
    Ok(json!({"couponId":coupon_id,"couponCode":code,"subtotalMinor":subtotal,"discountMinor":discount,"totalMinor":final_total,"allocations":children.iter().zip(allocations.iter()).map(|((id,_),amount)|json!({"visitChildId":id,"discountMinor":amount})).collect::<Vec<_>>()}))
}

#[tauri::command]
fn create_membership_sale(
    app: tauri::AppHandle,
    plan_id: String,
    child_name: String,
    guardian_phone: String,
    amount_paid_minor: Option<i64>,
    method: String,
    note: String,
    coupon_code: Option<String>,
) -> Result<Value, String> {
    if plan_id.trim().is_empty() || child_name.trim().is_empty() || guardian_phone.trim().is_empty()
        || !["cash","instapay","wallet","visa","other"].contains(&method.as_str())
        || amount_paid_minor.map(|v|v<=0).unwrap_or(false) {
        return Err("راجع بيانات الطفل والباقة ومبلغ التحصيل وطريقة الدفع.".into());
    }
    let mut db=auth_db(&app)?;
    require_permission(&db,"packages")?;
    require_permission(&db,"shift")?;
    if coupon_code.as_deref().map(|v|!v.trim().is_empty()).unwrap_or(false) {  require_permission(&db,"discounts")?; }
    let (actor,_)=require_role(&db,&["admin","manager","cashier"])?;
    let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let (plan_name,plan_price,included_minutes,validity_days):(String,i64,i64,i64)=tx.query_row(
        "SELECT name,price_minor,included_minutes,validity_days FROM local_membership_plans WHERE id=? AND is_active=1",
        params![plan_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))
    ).optional().map_err(|e|e.to_string())?.ok_or("الباقة غير موجودة أو غير نشطة.")?;
    if plan_price<=0 { return Err("سعر الباقة يجب أن يكون أكبر من صفر.".into()); }
    let shift_id:String=tx.query_row("SELECT id FROM local_cash_sessions WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?.ok_or("افتح الوردية قبل تسجيل بيع الباقة.")?;
    let now=Utc::now().to_rfc3339();
    let mut coupon_id:Option<String>=None;
    let mut discount_minor=0i64;
    let normalized_coupon=coupon_code.as_deref().map(str::trim).filter(|v|!v.is_empty()).map(|v|v.to_ascii_uppercase());
    if let Some(code)=normalized_coupon.as_deref() {
        let coupon:Option<(String,String,i64,Option<i64>,Option<i64>,i64,Option<String>,Option<String>,i64)>=tx.query_row(
            "SELECT id,discount_type,discount_value,max_discount_minor,usage_limit,used_count,starts_at,ends_at,is_active FROM local_coupons WHERE code=? COLLATE NOCASE",
            params![code],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?))
        ).optional().map_err(|e|e.to_string())?;
        let (id,kind,value,cap,limit,used,start,end,active)=coupon.ok_or("كود الخصم غير موجود.")?;
        if active!=1 || limit.map(|n|used>=n).unwrap_or(false) { return Err("الكوبون غير نشط أو استنفد عدد مرات استخدامه.".into()); }
        if start.as_deref().map(|v|now.as_str()<v).unwrap_or(false)||end.as_deref().map(|v|now.as_str()>v).unwrap_or(false) { return Err("الكوبون خارج فترة الصلاحية.".into()); }
        discount_minor=if kind=="percent" { plan_price.checked_mul(value).ok_or("قيمة الخصم كبيرة جدًا.")?/10000 } else if kind=="fixed" { value.min(plan_price) } else { return Err("نوع الخصم غير صالح.".into()); };
        if let Some(maximum)=cap { discount_minor=discount_minor.min(maximum); }
        coupon_id=Some(id);
    }
    let total_minor=plan_price.checked_sub(discount_minor).ok_or("حساب الخصم غير صحيح.")?;
    let paid=amount_paid_minor.unwrap_or(total_minor);
    if paid<=0 || paid>total_minor { return Err(format!("المدفوع يجب أن يكون أكبر من صفر ولا يتجاوز صافي الباقة: {} جنيه.",total_minor as f64/100.0)); }
    let sale_id=uuid::Uuid::new_v4().to_string();
    let sale_number:i64=tx.query_row("SELECT COALESCE(MAX(sale_number_local),0)+1 FROM local_sales",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    tx.execute(
        "INSERT INTO local_sales(id,sale_number_local,visit_id,status,subtotal_minor,discount_minor,total_minor,cashier_user_id,created_at,sync_state,coupon_id) VALUES(?,?,NULL,'completed',?,?,?,?,?,'pending',?)",
        params![sale_id,sale_number,plan_price,discount_minor,total_minor,actor,now,coupon_id]
    ).map_err(|e|e.to_string())?;
    tx.execute(
        "INSERT INTO local_sale_items(id,sale_id,item_type,inventory_item_id,description_snapshot,quantity_milli,unit_price_minor,line_total_minor) VALUES(?,?,'other',NULL,?,1000,?,?)",
        params![uuid::Uuid::new_v4().to_string(),sale_id,format!("Membership package: {} - {}",plan_name,child_name.trim()),plan_price,plan_price]
    ).map_err(|e|e.to_string())?;
    let membership_id=uuid::Uuid::new_v4().to_string();
    let purchased=Utc::now();
    let expires=(purchased+chrono::Duration::days(validity_days)).to_rfc3339();
    let purchased_at=purchased.to_rfc3339();
    tx.execute(
        "INSERT INTO local_child_memberships(id,child_id,child_name_snapshot,guardian_phone_snapshot,plan_id,purchased_at,starts_at,expires_at,included_minutes,used_minutes,status,sync_state,sale_id) VALUES(?,NULL,?,?,?,?,?,?,?,0,'active','pending',?)",
        params![membership_id,child_name.trim(),guardian_phone.trim(),plan_id,purchased_at,purchased_at,expires,included_minutes,sale_id]
    ).map_err(|e|e.to_string())?;
    let stored_method=if ["visa","other"].contains(&method.as_str()){"wallet"}else{method.as_str()};
    tx.execute(
        "INSERT INTO local_payments(id,sale_id,visit_id,method,method_label,status,amount_minor,external_reference,received_by,created_at,sync_state,cash_session_id) VALUES(?,?,NULL,?,?,'confirmed',?,?,?,?, 'pending',?)",
        params![uuid::Uuid::new_v4().to_string(),sale_id,stored_method,method,paid,note.trim(),actor,purchased_at,shift_id]
    ).map_err(|e|e.to_string())?;
    if let Some(id)=coupon_id.as_deref(){tx.execute("UPDATE local_coupons SET used_count=used_count+1 WHERE id=?",params![id]).map_err(|e|e.to_string())?;}
    tx.execute(
        "INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,reason,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'membership_sale_created','membership',?,?,?,?)",
        params![actor,membership_id,note.trim(),json!({"sale_id":sale_id,"sale_number":sale_number,"plan_id":plan_id,"subtotal_minor":plan_price,"discount_minor":discount_minor,"coupon_code":normalized_coupon,"total_minor":total_minor,"paid_minor":paid,"remaining_minor":total_minor-paid,"method":method,"cash_session_id":shift_id}).to_string(),now]
    ).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;
    Ok(json!({"membershipId":membership_id,"saleId":sale_id,"saleNumber":sale_number,"subtotalMinor":plan_price,"discountMinor":discount_minor,"totalMinor":total_minor,"paidMinor":paid,"remainingMinor":total_minor-paid,"couponCode":normalized_coupon}))
}

#[tauri::command]
fn record_membership_payment(app:tauri::AppHandle,membership_id:String,amount_minor:i64,method:String,note:String)->Result<Value,String>{
    if membership_id.trim().is_empty()||amount_minor<=0||!["cash","instapay","wallet","visa","other"].contains(&method.as_str()){return Err("راجع الباقة والمبلغ وطريقة الدفع.".into())}
    let mut db=auth_db(&app)?;
    require_permission(&db,"packages")?;
    require_permission(&db,"shift")?;
    let(actor,_)=require_role(&db,&["admin","manager","cashier"])?;
    let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let (sale_id,sale_total,status):(Option<String>,i64,String)=tx.query_row("SELECT m.sale_id,COALESCE(s.total_minor,p.price_minor),m.status FROM local_child_memberships m JOIN local_membership_plans p ON p.id=m.plan_id LEFT JOIN local_sales s ON s.id=m.sale_id WHERE m.id=?",params![membership_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"الاشتراك غير موجود.".to_string())?;
    let sale_id=sale_id.ok_or("هذا الاشتراك غير مرتبط بفاتورة تحصيل.")?;
    if status=="cancelled"{return Err("لا يمكن التحصيل على اشتراك ملغي.".into())}
    let paid:i64=tx.query_row("SELECT COALESCE(SUM(amount_minor),0) FROM local_payments WHERE sale_id=? AND status='confirmed'",params![sale_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    let remaining=sale_total.saturating_sub(paid);
    if amount_minor>remaining{return Err(format!("المبلغ أكبر من المتبقي على الباقة: {} جنيه.",remaining as f64/100.0))}
    let shift_id:String=tx.query_row("SELECT id FROM local_cash_sessions WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?.ok_or("افتح وردية قبل تسجيل دفعة الباقة.")?;
    let stored_method=if ["visa","other"].contains(&method.as_str()){"wallet"}else{method.as_str()};
    let now=Utc::now().to_rfc3339();
    tx.execute("INSERT INTO local_payments(id,sale_id,visit_id,method,method_label,status,amount_minor,external_reference,received_by,created_at,cash_session_id) VALUES(?,?,NULL,?,?,'confirmed',?,?,?,?,?)",params![uuid::Uuid::new_v4().to_string(),sale_id,stored_method,method,amount_minor,note.trim(),actor,now,shift_id]).map_err(|e|e.to_string())?;
    let new_paid=paid.saturating_add(amount_minor);let new_remaining=sale_total.saturating_sub(new_paid);
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,reason,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'membership_payment_recorded','membership',?,?,?,?)",params![actor,membership_id,note.trim(),json!({"sale_id":sale_id,"amount_minor":amount_minor,"method":method,"paid_minor":new_paid,"remaining_minor":new_remaining,"cash_session_id":shift_id}).to_string(),now]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;
    Ok(json!({"paidMinor":new_paid,"remainingMinor":new_remaining}))
}

#[tauri::command]
fn list_monthly_expenses(app: tauri::AppHandle, expense_month: String) -> Result<Vec<Value>,String> {
    if expense_month.len()!=7 || !expense_month.chars().nth(4).map(|c|c=='-').unwrap_or(false) { return Err("الشهر يجب أن يكون بصيغة YYYY-MM.".into()); }
    let db=auth_db(&app)?;
    require_permission(&db,"shift")?;
    require_role(&db,&["admin","manager"])?;
    let mut st=db.prepare("SELECT id,expense_name,amount_minor,expense_month,paid_at,payment_method,notes,created_by,created_at FROM local_monthly_expenses WHERE expense_month=? ORDER BY expense_name").map_err(|e|e.to_string())?;
    let rows=st.query_map(params![expense_month],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"amountMinor":r.get::<_,i64>(2)?,"month":r.get::<_,String>(3)?,"paidAt":r.get::<_,Option<String>>(4)?,"paymentMethod":r.get::<_,String>(5)?,"notes":r.get::<_,Option<String>>(6)?,"createdBy":r.get::<_,String>(7)?,"createdAt":r.get::<_,String>(8)?}))).map_err(|e|e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}

#[tauri::command]
fn save_monthly_expense(app: tauri::AppHandle, expense_name: String, amount_minor: i64, expense_month: String, payment_method: String, notes: String) -> Result<(),String> {
    if expense_name.trim().is_empty() || amount_minor<=0 || expense_month.len()!=7 || !expense_month.chars().nth(4).map(|c|c=='-').unwrap_or(false) || !["cash","instapay","wallet","visa","other"].contains(&payment_method.as_str()) {
        return Err("راجع اسم المصروف والمبلغ والشهر وطريقة الدفع.".into());
    }
    let mut db=auth_db(&app)?;
    require_permission(&db,"shift")?;
    let (actor,_)=require_role(&db,&["admin"])?;
    let now=Utc::now().to_rfc3339();
    let id=uuid::Uuid::new_v4().to_string();
    let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_monthly_expenses(id,expense_name,amount_minor,expense_month,payment_method,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(expense_name,expense_month) DO UPDATE SET amount_minor=excluded.amount_minor,payment_method=excluded.payment_method,notes=excluded.notes",params![id,expense_name.trim(),amount_minor,expense_month,payment_method,notes.trim(),actor,now]).map_err(|e|e.to_string())?;
    let saved_id:String=tx.query_row("SELECT id FROM local_monthly_expenses WHERE expense_name=? AND expense_month=?",params![expense_name.trim(),expense_month],|r|r.get(0)).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,reason,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'monthly_expense_saved','monthly_expense',?,?,?,?)",params![actor,saved_id,notes.trim(),json!({"name":expense_name,"amount_minor":amount_minor,"month":expense_month,"payment_method":payment_method}).to_string(),now]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;
    Ok(())
}





#[tauri::command]
fn record_cafe_stock_count(app:tauri::AppHandle,item_id:String,counted_quantity_milli:i64,reason:String)->Result<Value,String>{
    if item_id.trim().is_empty()||counted_quantity_milli<0{return Err("أدخل الصنف والكمية الفعلية بشكل صحيح.".into())}
    let mut db=auth_db(&app)?;let(actor,_)=require_role(&db,&["admin","manager"])?;require_permission(&db,"cafe")?;
    let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let expected:i64=tx.query_row("SELECT COALESCE(SUM(CASE WHEN movement_type IN ('purchase','stock_in','return_in','opening') THEN quantity_milli WHEN movement_type IN ('sale','waste','stock_out','return_supplier') THEN -quantity_milli ELSE 0 END),0) FROM local_stock_movements WHERE inventory_item_id=?",params![item_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    let variance=counted_quantity_milli.checked_sub(expected).ok_or("فرق الجرد كبير جدًا.")?;
    if variance!=0&&reason.trim().is_empty(){return Err("يجب تسجيل سبب فرق الجرد.".into())}
    let now=Utc::now().to_rfc3339();let id=uuid::Uuid::new_v4().to_string();
    tx.execute("INSERT INTO local_stock_counts(id,inventory_item_id,expected_quantity_milli,counted_quantity_milli,variance_quantity_milli,reason,counted_by,counted_at) VALUES(?,?,?,?,?,?,?,?)",params![id,item_id,expected,counted_quantity_milli,variance,reason.trim(),actor,now]).map_err(|e|e.to_string())?;
    if variance>0{tx.execute("INSERT INTO local_stock_movements(id,inventory_item_id,movement_type,quantity_milli,reason,created_by,created_at) VALUES(?,?,'stock_in',?,?,?,?)",params![uuid::Uuid::new_v4().to_string(),item_id,variance,format!("تسوية جرد: {}",reason.trim()),actor,now]).map_err(|e|e.to_string())?;}else if variance<0{tx.execute("INSERT INTO local_stock_movements(id,inventory_item_id,movement_type,quantity_milli,reason,created_by,created_at) VALUES(?,?,'stock_out',?,?,?,?)",params![uuid::Uuid::new_v4().to_string(),item_id,variance.abs(),format!("تسوية جرد: {}",reason.trim()),actor,now]).map_err(|e|e.to_string())?;consume_expiry_batches(&tx,&item_id,variance.abs())?;}
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,reason,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'cafe_stock_counted','stock_count',?,?,?,?)",params![actor,id,reason.trim(),json!({"expected_milli":expected,"counted_milli":counted_quantity_milli,"variance_milli":variance}).to_string(),now]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;Ok(json!({"expectedMilli":expected,"countedMilli":counted_quantity_milli,"varianceMilli":variance}))
}

#[tauri::command]
fn list_cafe_expiry_alerts(app:tauri::AppHandle)->Result<Vec<Value>,String>{
    let db=auth_db(&app)?;require_role(&db,&["admin","manager","cashier"])?;
    require_permission(&db,"cafe")?;
    let mut st=db.prepare("SELECT b.id,i.name,b.quantity_milli,b.expiry_date,CAST(julianday(b.expiry_date)-julianday(date('now')) AS INTEGER) FROM local_expiry_batches b JOIN local_inventory_items i ON i.id=b.inventory_item_id WHERE b.quantity_milli>0 AND date(b.expiry_date)<=date('now','+30 days') ORDER BY b.expiry_date").map_err(|e|e.to_string())?;
    let rows=st.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"itemName":r.get::<_,String>(1)?,"quantityMilli":r.get::<_,i64>(2)?,"expiryDate":r.get::<_,String>(3)?,"daysRemaining":r.get::<_,i64>(4)?}))).map_err(|e|e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}

#[tauri::command]
fn save_cafe_recipe(app:tauri::AppHandle,sellable_item_id:String,recipe_name:String,yield_quantity_milli:i64,ingredients:Vec<Value>)->Result<(),String>{
    if sellable_item_id.trim().is_empty()||recipe_name.trim().is_empty()||yield_quantity_milli<=0||ingredients.is_empty(){return Err("أدخل اسم الوصفة والمنتج والكمية الناتجة ومكونًا واحدًا على الأقل.".into())}
    let mut db=auth_db(&app)?;let(actor,_)=require_role(&db,&["admin","manager"])?;require_permission(&db,"cafe")?;
    let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let kind:String=tx.query_row("SELECT item_kind FROM local_inventory_items WHERE id=? AND is_active=1",params![sellable_item_id],|r|r.get(0)).map_err(|_|"المنتج غير موجود.".to_string())?;if kind!="ready_product"{return Err("الوصفة يجب أن ترتبط بمنتج جاهز للبيع.".into())}
    let recipe_id:Option<String>=tx.query_row("SELECT id FROM local_recipes WHERE sellable_item_id=?",params![sellable_item_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let id=recipe_id.unwrap_or_else(||uuid::Uuid::new_v4().to_string());
    tx.execute("INSERT INTO local_recipes(id,sellable_item_id,name,yield_quantity_milli) VALUES(?,?,?,?) ON CONFLICT(sellable_item_id) DO UPDATE SET name=excluded.name,yield_quantity_milli=excluded.yield_quantity_milli",params![id,sellable_item_id,recipe_name.trim(),yield_quantity_milli]).map_err(|e|e.to_string())?;
    let actual_id:String=tx.query_row("SELECT id FROM local_recipes WHERE sellable_item_id=?",params![sellable_item_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    tx.execute("DELETE FROM local_recipe_ingredients WHERE recipe_id=?",params![actual_id]).map_err(|e|e.to_string())?;
    let mut seen=std::collections::HashSet::new();
    for line in ingredients.iter(){let item=line.get("itemId").and_then(Value::as_str).ok_or("مكون الوصفة غير محدد.")?;let qty=line.get("quantityMilli").and_then(Value::as_i64).ok_or("كمية مكون الوصفة غير صحيحة.")?;if qty<=0||item==sellable_item_id||!seen.insert(item.to_string()){return Err("راجع مكونات الوصفة؛ يجب أن تكون الكميات موجبة والمكونات غير مكررة.".into())}let exists:i64=tx.query_row("SELECT COUNT(*) FROM local_inventory_items WHERE id=? AND is_active=1",params![item],|r|r.get(0)).map_err(|e|e.to_string())?;if exists==0{return Err("أحد مكونات الوصفة غير موجود.".into())}tx.execute("INSERT INTO local_recipe_ingredients(id,recipe_id,inventory_item_id,quantity_milli) VALUES(?,?,?,?)",params![uuid::Uuid::new_v4().to_string(),actual_id,item,qty]).map_err(|e|e.to_string())?;}
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'cafe_recipe_saved','recipe',?,?,?)",params![actor,actual_id,json!({"product_id":sellable_item_id,"name":recipe_name,"yield_quantity_milli":yield_quantity_milli,"ingredients":ingredients}).to_string(),Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;Ok(())
}

#[tauri::command]
fn list_cafe_recipes(app:tauri::AppHandle)->Result<Vec<Value>,String>{
    let db=auth_db(&app)?;
    require_permission(&db,"cafe")?;
    require_role(&db,&["admin","manager","cashier"])?;
    let mut st=db.prepare("SELECT r.id,r.name,r.sellable_item_id,i.name,r.yield_quantity_milli,(SELECT COUNT(*) FROM local_recipe_ingredients ri WHERE ri.recipe_id=r.id) FROM local_recipes r JOIN local_inventory_items i ON i.id=r.sellable_item_id ORDER BY r.name").map_err(|e|e.to_string())?;
    let rows=st.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"productId":r.get::<_,String>(2)?,"productName":r.get::<_,String>(3)?,"yieldQuantityMilli":r.get::<_,i64>(4)?,"ingredientCount":r.get::<_,i64>(5)?}))).map_err(|e|e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}

#[tauri::command]
fn create_cafe_sale(app:tauri::AppHandle,items:Vec<Value>,payments:Vec<Value>,coupon_code:Option<String>)->Result<Value,String>{
    if items.is_empty()||payments.is_empty(){return Err("أضف أصنافًا وحدد دفعة واحدة على الأقل.".into())}
    let mut db=auth_db(&app)?;let(actor,_)=require_role(&db,&["admin","manager","cashier"])?;require_permission(&db,"cafe")?;if coupon_code.as_deref().map(|v|!v.trim().is_empty()).unwrap_or(false){require_permission(&db,"discounts")?;}
    let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let shift_id:String=tx.query_row("SELECT id FROM local_cash_sessions WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?.ok_or("افتح الوردية قبل تسجيل بيع الكافيه.")?;
    let mut prepared:Vec<(String,String,i64,i64,i64,String)>=Vec::new();let mut subtotal:i64=0;
    for line in items.iter(){
        let item_id=line.get("itemId").and_then(Value::as_str).ok_or("صنف البيع غير محدد.")?;
        let qty=line.get("quantityMilli").and_then(Value::as_i64).ok_or("كمية البيع غير صحيحة.")?;
        if qty<=0{return Err("كمية البيع يجب أن تكون أكبر من صفر.".into())}
        let item:Option<(String,String,i64,i64)>=tx.query_row("SELECT name,item_kind,COALESCE(sale_price_minor,0),is_active FROM local_inventory_items WHERE id=?",params![item_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|e|e.to_string())?;
        let (name,kind,price,active)=item.ok_or("أحد أصناف البيع غير موجود.")?;if active!=1||price<=0{return Err(format!("الصنف {} غير نشط أو سعر البيع غير محدد.",name))}
        let line_total=price.checked_mul(qty).ok_or("إجمالي الصنف كبير جدًا.")?/1000;
        subtotal=subtotal.checked_add(line_total).ok_or("إجمالي الفاتورة كبير جدًا.")?;
        let recipe:Option<(String,i64)>=tx.query_row("SELECT id,yield_quantity_milli FROM local_recipes WHERE sellable_item_id=?",params![item_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
        let (recipe_id,yield_qty)=recipe.map(|(id,y)| (id,y)).unwrap_or_default();
        if !recipe_id.is_empty(){
            let mut st=tx.prepare("SELECT inventory_item_id,quantity_milli FROM local_recipe_ingredients WHERE recipe_id=?").map_err(|e|e.to_string())?;
            let ingredients=st.query_map(params![recipe_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
            if ingredients.is_empty(){return Err(format!("وصفة {} لا تحتوي على مكونات.",name))}
            for (ingredient,per_yield) in ingredients{
                let required=per_yield.checked_mul(qty).ok_or("كمية مكونات الوصفة كبيرة جدًا.")?.checked_add(yield_qty-1).ok_or("كمية مكونات الوصفة كبيرة جدًا.")?/yield_qty;
                let available:i64=tx.query_row("SELECT COALESCE(SUM(CASE WHEN movement_type IN ('purchase','stock_in','return_in','opening') THEN quantity_milli WHEN movement_type IN ('sale','waste','stock_out','return_supplier') THEN -quantity_milli ELSE 0 END),0) FROM local_stock_movements WHERE inventory_item_id=?",params![ingredient],|r|r.get(0)).map_err(|e|e.to_string())?;
                if required>available{return Err(format!("المخزون غير كافٍ لأحد مكونات وصفة {}.",name))}
            }
        }else{
            let available:i64=tx.query_row("SELECT COALESCE(SUM(CASE WHEN movement_type IN ('purchase','stock_in','return_in','opening') THEN quantity_milli WHEN movement_type IN ('sale','waste','stock_out','return_supplier') THEN -quantity_milli ELSE 0 END),0) FROM local_stock_movements WHERE inventory_item_id=?",params![item_id],|r|r.get(0)).map_err(|e|e.to_string())?;
            if qty>available{return Err(format!("المخزون غير كافٍ للصنف {}.",name))}
        }
        prepared.push((item_id.to_string(),name,qty,price,line_total,recipe_id));
    }

    let now=Utc::now().to_rfc3339();
    let mut coupon_id:Option<String>=None;
    let mut discount_minor:i64=0;
    if let Some(raw_code)=coupon_code.as_deref().filter(|v|!v.trim().is_empty()){
        let code=raw_code.trim().to_ascii_uppercase();
        let coupon:Option<(String,String,i64,Option<i64>,Option<i64>,i64,Option<String>,Option<String>,i64)>=tx.query_row("SELECT id,discount_type,discount_value,max_discount_minor,usage_limit,used_count,starts_at,ends_at,is_active FROM local_coupons WHERE code=? COLLATE NOCASE",params![code],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?))).optional().map_err(|e|e.to_string())?;
        let (id,kind,value,max_discount,usage_limit,used,start,end,active)=coupon.ok_or("كود الخصم غير موجود.")?;
        if active!=1{return Err("كود الخصم غير نشط.".into())}
        if usage_limit.map(|limit|used>=limit).unwrap_or(false){return Err("تم استنفاد عدد مرات استخدام الكوبون.".into())}
        if start.as_deref().map(|v|now.as_str()<v).unwrap_or(false)||end.as_deref().map(|v|now.as_str()>v).unwrap_or(false){return Err("الكوبون خارج فترة الصلاحية.".into())}
        discount_minor=if kind=="percent"{subtotal.checked_mul(value).ok_or("قيمة الخصم كبيرة جدًا.")?/10000}else if kind=="fixed"{value.min(subtotal)}else{return Err("نوع الخصم غير صالح.".into())};
        if let Some(cap)=max_discount{discount_minor=discount_minor.min(cap)}
        coupon_id=Some(id);
    }
    let total_minor=subtotal.saturating_sub(discount_minor);
    let sale_id=uuid::Uuid::new_v4().to_string();let now=Utc::now().to_rfc3339();let sale_no:i64=tx.query_row("SELECT COALESCE(MAX(sale_number_local),0)+1 FROM local_sales",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_sales(id,sale_number_local,visit_id,status,subtotal_minor,discount_minor,total_minor,cashier_user_id,created_at,coupon_id) VALUES(?,?,NULL,'completed',?,?,?,?,?,?)",params![sale_id,sale_no,subtotal,discount_minor,total_minor,actor,now,coupon_id]).map_err(|e|e.to_string())?;
    for (item_id,name,qty,price,line_total,recipe_id) in prepared.iter(){
        tx.execute("INSERT INTO local_sale_items(id,sale_id,item_type,inventory_item_id,description_snapshot,quantity_milli,unit_price_minor,line_total_minor) VALUES(?,?,'cafe_product',?,?,?,?,?)",params![uuid::Uuid::new_v4().to_string(),sale_id,item_id,name,qty,price,line_total]).map_err(|e|e.to_string())?;
        if recipe_id.is_empty(){
            tx.execute("INSERT INTO local_stock_movements(id,inventory_item_id,movement_type,quantity_milli,sale_id,reason,created_by,created_at) VALUES(?,?,'sale',?,?,?, ?,?)",params![uuid::Uuid::new_v4().to_string(),item_id,qty,sale_id,"بيع كافيه",actor,now]).map_err(|e|e.to_string())?;
            consume_expiry_batches(&tx,item_id,*qty)?;
        }else{
            let mut st=tx.prepare("SELECT inventory_item_id,quantity_milli FROM local_recipe_ingredients WHERE recipe_id=?").map_err(|e|e.to_string())?;
            let ingredients=st.query_map(params![recipe_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
            let yield_qty:i64=tx.query_row("SELECT yield_quantity_milli FROM local_recipes WHERE id=?",params![recipe_id],|r|r.get(0)).map_err(|e|e.to_string())?;
            for (ingredient,per_yield) in ingredients{let required=per_yield.checked_mul(*qty).ok_or("كمية الوصفة كبيرة جدًا.")?.checked_add(yield_qty-1).ok_or("كمية الوصفة كبيرة جدًا.")?/yield_qty;tx.execute("INSERT INTO local_stock_movements(id,inventory_item_id,movement_type,quantity_milli,sale_id,reason,created_by,created_at) VALUES(?,?,'sale',?,?,?, ?,?)",params![uuid::Uuid::new_v4().to_string(),ingredient,required,sale_id,format!("استهلاك وصفة {}",name),actor,now]).map_err(|e|e.to_string())?;consume_expiry_batches(&tx,&ingredient,required)?;}
        }
    }
    let mut collected:i64=0;
    let mut normalized_payments:Vec<(String,i64)>=Vec::new();
    for payment in payments.iter(){
        let method=payment.get("method").and_then(Value::as_str).ok_or("طريقة الدفع غير محددة.")?;
        let amount=payment.get("amountMinor").and_then(Value::as_i64).ok_or("قيمة الدفعة غير صحيحة.")?;
        if !["cash","instapay","wallet","visa","other"].contains(&method)||amount<=0{return Err("راجع طريقة الدفع ومبلغ كل دفعة؛ يجب أن تكون القيم أكبر من صفر.".into())}
        collected=collected.checked_add(amount).ok_or("إجمالي الدفعات كبير جدًا.")?;
        normalized_payments.push((method.to_string(),amount));
    }
    if collected!=total_minor{return Err(format!("مجموع الدفعات ({}) يجب أن يساوي صافي الفاتورة بعد الخصم ({}).",collected,total_minor))}
    for (method,amount) in normalized_payments.iter(){
        let stored_method=if ["visa","other"].contains(&method.as_str()){"wallet"}else{method.as_str()};
        tx.execute("INSERT INTO local_payments(id,sale_id,visit_id,method,method_label,status,amount_minor,received_by,created_at,cash_session_id) VALUES(?,?,NULL,?,?,'confirmed',?,?,?,?)",params![uuid::Uuid::new_v4().to_string(),sale_id,stored_method,method,amount,actor,now,shift_id]).map_err(|e|e.to_string())?;
    }
    if let Some(id)=coupon_id.as_deref(){tx.execute("UPDATE local_coupons SET used_count=used_count+1 WHERE id=?",params![id]).map_err(|e|e.to_string())?;}
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'cafe_sale_created','sale',?,?,?)",params![actor,sale_id,json!({"sale_number":sale_no,"subtotal_minor":subtotal,"discount_minor":discount_minor,"total_minor":total_minor,"payments":normalized_payments.iter().map(|(method,amount)|json!({"method":method,"amount_minor":amount})).collect::<Vec<_>>(),"cash_session_id":shift_id}).to_string(),now]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;Ok(json!({"saleId":sale_id,"saleNumber":sale_no,"subtotalMinor":subtotal,"discountMinor":discount_minor,"totalMinor":total_minor,"couponCode":coupon_code,"createdAt":now,"payments":normalized_payments.iter().map(|(method,amount)|json!({"method":method,"amountMinor":amount})).collect::<Vec<_>>(),"items":prepared.iter().map(|(_,name,qty,_,line_total,_)|json!({"name":name,"quantityMilli":qty,"lineTotalMinor":line_total})).collect::<Vec<_>>()}))
}


fn consume_expiry_batches(tx:&rusqlite::Transaction<'_>,item_id:&str,quantity_milli:i64)->Result<(),String>{
    let batches={
        let mut st=tx.prepare("SELECT id,quantity_milli FROM local_expiry_batches WHERE inventory_item_id=? AND quantity_milli>0 ORDER BY expiry_date,created_at").map_err(|e|e.to_string())?;
        let rows=st.query_map(params![item_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).map_err(|e|e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?
    };
    let mut remaining=quantity_milli;
    for (id,available) in batches{if remaining<=0{break}let take=remaining.min(available);tx.execute("UPDATE local_expiry_batches SET quantity_milli=quantity_milli-? WHERE id=?",params![take,id]).map_err(|e|e.to_string())?;remaining-=take;}
    Ok(())
}


#[tauri::command]
fn list_coupons(app:tauri::AppHandle)->Result<Vec<Value>,String>{
    let db=auth_db(&app)?;require_permission(&db,"discounts")?;require_role(&db,&["admin","manager","cashier"])?;
    let mut st=db.prepare("SELECT id,code,description,discount_type,discount_value,max_discount_minor,usage_limit,used_count,starts_at,ends_at,is_active FROM local_coupons ORDER BY created_at DESC").map_err(|e|e.to_string())?;
    let rows=st.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"code":r.get::<_,String>(1)?,"description":r.get::<_,String>(2)?,"discountType":r.get::<_,String>(3)?,"discountValue":r.get::<_,i64>(4)?,"maxDiscountMinor":r.get::<_,Option<i64>>(5)?,"usageLimit":r.get::<_,Option<i64>>(6)?,"usedCount":r.get::<_,i64>(7)?,"startsAt":r.get::<_,Option<String>>(8)?,"endsAt":r.get::<_,Option<String>>(9)?,"active":r.get::<_,i64>(10)?==1}))).map_err(|e|e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}
#[tauri::command]
fn save_coupon(app:tauri::AppHandle,code:String,description:String,discount_type:String,discount_value:i64,max_discount_minor:Option<i64>,usage_limit:Option<i64>,starts_at:Option<String>,ends_at:Option<String>)->Result<String,String>{
    let normalized=code.trim().to_ascii_uppercase();
    if normalized.len()<3||normalized.len()>32||!normalized.chars().all(|c|c.is_ascii_alphanumeric()||c=='-')||!["percent","fixed"].contains(&discount_type.as_str())||discount_value<=0||(discount_type=="percent"&&discount_value>10000)||max_discount_minor.map(|v|v<=0).unwrap_or(false)||usage_limit.map(|v|v<=0).unwrap_or(false){return Err("راجع كود الخصم ونوعه وقيمته وحدود الاستخدام.".into())}
    if let (Some(start),Some(end))=(&starts_at,&ends_at){if start>=end{return Err("تاريخ انتهاء الكوبون يجب أن يكون بعد تاريخ البداية.".into())}}
    let mut db=auth_db(&app)?;require_permission(&db,"pricing")?;let(actor,_)=require_role(&db,&["admin","manager","cashier"])?;
    let id=uuid::Uuid::new_v4().to_string();let now=Utc::now().to_rfc3339();
    db.execute("INSERT INTO local_coupons(id,code,description,discount_type,discount_value,max_discount_minor,usage_limit,starts_at,ends_at,is_active,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)",params![id,normalized,description.trim(),discount_type,discount_value,max_discount_minor,usage_limit,starts_at,ends_at,actor,now]).map_err(|e|if e.to_string().contains("UNIQUE"){"كود الخصم مستخدم بالفعل.".to_string()}else{e.to_string()})?;
    db.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'coupon_created','coupon',?,?,?)",params![actor,id,json!({"code":normalized,"discount_type":discount_type,"discount_value":discount_value}).to_string(),now]).map_err(|e|e.to_string())?;
    Ok(id)
}
#[tauri::command]
fn list_bookings(app:tauri::AppHandle)->Result<Vec<Value>,String>{
    let db=auth_db(&app)?;
    require_permission(&db,"bookings")?;
    require_role(&db,&["admin","manager","cashier"])?;
    let mut st=db.prepare("SELECT id,booking_type,guardian_name,guardian_phone,scheduled_at,duration_minutes,child_count,guest_count,status,notes,created_by,created_at FROM local_bookings ORDER BY scheduled_at DESC LIMIT 300").map_err(|e|e.to_string())?;
    let rows=st.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"type":r.get::<_,String>(1)?,"guardianName":r.get::<_,String>(2)?,"phone":r.get::<_,String>(3)?,"scheduledAt":r.get::<_,String>(4)?,"durationMinutes":r.get::<_,i64>(5)?,"childCount":r.get::<_,i64>(6)?,"guestCount":r.get::<_,i64>(7)?,"status":r.get::<_,String>(8)?,"notes":r.get::<_,Option<String>>(9)?,"createdBy":r.get::<_,String>(10)?,"createdAt":r.get::<_,String>(11)?}))).map_err(|e|e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}

#[tauri::command]
fn save_booking(app:tauri::AppHandle,booking_type:String,guardian_name:String,guardian_phone:String,scheduled_at:String,duration_minutes:i64,child_count:i64,guest_count:i64,notes:String)->Result<String,String>{
    if !["visit","birthday"].contains(&booking_type.as_str())||guardian_name.trim().is_empty()||guardian_phone.trim().is_empty()||scheduled_at.trim().is_empty()||duration_minutes<=0||child_count<=0||guest_count<0{return Err("راجع نوع الحجز وبيانات المرافق والتاريخ والمدة والأعداد.".into())}
    let mut db=auth_db(&app)?;
    require_permission(&db,"bookings")?;
    let(actor,_)=require_role(&db,&["admin","manager","cashier"])?;
    let id=uuid::Uuid::new_v4().to_string();let now=Utc::now().to_rfc3339();
    db.execute("INSERT INTO local_bookings(id,booking_type,guardian_name,guardian_phone,scheduled_at,duration_minutes,child_count,guest_count,status,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?, 'booked',?,?,?)",params![id,booking_type,guardian_name.trim(),guardian_phone.trim(),scheduled_at,duration_minutes,child_count,guest_count,notes.trim(),actor,now]).map_err(|e|e.to_string())?;
    db.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'booking_created','booking',?,?,?)",params![actor,id,json!({"type":booking_type,"scheduled_at":scheduled_at,"guardian":guardian_name,"phone":guardian_phone}).to_string(),now]).map_err(|e|e.to_string())?;
    Ok(id)
}

#[tauri::command]
fn update_booking_status(app:tauri::AppHandle,booking_id:String,status:String,reason:String)->Result<(),String>{
    if !["confirmed","cancelled"].contains(&status.as_str())||booking_id.trim().is_empty(){return Err("حالة الحجز غير صحيحة.".into())}
    if status=="cancelled"&&reason.trim().is_empty(){return Err("سبب إلغاء الحجز مطلوب.".into())}
    let mut db=auth_db(&app)?;require_permission(&db,"bookings")?;let(actor,_)=require_role(&db,&["admin","manager","cashier"])?;
    let changed=db.execute("UPDATE local_bookings SET status=? WHERE id=? AND status IN ('booked','confirmed')",params![status,booking_id]).map_err(|e|e.to_string())?;
    if changed==0{return Err("الحجز غير موجود أو تم إنهاؤه بالفعل.".into())}
    db.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,reason,created_at) VALUES(lower(hex(randomblob(16))),?,'booking_status_changed','booking',?,?,?)",params![actor,booking_id,reason.trim(),Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;Ok(())
}

#[tauri::command]
fn list_cafe_stock_movements(app:tauri::AppHandle)->Result<Vec<Value>,String>{
    let db=auth_db(&app)?;
    require_permission(&db,"cafe")?;
    require_role(&db,&["admin","manager","cashier"])?;
    let mut st=db.prepare("SELECT m.id,i.name,m.movement_type,m.quantity_milli,m.reason,m.created_by,m.created_at FROM local_stock_movements m JOIN local_inventory_items i ON i.id=m.inventory_item_id ORDER BY m.created_at DESC LIMIT 150").map_err(|e|e.to_string())?;
    let rows=st.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"itemName":r.get::<_,String>(1)?,"type":r.get::<_,String>(2)?,"quantityMilli":r.get::<_,i64>(3)?,"reason":r.get::<_,String>(4)?,"createdBy":r.get::<_,String>(5)?,"createdAt":r.get::<_,String>(6)?}))).map_err(|e|e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}

#[tauri::command]
fn list_cafe_items(app: tauri::AppHandle) -> Result<Vec<Value>,String> {
    let db=auth_db(&app)?;
    require_permission(&db,"cafe")?;
    require_role(&db,&["admin","manager","cashier"])?;
    let mut st=db.prepare("SELECT i.id,i.name,i.sku,i.barcode,i.item_kind,i.base_unit,i.purchase_price_minor,COALESCE(i.sale_price_minor,0),i.minimum_stock_milli,i.is_active,COALESCE(SUM(CASE WHEN m.movement_type IN ('purchase','stock_in','return_in','opening') THEN m.quantity_milli WHEN m.movement_type IN ('sale','waste','stock_out','return_supplier') THEN -m.quantity_milli ELSE 0 END),0) FROM local_inventory_items i LEFT JOIN local_stock_movements m ON m.inventory_item_id=i.id GROUP BY i.id ORDER BY i.name").map_err(|e|e.to_string())?;
    let rows=st.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"sku":r.get::<_,Option<String>>(2)?,"barcode":r.get::<_,Option<String>>(3)?,"kind":r.get::<_,String>(4)?,"unit":r.get::<_,String>(5)?,"purchasePriceMinor":r.get::<_,i64>(6)?,"salePriceMinor":r.get::<_,i64>(7)?,"minimumStockMilli":r.get::<_,i64>(8)?,"active":r.get::<_,i64>(9)?,"stockMilli":r.get::<_,i64>(10)?}))).map_err(|e|e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}

#[tauri::command]
fn save_cafe_item(app:tauri::AppHandle,item_id:Option<String>,name:String,sku:Option<String>,barcode:Option<String>,item_kind:String,base_unit:String,purchase_price_minor:i64,sale_price_minor:i64,minimum_stock_milli:i64)->Result<String,String>{
    if name.trim().is_empty()||base_unit.trim().is_empty()||!["ingredient","ready_product","packaging","other"].contains(&item_kind.as_str())||purchase_price_minor<0||sale_price_minor<0||minimum_stock_milli<0{return Err("راجع اسم الصنف والوحدة والأسعار والحد الأدنى للمخزون.".into())}
    let mut db=auth_db(&app)?;let(actor,_)=require_role(&db,&["admin","manager"])?;let tx=db.transaction().map_err(|e|e.to_string())?;let id=item_id.unwrap_or_else(||uuid::Uuid::new_v4().to_string());
    tx.execute("INSERT INTO local_inventory_items(id,name,sku,barcode,item_kind,base_unit,purchase_price_minor,sale_price_minor,minimum_stock_milli,is_active) VALUES(?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,sku=excluded.sku,barcode=excluded.barcode,item_kind=excluded.item_kind,base_unit=excluded.base_unit,purchase_price_minor=excluded.purchase_price_minor,sale_price_minor=excluded.sale_price_minor,minimum_stock_milli=excluded.minimum_stock_milli",params![id,name.trim(),sku.as_deref(),barcode.as_deref(),item_kind,base_unit.trim(),purchase_price_minor,sale_price_minor,minimum_stock_milli]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'cafe_item_saved','inventory_item',?,?,?)",params![actor,id,json!({"name":name,"kind":item_kind,"unit":base_unit,"purchase_price_minor":purchase_price_minor,"sale_price_minor":sale_price_minor}).to_string(),Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;Ok(id)
}

#[tauri::command]
fn adjust_cafe_stock(app:tauri::AppHandle,item_id:String,movement_type:String,quantity_milli:i64,reason:String)->Result<(),String>{
    if item_id.trim().is_empty()||quantity_milli<=0||!["purchase","stock_in","waste","stock_out","return_in","return_supplier","opening"].contains(&movement_type.as_str())||reason.trim().is_empty(){return Err("راجع الصنف والكمية ونوع الحركة والسبب.".into())}
    let mut db=auth_db(&app)?;let(actor,_)=require_role(&db,&["admin","manager"])?;require_permission(&db,"cafe")?;
    let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let exists:i64=tx.query_row("SELECT COUNT(*) FROM local_inventory_items WHERE id=? AND is_active=1",params![item_id],|r|r.get(0)).map_err(|e|e.to_string())?;if exists==0{return Err("الصنف غير موجود أو غير نشط.".into())}
    let current:i64=tx.query_row("SELECT COALESCE(SUM(CASE WHEN movement_type IN ('purchase','stock_in','return_in','opening') THEN quantity_milli WHEN movement_type IN ('sale','waste','stock_out','return_supplier') THEN -quantity_milli ELSE 0 END),0) FROM local_stock_movements WHERE inventory_item_id=?",params![item_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if ["waste","stock_out","return_supplier"].contains(&movement_type.as_str())&&quantity_milli>current{return Err("الكمية أكبر من المخزون المتاح.".into())}
    tx.execute("INSERT INTO local_stock_movements(id,inventory_item_id,movement_type,quantity_milli,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?)",params![uuid::Uuid::new_v4().to_string(),item_id,movement_type,quantity_milli,reason.trim(),actor,Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    if ["waste","stock_out","return_supplier"].contains(&movement_type.as_str()){consume_expiry_batches(&tx,&item_id,quantity_milli)?;}
    tx.commit().map_err(|e|e.to_string())?;Ok(())
}


#[tauri::command]
fn record_cafe_purchase(app:tauri::AppHandle,supplier_id:Option<String>,document_number:Option<String>,item_id:String,quantity_milli:i64,unit_cost_minor:i64,expiry_date:Option<String>,notes:String)->Result<(),String>{
    if item_id.trim().is_empty()||quantity_milli<=0||unit_cost_minor<0{return Err("راجع الصنف والكمية وتكلفة الوحدة.".into())}
    let mut db=auth_db(&app)?;let(actor,_)=require_role(&db,&["admin","manager"])?;require_permission(&db,"cafe")?;
    let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let item_name:String=tx.query_row("SELECT name FROM local_inventory_items WHERE id=? AND is_active=1",params![item_id],|r|r.get(0)).map_err(|_|"الصنف غير موجود أو غير نشط.".to_string())?;
    if let Some(sid)=supplier_id.as_deref(){let n:i64=tx.query_row("SELECT COUNT(*) FROM local_suppliers WHERE id=? AND is_active=1",params![sid],|r|r.get(0)).map_err(|e|e.to_string())?;if n==0{return Err("المورد غير موجود.".into())}}
    let now=Utc::now().to_rfc3339();let purchase_id=uuid::Uuid::new_v4().to_string();let total=quantity_milli.checked_mul(unit_cost_minor).ok_or("قيمة الشراء كبيرة جدًا.")?/1000;
    tx.execute("INSERT INTO local_stock_purchases(id,supplier_id,document_number,total_cost_minor,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?)",params![purchase_id,supplier_id.as_deref(),document_number.as_deref(),total,notes.trim(),actor,now]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_stock_purchase_items(id,purchase_id,inventory_item_id,quantity_milli,unit_cost_minor,expiry_date) VALUES(?,?,?,?,?,?)",params![uuid::Uuid::new_v4().to_string(),purchase_id,item_id,quantity_milli,unit_cost_minor,expiry_date.as_deref()]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_stock_movements(id,inventory_item_id,movement_type,quantity_milli,unit_cost_minor,reason,created_by,created_at) VALUES(?,?, 'purchase',?,?,?, ?,?)",params![uuid::Uuid::new_v4().to_string(),item_id,quantity_milli,unit_cost_minor,format!("شراء {} - {}",item_name,document_number.as_deref().unwrap_or("بدون رقم فاتورة")),actor,now]).map_err(|e|e.to_string())?;
    if let Some(date)=expiry_date.as_deref(){if !date.trim().is_empty(){tx.execute("INSERT INTO local_expiry_batches(id,inventory_item_id,quantity_milli,expiry_date,created_at) VALUES(?,?,?,?,?)",params![uuid::Uuid::new_v4().to_string(),item_id,quantity_milli,date,now]).map_err(|e|e.to_string())?;}}
    tx.execute("UPDATE local_inventory_items SET purchase_price_minor=? WHERE id=?",params![unit_cost_minor,item_id]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,reason,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'cafe_purchase_recorded','stock_purchase',?,?,?,?)",params![actor,purchase_id,notes.trim(),json!({"item_id":item_id,"quantity_milli":quantity_milli,"unit_cost_minor":unit_cost_minor,"total_cost_minor":total}).to_string(),now]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;Ok(())
}

#[tauri::command]
fn save_cafe_supplier(app:tauri::AppHandle,supplier_id:Option<String>,name:String,phone:Option<String>,notes:Option<String>)->Result<String,String>{
    if name.trim().is_empty(){return Err("اسم المورد مطلوب.".into())}
    let mut db=auth_db(&app)?;
    require_permission(&db,"cafe")?;
    let(actor,_)=require_role(&db,&["admin","manager"])?;
    let id=supplier_id.unwrap_or_else(||uuid::Uuid::new_v4().to_string());
    db.execute("INSERT INTO local_suppliers(id,name,phone,notes,is_active,created_at) VALUES(?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,phone=excluded.phone,notes=excluded.notes",params![id,name.trim(),phone.as_deref(),notes.as_deref(),Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    db.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'supplier_saved','supplier',?,?,?)",params![actor,id,json!({"name":name,"phone":phone}).to_string(),Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    Ok(id)
}

#[tauri::command]
fn list_cafe_suppliers(app:tauri::AppHandle)->Result<Vec<Value>,String>{
    let db=auth_db(&app)?;
    require_permission(&db,"cafe")?;
    require_role(&db,&["admin","manager","cashier"])?;
    let mut st=db.prepare("SELECT id,name,phone,notes,is_active FROM local_suppliers WHERE is_active=1 ORDER BY name").map_err(|e|e.to_string())?;
    let rows=st.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"phone":r.get::<_,Option<String>>(2)?,"notes":r.get::<_,Option<String>>(3)?,"active":r.get::<_,i64>(4)?}))).map_err(|e|e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_local_pos_schema",
            sql: include_str!("../migrations/001_local_schema_migration.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add_pricing_discounts_and_memberships",
            sql: include_str!("../migrations/002_pricing_schema.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "customer_profiles_and_membership_usage",
            sql: include_str!("../migrations/003_customer_profiles_and_membership_usage.sql"),
            kind: MigrationKind::Up,
        },
        Migration { version: 4, description: "auth_shifts_audit", sql: include_str!("../migrations/004_auth_shifts_audit.sql"), kind: MigrationKind::Up },
        Migration { version: 5, description: "role_write_guards", sql: include_str!("../migrations/005_role_write_guards.sql"), kind: MigrationKind::Up },
        Migration { version: 6, description: "pricing_role_policy", sql: include_str!("../migrations/006_pricing_role_policy.sql"), kind: MigrationKind::Up },
        Migration { version: 7, description: "partial_collection_and_membership_sales", sql: include_str!("../migrations/007_partial_collection_and_membership_sales.sql"), kind: MigrationKind::Up },
        Migration { version: 8, description: "membership_overtime_rate", sql: include_str!("../migrations/008_membership_overtime_rate.sql"), kind: MigrationKind::Up },
        Migration { version: 9, description: "waivers_and_visit_cancellations", sql: include_str!("../migrations/009_waivers_and_visit_cancellations.sql"), kind: MigrationKind::Up },
        Migration { version: 10, description: "shift_payments_expenses_refunds", sql: include_str!("../migrations/010_shift_payments_expenses_refunds.sql"), kind: MigrationKind::Up },
        Migration { version: 11, description: "shift_variance_reason", sql: include_str!("../migrations/011_shift_variance_reason.sql"), kind: MigrationKind::Up },
        Migration { version: 12, description: "operations_inventory_and_fixed_expenses", sql: include_str!("../migrations/012_operations_inventory_and_fixed_expenses.sql"), kind: MigrationKind::Up },
        Migration { version: 13, description: "custom_employee_permissions", sql: include_str!("../migrations/013_custom_employee_permissions.sql"), kind: MigrationKind::Up },
        Migration { version: 14, description: "extended_payment_methods", sql: include_str!("../migrations/014_extended_payment_methods.sql"), kind: MigrationKind::Up },
        Migration { version: 15, description: "membership_partial_payments", sql: include_str!("../migrations/015_membership_partial_payments.sql"), kind: MigrationKind::Up },
        Migration { version: 16, description: "bookings_and_birthday_parties", sql: include_str!("../migrations/016_bookings_and_birthday_parties.sql"), kind: MigrationKind::Up },
        Migration { version: 17, description: "coupons", sql: include_str!("../migrations/017_coupons.sql"), kind: MigrationKind::Up },
        Migration { version: 18, description: "booking_visit_link", sql: include_str!("../migrations/018_booking_visit_link.sql"), kind: MigrationKind::Up },
        Migration { version: 19, description: "custom_pricing_guards", sql: include_str!("../migrations/019_custom_pricing_guards.sql"), kind: MigrationKind::Up },
        Migration { version: 20, description: "visit_coupons", sql: include_str!("../migrations/020_visit_coupons.sql"), kind: MigrationKind::Up },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:secret-kids-club.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![greet, list_coupons, save_coupon, apply_visit_coupon, create_membership_sale, list_bookings, save_booking, update_booking_status, list_cafe_stock_movements, record_cafe_stock_count, list_cafe_expiry_alerts, save_cafe_recipe, list_cafe_recipes, create_cafe_sale, list_cafe_items, save_cafe_item, adjust_cafe_stock, record_cafe_purchase, save_cafe_supplier, list_cafe_suppliers, cancel_membership, record_membership_payment, record_cash_movement, list_monthly_expenses, save_monthly_expense, checkout_child, cancel_visit, update_membership_overtime_rate, list_refundable_payments, record_expense, record_refund, auth_status, setup_first_admin, login_user, logout_user, change_own_password, admin_list_users, admin_set_user_permissions, admin_create_user, admin_set_user_active, admin_reset_user_password, admin_update_user_role, admin_delete_user, delete_pricing_rule, create_pricing_rule, get_active_cash_shift, open_cash_shift, close_cash_shift, admin_audit_log])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod checkout_tests {
    use super::checkout_transaction;
    use chrono::{Duration, SecondsFormat, Utc};
    use rusqlite::{params, Connection};
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn setup_db(seconds_ago: i64) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "skc-checkout-test-{}-{nonce}.db",
            std::process::id()
        ));

        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "
            CREATE TABLE local_visits (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                checked_in_at TEXT NOT NULL,
                checked_out_at TEXT,
                final_amount_minor INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE local_visit_children (
                id TEXT PRIMARY KEY,
                visit_id TEXT NOT NULL,
                checked_out_at TEXT,
                actual_duration_minutes INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE local_audit_log (
                id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL, action TEXT NOT NULL,
                entity_type TEXT NOT NULL, entity_id TEXT, reason TEXT, before_json TEXT,
                after_json TEXT, created_at TEXT NOT NULL
            );
            CREATE TABLE local_session (singleton_id INTEGER PRIMARY KEY, actor_user_id TEXT);
            INSERT INTO local_session(singleton_id,actor_user_id) VALUES(1,'test-user');
            CREATE TABLE local_cash_sessions (id TEXT PRIMARY KEY, opened_at TEXT, closed_at TEXT);
            INSERT INTO local_cash_sessions(id,opened_at,closed_at) VALUES('shift-test','2000-01-01T00:00:00Z',NULL);
            CREATE TABLE local_payments (
                id TEXT PRIMARY KEY, visit_id TEXT, method TEXT, status TEXT,
                amount_minor INTEGER, received_by TEXT, created_at TEXT, cash_session_id TEXT
            );
            CREATE TABLE local_visit_child_pricing (
                id TEXT PRIMARY KEY,
                visit_child_id TEXT NOT NULL UNIQUE,
                pricing_type TEXT NOT NULL,
                pricing_rule_id TEXT,
                membership_id TEXT,
                duration_minutes INTEGER NOT NULL DEFAULT 0,
                included_minutes INTEGER NOT NULL DEFAULT 0,
                base_amount_minor INTEGER NOT NULL DEFAULT 0,
                discount_amount_minor INTEGER NOT NULL DEFAULT 0,
                calculation_json TEXT NOT NULL DEFAULT '{}',
                overtime_minutes INTEGER NOT NULL DEFAULT 0,
                overtime_amount_minor INTEGER NOT NULL DEFAULT 0,
                overtime_collected INTEGER NOT NULL DEFAULT 1,
                overtime_collection_note TEXT,
                membership_minutes_used INTEGER NOT NULL DEFAULT 0,
                overtime_waived INTEGER NOT NULL DEFAULT 0,
                overtime_waived_by TEXT,
                overtime_waived_at TEXT,
                overtime_waiver_reason TEXT,
                final_amount_minor INTEGER NOT NULL DEFAULT 0
            );
            "
        ).unwrap();

        let checkin = (Utc::now() - Duration::seconds(seconds_ago))
            .to_rfc3339_opts(SecondsFormat::Millis, true);

        db.execute(
            "INSERT INTO local_visits (id, status, checked_in_at)
             VALUES ('visit-1', 'active', ?)",
            params![checkin],
        ).unwrap();

        drop(db);
        path
    }

    fn add_child(
        path: &Path,
        id: &str,
        kind: &str,
        booked: i64,
        base: i64,
        discount: i64,
        calculation: &str,
    ) {
        let db = Connection::open(path).unwrap();

        db.execute(
            "INSERT INTO local_visit_children (id, visit_id)
             VALUES (?, 'visit-1')",
            params![id],
        ).unwrap();

        db.execute(
            "INSERT INTO local_visit_child_pricing
             (id, visit_child_id, pricing_type, duration_minutes,
              base_amount_minor, discount_amount_minor,
              calculation_json, final_amount_minor)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                format!("pricing-{id}"), id, kind, booked,
                base, discount, calculation, base
            ],
        ).unwrap();
    }

    #[test]
    fn hourly_checkout_saves_overtime_discount_and_total() {
        let path = setup_db(3690);
        add_child(
            &path, "child-hourly", "hourly", 60,
            12000, 2000, r#"{"hourlyRateMinor":6000}"#
        );

        checkout_transaction(&path, "child-hourly").unwrap();

        let db = Connection::open(&path).unwrap();
        let saved: (i64, i64, i64, i64) = db.query_row(
            "SELECT p.overtime_minutes, p.overtime_amount_minor,
                    p.final_amount_minor, c.actual_duration_minutes
             FROM local_visit_child_pricing p
             JOIN local_visit_children c ON c.id = p.visit_child_id
             WHERE p.visit_child_id = 'child-hourly'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).unwrap();

        assert_eq!(saved.0, 2);
        assert_eq!(saved.1, 200);
        assert_eq!(saved.2, 10200);
        assert_eq!(saved.3, 62);

        let visit: (String, Option<String>, i64) = db.query_row(
            "SELECT status, checked_out_at, final_amount_minor
             FROM local_visits WHERE id = 'visit-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();

        assert_eq!(visit.0, "completed");
        assert!(visit.1.is_some());
        assert_eq!(visit.2, 10200);

        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn hourly_checkout_without_valid_rate_fails_and_rolls_back() {
        let path = setup_db(3690);
        add_child(
            &path, "child-no-rate", "hourly", 60, 12000, 2000, "{}"
        );

        let result = checkout_transaction(&path, "child-no-rate");
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("hourly rate"),
            "Expected a clear missing-rate error"
        );

        let db = Connection::open(&path).unwrap();
        let child: (Option<String>, i64) = db.query_row(
            "SELECT checked_out_at, actual_duration_minutes
             FROM local_visit_children WHERE id = 'child-no-rate'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert!(child.0.is_none(), "Failed checkout must not check out the child");
        assert_eq!(child.1, 0, "Failed checkout must not save duration");

        let pricing: (i64, i64, i64) = db.query_row(
            "SELECT overtime_minutes, overtime_amount_minor, final_amount_minor
             FROM local_visit_child_pricing WHERE visit_child_id = 'child-no-rate'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert_eq!(pricing, (0, 0, 12000));

        let visit_status: String = db.query_row(
            "SELECT status FROM local_visits WHERE id = 'visit-1'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(visit_status, "active");

        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn hourly_checkout_overflow_fails_and_rolls_back() {
        let path = setup_db(3690);
        add_child(
            &path,
            "child-overflow",
            "hourly",
            60,
            12000,
            0,
            r#"{"hourlyRateMinor":9223372036854775807}"#,
        );

        let result = checkout_transaction(&path, "child-overflow");
        assert!(result.is_err(), "Overflow must cancel checkout");

        let db = Connection::open(&path).unwrap();
        let child_checkout: Option<String> = db.query_row(
            "SELECT checked_out_at FROM local_visit_children
             WHERE id = 'child-overflow'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert!(child_checkout.is_none(), "Overflow must roll back checkout");

        let visit_status: String = db.query_row(
            "SELECT status FROM local_visits WHERE id = 'visit-1'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(visit_status, "active");

        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn visit_total_overflow_rolls_back_last_child_checkout() {
        let path = setup_db(300);

        add_child(
            &path,
            "child-max",
            "fixed",
            60,
            i64::MAX,
            0,
            "{}",
        );
        add_child(
            &path,
            "child-last",
            "fixed",
            60,
            1,
            0,
            "{}",
        );

        // The first child checks out successfully.
        checkout_transaction(&path, "child-max").unwrap();

        // Adding the last child's amount would overflow SQLite SUM.
        let result = checkout_transaction(&path, "child-last");
        assert!(result.is_err(), "Overflow must cancel the last checkout");

        let db = Connection::open(&path).unwrap();

        let last_checkout: Option<String> = db.query_row(
            "SELECT checked_out_at FROM local_visit_children
             WHERE id = 'child-last'",
            [],
            |row| row.get(0),
        ).unwrap();

        assert!(
            last_checkout.is_none(),
            "Failed checkout must leave the last child checked in"
        );

        let first_checkout: Option<String> = db.query_row(
            "SELECT checked_out_at FROM local_visit_children
             WHERE id = 'child-max'",
            [],
            |row| row.get(0),
        ).unwrap();

        assert!(
            first_checkout.is_some(),
            "The first successful checkout must remain saved"
        );

        let visit: (String, Option<String>) = db.query_row(
            "SELECT status, checked_out_at FROM local_visits
             WHERE id = 'visit-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();

        assert_eq!(visit.0, "active");
        assert!(
            visit.1.is_none(),
            "The visit must not be completed after the failed checkout"
        );

        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn visit_stays_active_until_last_child_checks_out() {
        let path = setup_db(300);
        add_child(&path, "child-one", "fixed", 60, 500, 0, "{}");
        add_child(&path, "child-two", "fixed", 60, 500, 0, "{}");

        checkout_transaction(&path, "child-one").unwrap();

        let db = Connection::open(&path).unwrap();
        let first: (String, Option<String>, i64) = db.query_row(
            "SELECT status, checked_out_at, final_amount_minor
             FROM local_visits WHERE id = 'visit-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();

        assert_eq!(first.0, "active");
        assert!(first.1.is_none());
        assert_eq!(first.2, 0);
        drop(db);

        checkout_transaction(&path, "child-two").unwrap();

        let db = Connection::open(&path).unwrap();
        let final_state: (String, Option<String>, i64) = db.query_row(
            "SELECT status, checked_out_at, final_amount_minor
             FROM local_visits WHERE id = 'visit-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();

        assert_eq!(final_state.0, "completed");
        assert!(final_state.1.is_some());
        assert_eq!(final_state.2, 1000);

        drop(db);
        let _ = std::fs::remove_file(path);
    }
}
