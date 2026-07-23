-- Social graph: directed friend/request/block edges. Additive (new table + enum).
CREATE TYPE "FriendStatus" AS ENUM ('PENDING', 'ACCEPTED', 'BLOCKED');

CREATE TABLE "Friendship" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "otherId" TEXT NOT NULL,
    "status" "FriendStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Friendship_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Friendship_accountId_otherId_key" ON "Friendship"("accountId", "otherId");
CREATE INDEX "Friendship_otherId_status_idx" ON "Friendship"("otherId", "status");

ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_otherId_fkey" FOREIGN KEY ("otherId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
