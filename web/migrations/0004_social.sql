-- 0004 · Social core (T4.1): curves, lineages and versions, favorites, activity, shares and their
-- funnel, packs and reports. Plan §3.7 and annex A.2, adapted: the profile lives on "user" columns
-- (0009) and the nickname history is username_holds (0009), so neither is created here.
--
-- Migration order: on a fresh database this file runs BEFORE 0007-0010, on an already migrated
-- one it runs after them. It references only "user"("id") (0001) and its own tables.
-- Times are epoch milliseconds (INTEGER). All access goes through web/src/lib/server/social/repo.ts
-- (see the README there for the visibility rules and the deletion semantics).

-- Content-addressed curves. `id` is curveId(s1) of open-auri/share (12 characters of lowercase
-- RFC 4648 base32). The row is also the cache of the server gate: `gate_ver` identifies the gate
-- that produced `gate_ok`/`gate_reasons` (a JSON array of reason codes), and is re-run by the
-- service when it differs from the current one. No author column: a curve carries no personal data.
CREATE TABLE curves (
	id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 12 AND id NOT GLOB '*[^a-z2-7]*'),
	s1 TEXT NOT NULL UNIQUE CHECK (length(s1) = 68),
	canon_key TEXT NOT NULL CHECK (length(canon_key) BETWEEN 1 AND 512),
	gate_ver TEXT NOT NULL CHECK (length(gate_ver) BETWEEN 1 AND 64),
	gate_ok INTEGER NOT NULL CHECK (gate_ok IN (0, 1)),
	gate_reasons TEXT NOT NULL CHECK (json_valid(gate_reasons) AND json_type(gate_reasons) = 'array'),
	level_db REAL,
	created_at INTEGER NOT NULL
);

CREATE INDEX curves_canon_key ON curves (canon_key);

-- The identity of a curve never changes (only the gate cache columns may be updated).
CREATE TRIGGER curves_identity_immutable
BEFORE UPDATE ON curves
WHEN NEW.id IS NOT OLD.id OR NEW.s1 IS NOT OLD.s1 OR NEW.canon_key IS NOT OLD.canon_key
BEGIN
	SELECT RAISE(ABORT, 'curve_immutable: curves.id, s1 and canon_key cannot change');
END;

-- A lineage is the public identity of a creation; its versions form one linear history.
--   owner_user_id        NULL after an anonymized account closure ("autor removido");
--   forked_from_version  version this lineage was forked from, NULL when that version is deleted
--                        (the fork survives);
--   head_version         latest version, NULL only between the INSERT of a lineage and the
--                        INSERT of its root version (same batch);
--   status               owner tombstone ('retracted'), undone by the owner;
--   moderation           set by moderation only, separate from status so an owner cannot undo it;
--   curated              editorial pick (admin).
CREATE TABLE lineages (
	id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 8 AND 64),
	owner_user_id TEXT REFERENCES "user" ("id") ON DELETE SET NULL,
	forked_from_version TEXT REFERENCES versions (id) ON DELETE SET NULL,
	head_version TEXT REFERENCES versions (id) ON DELETE SET NULL,
	visibility TEXT NOT NULL CHECK (visibility IN ('private', 'unlisted', 'public')),
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retracted')),
	moderation TEXT NOT NULL DEFAULT 'visible'
		CHECK (moderation IN ('visible', 'auto_hidden', 'hidden', 'removed')),
	curated INTEGER NOT NULL DEFAULT 0 CHECK (curated IN (0, 1)),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX lineages_owner ON lineages (owner_user_id, created_at DESC, id DESC);
CREATE INDEX lineages_forked_from ON lineages (forked_from_version);
CREATE INDEX lineages_head ON lineages (head_version);
CREATE INDEX lineages_public_feed ON lineages (created_at DESC, id DESC)
	WHERE visibility = 'public' AND status = 'active' AND moderation = 'visible';

-- Versions are append-only (Total Recall). UNIQUE (lineage_id, parent_id) plus the single-root
-- index make the history linear: two versions appended to the same parent fail atomically.
CREATE TABLE versions (
	id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 8 AND 64),
	lineage_id TEXT NOT NULL REFERENCES lineages (id) ON DELETE CASCADE,
	parent_id TEXT REFERENCES versions (id) ON DELETE CASCADE,
	curve_id TEXT NOT NULL REFERENCES curves (id) ON DELETE RESTRICT,
	name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
	description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
	license TEXT NOT NULL CHECK (license IN ('CC0-1.0', 'CC-BY-4.0')),
	recipe TEXT CHECK (recipe IS NULL OR (json_valid(recipe) AND length(recipe) <= 16384)),
	lang TEXT NOT NULL CHECK (lang IN ('pt-BR', 'en-US')),
	created_at INTEGER NOT NULL,
	UNIQUE (lineage_id, parent_id),
	CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE UNIQUE INDEX versions_single_root ON versions (lineage_id) WHERE parent_id IS NULL;
