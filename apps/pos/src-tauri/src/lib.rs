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

        let payment_method = calculation.get("paymentMethod").and_then(Value::as_str).unwrap_or("cash");
        let payment_method = if ["cash", "instapay", "wallet"].contains(&payment_method) { payment_method } else { "cash" };
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
                "INSERT INTO local_payments(id,visit_id,method,status,amount_minor,received_by,created_at,cash_session_id) VALUES(lower(hex(randomblob(16))),? ,?,'confirmed',?,?,?,?)",
                params![visit_id, payment_method, collected_total, actor, checkout_time_string, shift_id],
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
    let (actor, _) = if overtime_waived { require_role(&db, &["admin", "manager"])? } else { require_role(&db, &["admin", "manager", "cashier"])? };
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
#[tauri::command]
fn auth_status(app:tauri::AppHandle)->Result<Value,String>{
 let db=auth_db(&app)?;
 let count:i64=db.query_row("SELECT COUNT(*) FROM local_users WHERE username IS NOT NULL AND password_hash IS NOT NULL",[],|r|r.get(0)).map_err(|e|e.to_string())?;
 // Read the current local session without mutating it. The previous implementation
 // silently logged the user out whenever the UI rechecked authentication status.
 let user:Option<(String,String,String)>=db.query_row(
  "SELECT u.id,u.display_name,u.role_codes_json FROM local_session s JOIN local_users u ON u.id=s.actor_user_id WHERE s.singleton_id=1 AND u.is_active=1",
  [],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))
 ).optional().map_err(|e|e.to_string())?;
 let user_json=user.map(|(id,name,roles)|json!({"id":id,"name":name,"roles":roles}));
 Ok(json!({"needsSetup":count==0,"user":user_json}))
}
#[tauri::command]
fn setup_first_admin(app:tauri::AppHandle,username:String,display_name:String,password:String)->Result<Value,String>{
 if username.trim().len()<3||display_name.trim().is_empty()||password.chars().count()<12{return Err("اسم المستخدم 3 أحرف على الأقل وكلمة المرور 12 حرفًا على الأقل.".into())}
 let mut db=auth_db(&app)?;let tx=db.transaction().map_err(|e|e.to_string())?;let count:i64=tx.query_row("SELECT COUNT(*) FROM local_users WHERE username IS NOT NULL AND password_hash IS NOT NULL",[],|r|r.get(0)).map_err(|e|e.to_string())?;if count>0{return Err("تم إعداد المدير بالفعل.".into())}
 let mut salt=[0u8;16];rand::thread_rng().fill_bytes(&mut salt);let id=uuid::Uuid::new_v4().to_string();let now=Utc::now().to_rfc3339();
 tx.execute("INSERT INTO local_users(id,display_name,role_codes_json,permissions_json,is_active,last_authenticated_at,username,password_salt,password_hash,created_at) VALUES(?,?,'[\"admin\"]','[\"all\"]',1,?,?,?,?,?)",params![id,display_name.trim(),now,username.trim(),hex::encode(salt),hash_password(&password,&salt),now]).map_err(|e|e.to_string())?;
 tx.execute("UPDATE local_session SET actor_user_id=?,authenticated_at=? WHERE singleton_id=1",params![id,now]).map_err(|e|e.to_string())?;tx.commit().map_err(|e|e.to_string())?;Ok(json!({"id":id,"name":display_name.trim(),"roles":"[\"admin\"]"}))
}
#[tauri::command]
fn login_user(app:tauri::AppHandle,username:String,password:String)->Result<Value,String>{
 let mut db=auth_db(&app)?;let row:Option<(String,String,String,String,i64)>=db.query_row("SELECT id,display_name,password_salt,password_hash,is_active FROM local_users WHERE username=? COLLATE NOCASE",params![username.trim()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(|e|e.to_string())?;
 let(id,name,salt,expected,active)=row.ok_or("اسم المستخدم أو كلمة المرور غير صحيحة.")?;let salt=hex::decode(salt).map_err(|e|e.to_string())?;if active!=1||hash_password(&password,&salt)!=expected{return Err("اسم المستخدم أو كلمة المرور غير صحيحة.".into())}
 let now=Utc::now().to_rfc3339();let tx=db.transaction().map_err(|e|e.to_string())?;tx.execute("UPDATE local_session SET actor_user_id=?,authenticated_at=? WHERE singleton_id=1",params![id,now]).map_err(|e|e.to_string())?;tx.execute("UPDATE local_users SET last_authenticated_at=? WHERE id=?",params![now,id]).map_err(|e|e.to_string())?;tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,created_at) VALUES(lower(hex(randomblob(16))),?,'login','user',?,?)",params![id,id,now]).map_err(|e|e.to_string())?;tx.commit().map_err(|e|e.to_string())?;
 let roles:String=db.query_row("SELECT role_codes_json FROM local_users WHERE id=?",params![id],|r|r.get(0)).map_err(|e|e.to_string())?;Ok(json!({"id":id,"name":name,"roles":roles}))
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
 let db=auth_db(&app)?;require_role(&db,&["admin"])?;let mut st=db.prepare("SELECT id,username,display_name,role_codes_json,is_active,created_at,last_authenticated_at FROM local_users ORDER BY display_name").map_err(|e|e.to_string())?;
 let rows=st.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"username":r.get::<_,Option<String>>(1)?,"name":r.get::<_,String>(2)?,"roles":r.get::<_,String>(3)?,"active":r.get::<_,i64>(4)?,"createdAt":r.get::<_,Option<String>>(5)?,"lastLogin":r.get::<_,Option<String>>(6)?}))).map_err(|e|e.to_string())?;rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}
