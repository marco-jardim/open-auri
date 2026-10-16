-- 0003 · Administration audit trail (T3.8).
--
-- audit_log: one row per administrative mutation, written by the /admin actions
-- (web/src/lib/server/admin/audit.ts), by the operator tools (tools/grant-admin.mjs,
-- tools/access-log-query.mjs) and by system jobs. Append-only: rows can never be updated or
-- deleted (triggers below), so the trail survives a compromised admin session. Columns:
--   actor_id    user id of the admin, operator label of a tool run, or NULL for the system;
--   actor_kind  'admin' | 'operator' | 'system';
--   action      stable dotted code ('user.ban', 'user.unban', 'mode.read_only', ...);
--   target_kind / target_id  what was acted upon ('user' + user id, 'config' + key, ...);
--   detail      JSON object without personal data beyond ids (no e-mail, IP, token);
--   created_at  Unix epoch milliseconds.
-- No foreign key to "user": the trail outlives deleted accounts (ids only, never e-mails).
-- Retention: kept for the life of the service (plan §3.8); it holds no personal data beyond ids.
CREATE TABLE audit_log (
	id TEXT PRIMARY KEY NOT NULL,
	actor_id TEXT,
	actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin', 'operator', 'system')),
	action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
	target_kind TEXT,
	target_id TEXT,
	detail TEXT CHECK (detail IS NULL OR json_valid(detail)),
	created_at INTEGER NOT NULL
);

CREATE INDEX audit_log_created_at ON audit_log (created_at DESC, id);
CREATE INDEX audit_log_target ON audit_log (target_kind, target_id, created_at DESC);
CREATE INDEX audit_log_actor ON audit_log (actor_id, created_at DESC);
CREATE INDEX audit_log_action ON audit_log (action, created_at DESC);

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
	SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
	SELECT RAISE(ABORT, 'audit_log is append-only');
END;
