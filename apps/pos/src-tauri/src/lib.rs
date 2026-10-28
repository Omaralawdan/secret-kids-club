use tauri_plugin_sql::{Migration, MigrationKind};

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
            sql: include_str!(
                "../migrations/003_customer_profiles_and_membership_usage.sql"
            ),
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
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
