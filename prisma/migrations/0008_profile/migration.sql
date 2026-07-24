-- Profile: vanity layer (bio + equipped cosmetics), 1:1 with Account.
-- Additive (new table only). Cosmetic ownership is derived, not stored.
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "bio" TEXT NOT NULL DEFAULT '',
    "equipped" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Profile_accountId_key" ON "Profile"("accountId");

ALTER TABLE "Profile" ADD CONSTRAINT "Profile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