CREATE INDEX versions_lineage ON versions (lineage_id, created_at DESC);
CREATE INDEX versions_parent ON versions (parent_id);
CREATE INDEX versions_curve ON versions (curve_id);

-- Invariant §0.12.4, defense in depth: no version (root, new version or fork) may reference a
-- curve the server gate rejected (or a curve that is not there).
CREATE TRIGGER versions_gate_ok
BEFORE INSERT ON versions
WHEN (SELECT gate_ok FROM curves WHERE id = NEW.curve_id) IS NOT 1
BEGIN
	SELECT RAISE(ABORT, 'gate_rejected: the curve of a version must pass the safety gate');
END;

CREATE TRIGGER versions_parent_same_lineage
BEFORE INSERT ON versions
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM versions p WHERE p.id = NEW.parent_id AND p.lineage_id = NEW.lineage_id
)
BEGIN
	SELECT RAISE(ABORT, 'parent_lineage: a parent version must belong to the same lineage');
END;

-- Append-only. Foreign-key actions on versions are all CASCADE deletes, never updates.
CREATE TRIGGER versions_append_only
BEFORE UPDATE ON versions
BEGIN
	SELECT RAISE(ABORT, 'versions_append_only: versions cannot be updated');
END;

CREATE TRIGGER lineages_head_null_on_insert
BEFORE INSERT ON lineages
WHEN NEW.head_version IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'head_on_insert: a lineage is created without a head');
END;

-- The head only moves forward, to a child of the current head in the same lineage (the root when
-- there is no head yet). Clearing it (NULL) happens only when its versions are deleted.
CREATE TRIGGER lineages_head_advances
BEFORE UPDATE OF head_version ON lineages
WHEN NEW.head_version IS NOT OLD.head_version AND NEW.head_version IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM versions v
	WHERE v.id = NEW.head_version AND v.lineage_id = NEW.id AND v.parent_id IS OLD.head_version
)
BEGIN
	SELECT RAISE(ABORT, 'head_not_child: the head must advance to a child of the current head');
END;

-- Ownership is never transferred, only removed (anonymized closure).
CREATE TRIGGER lineages_owner_fixed
BEFORE UPDATE OF owner_user_id ON lineages
WHEN NEW.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NOT OLD.owner_user_id
BEGIN
	SELECT RAISE(ABORT, 'owner_transfer: lineage ownership cannot be transferred');
END;

CREATE TABLE favorites (
	user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	lineage_id TEXT NOT NULL REFERENCES lineages (id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, lineage_id)
) WITHOUT ROWID;

CREATE INDEX favorites_user ON favorites (user_id, created_at DESC, lineage_id DESC);
CREATE INDEX favorites_lineage ON favorites (lineage_id, created_at);

-- One row per user, lineage and kind ('previewed' = audible preview of 10 s or more,
-- 'installed' = real write to the device), deduplicated, with first and last time and a count.
CREATE TABLE activity (
	user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	lineage_id TEXT NOT NULL REFERENCES lineages (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('previewed', 'installed')),
	first_at INTEGER NOT NULL,
	last_at INTEGER NOT NULL,
	count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
	PRIMARY KEY (user_id, lineage_id, kind),
	CHECK (first_at <= last_at)
) WITHOUT ROWID;

CREATE INDEX activity_user ON activity (user_id, last_at DESC, lineage_id DESC, kind);
CREATE INDEX activity_lineage ON activity (lineage_id, kind, last_at DESC);
CREATE INDEX activity_kind_last ON activity (kind, last_at);

-- A share link /c/<lineage>?s=<share id>. `owner_user_id` is the user who shared (not
-- necessarily the author). `channel` is a short free code ('link', 'qr', ...).
CREATE TABLE shares (
	id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 8 AND 64),
	lineage_id TEXT NOT NULL REFERENCES lineages (id) ON DELETE CASCADE,
	version_id TEXT REFERENCES versions (id) ON DELETE CASCADE,
	owner_user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	channel TEXT CHECK (
		channel IS NULL OR (length(channel) BETWEEN 1 AND 24 AND channel NOT GLOB '*[^a-z0-9-]*')
	),
	created_at INTEGER NOT NULL
);

