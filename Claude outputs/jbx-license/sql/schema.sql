-- Jointbox Licence Server — schema
-- Run once in Hostinger hPanel → Databases → phpMyAdmin → SQL tab.
-- Safe to re-run: every statement is IF NOT EXISTS / idempotent.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS plans (
  id                VARCHAR(32)  NOT NULL PRIMARY KEY,
  name              VARCHAR(64)  NOT NULL,
  max_subscribers   INT          NOT NULL DEFAULT 0,      -- 0 = unlimited
  features          JSON         NOT NULL,
  price_pkr_month   INT          NOT NULL DEFAULT 0,
  validity_days     SMALLINT     NOT NULL DEFAULT 14,     -- rolling licence lifetime
  grace_days        SMALLINT     NOT NULL DEFAULT 7,
  is_trial          TINYINT(1)   NOT NULL DEFAULT 0,
  sort_order        SMALLINT     NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Admin logins live here, not in the config file, so you can change your own
-- username and password from the UI without editing anything on the server.
CREATE TABLE IF NOT EXISTS admin_users (
  id            BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(64)  NOT NULL,
  pass_hash     VARCHAR(255) NOT NULL,
  full_name     VARCHAR(120) NULL,
  email         VARCHAR(160) NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL,
  last_login_at DATETIME     NULL,
  last_login_ip VARCHAR(45)  NULL,
  UNIQUE KEY uq_admin_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS customers (
  id            BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company       VARCHAR(160) NOT NULL,
  website       VARCHAR(160) NULL,
  contact_name  VARCHAR(120) NULL,
  email         VARCHAR(160) NULL,
  phone         VARCHAR(40)  NULL,
  country       VARCHAR(60)  NULL,
  notes         TEXT         NULL,
  created_at    DATETIME     NOT NULL,
  KEY idx_customers_company (company),
  KEY idx_customers_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS licenses (
  id                BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- 'JBX-' (4) + four 5-char groups (20) + three dashes (3) = exactly 27.
  license_key       CHAR(27)    NOT NULL,                 -- JBX-XXXXX-XXXXX-XXXXX-XXXXX
  customer_id       BIGINT      NOT NULL,
  plan_id           VARCHAR(32) NOT NULL,
  status            ENUM('unactivated','active','suspended','expired','revoked')
                    NOT NULL DEFAULT 'unactivated',
  hmac_secret       CHAR(64)    NOT NULL,                 -- per-licence, signs heartbeats
  paid_until        DATE        NULL,                     -- billing truth; renewals stop past this
  max_activations   SMALLINT    NOT NULL DEFAULT 1,
  max_rebinds_year  TINYINT     NOT NULL DEFAULT 3,
  is_trial          TINYINT(1)  NOT NULL DEFAULT 0,
  created_at        DATETIME    NOT NULL,
  created_by        VARCHAR(80) NULL,
  UNIQUE KEY uq_licenses_key (license_key),
  KEY idx_licenses_customer (customer_id),
  KEY idx_licenses_status (status),
  KEY idx_licenses_paid (paid_until),
  CONSTRAINT fk_licenses_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_licenses_plan FOREIGN KEY (plan_id) REFERENCES plans(id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS activations (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  license_id      BIGINT       NOT NULL,
  fp_machine_id   CHAR(64)     NULL,        -- sha256, peppered by the agent
  fp_mac          CHAR(64)     NULL,
  fp_rootfs       CHAR(64)     NULL,
  primary_mac     VARCHAR(24)  NULL,        -- readable, for your support desk
  hostname        VARCHAR(120) NULL,
  public_ip       VARCHAR(45)  NULL,
  panel_version   VARCHAR(32)  NULL,
  os_release      VARCHAR(120) NULL,
  activated_at    DATETIME     NOT NULL,
  last_seen_at    DATETIME     NULL,
  rebind_count    SMALLINT     NOT NULL DEFAULT 0,
  rebind_year     SMALLINT     NULL,
  status          ENUM('active','released','blocked') NOT NULL DEFAULT 'active',
  KEY idx_activations_license (license_id),
  KEY idx_activations_fp (fp_machine_id),
  KEY idx_activations_seen (last_seen_at),
  CONSTRAINT fk_activations_license FOREIGN KEY (license_id) REFERENCES licenses(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS heartbeats (
  id                BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  activation_id     BIGINT      NOT NULL,
  at                DATETIME    NOT NULL,
  subscriber_count  INT         NULL,
  nas_count         INT         NULL,
  panel_version     VARCHAR(32) NULL,
  tamper_flags      VARCHAR(255) NULL,
  ip                VARCHAR(45) NULL,
  KEY idx_heartbeats_act_at (activation_id, at),
  CONSTRAINT fk_heartbeats_activation FOREIGN KEY (activation_id) REFERENCES activations(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Replay protection for signed API calls. Pruned by cron.
CREATE TABLE IF NOT EXISTS nonces (
  nonce   CHAR(32)  NOT NULL PRIMARY KEY,
  seen_at DATETIME  NOT NULL,
  KEY idx_nonces_seen (seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Crude but effective rate limiting for the one unauthenticated endpoint.
CREATE TABLE IF NOT EXISTS rate_limit (
  bucket    VARCHAR(80) NOT NULL PRIMARY KEY,
  hits      INT         NOT NULL DEFAULT 0,
  window_at DATETIME    NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_log (
  id      BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at      DATETIME     NOT NULL,
  actor   VARCHAR(80)  NULL,
  action  VARCHAR(80)  NOT NULL,
  target  VARCHAR(120) NULL,
  detail  TEXT         NULL,
  ip      VARCHAR(45)  NULL,
  KEY idx_audit_at (at),
  KEY idx_audit_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Plan catalogue — mirrors panel.jointbox.net/#pricing (self-hosted tiers)
-- ---------------------------------------------------------------------------
INSERT INTO plans (id, name, max_subscribers, features, price_pkr_month,
                   validity_days, grace_days, is_trial, sort_order)
VALUES
  ('trial', 'Trial (24 hours)', 25,
   '["coa","radius"]', 0, 1, 0, 1, 0),

  ('starter', 'Starter', 500,
   '["coa","radius","billing","reports"]', 3500, 14, 7, 0, 1),

  ('professional', 'Professional', 5000,
   '["coa","radius","billing","reports","franchise","ipv6","olt"]', 8500, 14, 7, 0, 2),

  ('enterprise', 'Enterprise', 0,
   '["coa","radius","billing","reports","franchise","ipv6","olt","multitenant","api"]',
   15000, 30, 14, 0, 3)
ON DUPLICATE KEY UPDATE
  name            = VALUES(name),
  max_subscribers = VALUES(max_subscribers),
  features        = VALUES(features),
  price_pkr_month = VALUES(price_pkr_month),
  validity_days   = VALUES(validity_days),
  grace_days      = VALUES(grace_days),
  sort_order      = VALUES(sort_order);
