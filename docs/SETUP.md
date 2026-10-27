# Setup notes

## Supabase
1. Create a new Supabase project in the region appropriate for your business.
2. Run `supabase/migrations/001_initial_schema.sql` in the SQL Editor.
3. In Authentication, create the initial manager account.
4. Find that user's UUID in `auth.users`, then run:

```sql
insert into public.user_roles (user_id, role_id)
select '<AUTH_USER_UUID>', id
from public.roles
where code = 'owner'
on conflict do nothing;
```

Replace `<AUTH_USER_UUID>` with the actual UUID. Do not share credentials or service-role keys.

## Local development
The desktop and manager folders are scaffold directories in this first drop. Initialize each app with the current Tauri v2 + React/TypeScript template before adding production UI. Pin dependency versions after confirming compatibility in your environment.

## Deployment checklist
- Enable MFA for owner/admin accounts where possible.
- Configure Supabase Auth redirect URLs for the manager app's production domain.
- Keep secrets in environment variables on trusted server-side services only.
- Configure automated database backups / point-in-time recovery according to the selected Supabase plan.
- Test restoration into a separate project before launch.
- Test Windows installer on the actual cashier computer and printer.

## Local SQLite schema
The initial local schema is in `apps/pos/src-tauri/migrations/001_local_schema.sql`. It stores money in integer minor units (piastres) and measured quantities in milli-units to avoid floating-point arithmetic. Apply it through the desktop app's SQLite migration mechanism; do not manually copy a database file while the app is running.
