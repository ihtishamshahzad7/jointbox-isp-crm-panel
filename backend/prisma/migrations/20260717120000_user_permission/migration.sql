-- Delegated per-user permission overrides (parent controls child)
CREATE TABLE IF NOT EXISTS "user_permission" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "permission" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "user_permission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_permission_userId_permission_key" ON "user_permission"("userId", "permission");
CREATE INDEX IF NOT EXISTS "user_permission_userId_idx" ON "user_permission"("userId");

ALTER TABLE "user_permission" ADD CONSTRAINT "user_permission_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
