-- 0006 · Materialized rankings (T4.1, recomputed by the rankings job of T4.6). Plan §3.7.
-- Same ordering rule as 0004: references only tables of 0004.
--
-- `"window"` is always quoted: WINDOW is an SQL keyword.
-- One full set of rows per (metric, window), replaced atomically in one batch by
-- repo.recomputeRankings: rows are deleted and re-inserted together and ranking_state records the
-- computation time. A run older than the stored one changes nothing, so retries and overlapping
-- runs are idempotent.
CREATE TABLE rankings (
	metric TEXT NOT NULL CHECK (metric IN ('favorites', 'installs')),
	"window" TEXT NOT NULL CHECK ("window" IN ('7d', '30d', 'all')),
	lineage_id TEXT NOT NULL REFERENCES lineages (id) ON DELETE CASCADE,
	score INTEGER NOT NULL CHECK (score >= 0),
	rank INTEGER NOT NULL CHECK (rank >= 1),
	computed_at INTEGER NOT NULL,
	PRIMARY KEY (metric, "window", lineage_id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX rankings_rank ON rankings (metric, "window", rank);
CREATE INDEX rankings_lineage ON rankings (lineage_id);

CREATE TABLE ranking_state (
	metric TEXT NOT NULL CHECK (metric IN ('favorites', 'installs')),
	"window" TEXT NOT NULL CHECK ("window" IN ('7d', '30d', 'all')),
	computed_at INTEGER NOT NULL,
	row_count INTEGER NOT NULL CHECK (row_count >= 0),
	PRIMARY KEY (metric, "window")
) WITHOUT ROWID;
