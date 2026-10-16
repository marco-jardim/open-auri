-- T3.7: account area. Profile columns on Better Auth's "user" table (0001) plus the tables the
-- account area owns. D1 applies migrations in file-name order, so on a fresh database 0004-0006
-- (Phase 4) run BEFORE this file: nothing in 0004-0006 may reference what is created here, and this
-- file only adds columns and creates tables of its own (0001's "user" already exists).
--
-- Times are epoch milliseconds (INTEGER), unlike Better Auth's own DATE columns.

-- Public profile (plan §3.7). Private by default. The bio is plain text (escaped on output), at most
-- 280 characters (SQLite length() counts characters, not bytes).
ALTER TABLE "user" ADD COLUMN "bio" TEXT CHECK ("bio" IS NULL OR length("bio") <= 280);
ALTER TABLE "user" ADD COLUMN "activity_visibility" TEXT NOT NULL DEFAULT 'private'
	CHECK ("activity_visibility" IN ('private', 'public'));
ALTER TABLE "user" ADD COLUMN "library_visibility" TEXT NOT NULL DEFAULT 'private'
	CHECK ("library_visibility" IN ('private', 'public'));
-- Last nickname choice made in /conta (the 30-day change clock). NULL: never changed there.
ALTER TABLE "user" ADD COLUMN "username_changed_at" INTEGER;

-- Nicknames released by a change (or by an anonymized account closure) stay reserved for 90 days.
-- `skeleton` is the confusable skeleton (auth/username.ts), so look-alikes are held too.
-- `user_id` is the previous owner (may reclaim it during the hold, NULL after account closure),
-- `redirect_to` is the owner's current nickname, kept up to date on every later change, so
-- /u/<old> redirects to /u/<current> until `released_at`. Expired rows are ignored and may be
-- overwritten. No foreign key: account closure removes the owner's rows explicitly.
CREATE TABLE IF NOT EXISTS username_holds (
	skeleton TEXT PRIMARY KEY,
	username TEXT NOT NULL,
	user_id TEXT,
	released_at INTEGER NOT NULL,
	redirect_to TEXT
);

CREATE INDEX IF NOT EXISTS username_holds_user_idx ON username_holds (user_id);

-- Pending e-mail change shown in /conta. Better Auth's change-email tokens are signed JWTs and
-- leave no row behind, so the account area records the request itself. Cleared when the address
-- changes, on a new request, or ignored after `expires_at`.
CREATE TABLE IF NOT EXISTS email_change_requests (
	user_id TEXT NOT NULL PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
	new_email TEXT NOT NULL,
	requested_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);

-- Content policy chosen when the closure was requested, read by the beforeDelete hook when the
-- mailed confirmation link is opened (account/deletion.ts).
CREATE TABLE IF NOT EXISTS account_deletion_requests (
	user_id TEXT NOT NULL PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
	mode TEXT NOT NULL CHECK (mode IN ('anonymize', 'delete-all')),
	requested_at INTEGER NOT NULL
);
