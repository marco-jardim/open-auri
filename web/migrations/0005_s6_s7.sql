-- 0005 · S6 anonymous preference batches and S7 blind trades (T4.1). Plan §3.7.
-- Same ordering rule as 0004: references only "user"("id") (0001) and tables of 0004.

-- S6: one anonymous batch per submission. No account, no IP and no time finer than the UTC day.
-- `receipt_hash` is the SHA-256 (hex) of the random receipt kept by the browser: the batch can be
-- withdrawn with the receipt, and the receipt itself is never stored. `consent_ver` is the version
-- of the consent text the person accepted (LGPD art. 11).
CREATE TABLE s6_batches (
	id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 8 AND 64),
	receipt_hash TEXT NOT NULL UNIQUE
		CHECK (length(receipt_hash) = 64 AND receipt_hash NOT GLOB '*[^0-9a-f]*'),
	consent_ver TEXT NOT NULL CHECK (length(consent_ver) BETWEEN 1 AND 32),
	day TEXT NOT NULL CHECK (length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')
);

CREATE INDEX s6_batches_day ON s6_batches (day);

-- One comparison: `a` and `b` are curve ids (official presets are not in the database, so there
-- is no foreign key). `level_matched` records whether the two were played at matched loudness.
CREATE TABLE s6_pairs (
	id INTEGER PRIMARY KEY,
	batch_id TEXT NOT NULL REFERENCES s6_batches (id) ON DELETE CASCADE,
	a TEXT NOT NULL CHECK (length(a) BETWEEN 1 AND 64 AND a NOT GLOB '*[^a-z0-9._-]*'),
	b TEXT NOT NULL CHECK (length(b) BETWEEN 1 AND 64 AND b NOT GLOB '*[^a-z0-9._-]*'),
	choice TEXT NOT NULL CHECK (choice IN ('a', 'b', 'tie')),
	level_matched INTEGER NOT NULL CHECK (level_matched IN (0, 1)),
	CHECK (a <> b)
);

CREATE INDEX s6_pairs_batch ON s6_pairs (batch_id);

-- S7: a user offers one version of a lineage, waits for a partner, both score the curve they
-- received blind, and both rows are revealed once both scored.
--   match_id   the partner's trade (NULL while waiting, or after the partner's account closure);
--   score      the score (1-5) THIS user gave to the partner's curve;
--   expires_at creation + 72 h while waiting, reset to pairing + 72 h on both rows when matched.
-- At most one active trade ('waiting' or 'matched') per user (partial unique index).
CREATE TABLE trades (
	id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 8 AND 64),
	user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	lineage_id TEXT NOT NULL REFERENCES lineages (id) ON DELETE CASCADE,
	version_id TEXT NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'waiting'
		CHECK (status IN ('waiting', 'matched', 'revealed', 'expired', 'cancelled')),
	match_id TEXT REFERENCES trades (id) ON DELETE SET NULL,
	score INTEGER CHECK (score IS NULL OR score BETWEEN 1 AND 5),
	created_at INTEGER NOT NULL,
	matched_at INTEGER,
	scored_at INTEGER,
	expires_at INTEGER NOT NULL,
	CHECK (match_id IS NULL OR match_id <> id),
	CHECK ((score IS NULL) = (scored_at IS NULL))
);

CREATE UNIQUE INDEX trades_one_active_per_user ON trades (user_id)
	WHERE status IN ('waiting', 'matched');
CREATE INDEX trades_pairing ON trades (status, created_at);
CREATE INDEX trades_active_expiry ON trades (expires_at) WHERE status IN ('waiting', 'matched');
CREATE INDEX trades_user ON trades (user_id, created_at DESC, id DESC);
CREATE INDEX trades_lineage ON trades (lineage_id, status);
CREATE INDEX trades_version ON trades (version_id);
CREATE INDEX trades_match ON trades (match_id);