CREATE INDEX shares_owner ON shares (owner_user_id, created_at DESC, id DESC);
CREATE INDEX shares_lineage ON shares (lineage_id);
CREATE INDEX shares_version ON shares (version_id);

-- Anonymous funnel: a daily counter per share and kind, no identity of any kind.
CREATE TABLE share_events (
	share_id TEXT NOT NULL REFERENCES shares (id) ON DELETE CASCADE,
	day TEXT NOT NULL CHECK (length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
	kind TEXT NOT NULL CHECK (kind IN ('open', 'previewed', 'installed', 'favorited')),
	anon_count INTEGER NOT NULL DEFAULT 0 CHECK (anon_count >= 0),
	PRIMARY KEY (share_id, day, kind)
) WITHOUT ROWID;

-- Attributed funnel: signed-in users who previewed, installed or favorited through a share, once
-- per kind. Only counts leave the repository; identities are never exposed to the sharer.
CREATE TABLE share_event_users (
	share_id TEXT NOT NULL REFERENCES shares (id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('previewed', 'installed', 'favorited')),
	at INTEGER NOT NULL,
	PRIMARY KEY (share_id, user_id, kind)
) WITHOUT ROWID;

CREATE INDEX share_event_users_user ON share_event_users (user_id);

CREATE TABLE packs (
	id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 8 AND 64),
	owner_user_id TEXT REFERENCES "user" ("id") ON DELETE SET NULL,
	name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
	description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
	visibility TEXT NOT NULL CHECK (visibility IN ('private', 'unlisted', 'public')),
	moderation TEXT NOT NULL DEFAULT 'visible'
		CHECK (moderation IN ('visible', 'auto_hidden', 'hidden', 'removed')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX packs_owner ON packs (owner_user_id, created_at DESC, id DESC);
CREATE INDEX packs_public ON packs (created_at DESC, id DESC)
	WHERE visibility = 'public' AND moderation = 'visible';

CREATE TRIGGER packs_owner_fixed
BEFORE UPDATE OF owner_user_id ON packs
WHEN NEW.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NOT OLD.owner_user_id
BEGIN
	SELECT RAISE(ABORT, 'owner_transfer: pack ownership cannot be transferred');
END;

-- `license` is copied from the head version when the item is added (shown per curve).
CREATE TABLE pack_items (
	pack_id TEXT NOT NULL REFERENCES packs (id) ON DELETE CASCADE,
	lineage_id TEXT NOT NULL REFERENCES lineages (id) ON DELETE CASCADE,
	position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 199),
	license TEXT NOT NULL CHECK (license IN ('CC0-1.0', 'CC-BY-4.0')),
	PRIMARY KEY (pack_id, lineage_id),
	UNIQUE (pack_id, position)
) WITHOUT ROWID;

CREATE INDEX pack_items_lineage ON pack_items (lineage_id);

-- Moderation reports. One report per reporter and target. `reporter_user_id` becomes NULL when a
-- resolved report outlives its reporter's account (see the deletion part).
CREATE TABLE reports (
	id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 8 AND 64),
	target_kind TEXT NOT NULL CHECK (target_kind IN ('lineage', 'pack', 'user')),
	target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 64),
	reason TEXT NOT NULL
		CHECK (reason IN ('dangerous', 'spam', 'offensive', 'copyright', 'impersonation', 'other')),
	note TEXT CHECK (note IS NULL OR length(note) <= 500),
	reporter_user_id TEXT REFERENCES "user" ("id") ON DELETE SET NULL,
	created_at INTEGER NOT NULL,
	resolution TEXT
		CHECK (resolution IS NULL OR resolution IN ('dismissed', 'hidden', 'removed', 'restored', 'banned')),
	resolved_at INTEGER,
	UNIQUE (target_kind, target_id, reporter_user_id),
	CHECK ((resolution IS NULL) = (resolved_at IS NULL))
);

CREATE INDEX reports_target ON reports (target_kind, target_id, created_at);
CREATE INDEX reports_open ON reports (created_at, id) WHERE resolution IS NULL;
CREATE INDEX reports_reporter ON reports (reporter_user_id);
