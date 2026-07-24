-- Add traceId column to ActivityLog for end-to-end request tracing
ALTER TABLE "ActivityLog" ADD COLUMN IF NOT EXISTS "traceId" TEXT;
CREATE INDEX IF NOT EXISTS "ActivityLog_traceId_idx" ON "ActivityLog"("traceId");