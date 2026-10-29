use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

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

fn checkout_transaction(
    path: &Path,
    visit_child_id: &str,
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
                p.calculation_json
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

    let hourly_rate = calculation
        .get("hourlyRateMinor")
        .and_then(Value::as_i64)
        .filter(|rate| *rate >= 0);

    if pricing_type == "hourly" && hourly_rate.is_none() {
        return Err(io::Error::other(
            "Hourly checkout cancelled: the saved hourly rate is missing or invalid. Check the child's pricing before trying again.",
        )
        .into());
    }

    let overtime_minutes = if pricing_type == "hourly" && booked_minutes > 0 {
        actual_minutes
            .checked_sub(booked_minutes)
            .ok_or_else(|| io::Error::other("Overtime calculation overflowed."))?
            .max(0)
    } else {
        0
    };

    let overtime_amount = if pricing_type == "hourly" && overtime_minutes > 0 {
        let rate = hourly_rate.ok_or_else(|| {
            io::Error::other("Hourly rate is unavailable. Checkout was cancelled.")
        })?;
        rate.checked_mul(overtime_minutes)
            .and_then(|amount| amount.checked_add(30))
            .ok_or_else(|| io::Error::other("Overtime amount overflowed."))?
            / 60
    } else {
        0
    };

    let base_final_amount = base_amount
        .checked_sub(discount_amount)
        .ok_or_else(|| io::Error::other("Base price calculation overflowed."))?
        .max(0);
    let final_child_amount = base_final_amount
        .checked_add(overtime_amount)
        .ok_or_else(|| io::Error::other("Final child price overflowed."))?;
    let checkout_time_string =
        checkout_time.to_rfc3339_opts(SecondsFormat::Millis, true);

    calculation["actualDurationMinutes"] = json!(actual_minutes);
    calculation["overtimeMinutes"] = json!(overtime_minutes);
    calculation["overtimeAmountMinor"] = json!(overtime_amount);
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
            final_amount_minor = ?,
            calculation_json = ?
        WHERE visit_child_id = ?
        "#,
        params![
            overtime_minutes,
            overtime_amount,
            final_child_amount,
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
    }

    // All child, pricing, and final-visit updates commit together.
    tx.commit()?;
    Ok(())
}

