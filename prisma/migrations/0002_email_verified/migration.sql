-- Account recovery: track whether an account's email address is confirmed.
-- Additive and forward-only (safe on a live database): new column with a
-- default, so existing rows backfill to false automatically.
ALTER TABLE "Account" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false;
