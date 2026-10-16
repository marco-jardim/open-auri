-- 0007 · Access log (Marco Civil art. 15) and security counters (T3.3).
--
-- access_log_requests: one row per judicial request served by tools/access-log-query.mjs. It is
-- the request's audit trail: rows cannot be deleted, and only exported_count may be filled in, once
-- (NULL until the export finishes). Retention: 5 years (plan Q-LEGAL-FIELDS, requests).
CREATE TABLE access_log_requests (
	id TEXT PRIMARY KEY NOT NULL,
	case_ref TEXT NOT NULL,
	window_from TEXT NOT NULL,
	window_to TEXT NOT NULL,
	requested_at TEXT NOT NULL,
	requested_by TEXT NOT NULL,
	exported_count INTEGER,
	CHECK (window_from < window_to)
);

CREATE INDEX access_log_requests_requested_at ON access_log_requests (requested_at);

CREATE TRIGGER access_log_requests_no_delete
BEFORE DELETE ON access_log_requests
BEGIN
	SELECT RAISE(ABORT, 'access_log_requests is append-only');
END;

CREATE TRIGGER access_log_requests_export_once
BEFORE UPDATE ON access_log_requests
WHEN OLD.exported_count IS NOT NULL
	OR NEW.id IS NOT OLD.id
	OR NEW.case_ref IS NOT OLD.case_ref
	OR NEW.window_from IS NOT OLD.window_from
	OR NEW.window_to IS NOT OLD.window_to
	OR NEW.requested_at IS NOT OLD.requested_at
	OR NEW.requested_by IS NOT OLD.requested_by
BEGIN
	SELECT RAISE(ABORT, 'access_log_requests only records exported_count, once');
END;

-- access_log_objects: index of the encrypted R2 objects written by the jobs Worker, so the
-- operator tool can find a time window without listing the bucket (Wrangler cannot list R2
-- objects). Holds no access data: object key, UTC day, hour (NULL for day-only S6 batches) and the
-- key id. Rows are pruned with the objects by the access-log-retention job (180 days).
CREATE TABLE access_log_objects (
	object_key TEXT PRIMARY KEY NOT NULL,
	day TEXT NOT NULL,
	hour INTEGER,
	key_id TEXT NOT NULL,
	CHECK (hour IS NULL OR (hour BETWEEN 0 AND 23))
);

CREATE INDEX access_log_objects_day ON access_log_objects (day, hour);

-- rate_limit_counters: sliding-window counters for the authentication rules
-- (web/src/lib/server/security/ratelimit.ts). Keys hold only keyed hashes (daily salt), user ids
-- and route groups. Expired windows are deleted daily by the rate-limit-gc job.
CREATE TABLE rate_limit_counters (
	key TEXT NOT NULL,
	window_start INTEGER NOT NULL,
	count INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (key, window_start)
) WITHOUT ROWID;

CREATE INDEX rate_limit_counters_expires_at ON rate_limit_counters (expires_at);
