-- A company may run its own billing jobs (invoice / renew / suspend) for its
-- own customers; the run records which company it was limited to. NULL keeps
-- meaning the nightly installation-wide run.
-- IF NOT EXISTS throughout: db-deploy.sh also runs `prisma db push`.

ALTER TABLE "BillingRun" ADD COLUMN IF NOT EXISTS "companyId" INTEGER;
CREATE INDEX IF NOT EXISTS "BillingRun_companyId_idx" ON "BillingRun"("companyId");
