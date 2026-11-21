-- "Add router via VPN" over L2TP/IPsec: remote routers dial INTO Uplinko.
-- Additive only: two new tables, nothing existing changes.
CREATE TABLE "nas_l2tp_hub" (
  "id"          SERIAL NOT NULL,
  "nasId"       INTEGER NOT NULL,
  "username"    VARCHAR(64) NOT NULL,
  "passwordEnc" TEXT NOT NULL,
  "tunnelIp"    VARCHAR(45) NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "nas_l2tp_hub_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "nas_l2tp_hub_nasId_key" ON "nas_l2tp_hub"("nasId");
CREATE UNIQUE INDEX "nas_l2tp_hub_username_key" ON "nas_l2tp_hub"("username");
CREATE UNIQUE INDEX "nas_l2tp_hub_tunnelIp_key" ON "nas_l2tp_hub"("tunnelIp");
ALTER TABLE "nas_l2tp_hub" ADD CONSTRAINT "nas_l2tp_hub_nasId_fkey"
  FOREIGN KEY ("nasId") REFERENCES "nas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "l2tp_hub_settings" (
  "id"        INTEGER NOT NULL DEFAULT 1,
  "pskEnc"    TEXT,
  "subnet"    VARCHAR(18),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "l2tp_hub_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "l2tp_hub_settings_singleton" CHECK ("id" = 1)
);
