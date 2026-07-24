-- Ban: a moderation hold on an account, 1:1 with Account. Additive (new table).
-- `until` NULL = permanent; enforcement is server-side at login/session resume.
CREATE TABLE "Ban" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "by" TEXT NOT NULL DEFAULT '',
    "until" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Ban_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Ban_accountId_key" ON "Ban"("accountId");

ALTER TABLE "Ban" ADD CONSTRAINT "Ban_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
