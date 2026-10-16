-- FX3.1 (Q3-4): single use of the e-mail-change links. Better Auth's change-email links are
-- signed JWTs valid for 1 hour with no database row, so each GET of the first link would mail the
-- new address again and each GET of the second would re-apply the change. The auth hook claims a
-- link the first time it is used (auth/link-uses.ts); a second use is refused.
--
-- `token_hash` is the SHA-256 (hex) of the whole token: the table holds no token, e-mail or user
-- id. `expires_at` (epoch ms) is the token's own expiry; past it the row is useless (the token no
-- longer verifies) and is pruned by the hook itself, a few rows per claim.
CREATE TABLE IF NOT EXISTS auth_link_uses (
	token_hash TEXT NOT NULL PRIMARY KEY,
	used_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_link_uses_expires_idx ON auth_link_uses (expires_at);
