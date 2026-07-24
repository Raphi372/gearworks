-- Flag: an anti-cheat anomaly flag on an account, 1:1 (Phase 3). Additive.
-- A human-in-the-loop signal (score, don't auto-ban); `count` tracks repeats.
CREATE TABLE "Flag" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "score" INTEGER NOT NULL DEFAULT 0,
    "roomCode" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Flag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Flag_accountId_key" ON "Flag"("accountId");

ALTER TABLE "Flag" ADD CONSTRAINT "Flag_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
