# Offline-first synchronization design

## Local-first transaction flow
1. The POS generates a UUID on the device for each business transaction.
2. In a single SQLite transaction, it writes the business record and an outbox record.
3. The UI confirms that the transaction is saved locally, even without internet.
4. When online, the sync worker sends queued operations in order to a trusted server endpoint.
5. The server validates the authenticated user/device and permissions, applies the operation idempotently, and records the UUID in `sync_operations`.
6. The local outbox item is marked synced only after a server acknowledgement.

## Idempotency
- Every transaction has a client-generated UUID.
- The server enforces unique operation IDs. Replaying an acknowledged operation must not create a second sale, payment, stock movement, or visit.
- Never mark an outbox item synced before receiving the server acknowledgement.

## Conflict policy for the single POS device
- Product and price configuration is downloaded and cached with a version number.
- During an outage, the POS uses its last synchronized configuration and visibly shows when it was last updated.
- Financial transactions are append-only. Corrections use void/refund/adjustment records, not destructive edits.
- Stock movements are append-only. The server derives stock from movements; it does not blindly overwrite a central stock count with a local count.
- Membership balance/usage must be reserved locally and reconciled by operation ID. Do not permit offline membership use beyond a configured risk limit.
- Server timestamps and local timestamps are both retained.

## Security
Do not connect a desktop client with the Supabase service-role key. The production design should use authenticated requests and a server-side sync endpoint (for example, a Supabase Edge Function) that validates role, device, payload shape, and idempotency before writing records.

## Recovery
- SQLite database and outbox must be included in an encrypted, controlled local backup process.
- If the device fails before sync, recovery depends on the local database backup; cloud backups cannot contain unsynced records.
- Test restoring both local SQLite and central PostgreSQL data.
