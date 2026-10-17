-- 0011 · Audit retention (T5.3, docs/lgpd.md operation 12: 5 years).
--
-- 0003 made audit_log append-only with a trigger that refuses every DELETE. The retention of the
-- trail is 5 years, purged by the daily cleanup job (workers/jobs/src/jobs/cleanup.ts), so the
-- delete trigger is replaced by one that still refuses deleting any row younger than 5 years
-- (calendar years, against the database clock). Updates stay forbidden (audit_log_no_update of
-- 0003 is untouched). The cleanup job uses a cutoff one day older than this one, so it never trips
-- the trigger. The error message is the same as 0003's.
DROP TRIGGER IF EXISTS audit_log_no_delete;

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
WHEN OLD.created_at >= CAST(strftime('%s', 'now', '-5 years') AS INTEGER) * 1000
BEGIN
	SELECT RAISE(ABORT, 'audit_log is append-only');
END;