fn extend_child_time_transaction(
    path: &Path,
    visit_child_id: &str,
    extension_minutes: i64,
) -> Result<(), Box<dyn Error>> {
    if ![15, 30, 60, 120].contains(&extension_minutes) {
        return Err(io::Error::other("Choose an extension of 15, 30, 60, or 120 minutes.").into());
    }

    let mut connection = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let record = tx.query_row(
        r#"
        SELECT v.status, vc.checked_out_at, vc.child_name_snapshot,
               p.pricing_type, p.duration_minutes, p.base_amount_minor,
               p.discount_amount_minor, p.calculation_json, p.membership_id,
               r.amount_minor, r.duration_minutes
        FROM local_visit_children vc
        JOIN local_visits v ON v.id = vc.visit_id
        JOIN local_visit_child_pricing p ON p.visit_child_id = vc.id
        LEFT JOIN local_pricing_rules r ON r.id = p.pricing_rule_id
        WHERE vc.id = ?
        "#,
        params![visit_child_id],
        |row| Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, Option<String>>(8)?,
            row.get::<_, Option<i64>>(9)?,
            row.get::<_, Option<i64>>(10)?,
        )),
    ).optional()?.ok_or_else(|| io::Error::new(
        io::ErrorKind::NotFound, "The child's active visit was not found."
    ))?;

    let (status, checked_out_at, child_name, pricing_type, duration, base, discount,
         calculation_json, membership_id, rule_amount, rule_duration) = record;
    if status != "active" || checked_out_at.is_some() {
        return Err(io::Error::other("This child is no longer on an active visit.").into());
    }
    if pricing_type == "membership" || membership_id.is_some() {
        return Err(io::Error::other(
            "Membership time extensions are blocked until package balance deduction is enabled. No changes were saved."
        ).into());
    }

    let mut calculation: Value = serde_json::from_str(&calculation_json)?;
    if !calculation.is_object() {
        return Err(io::Error::other("The saved pricing calculation is invalid.").into());
    }

    let saved_rate = calculation.get("hourlyRateMinor").and_then(Value::as_i64)
        .filter(|rate| *rate >= 0);
    let configured_duration = rule_duration.filter(|value| *value > 0).unwrap_or(duration);
    let configured_rate = match (rule_amount, configured_duration) {
        (Some(amount), d) if amount >= 0 && d > 0 => {
            amount.checked_mul(60)
                .and_then(|value| value.checked_add(d / 2))
                .map(|value| value / d)
        }
        _ => None,
    };
    let rate = saved_rate.or(configured_rate).ok_or_else(|| io::Error::other(
        "Cannot extend this visit because its pricing rule has no usable rate or duration."
    ))?;

    let charge = rate.checked_mul(extension_minutes)
        .and_then(|value| value.checked_add(30))
        .ok_or_else(|| io::Error::other("Extension price overflowed."))? / 60;
    let new_duration = duration.checked_add(extension_minutes)
        .ok_or_else(|| io::Error::other("Visit duration overflowed."))?;
    let new_base = base.checked_add(charge)
        .ok_or_else(|| io::Error::other("Visit price overflowed."))?;
    let new_final = new_base.checked_sub(discount)
        .ok_or_else(|| io::Error::other("Visit discount calculation overflowed."))?
        .max(0);

    let extended_at = Utc::now();
    let extended_at_string = extended_at.to_rfc3339_opts(SecondsFormat::Millis, true);
    let next_expiry = (extended_at + chrono::Duration::minutes(extension_minutes))
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut extensions = calculation.get("extensions")
        .and_then(Value::as_array).cloned().unwrap_or_default();
    extensions.push(json!({
        "minutes": extension_minutes,
        "chargeMinor": charge,
        "extendedAt": extended_at_string,
        "expiresAt": next_expiry,
    }));
    calculation["bookedDurationMinutes"] = json!(new_duration);
    calculation["expiresAt"] = json!(next_expiry);
    calculation["extensionCount"] = json!(extensions.len());
    calculation["extensions"] = json!(extensions);

    let updated = tx.execute(
        r#"UPDATE local_visit_child_pricing
           SET duration_minutes = ?, base_amount_minor = ?, final_amount_minor = ?,
               calculation_json = ?
           WHERE visit_child_id = ?"#,
        params![new_duration, new_base, new_final, serde_json::to_string(&calculation)?, visit_child_id],
    )?;
    if updated != 1 {
        return Err(io::Error::other("Could not update the visit pricing.").into());
    }

    tx.execute(
        r#"INSERT INTO local_audit_log
           (actor_user_id, action, entity_type, entity_id, reason, before_json, after_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
        params![
            "local-cashier",
            "visit_time_extended",
            "visit_child_pricing",
            visit_child_id,
            "Booked visit time extended after expiry alert",
            serde_json::to_string(&json!({
                "childName": child_name,
                "durationMinutes": duration,
                "baseAmountMinor": base,
            }))?,
            serde_json::to_string(&json!({
                "childName": child_name,
                "durationMinutes": new_duration,
                "baseAmountMinor": new_base,
                "finalAmountMinor": new_final,
                "extensionMinutes": extension_minutes,
                "extensionChargeMinor": charge,
                "expiresAt": next_expiry,
            }))?,
            extended_at_string,
        ],
    )?;

    tx.commit()?;
    Ok(())
}

