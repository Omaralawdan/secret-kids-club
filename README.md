# Secret Kids Club Management System

Starter repository for a Windows POS (offline-first) and mobile-friendly manager dashboard.

## Architecture
- `apps/pos`: Tauri + React + TypeScript desktop POS. SQLite is the local source of truth while offline.
- `apps/manager`: mobile-friendly manager dashboard (PWA foundation).
- `supabase/migrations`: central PostgreSQL schema and Row Level Security policies.
- `docs`: synchronization rules, setup, and test plan.

## Important status
This is the **initial implementation scaffold**, not a production-ready POS yet. Before live use, configure Supabase secrets, implement and test the synchronization worker, receipt printing for your specific printer, authentication screens, and backup/restore drills. Do not use real customer data until security and recovery tests pass.

## Prerequisites
- Node.js LTS and npm
- Rust toolchain and Windows build prerequisites for Tauri
- A Supabase project

## Apply the central schema
1. Create a Supabase project.
2. Open its SQL Editor.
3. Run `supabase/migrations/001_initial_schema.sql`.
4. Create the first manager user in Supabase Auth, then assign the `owner` role using the SQL Editor (instructions in `docs/SETUP.md`).

Never put a Supabase `service_role` key in either client application.

## Planned development order
1. Schema + access control
2. Local SQLite schema + offline transaction queue
3. Visit check-in / checkout
4. Sales, payments, and shift close
5. Inventory, purchases, and recipes
6. Sync worker and conflict handling
7. Manager dashboard, exports, and alerts
8. Printer integration, installer, backup/restore and acceptance testing
