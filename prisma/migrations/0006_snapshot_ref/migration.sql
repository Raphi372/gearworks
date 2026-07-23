-- Externalized snapshots: the (large) snapshot blob may live in object/fs
-- storage addressed by a snapshotRef, so the World row can carry only metadata.
-- Additive + forward-only: snapshot becomes nullable, snapshotRef is added.
ALTER TABLE "World" ALTER COLUMN "snapshot" DROP NOT NULL;
ALTER TABLE "World" ADD COLUMN "snapshotRef" TEXT;
