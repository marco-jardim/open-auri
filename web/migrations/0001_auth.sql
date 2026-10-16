-- T3.5: Better Auth 1.7.10 schema for D1 (SQLite), written by hand from the installed package:
-- core tables (user, session, account, verification) + username plugin (user.username,
-- user.displayUsername) + admin plugin (user.role, banned, banReason, banExpires;
-- session.impersonatedBy) + twoFactor plugin (user.twoFactorEnabled, table twoFactor) + the
-- open-auri fields user.usernameSkeleton (confusable skeleton, unique) and
-- session.twoFactorVerifiedAt (2FA verified in this session; see web/src/lib/server/auth/README.md).
--
-- Column names and types follow Better Auth's own SQLite migration generator (camelCase names,
-- `date` columns holding ISO-8601 strings, booleans as INTEGER 0/1). Index names follow its
-- `<table>_<column>_idx|uidx` convention. Child tables cascade on user deletion (D1 enforces
-- foreign keys). Applied before 0002+ (D1 applies migrations in file-name order); no other
-- migration references these tables. tests/integration/auth/schema.test.ts checks this file
-- against the schema Better Auth expects for the configuration in web/src/lib/server/auth.ts.

CREATE TABLE IF NOT EXISTS "user" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"name" TEXT NOT NULL,
	"email" TEXT NOT NULL,
	"emailVerified" INTEGER NOT NULL DEFAULT 0,
	"image" TEXT,
	"createdAt" DATE NOT NULL,
	"updatedAt" DATE NOT NULL,
	"username" TEXT,
	"displayUsername" TEXT,
	"usernameSkeleton" TEXT,
	"role" TEXT,
	"banned" INTEGER DEFAULT 0,
	"banReason" TEXT,
	"banExpires" DATE,
	"twoFactorEnabled" INTEGER DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_email_uidx" ON "user" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "user_username_uidx" ON "user" ("username");
CREATE UNIQUE INDEX IF NOT EXISTS "user_usernameSkeleton_uidx" ON "user" ("usernameSkeleton");

CREATE TABLE IF NOT EXISTS "session" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"expiresAt" DATE NOT NULL,
	"token" TEXT NOT NULL,
	"createdAt" DATE NOT NULL,
	"updatedAt" DATE NOT NULL,
	"ipAddress" TEXT,
	"userAgent" TEXT,
	"userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	"impersonatedBy" TEXT,
	"twoFactorVerifiedAt" DATE
);

CREATE UNIQUE INDEX IF NOT EXISTS "session_token_uidx" ON "session" ("token");
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");

CREATE TABLE IF NOT EXISTS "account" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"accountId" TEXT NOT NULL,
	"providerId" TEXT NOT NULL,
	"userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	"accessToken" TEXT,
	"refreshToken" TEXT,
	"idToken" TEXT,
	"accessTokenExpiresAt" DATE,
	"refreshTokenExpiresAt" DATE,
	"scope" TEXT,
	"password" TEXT,
	"createdAt" DATE NOT NULL,
	"updatedAt" DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");

CREATE TABLE IF NOT EXISTS "verification" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"identifier" TEXT NOT NULL,
	"value" TEXT NOT NULL,
	"expiresAt" DATE NOT NULL,
	"createdAt" DATE NOT NULL,
	"updatedAt" DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE IF NOT EXISTS "twoFactor" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"secret" TEXT NOT NULL,
	"backupCodes" TEXT NOT NULL,
	"userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	"verified" INTEGER DEFAULT 1,
	"failedVerificationCount" INTEGER DEFAULT 0,
	"lockedUntil" DATE
);

CREATE INDEX IF NOT EXISTS "twoFactor_secret_idx" ON "twoFactor" ("secret");
CREATE INDEX IF NOT EXISTS "twoFactor_userId_idx" ON "twoFactor" ("userId");
