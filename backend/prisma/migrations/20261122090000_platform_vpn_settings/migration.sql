-- Installation-wide NAS management VPN settings, edited in the web panel
-- (Settings, platform owner). One row. Additive; nothing existing changes.
-- mgmtEnabled defaults to false: the feature stays off until switched on.
CREATE TABLE "platform_vpn_settings" (
  "id"                    INTEGER NOT NULL DEFAULT 1,
  "mgmtEnabled"           BOOLEAN NOT NULL DEFAULT false,
  "publicIp"              VARCHAR(45),
  "mgmtPool"              VARCHAR(18),
  "protectedCidrs"        VARCHAR(1000),
  "allowPrivateEndpoints" BOOLEAN NOT NULL DEFAULT false,
  "updatedById"           INTEGER,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_vpn_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_vpn_settings_singleton" CHECK ("id" = 1)
);
