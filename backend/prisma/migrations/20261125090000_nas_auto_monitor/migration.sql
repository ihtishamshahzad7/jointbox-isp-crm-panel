-- nasIp is INET, host is text: compare with host(nasIp).
-- Every router (NAS) is monitored automatically on Network Monitoring.
-- Additive: one nullable column on monitor_target, plus monitors for the
-- routers that already exist (skipping any host the owner already monitors).
ALTER TABLE "monitor_target" ADD COLUMN "nasId" INTEGER;
CREATE UNIQUE INDEX "monitor_target_nasId_key" ON "monitor_target"("nasId");
ALTER TABLE "monitor_target" ADD CONSTRAINT "monitor_target_nasId_fkey"
  FOREIGN KEY ("nasId") REFERENCES "nas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Link a monitor the owner already has for the router's IP...
UPDATE "monitor_target" m SET "nasId" = n."id"
FROM "nas" n
WHERE n."nasIp" IS NOT NULL AND m."nasId" IS NULL
  AND m."host" = host(n."nasIp") AND m."ownerId" IS NOT DISTINCT FROM n."ownerId"
  AND m."id" = (SELECT min(m2."id") FROM "monitor_target" m2
                WHERE m2."host" = host(n."nasIp") AND m2."ownerId" IS NOT DISTINCT FROM n."ownerId")
  AND NOT EXISTS (SELECT 1 FROM "monitor_target" x WHERE x."nasId" = n."id");

-- ...and create one for every router that still has none.
INSERT INTO "monitor_target" ("name", "host", "groupName", "ownerId", "nasId")
SELECT left(coalesce(nullif(n."shortname", ''), n."nasname"), 120), host(n."nasIp"), 'Routers', n."ownerId", n."id"
FROM "nas" n
WHERE n."nasIp" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "monitor_target" m WHERE m."nasId" = n."id");
