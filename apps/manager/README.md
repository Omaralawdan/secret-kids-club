# Manager PWA

Mobile-first dashboard. It should read central, synchronized data only and must show the last successful POS sync timestamp. Do not expose unsynced local POS records directly to the mobile app.

Recommended bootstrap:

```bash
npm create vite@latest . -- --template react-ts
npm install
```

Then add the Supabase client, router, authentication flow, and PWA support. Keep all privileged operations on a trusted server endpoint.
