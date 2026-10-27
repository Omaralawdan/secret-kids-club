# Windows POS app

This folder is reserved for the Tauri v2 + React + TypeScript cashier app.

Initial implementation requirements:
- SQLite database created and migrated on first launch.
- Outbox table committed atomically with each local business transaction.
- No service-role key in desktop code.
- Display offline/online status and last successful sync.
- Print receipt through the OS printer service; test with the actual printer model.

Recommended bootstrap command from the repository root after installing Node/Rust prerequisites:

```bash
npm create tauri-app@latest
```

Choose TypeScript / JavaScript, npm, React, TypeScript, then move the generated app into this folder or initialize directly here. Add the SQLite plugin only after checking current Tauri v2 plugin documentation and permissions.
