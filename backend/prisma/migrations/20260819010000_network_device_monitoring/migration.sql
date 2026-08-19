-- Network Device Monitoring (SNMP + Syslog switch/port monitoring).
-- Owner-scoped like monitor_target: a child account sees only devices inside
-- its own subtree. SNMP credentials live in snmp_configuration, encrypted at
-- rest by the application (SecretsService, AES-256-GCM), never returned to
-- the browser.

-- ── NetworkDevice ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "network_device" (
  "id"              SERIAL PRIMARY KEY,
  "ownerId"         INTEGER,
  "name"            VARCHAR(120) NOT NULL,
  "ip"              VARCHAR(64) NOT NULL,
  "vendor"          VARCHAR(24) NOT NULL DEFAULT 'OTHER',
  "deviceType"      VARCHAR(80),
  "groupName"       VARCHAR(80),
  "location"        VARCHAR(160),
  "description"     VARCHAR(500),
  "enabled"         BOOLEAN NOT NULL DEFAULT true,
  "snmpVersion"     VARCHAR(8) NOT NULL DEFAULT 'V2C',
  "snmpPort"        INTEGER NOT NULL DEFAULT 161,
  "pollIntervalSec" INTEGER NOT NULL DEFAULT 30,
  "snmpTimeoutMs"   INTEGER NOT NULL DEFAULT 5000,
  "snmpRetries"     INTEGER NOT NULL DEFAULT 1,
  "isReachable"     BOOLEAN,
  "cpu"             DOUBLE PRECISION,
  "memory"          DOUBLE PRECISION,
  "temperature"     DOUBLE PRECISION,
  "uptimeSec"       BIGINT,
  "lastSnmpPollAt"  TIMESTAMP(3),
  "lastSyslogAt"    TIMESTAMP(3),
  "lastError"       VARCHAR(500),
  "interfaceCount"  INTEGER NOT NULL DEFAULT 0,
  "upPorts"         INTEGER NOT NULL DEFAULT 0,
  "downPorts"       INTEGER NOT NULL DEFAULT 0,
  "syslogEnabled"   BOOLEAN NOT NULL DEFAULT false,
  "syslogProtocol"  VARCHAR(8) NOT NULL DEFAULT 'UDP',
  "syslogPort"      INTEGER NOT NULL DEFAULT 514,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "network_device_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "network_device_ownerId_idx" ON "network_device"("ownerId");
CREATE INDEX IF NOT EXISTS "network_device_enabled_idx" ON "network_device"("enabled");
CREATE INDEX IF NOT EXISTS "network_device_ip_idx" ON "network_device"("ip");

-- ── SNMP credentials (encrypted at rest) ────────────────────────
CREATE TABLE IF NOT EXISTS "snmp_configuration" (
  "id"            SERIAL PRIMARY KEY,
  "deviceId"      INTEGER NOT NULL UNIQUE,
  "communityEnc"  TEXT,
  "v3Username"    VARCHAR(64),
  "v3AuthProto"   VARCHAR(16),
  "v3AuthKeyEnc"  TEXT,
  "v3PrivProto"   VARCHAR(16),
  "v3PrivKeyEnc"  TEXT,
  "hasCommunity"  BOOLEAN NOT NULL DEFAULT false,
  "hasAuthKey"    BOOLEAN NOT NULL DEFAULT false,
  "hasPrivKey"    BOOLEAN NOT NULL DEFAULT false,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "snmp_configuration_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "network_device"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ── NetworkInterface ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "network_interface" (
  "id"                 SERIAL PRIMARY KEY,
  "deviceId"           INTEGER NOT NULL,
  "ifIndex"            INTEGER NOT NULL,
  "name"               VARCHAR(96) NOT NULL,
  "description"        VARCHAR(240),
  "adminStatus"        INTEGER NOT NULL DEFAULT 1,
  "operStatus"         INTEGER NOT NULL DEFAULT 2,
  "speedMbps"          INTEGER,
  "duplex"             VARCHAR(16),
  "inOctets"           BIGINT,
  "outOctets"          BIGINT,
  "inUcastPkts"        BIGINT,
  "outUcastPkts"       BIGINT,
  "inErrors"           BIGINT,
  "outErrors"          BIGINT,
  "inDiscards"         BIGINT,
  "outDiscards"        BIGINT,
  "crcErrors"          BIGINT,
  "rxRateBps"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "txRateBps"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "rxPps"              DOUBLE PRECISION NOT NULL DEFAULT 0,
  "txPps"              DOUBLE PRECISION NOT NULL DEFAULT 0,
  "errorRatePerMin"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "mac"                VARCHAR(40),
  "ifLastChangeTicks"  BIGINT,
  "lastStateChangeAt"  TIMESTAMP(3),
  "firstSeen"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeen"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastPollAt"         TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "network_interface_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "network_device"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "network_interface_deviceId_ifIndex_key" UNIQUE ("deviceId", "ifIndex")
);
CREATE INDEX IF NOT EXISTS "network_interface_deviceId_idx" ON "network_interface"("deviceId");
CREATE INDEX IF NOT EXISTS "network_interface_operStatus_idx" ON "network_interface"("operStatus");
CREATE INDEX IF NOT EXISTS "network_interface_deviceId_operStatus_idx" ON "network_interface"("deviceId", "operStatus");

-- ── InterfaceStatusHistory (availability transitions) ──────────
CREATE TABLE IF NOT EXISTS "interface_status_history" (
  "id"          SERIAL PRIMARY KEY,
  "deviceId"    INTEGER NOT NULL,
  "interfaceId" INTEGER NOT NULL,
  "toStatus"    VARCHAR(8) NOT NULL,
  "durationSec" INTEGER,
  "at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "interface_status_history_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "network_device"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "interface_status_history_interfaceId_fkey" FOREIGN KEY ("interfaceId") REFERENCES "network_interface"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "interface_status_history_deviceId_at_idx" ON "interface_status_history"("deviceId", "at");
CREATE INDEX IF NOT EXISTS "interface_status_history_interfaceId_at_idx" ON "interface_status_history"("interfaceId", "at");
CREATE INDEX IF NOT EXISTS "interface_status_history_deviceId_interfaceId_idx" ON "interface_status_history"("deviceId", "interfaceId");

-- ── InterfaceTrafficHistory ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "interface_traffic_history" (
  "id"              SERIAL PRIMARY KEY,
  "deviceId"        INTEGER NOT NULL,
  "interfaceId"     INTEGER NOT NULL,
  "at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rxRateBps"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  "txRateBps"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  "rxPps"           DOUBLE PRECISION NOT NULL DEFAULT 0,
  "txPps"           DOUBLE PRECISION NOT NULL DEFAULT 0,
  "errorRatePerMin" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "up"              BOOLEAN NOT NULL DEFAULT true,
  "speedMbps"       INTEGER,
  "inOctets"        BIGINT,
  "outOctets"       BIGINT,
  "inErrors"        BIGINT,
  "outErrors"       BIGINT,
  "inDiscards"      BIGINT,
  "outDiscards"     BIGINT,
  "crcErrors"       BIGINT,
  CONSTRAINT "interface_traffic_history_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "network_device"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "interface_traffic_history_interfaceId_fkey" FOREIGN KEY ("interfaceId") REFERENCES "network_interface"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "interface_traffic_history_deviceId_at_idx" ON "interface_traffic_history"("deviceId", "at");
CREATE INDEX IF NOT EXISTS "interface_traffic_history_interfaceId_at_idx" ON "interface_traffic_history"("interfaceId", "at");
CREATE INDEX IF NOT EXISTS "interface_traffic_history_deviceId_interfaceId_at_idx" ON "interface_traffic_history"("deviceId", "interfaceId", "at");

-- ── SyslogEvent ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "syslog_event" (
  "id"           SERIAL PRIMARY KEY,
  "deviceId"     INTEGER,
  "sourceIp"     VARCHAR(64) NOT NULL,
  "hostname"     VARCHAR(120),
  "facility"     INTEGER,
  "facilityName" VARCHAR(32),
  "severity"     INTEGER,
  "severityName" VARCHAR(16) NOT NULL DEFAULT 'INFO',
  "tag"          VARCHAR(64),
  "message"      TEXT NOT NULL,
  "eventType"    VARCHAR(48),
  "status"       VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  "raw"          TEXT,
  "receivedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "syslog_event_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "network_device"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "syslog_event_deviceId_receivedAt_idx" ON "syslog_event"("deviceId", "receivedAt");
CREATE INDEX IF NOT EXISTS "syslog_event_sourceIp_receivedAt_idx" ON "syslog_event"("sourceIp", "receivedAt");
CREATE INDEX IF NOT EXISTS "syslog_event_severity_receivedAt_idx" ON "syslog_event"("severity", "receivedAt");
CREATE INDEX IF NOT EXISTS "syslog_event_eventType_idx" ON "syslog_event"("eventType");
CREATE INDEX IF NOT EXISTS "syslog_event_status_idx" ON "syslog_event"("status");
CREATE INDEX IF NOT EXISTS "syslog_event_receivedAt_idx" ON "syslog_event"("receivedAt");

-- ── NetworkEvent (smart-parsed events) ──────────────────────────
CREATE TABLE IF NOT EXISTS "network_event" (
  "id"            SERIAL PRIMARY KEY,
  "deviceId"      INTEGER,
  "sourceIp"      VARCHAR(64),
  "interfaceId"   INTEGER,
  "interfaceName" VARCHAR(96),
  "eventType"     VARCHAR(48) NOT NULL,
  "severity"      VARCHAR(16) NOT NULL,
  "message"       TEXT NOT NULL,
  "status"        VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  "count"         INTEGER NOT NULL DEFAULT 1,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"    TIMESTAMP(3),
  CONSTRAINT "network_event_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "network_device"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "network_event_interfaceId_fkey" FOREIGN KEY ("interfaceId") REFERENCES "network_interface"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "network_event_deviceId_createdAt_idx" ON "network_event"("deviceId", "createdAt");
CREATE INDEX IF NOT EXISTS "network_event_interfaceId_createdAt_idx" ON "network_event"("interfaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "network_event_eventType_status_idx" ON "network_event"("eventType", "status");
CREATE INDEX IF NOT EXISTS "network_event_severity_idx" ON "network_event"("severity");
CREATE INDEX IF NOT EXISTS "network_event_status_idx" ON "network_event"("status");
CREATE INDEX IF NOT EXISTS "network_event_createdAt_idx" ON "network_event"("createdAt");

-- ── AlertRule ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "alert_rule" (
  "id"          SERIAL PRIMARY KEY,
  "ownerId"     INTEGER,
  "name"        VARCHAR(120) NOT NULL,
  "eventType"   VARCHAR(48) NOT NULL,
  "condition"   VARCHAR(120),
  "severity"    VARCHAR(16) NOT NULL DEFAULT 'WARNING',
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "channels"    JSONB NOT NULL DEFAULT '{}',
  "description" VARCHAR(500),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alert_rule_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "alert_rule_ownerId_idx" ON "alert_rule"("ownerId");
CREATE INDEX IF NOT EXISTS "alert_rule_eventType_enabled_idx" ON "alert_rule"("eventType", "enabled");

-- ── Alert ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "alert" (
  "id"             SERIAL PRIMARY KEY,
  "ruleId"         INTEGER,
  "deviceId"       INTEGER,
  "interfaceId"    INTEGER,
  "interfaceName"  VARCHAR(96),
  "eventType"      VARCHAR(48) NOT NULL,
  "title"          VARCHAR(240) NOT NULL,
  "message"        TEXT NOT NULL,
  "severity"       VARCHAR(16) NOT NULL DEFAULT 'WARNING',
  "key"            VARCHAR(160) NOT NULL,
  "status"         VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  "openedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"     TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "acknowledgedBy" INTEGER,
  "fireCount"      INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "alert_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "alert_rule"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "alert_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "network_device"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "alert_interfaceId_fkey" FOREIGN KEY ("interfaceId") REFERENCES "network_interface"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "alert_status_openedAt_idx" ON "alert"("status", "openedAt");
CREATE INDEX IF NOT EXISTS "alert_deviceId_status_idx" ON "alert"("deviceId", "status");
CREATE INDEX IF NOT EXISTS "alert_interfaceId_status_idx" ON "alert"("interfaceId", "status");
CREATE INDEX IF NOT EXISTS "alert_key_status_idx" ON "alert"("key", "status");
CREATE INDEX IF NOT EXISTS "alert_eventType_idx" ON "alert"("eventType");

-- ── Notification (delivery log) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS "notification" (
  "id"      SERIAL PRIMARY KEY,
  "alertId" INTEGER,
  "channel" VARCHAR(32) NOT NULL,
  "title"   VARCHAR(240) NOT NULL,
  "message" TEXT NOT NULL,
  "status"  VARCHAR(16) NOT NULL DEFAULT 'SENT',
  "error"   VARCHAR(500),
  "sentAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "alert"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "notification_alertId_idx" ON "notification"("alertId");
CREATE INDEX IF NOT EXISTS "notification_channel_sentAt_idx" ON "notification"("channel", "sentAt");

-- ── SyslogServerSetting (listener config) ───────────────────────
CREATE TABLE IF NOT EXISTS "syslog_server_setting" (
  "id"          SERIAL PRIMARY KEY,
  "protocol"    VARCHAR(8) NOT NULL UNIQUE,
  "enabled"     BOOLEAN NOT NULL DEFAULT false,
  "port"        INTEGER NOT NULL DEFAULT 514,
  "tlsCertPath" VARCHAR(500),
  "tlsKeyPath"  VARCHAR(500),
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── DeviceHealthMetric (CPU/mem/temp series) ────────────────────
CREATE TABLE IF NOT EXISTS "device_health_metric" (
  "id"       SERIAL PRIMARY KEY,
  "deviceId" INTEGER NOT NULL,
  "ts"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metric"   VARCHAR(24) NOT NULL,
  "value"    DOUBLE PRECISION NOT NULL,
  CONSTRAINT "device_health_metric_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "network_device"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "device_health_metric_deviceId_metric_ts_idx" ON "device_health_metric"("deviceId", "metric", "ts");
CREATE INDEX IF NOT EXISTS "device_health_metric_deviceId_ts_idx" ON "device_health_metric"("deviceId", "ts");

-- Seed the syslog server settings so the built-in listeners have a row each
-- (UDP/TCP default to port 514, disabled until the admin enables them).
INSERT INTO "syslog_server_setting" ("protocol", "enabled", "port")
VALUES ('UDP', false, 514), ('TCP', false, 514), ('TLS', false, 6514)
ON CONFLICT ("protocol") DO NOTHING;