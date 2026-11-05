CREATE TABLE IF NOT EXISTS local_bookings (
  id TEXT PRIMARY KEY,
  booking_type TEXT NOT NULL CHECK(booking_type IN ('visit','birthday')),
  guardian_name TEXT NOT NULL,
  guardian_phone TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK(duration_minutes > 0),
  child_count INTEGER NOT NULL DEFAULT 1 CHECK(child_count > 0),
  guest_count INTEGER NOT NULL DEFAULT 0 CHECK(guest_count >= 0),
  status TEXT NOT NULL DEFAULT 'booked' CHECK(status IN ('booked','confirmed','completed','cancelled')),
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS local_bookings_scheduled_idx ON local_bookings(scheduled_at,status);
