-- 0012 · Filter labels per version (open-auri/preset@2, docs/social.md S5).
--
-- A version may carry the custom names of its ten filters, by wire index of its curve's S1: a JSON
-- array of exactly ten entries, each a string (1-24 code points, normalized by the core's
-- normalizeLabels, checked by the API) or null. NULL means no labels; an all-null list is stored
-- as NULL. Labels are presentation only: they belong to the version, never to the curves row, its
-- id, its canonical key or its gate result. A labels-only change appends a new version (it counts
-- toward the quota) that reuses the same curves row and its cached gate result.
--
-- `length(labels)` counts characters of the JSON text; ten 24-code-point labels with quotes and
-- separators stay far below 1024. Versions stay append-only (versions_append_only of 0004).
ALTER TABLE versions ADD COLUMN labels TEXT CHECK (
	labels IS NULL OR (
		json_valid(labels)
		AND json_type(labels) = 'array'
		AND json_array_length(labels) = 10
		AND length(labels) <= 1024
	)
);
