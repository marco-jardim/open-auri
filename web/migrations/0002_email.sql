-- T3.2: transactional e-mail.
--
-- email_suppressions: addresses that must never be e-mailed again (hard bounce or complaint).
-- Only HMAC-SHA256 of the normalized address is stored (see web/src/lib/server/email/suppression.ts),
-- never the address. created_at is unix milliseconds. event_id is the svix-id of the webhook that
-- created the row (null when the row was added by hand).
CREATE TABLE IF NOT EXISTS email_suppressions (
	address_hash TEXT PRIMARY KEY NOT NULL,
	reason TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint')),
	created_at INTEGER NOT NULL,
	event_id TEXT
);

-- email_webhook_events: svix-id of every processed Resend webhook, for replay protection.
-- received_at is unix milliseconds; rows older than 30 days are pruned by the webhook itself.
CREATE TABLE IF NOT EXISTS email_webhook_events (
	id TEXT PRIMARY KEY NOT NULL,
	received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS email_webhook_events_received_at ON email_webhook_events (received_at);
