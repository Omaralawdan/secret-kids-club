-- Link a completed reservation to the actual guardian visit without changing historical visits.
ALTER TABLE local_visits ADD COLUMN booking_id TEXT REFERENCES local_bookings(id);
CREATE UNIQUE INDEX IF NOT EXISTS local_visits_booking_unique_idx
  ON local_visits(booking_id) WHERE booking_id IS NOT NULL;
