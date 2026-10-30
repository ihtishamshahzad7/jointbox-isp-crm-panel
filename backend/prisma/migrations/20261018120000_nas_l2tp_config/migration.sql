-- Independent L2TP/IPsec configuration per NAS. Secrets are encrypted before
-- being persisted and never returned through the API or logs.

CREATE TABLE IF NOT EXISTS "nas_l2tp_config" (
  "id" SERIAL PRIMARY KEY,
  "nasId" INTEGER NOT NULL UNIQUE,
  "configurationName" VARCHAR(128),
  "publicHost" VARCHAR(255),
  "routerManagementIp" VARCHAR(45),
  "l2tpEnabled" BOOLEAN NOT NULL DEFAULT true,
  "ipsecEnabled" BOOLEAN NOT NULL DEFAULT true,
  "ipsecPskEnc" VARCHAR(512),
  "pppProfile" VARCHAR(64),
  "clientPool" VARCHAR(64),
  "dnsServers" TEXT[] NOT NULL DEFAULT '{}',
  "mtu" INTEGER,
  "mru" INTEGER,
  "maxSessions" INTEGER,
  "idleTimeout" INTEGER,
  "sessionTimeout" INTEGER,
  "radiusServer" VARCHAR(255),
  "radiusAuthPort" INTEGER NOT NULL DEFAULT 1812,
  "radiusAcctPort" INTEGER NOT NULL DEFAULT 1813,
  "nasIdentifier" VARCHAR(128),
  "radiusSourceIp" VARCHAR(45),
  "radiusSharedSecretEnc" VARCHAR(512),
  "state" VARCHAR(24) NOT NULL DEFAULT 'draft',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "lastAppliedAt" TIMESTAMPTZ,
  "lastVerifiedAt" TIMESTAMPTZ,
  "lastError" VARCHAR(512),
  "createdById" INTEGER,
  "updatedById" INTEGER,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "nas_l2tp_config_nasId_fkey"
    FOREIGN KEY ("nasId") REFERENCES "nas"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "nas_l2tp_config_state_idx"
  ON "nas_l2tp_config" ("state");

CREATE INDEX IF NOT EXISTS "nas_l2tp_config_updatedAt_idx"
  ON "nas_l2tp_config" ("updatedAt");
