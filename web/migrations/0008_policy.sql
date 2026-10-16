-- T3.4: privacy policy / terms acknowledgements of signed-in users (anonymous visitors keep
-- `oa.policy.seen` in localStorage). One row per user and policy version; `accepted_at` is epoch ms.
-- Rows are deleted with the account (T3.7) and included in the data export.
CREATE TABLE IF NOT EXISTS policy_acceptances (
	user_id TEXT NOT NULL,
	version TEXT NOT NULL,
	accepted_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, version)
);
