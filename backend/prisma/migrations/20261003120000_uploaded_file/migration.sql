-- Registry of uploaded files and the company that owns each one.
-- IF NOT EXISTS: db-deploy.sh also runs `prisma db push`, which may get there first.
CREATE TABLE IF NOT EXISTS "uploaded_file" (
    "id" SERIAL NOT NULL,
    "filename" VARCHAR(200) NOT NULL,
    "ownerId" INTEGER,
    "uploadedBy" INTEGER,
    "mimeType" VARCHAR(100),
    "size" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "uploaded_file_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "uploaded_file_filename_key" ON "uploaded_file"("filename");
CREATE INDEX IF NOT EXISTS "uploaded_file_ownerId_idx" ON "uploaded_file"("ownerId");
