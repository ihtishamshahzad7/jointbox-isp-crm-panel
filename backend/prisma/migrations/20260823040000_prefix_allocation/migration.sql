-- ROUTED PREFIX ALLOCATION REGISTER
--
-- Corporate/P2P clients get a VLAN, a /30 transit link and a routed block of
-- their own. That was tracked on paper, which is how two clients end up on one
-- prefix and why nobody can say who held a block when abuse is reported months
-- later. This is the register.
--
-- Idempotent: safe to re-run, and safe after `prisma db push`.

CREATE TABLE IF NOT EXISTS "prefix_pool" (
  "id"          SERIAL PRIMARY KEY,
  "name"        VARCHAR(120) NOT NULL,
  "cidr"        VARCHAR(64)  NOT NULL,
  "kind"        VARCHAR(16)  NOT NULL DEFAULT 'PUBLIC',
  "defaultSize" INTEGER      NOT NULL DEFAULT 29,
  "description" VARCHAR(300),
  "ownerId"     INTEGER,
  "isActive"    BOOLEAN      NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "prefix_pool_kind_idx"     ON "prefix_pool" ("kind");
CREATE INDEX IF NOT EXISTS "prefix_pool_isActive_idx" ON "prefix_pool" ("isActive");

CREATE TABLE IF NOT EXISTS "prefix_allocation" (
  "id"            SERIAL PRIMARY KEY,
  "clientName"    VARCHAR(160) NOT NULL,
  "subscriberId"  INTEGER,
  "poolId"        INTEGER REFERENCES "prefix_pool"("id") ON DELETE SET NULL,
  "vlanId"        INTEGER,
  "vlanName"      VARCHAR(80),
  "linkType"      VARCHAR(16)  NOT NULL DEFAULT 'P2P',
  "transitCidr"   VARCHAR(64),
  "ourIp"         VARCHAR(64),
  "clientIp"      VARCHAR(64),
  "allocatedCidr" VARCHAR(64)  NOT NULL,
  "urpfEnabled"   BOOLEAN      NOT NULL DEFAULT true,
  "ingressAcl"    VARCHAR(120),
  "mtu"           INTEGER      DEFAULT 1500,
  "description"   VARCHAR(300),
  "deviceName"    VARCHAR(120),
  "nasId"         INTEGER,
  "status"        VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
  "provisionedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "releasedAt"    TIMESTAMP(3),
  "releaseReason" VARCHAR(300),
  "notes"         TEXT,
  "createdById"   INTEGER,
  "ownerId"       INTEGER,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "prefix_allocation_allocatedCidr_idx" ON "prefix_allocation" ("allocatedCidr");
CREATE INDEX IF NOT EXISTS "prefix_allocation_status_idx"        ON "prefix_allocation" ("status");
CREATE INDEX IF NOT EXISTS "prefix_allocation_vlanId_idx"        ON "prefix_allocation" ("vlanId");
CREATE INDEX IF NOT EXISTS "prefix_allocation_clientName_idx"    ON "prefix_allocation" ("clientName");

-- ── Seed: the pools these allocations come from ──────────────────────────
-- Adjust the CIDRs to the real ranges you hold; they are inferred from the
-- first provisioned client and are the operator's to correct.
INSERT INTO "prefix_pool" ("name", "cidr", "kind", "defaultSize", "description")
SELECT 'Customer public space', '103.115.196.0/24', 'PUBLIC', 29,
       'Routed blocks delegated to corporate/P2P clients'
WHERE NOT EXISTS (SELECT 1 FROM "prefix_pool" WHERE "cidr" = '103.115.196.0/24');

INSERT INTO "prefix_pool" ("name", "cidr", "kind", "defaultSize", "description")
SELECT 'P2P transit links', '10.152.0.0/16', 'TRANSIT', 30,
       'Point-to-point /30 link addressing between the router and each client'
WHERE NOT EXISTS (SELECT 1 FROM "prefix_pool" WHERE "cidr" = '10.152.0.0/16');

-- ── Seed: the first real provisioning record (Zubair, 23-Aug-2026) ───────
-- Captured from the router configuration actually applied, so the register
-- starts complete rather than from the next client onwards.
INSERT INTO "prefix_allocation" (
  "clientName", "poolId", "vlanId", "vlanName", "linkType",
  "transitCidr", "ourIp", "clientIp", "allocatedCidr",
  "urpfEnabled", "ingressAcl", "mtu", "description", "status", "provisionedAt", "notes"
)
SELECT
  'Zubair',
  (SELECT "id" FROM "prefix_pool" WHERE "cidr" = '103.115.196.0/24' LIMIT 1),
  651, 'vlan651-Zubair', 'P2P',
  '10.152.0.0/30', '10.152.0.1', '10.152.0.2', '103.115.196.8/29',
  true, 'ACL-CLIENT-ZUBAIR-IN', 1500, 'Client-Zubair-P2P-23Aug2026',
  'ACTIVE', '2026-08-23 00:00:00',
  'Static route: ip route 103.115.196.8/29 10.152.0.2 name Client-Zubair'
WHERE NOT EXISTS (SELECT 1 FROM "prefix_allocation" WHERE "allocatedCidr" = '103.115.196.8/29' AND "status" = 'ACTIVE');
