-- 1. Seed data contains PSM-2026-PUNE-10001, but certificate_seq started at 10001, so the
--    first Pune certificate issued by the worker collided with it (issuance job failed).
--    Move the sequence past the seeded numbers (never move it backwards).
SELECT setval('certificate_seq', GREATEST(20000, (SELECT last_value FROM certificate_seq)));

-- 2. Last 4 digits of a national ID are NOT unique per person: with 60 candidates there is a
--    ~16% chance two share them, so valid batches were being rejected. Identity within a batch
--    is the phone number (still unique per batch).
DROP INDEX IF EXISTS "Candidate_batchId_nationalIdLast4_key";

-- 3. Indexes for the SLA monitor / reconciler / district queues.
CREATE INDEX IF NOT EXISTS "Batch_status_stageEnteredAt_idx" ON "Batch"("status", "stageEnteredAt");
CREATE INDEX IF NOT EXISTS "Batch_district_status_idx" ON "Batch"("district", "status");
CREATE INDEX IF NOT EXISTS "WhatsAppMessage_status_updatedAt_idx" ON "WhatsAppMessage"("status", "updatedAt");