#[tauri::command]
fn admin_create_user(app:tauri::AppHandle,username:String,display_name:String,password:String,role:String)->Result<(),String>{
 if username.trim().len()<3||display_name.trim().is_empty()||password.chars().count()<12{return Err("أدخل اسم مستخدم واسم موظف وكلمة مرور 12 حرفًا على الأقل.".into())}if !["admin","manager","cashier","viewer"].contains(&role.as_str()){return Err("الدور غير صالح.".into())}
 let mut db=auth_db(&app)?;let(actor,_)=require_role(&db,&["admin"])?;let mut salt=[0u8;16];rand::thread_rng().fill_bytes(&mut salt);let id=uuid::Uuid::new_v4().to_string();let now=Utc::now().to_rfc3339();let tx=db.transaction().map_err(|e|e.to_string())?;
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
    let mut db=auth_db(&app)?; let (actor,_)=require_role(&db,&["admin"])?;
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
    let mut db=auth_db(&app)?; let (actor,_)=require_role(&db,&["admin"])?; let (current,_)=active_user(&db)?;
    if current==user_id && role!="admin" { return Err("لا يمكنك إزالة صلاحية مدير النظام من حسابك الحالي.".into()); }
    let tx=db.transaction().map_err(|e|e.to_string())?;
    let before:String=tx.query_row("SELECT role_codes_json FROM local_users WHERE id=?",params![user_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    tx.execute("UPDATE local_users SET role_codes_json=?,permissions_json=? WHERE id=?",params![json!([role]).to_string(),if role=="admin"{"[\"all\"]"}else{"[]"},user_id]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,before_json,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'user_role_changed','user',?,?,?,?)",params![actor,user_id,json!({"roles":before}).to_string(),json!({"role":role}).to_string(),Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?; Ok(())
}
#[tauri::command]
fn admin_delete_user(app: tauri::AppHandle, user_id: String) -> Result<(), String> {
    let mut db=auth_db(&app)?; let (actor,_)=require_role(&db,&["admin"])?; let (current,_)=active_user(&db)?;
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
    let (actor, _) = require_role(&db, &["admin", "manager"])?;
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
    require_role(&db, &["admin", "manager", "cashier"])?;
    let shift: Option<Value> = db.query_row(
        "SELECT s.id,s.opening_float_minor,s.opened_at,COALESCE(u.display_name,s.opened_by),
          COALESCE((SELECT SUM(p.amount_minor) FROM local_payments p WHERE p.cash_session_id=s.id AND p.method='cash' AND p.status='confirmed'),0),
          COALESCE((SELECT SUM(p.amount_minor) FROM local_payments p WHERE p.cash_session_id=s.id AND p.method<>'cash' AND p.status='confirmed'),0),
          COALESCE((SELECT SUM(e.amount_minor) FROM local_expenses e WHERE e.cash_session_id=s.id AND e.method='cash'),0),
          COALESCE((SELECT SUM(r.amount_minor) FROM local_refunds r WHERE r.cash_session_id=s.id AND r.method='cash'),0)
         FROM local_cash_sessions s LEFT JOIN local_users u ON u.id=s.opened_by
         WHERE s.closed_at IS NULL ORDER BY s.opened_at DESC LIMIT 1",
        [], |row| {
            let opening:i64=row.get(1)?; let cash:i64=row.get(4)?; let electronic:i64=row.get(5)?;
            let expenses:i64=row.get(6)?; let refunds:i64=row.get(7)?;
            Ok(json!({"id":row.get::<_,String>(0)?,"openingFloatMinor":opening,"openedAt":row.get::<_,String>(2)?,"openedBy":row.get::<_,String>(3)?,"cashSalesMinor":cash,"electronicSalesMinor":electronic,"cashExpensesMinor":expenses,"cashRefundsMinor":refunds,"expectedCashMinor":opening.saturating_add(cash).saturating_sub(expenses).saturating_sub(refunds)}))
        }
    ).optional().map_err(|e| e.to_string())?;
    Ok(shift.unwrap_or(Value::Null))
}

#[tauri::command]
fn open_cash_shift(app:tauri::AppHandle,opening_float_minor:i64)->Result<Value,String>{
 if opening_float_minor<0{return Err("رصيد بداية الوردية غير صحيح.".into())}
 let mut db=auth_db(&app)?;
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
 let expected=float.checked_add(sales).and_then(|v|v.checked_sub(expenses)).and_then(|v|v.checked_sub(refunds)).ok_or("قيمة النقدية المتوقعة تجاوزت الحد المسموح.")?;
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
    let (actor, _) = require_role(&db, &["admin"])?;
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
        "SELECT p.id,p.amount_minor,p.method,p.created_at,p.visit_id,p.sale_id,
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
    if !["cash","instapay","wallet"].contains(&method.as_str()) { return Err("طريقة الدفع غير صحيحة.".into()); }
    let mut db = auth_db(&app)?;
    let (actor, _) = require_role(&db, &["admin","manager","cashier"])?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let shift_id: String = tx.query_row("SELECT id FROM local_cash_sessions WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?.ok_or("افتح وردية قبل تسجيل المصروف.")?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    tx.execute("INSERT INTO local_expenses(id,cash_session_id,amount_minor,category,reason,method,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",params![id,shift_id,amount_minor,category.trim(),reason.trim(),method,actor,now]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO local_audit_log(id,actor_user_id,action,entity_type,entity_id,reason,after_json,created_at) VALUES(lower(hex(randomblob(16))),?,'expense_recorded','expense',?,?,?,?)",params![actor,id,reason.trim(),json!({"amount_minor":amount_minor,"category":category,"method":method,"cash_session_id":shift_id}).to_string(),now]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;
    Ok(())
}

#[tauri::command]
fn record_refund(app: tauri::AppHandle, payment_id: String, amount_minor: i64, reason: String) -> Result<(), String> {
    if payment_id.trim().is_empty() || amount_minor <= 0 || reason.trim().is_empty() { return Err("اختر عملية أصلية وأدخل مبلغ الاسترداد وسببه.".into()); }
    let mut db = auth_db(&app)?;
    let (actor, _) = require_role(&db, &["admin","manager","cashier"])?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let original: Option<(i64,String,Option<String>)> = tx.query_row(
        "SELECT amount_minor,method,sale_id FROM local_payments WHERE id=? AND status='confirmed'",
        params![payment_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))
    ).optional().map_err(|e|e.to_string())?;
    let (original_amount,method,sale_id) = original.ok_or("عملية التحصيل الأصلية غير متاحة للاسترداد.")?;
    let refunded: i64 = tx.query_row("SELECT COALESCE(SUM(amount_minor),0) FROM local_refunds WHERE payment_id=?",params![payment_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    let new_total = refunded.checked_add(amount_minor).ok_or("مبلغ الاسترداد تجاوز الحد المسموح.")?;
    if new_total > original_amount { return Err("مبلغ الاسترداد أكبر من المبلغ المتبقي من العملية الأصلية.".into()); }
    let shift_id: String = tx.query_row("SELECT id FROM local_cash_sessions WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?.ok_or("افتح وردية قبل تسجيل الاسترداد.")?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    tx.execute("INSERT INTO local_refunds(id,payment_id,cash_session_id,amount_minor,reason,method,refunded_by,created_at) VALUES(?,?,?,?,?,?,?,?)",params![id,payment_id,shift_id,amount_minor,reason.trim(),method,actor,now]).map_err(|e|e.to_string())?;
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
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:secret-kids-club.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![greet, checkout_child, cancel_visit, update_membership_overtime_rate, list_refundable_payments, record_expense, record_refund, auth_status, setup_first_admin, login_user, logout_user, change_own_password, admin_list_users, admin_create_user, admin_set_user_active, admin_reset_user_password, admin_update_user_role, admin_delete_user, delete_pricing_rule, create_pricing_rule, get_active_cash_shift, open_cash_shift, close_cash_shift, admin_audit_log])
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