#[tauri::command]
fn extend_child_time(
    app: tauri::AppHandle,
    visit_child_id: String,
    extension_minutes: i64,
) -> Result<(), String> {
    if visit_child_id.trim().is_empty() {
        return Err("Missing child visit ID.".to_string());
    }
    let path = database_path(&app).map_err(|error| error.to_string())?;
    extend_child_time_transaction(&path, &visit_child_id, extension_minutes)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn checkout_child(
    app: tauri::AppHandle,
    visit_child_id: String,
) -> Result<(), String> {
    if visit_child_id.trim().is_empty() {
        return Err("Missing child visit ID.".to_string());
    }

    let path = database_path(&app).map_err(|error| error.to_string())?;
    checkout_transaction(&path, &visit_child_id).map_err(|error| error.to_string())
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
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:secret-kids-club.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![greet, checkout_child, extend_child_time])
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
            CREATE TABLE local_visit_child_pricing (
                id TEXT PRIMARY KEY,
                visit_child_id TEXT NOT NULL UNIQUE,
                pricing_type TEXT NOT NULL,
                duration_minutes INTEGER NOT NULL DEFAULT 0,
                base_amount_minor INTEGER NOT NULL DEFAULT 0,
                discount_amount_minor INTEGER NOT NULL DEFAULT 0,
                calculation_json TEXT NOT NULL DEFAULT '{}',
                overtime_minutes INTEGER NOT NULL DEFAULT 0,
                overtime_amount_minor INTEGER NOT NULL DEFAULT 0,
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


#[cfg(test)]
mod extension_tests {
    use super::extend_child_time_transaction;
    use rusqlite::{params, Connection};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn extension_db(membership: bool) -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("skc-extension-test-{}-{nonce}.db", std::process::id()));
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE local_visits (
                id TEXT PRIMARY KEY, status TEXT NOT NULL
            );
            CREATE TABLE local_visit_children (
                id TEXT PRIMARY KEY, visit_id TEXT NOT NULL,
                child_name_snapshot TEXT NOT NULL, checked_out_at TEXT
            );
            CREATE TABLE local_pricing_rules (
                id TEXT PRIMARY KEY, amount_minor INTEGER, duration_minutes INTEGER
            );
            CREATE TABLE local_visit_child_pricing (
                id TEXT PRIMARY KEY, visit_child_id TEXT NOT NULL,
                pricing_type TEXT NOT NULL, pricing_rule_id TEXT,
                membership_id TEXT, duration_minutes INTEGER NOT NULL,
                base_amount_minor INTEGER NOT NULL, discount_amount_minor INTEGER NOT NULL,
                final_amount_minor INTEGER NOT NULL, calculation_json TEXT NOT NULL
            );
            CREATE TABLE local_audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id TEXT NOT NULL,
                action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT,
                reason TEXT, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL
            );
            INSERT INTO local_visits (id, status) VALUES ('visit-1', 'active');
            INSERT INTO local_visit_children (id, visit_id, child_name_snapshot)
                VALUES ('child-1', 'visit-1', 'Test child');
            INSERT INTO local_pricing_rules (id, amount_minor, duration_minutes)
                VALUES ('rule-1', 6000, 60);"
        ).unwrap();
        db.execute(
            "INSERT INTO local_visit_child_pricing
             (id, visit_child_id, pricing_type, pricing_rule_id, membership_id,
              duration_minutes, base_amount_minor, discount_amount_minor,
              final_amount_minor, calculation_json)
             VALUES ('pricing-1', 'child-1', ?, 'rule-1', ?, 60, 6000, 0, 6000, ?)",
            params![
                if membership { "membership" } else { "hourly" },
                if membership { Some("membership-1") } else { None },
                if membership { r#"{"hourlyRateMinor":6000}"# } else { r#"{"hourlyRateMinor":6000}"# }
            ],
        ).unwrap();
        drop(db);
        path
    }

    #[test]
    fn extension_updates_price_duration_expiry_and_audit_atomically() {
        let path = extension_db(false);
        extend_child_time_transaction(&path, "child-1", 30).unwrap();

        let db = Connection::open(&path).unwrap();
        let saved: (i64, i64, i64, String) = db.query_row(
            "SELECT duration_minutes, base_amount_minor, final_amount_minor, calculation_json
             FROM local_visit_child_pricing WHERE visit_child_id = 'child-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        assert_eq!(saved.0, 90);
        assert_eq!(saved.1, 9000);
        assert_eq!(saved.2, 9000);
        assert!(saved.3.contains("expiresAt"));

        let audit_count: i64 = db.query_row(
            "SELECT COUNT(*) FROM local_audit_log WHERE action = 'visit_time_extended'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(audit_count, 1);
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn membership_extension_is_rejected_without_changing_records() {
        let path = extension_db(true);
        assert!(extend_child_time_transaction(&path, "child-1", 30).is_err());
        let db = Connection::open(&path).unwrap();
        let saved: (i64, i64) = db.query_row(
            "SELECT duration_minutes, base_amount_minor FROM local_visit_child_pricing
             WHERE visit_child_id = 'child-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(saved, (60, 6000));
        let audit_count: i64 = db.query_row(
            "SELECT COUNT(*) FROM local_audit_log",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(audit_count, 0);
        drop(db);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn unsupported_extension_duration_is_rejected() {
        let path = extension_db(false);
        assert!(extend_child_time_transaction(&path, "child-1", 20).is_err());
        let _ = std::fs::remove_file(path);
    }
}
