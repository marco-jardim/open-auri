-- FXP-B: opaque, stable public author ids, distinct from private auth ids and nicknames.
ALTER TABLE "user" ADD COLUMN public_author_id TEXT;
UPDATE "user" SET public_author_id = lower(hex(randomblob(16))) WHERE public_author_id IS NULL;
CREATE UNIQUE INDEX user_public_author_id ON "user" (public_author_id);
CREATE TRIGGER user_public_author_id AFTER INSERT ON "user" WHEN NEW.public_author_id IS NULL
BEGIN
	UPDATE "user" SET public_author_id = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;

-- Private viewer preferences, not moderation or reports. Curve = lineage id (all versions).
CREATE TABLE hidden_items (
	user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	target_type TEXT NOT NULL CHECK (target_type IN ('author', 'curve')),
	target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 64),
	label TEXT CHECK (label IS NULL OR length(label) <= 80),
	created_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, target_type, target_id)
);

-- Enforce the per-type cap even for concurrent merges. A failed D1 batch rolls back in full.
CREATE TRIGGER hidden_items_limit BEFORE INSERT ON hidden_items
WHEN NOT EXISTS (
	SELECT 1 FROM hidden_items WHERE user_id = NEW.user_id
	AND target_type = NEW.target_type AND target_id = NEW.target_id
) AND (SELECT count(*) FROM hidden_items
	WHERE user_id = NEW.user_id AND target_type = NEW.target_type) >= 500
BEGIN
	SELECT RAISE(ABORT, 'hidden_items_limit');
END;
