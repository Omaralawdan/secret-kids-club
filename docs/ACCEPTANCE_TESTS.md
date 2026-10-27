# Acceptance test plan

## Offline POS
- [ ] Start POS while online and sync reference data.
- [ ] Disable internet and register a child visit.
- [ ] Create a cafe sale and payment while offline.
- [ ] Close/reopen the POS while offline; locally saved records remain visible.
- [ ] Restore internet; queued operations sync and become acknowledged.
- [ ] Force a retry of the same operation; verify no duplicate sale/payment/stock movement.
- [ ] Simulate a failed sync; the queue remains pending and can retry safely.

## Money and shifts
- [ ] Cash, InstaPay and wallet payments are recorded separately.
- [ ] Partial/mixed payments cannot exceed invoice total.
- [ ] Discounts require permission and optionally a reason.
- [ ] Refunds/voids preserve the original sale and audit trail.
- [ ] Expected cash at shift close equals opening float + cash received - cash refunds - cash expenses.

## Inventory
- [ ] Selling a ready-made item reduces its stock by quantity sold.
- [ ] Selling a recipe item consumes configured ingredients exactly once.
- [ ] Waste and stock adjustments require permission and a reason.
- [ ] Stock count shows variance before an authorized adjustment is posted.

## Security and backups
- [ ] Cashier cannot access financial reports or user administration without permission.
- [ ] Anonymous users cannot read protected customer/sales/inventory data.
- [ ] Client apps contain no service-role secret.
- [ ] Restore central backup to a separate project and validate row counts.
- [ ] Restore local SQLite backup and verify unsynced outbox items remain queued.
