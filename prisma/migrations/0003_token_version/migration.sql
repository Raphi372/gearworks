-- Versioned sessions: a monotonically-increasing counter per account. Bumping
-- it invalidates every previously-issued session token (used by password reset
-- and a future "log out everywhere"). Additive, forward-only: existing rows
-- backfill to 0 via the default.
ALTER TABLE "Account" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
