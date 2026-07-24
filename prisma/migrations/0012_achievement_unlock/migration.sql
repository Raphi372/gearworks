-- AchievementUnlock: notification bookkeeping (Phase 2 increment). Additive.
-- Records which unlocks have been announced; ownership stays derived, not stored.
CREATE TABLE "AchievementUnlock" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AchievementUnlock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AchievementUnlock_accountId_key_key" ON "AchievementUnlock"("accountId", "key");
CREATE INDEX "AchievementUnlock_accountId_idx" ON "AchievementUnlock"("accountId");

ALTER TABLE "AchievementUnlock" ADD CONSTRAINT "AchievementUnlock_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
