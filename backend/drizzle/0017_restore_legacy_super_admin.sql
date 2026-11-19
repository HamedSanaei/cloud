-- PostgreSQL permits assigning the enum value only once the DDL transaction commits.
-- The migration runner consumes this marker before it releases the writer lock.
INSERT INTO settings (key, value) VALUES ('auth.legacy_super_admin_backfill', '"pending"'::jsonb)
ON CONFLICT (key) DO NOTHING;
