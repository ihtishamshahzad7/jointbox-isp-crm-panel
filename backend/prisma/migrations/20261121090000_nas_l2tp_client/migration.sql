-- NAS management VPN (Uplinko host = L2TP/IPsec client, MikroTik NAS = server).
-- Additive only: new nullable/defaulted columns on nas_l2tp_config. No existing
-- column, row or table is changed or dropped. Secrets are stored encrypted.
-- The management VPN has its own endpoint/PSK/state columns so the legacy
-- L2TP/RADIUS draft flow (publicHost, ipsecPskEnc, state) is never touched.
ALTER TABLE "nas_l2tp_config"
  ADD COLUMN "mgmtPublicHost"        VARCHAR(45),
  ADD COLUMN "mgmtIpsecPskEnc"       VARCHAR(512),
  ADD COLUMN "pppUsername"           VARCHAR(64),
  ADD COLUMN "pppPasswordEnc"        VARCHAR(512),
  ADD COLUMN "localAddress"          VARCHAR(45),
  ADD COLUMN "remoteAddress"         VARCHAR(45),
  ADD COLUMN "connectTimeoutSec"     INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "retryCount"            INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "retryDelaySec"         INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "clientState"           VARCHAR(24) NOT NULL DEFAULT 'disconnected',
  ADD COLUMN "clientLockOwner"       VARCHAR(64),
  ADD COLUMN "clientLockUntil"       TIMESTAMP(3),
  ADD COLUMN "clientOpId"            VARCHAR(64),
  ADD COLUMN "clientOpKind"          VARCHAR(24),
  ADD COLUMN "clientOpStartedAt"     TIMESTAMP(3),
  ADD COLUMN "clientCancelRequested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "tunnelInterface"       VARCHAR(15),
  ADD COLUMN "lastDialAt"            TIMESTAMP(3),
  ADD COLUMN "lastConnectedAt"       TIMESTAMP(3),
  ADD COLUMN "lastDisconnectedAt"    TIMESTAMP(3),
  ADD COLUMN "lastClientErrorCode"   VARCHAR(40),
  ADD COLUMN "lastClientError"       VARCHAR(512),
  ADD COLUMN "mgmtApplyState"        VARCHAR(32) NOT NULL DEFAULT 'none',
  ADD COLUMN "mgmtApplyDetail"       VARCHAR(512),
  ADD COLUMN "nasAppliedAt"          TIMESTAMP(3),
  ADD COLUMN "mgmtSnapshotEnc"       TEXT,
  ADD COLUMN "mgmtDesiredEnc"        TEXT;

-- One management VPN per NAS endpoint and per tunnel address on this host.
-- (Cross-column overlap — one NAS's local address equal to another's remote —
-- is enforced in the application under an advisory lock.) NULLs never collide.
CREATE UNIQUE INDEX "nas_l2tp_config_mgmtPublicHost_key" ON "nas_l2tp_config"("mgmtPublicHost");
CREATE UNIQUE INDEX "nas_l2tp_config_localAddress_key" ON "nas_l2tp_config"("localAddress");
CREATE UNIQUE INDEX "nas_l2tp_config_remoteAddress_key" ON "nas_l2tp_config"("remoteAddress");
