-- =============================================================================
-- RADIUS tenancy policy: a subscriber may only authenticate (and be accounted)
-- on a router that belongs to the subscriber's own company, or on a router
-- explicitly and authorisedly shared into that company. See
-- docs/RADIUS_TENANCY.md for the policy, the rollout and the rollback.
--
-- Before this, FreeRADIUS looked a user up in radcheck by username alone and
-- checked only the router's shared secret: any company's router could log any
-- other company's subscriber in, and record accounting against them.
--
-- WHERE OWNERSHIP COMES FROM (database relationships only; nothing the router
-- or the user sends is trusted for ownership):
--   router      the RADIUS client FreeRADIUS matched by the packet's SOURCE
--               address  ->  nas."nasIp" (the address the client list is
--               rendered from)  ->  nas."ownerId". The NAS-IP-Address the
--               router writes into the packet is never used to decide; it is
--               only checked not to name another company's router.
--   subscriber  User-Name  ->  "Subscriber".username (exact)  ->  "userId"
--   company     an account's top-most ancestor below the platform account
--               (same rule as ScopeService.companyRootId)
--   share       "NasAssignment" to the subscriber's owner (any propagate) or to
--               an account above it inside its company (propagate = true),
--               made by an account of the router's company or by the platform
--
-- Everything missing, ambiguous or invalid is refused when enforced (fail
-- closed). The platform account has no exemption: a router or subscriber it
-- owns directly belongs to no company.
--
-- What this migration changes: nothing at authentication time. FreeRADIUS
-- consults these functions only after scripts/radius-tenancy.sh --install adds
-- the policy, and every database starts in mode 'monitor' (record, never
-- refuse). Enforcement is switched on by an operator (radius-tenancy.sh
-- --enforce), never by a migration.
-- =============================================================================

-- CreateTable
CREATE TABLE IF NOT EXISTS "radius_tenancy_setting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "mode" VARCHAR(10) NOT NULL DEFAULT 'monitor',
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" VARCHAR(120),

    CONSTRAINT "radius_tenancy_setting_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "radius_tenancy_setting_single_row" CHECK ("id" = 1),
    CONSTRAINT "radius_tenancy_setting_mode" CHECK ("mode" IN ('off', 'monitor', 'enforce'))
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "radius_tenancy_event" (
    "id" BIGSERIAL NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "reason" VARCHAR(40) NOT NULL,
    "username" VARCHAR(64) NOT NULL DEFAULT '',
    "nas_ip" VARCHAR(64) NOT NULL DEFAULT '',
    "mode" VARCHAR(10) NOT NULL,
    "count" BIGINT NOT NULL DEFAULT 1,
    "first_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "radius_tenancy_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "radius_tenancy_event_last_at_idx" ON "radius_tenancy_event"("last_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "radius_tenancy_event_kind_reason_username_nas_ip_key" ON "radius_tenancy_event"("kind", "reason", "username", "nas_ip");

-- The switch starts in monitor on every database; an operator enforces.
INSERT INTO "radius_tenancy_setting" ("id", "mode", "updated_by")
VALUES (1, 'monitor', 'migration 20261013130000_radius_tenancy_policy')
ON CONFLICT ("id") DO NOTHING;

-- -----------------------------------------------------------------------------
-- An account's company: its top-most ancestor below the platform account.
-- NULL for the platform account itself, an unknown id, a parent cycle, or a
-- chain deeper than 64 (corrupt data) -- never a guess.
CREATE OR REPLACE FUNCTION jointbox_company_root(p_user_id integer) RETURNS integer
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  v_cur integer := p_user_id;
  v_parent integer;
  v_role text;
  v_root integer := NULL;
  v_depth integer := 0;
BEGIN
  IF p_user_id IS NULL THEN RETURN NULL; END IF;
  LOOP
    SELECT u."parentId", u."role"::text INTO v_parent, v_role FROM "User" u WHERE u."id" = v_cur;
    IF NOT FOUND OR v_role = 'SUPER_ADMIN' THEN RETURN v_root; END IF;
    v_root := v_cur;
    IF v_parent IS NULL THEN RETURN v_root; END IF;
    v_depth := v_depth + 1;
    IF v_depth > 64 THEN RETURN NULL; END IF;
    v_cur := v_parent;
  END LOOP;
END
$fn$;

-- A share counts across companies only when someone entitled to give the
-- router away made it: an account of the router's own company, or the
-- platform account. A share with no recorded author is not proof of consent.
CREATE OR REPLACE FUNCTION jointbox_radius_share_authorised(p_assigner integer, p_nas_company integer) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT p_assigner IS NOT NULL AND EXISTS (
    SELECT 1 FROM "User" u
     WHERE u."id" = p_assigner
       AND (u."role"::text = 'SUPER_ADMIN'
            OR (p_nas_company IS NOT NULL AND jointbox_company_root(u."id") = p_nas_company)))
$fn$;

-- May a subscriber owned by account p_owner use router p_nas?
-- 'allow' or the reason it may not.
CREATE OR REPLACE FUNCTION jointbox_radius_owner_on_nas(p_owner integer, p_nas integer) RETURNS text
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  v_sub_company integer;
  v_nas_owner integer;
  v_nas_company integer;
  v_cur integer;
  v_parent integer;
  v_role text;
  v_depth integer := 0;
BEGIN
  IF p_owner IS NULL OR NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = p_owner) THEN
    RETURN 'subscriber-no-owner';
  END IF;
  v_sub_company := jointbox_company_root(p_owner);
  IF v_sub_company IS NULL THEN RETURN 'subscriber-no-company'; END IF;

  SELECT n."ownerId" INTO v_nas_owner FROM "nas" n WHERE n."id" = p_nas;
  IF v_nas_owner IS NOT NULL THEN
    v_nas_company := jointbox_company_root(v_nas_owner);
    IF v_nas_company = v_sub_company THEN RETURN 'allow'; END IF;
  END IF;

  -- Not the subscriber's company's router: only an explicit, authorised share
  -- to the owner itself, or a propagating share to an account above it INSIDE
  -- its company. The walk stops below the platform account, so a share to the
  -- platform account reaches nobody.
  v_cur := p_owner;
  LOOP
    IF EXISTS (SELECT 1 FROM "NasAssignment" a
                WHERE a."nasId" = p_nas AND a."userId" = v_cur
                  AND (v_cur = p_owner OR a."propagate")
                  AND jointbox_radius_share_authorised(a."assignedById", v_nas_company)) THEN
      RETURN 'allow';
    END IF;
    SELECT u."parentId" INTO v_parent FROM "User" u WHERE u."id" = v_cur;
    EXIT WHEN v_parent IS NULL;
    SELECT u."role"::text INTO v_role FROM "User" u WHERE u."id" = v_parent;
    EXIT WHEN NOT FOUND OR v_role = 'SUPER_ADMIN';
    v_depth := v_depth + 1;
    EXIT WHEN v_depth > 64;
    v_cur := v_parent;
  END LOOP;

  IF v_nas_owner IS NULL THEN RETURN 'nas-no-owner'; END IF;
  IF v_nas_company IS NULL THEN RETURN 'nas-no-company'; END IF;
  RETURN 'cross-company';
END
$fn$;

-- The router behind a RADIUS source address. Mirrors the client list: only
-- ACTIVE routers are rendered, one per address. Two active routers on one
-- address is ambiguous ownership.
CREATE OR REPLACE FUNCTION jointbox_radius_nas(p_ip text, OUT nas_id integer, OUT reason text)
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  v_ip inet;
  v_active integer;
  v_total integer;
BEGIN
  BEGIN
    v_ip := nullif(btrim(p_ip), '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;
  IF v_ip IS NULL THEN reason := 'nas-unknown'; RETURN; END IF;
  -- an IPv4 router seen through a dual-stack socket (::ffff:a.b.c.d)
  IF family(v_ip) = 6 AND host(v_ip) ~ '^::ffff:[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' THEN
    v_ip := substring(host(v_ip) from 8)::inet;
  END IF;
  SELECT count(*) FILTER (WHERE n."isActive"), min(n."id") FILTER (WHERE n."isActive"), count(*)
    INTO v_active, nas_id, v_total
    FROM "nas" n
   WHERE n."nasIp" IS NOT NULL AND host(n."nasIp") = host(v_ip) AND family(n."nasIp") = family(v_ip);
  IF v_total = 0 THEN nas_id := NULL; reason := 'nas-unknown';
  ELSIF v_active = 0 THEN nas_id := NULL; reason := 'nas-disabled';
  ELSIF v_active > 1 THEN nas_id := NULL; reason := 'nas-ambiguous';
  END IF;
END
$fn$;

-- The decision, with no side effects: 'allow' or the reason for refusing.
CREATE OR REPLACE FUNCTION jointbox_radius_authz(p_username text, p_nas_ip text) RETURNS text
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  v_nas integer;
  v_reason text;
  v_owner integer;
BEGIN
  SELECT r.nas_id, r.reason INTO v_nas, v_reason FROM jointbox_radius_nas(p_nas_ip) r;
  IF v_reason IS NOT NULL THEN RETURN v_reason; END IF;
  IF p_username IS NULL OR p_username = '' THEN RETURN 'subscriber-unknown'; END IF;
  SELECT s."userId" INTO v_owner FROM "Subscriber" s WHERE s."username" = p_username;
  IF NOT FOUND THEN RETURN 'subscriber-unknown'; END IF;
  RETURN jointbox_radius_owner_on_nas(v_owner, v_nas);
END
$fn$;

-- Current mode. A missing or unreadable switch means enforce (fail closed).
CREATE OR REPLACE FUNCTION jointbox_radius_tenancy_mode() RETURNS text
LANGUAGE plpgsql STABLE AS $fn$
DECLARE v_mode text;
BEGIN
  SELECT s."mode" INTO v_mode FROM "radius_tenancy_setting" s WHERE s."id" = 1;
  IF v_mode IN ('off', 'monitor', 'enforce') THEN RETURN v_mode; END IF;
  RETURN 'enforce';
EXCEPTION WHEN others THEN
  RETURN 'enforce';
END
$fn$;

-- The NAS-IP-Address a router writes into a packet is its own claim. It is
-- what the accounting row and the post-auth log record as "the router", and
-- what a CoA is later sent to — so a router claiming ANOTHER company's
-- router address would file its sessions under that router (visible to that
-- company) and steer disconnects at it. NULL when the claim is harmless:
-- absent, not an address, the sending router's own address, a router of the
-- same company, or an address no router has (a private address behind NAT).
CREATE OR REPLACE FUNCTION jointbox_radius_claim(p_src_ip text, p_claimed_ip text) RETURNS text
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  v_src integer;
  v_src_reason text;
  v_claimed inet;
  v_src_company integer;
BEGIN
  IF p_claimed_ip IS NULL OR btrim(p_claimed_ip) = '' THEN RETURN NULL; END IF;
  BEGIN
    v_claimed := btrim(p_claimed_ip)::inet;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF family(v_claimed) = 6 AND host(v_claimed) ~ '^::ffff:[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' THEN
    v_claimed := substring(host(v_claimed) from 8)::inet;
  END IF;
  SELECT r.nas_id, r.reason INTO v_src, v_src_reason FROM jointbox_radius_nas(p_src_ip) r;
  IF v_src IS NULL THEN RETURN NULL; END IF; -- the source itself is judged by jointbox_radius_authz
  SELECT jointbox_company_root(n."ownerId") INTO v_src_company FROM "nas" n WHERE n."id" = v_src;
  IF EXISTS (SELECT 1 FROM "nas" n
              WHERE n."nasIp" IS NOT NULL AND n."id" <> v_src
                AND host(n."nasIp") = host(v_claimed) AND family(n."nasIp") = family(v_claimed)
                AND jointbox_company_root(n."ownerId") IS DISTINCT FROM v_src_company) THEN
    RETURN 'nas-ip-foreign';
  END IF;
  RETURN NULL;
END
$fn$;

-- Count a refusal (or, in monitor mode, a would-be refusal). Never fails the
-- request: the decision does not depend on the write.
CREATE OR REPLACE FUNCTION jointbox_radius_tenancy_record(p_kind text, p_reason text, p_username text, p_nas_ip text, p_mode text) RETURNS void
LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  INSERT INTO "radius_tenancy_event" ("kind", "reason", "username", "nas_ip", "mode")
  VALUES (left(coalesce(p_kind, ''), 16), left(coalesce(p_reason, ''), 40),
          left(coalesce(p_username, ''), 64), left(coalesce(p_nas_ip, ''), 64), p_mode)
  ON CONFLICT ("kind", "reason", "username", "nas_ip") DO UPDATE
    SET "count" = "radius_tenancy_event"."count" + 1,
        "last_at" = CURRENT_TIMESTAMP,
        "mode" = EXCLUDED."mode";
EXCEPTION WHEN others THEN
  RAISE WARNING 'jointbox tenancy: event not recorded (SQLSTATE %)', SQLSTATE;
END
$fn$;

-- Called by FreeRADIUS (authorize, outer and inner-tunnel: kind 'auth';
-- accounting: kind 'acct') and by the panel before a CoA / disconnect / router
-- API call (kind 'coa'). p_nas_ip is the packet's SOURCE address;
-- p_claimed_ip the NAS-IP-Address inside it (FreeRADIUS only).
-- Returns 'allow', 'monitor:<reason>' (would refuse; allowed in monitor mode)
-- or 'reject:<reason>'. The username is recorded only when it is a
-- subscriber's (anything a router sends would otherwise land in the table),
-- whatever the reason.
-- An unexpected error inside the check is 'check-error': refused when
-- enforced, allowed (and recorded) in monitor — it can never switch
-- enforcement off.
-- Kind 'auth-eap-id' (FreeRADIUS, an EAP Identity or NAK round) verifies no
-- credential: the answer to such a round is always an Access-Challenge, and
-- its name is often a placeholder ("anonymous" outside a TTLS / PEAP tunnel).
-- The router and its NAS-IP-Address claim are judged as usual, and so is a
-- name that IS a subscriber; a name that is no subscriber is left to the
-- round that verifies the credential (the EAP method round, or the identity
-- inside the tunnel) and is not recorded. Recorded as kind 'auth'.
DROP FUNCTION IF EXISTS jointbox_radius_tenancy(text, text, text);
CREATE OR REPLACE FUNCTION jointbox_radius_tenancy(p_kind text, p_username text, p_nas_ip text, p_claimed_ip text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $fn$
DECLARE
  v_mode text := jointbox_radius_tenancy_mode();
  v_reason text;
  v_named boolean := true; -- the username is a subscriber (safe to record)
BEGIN
  IF v_mode = 'off' THEN RETURN 'allow'; END IF;
  BEGIN
    v_reason := jointbox_radius_authz(p_username, p_nas_ip);
    IF v_reason = 'subscriber-unknown' AND p_kind = 'auth-eap-id' THEN
      v_named := false;
      v_reason := 'allow'; -- judged where the credential is (see above); the router still is, below
    END IF;
    IF v_reason = 'allow' THEN
      v_reason := coalesce(jointbox_radius_claim(p_nas_ip, p_claimed_ip), 'allow');
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'jointbox tenancy: check failed (SQLSTATE %)', SQLSTATE;
    v_reason := 'check-error';
  END;
  IF v_reason = 'allow' THEN RETURN 'allow'; END IF;
  -- record the username only when it is a subscriber's: whatever else a
  -- router sends (a mistyped password, probing) never lands in the table
  BEGIN
    v_named := v_named AND v_reason NOT IN ('subscriber-unknown', 'check-error')
               AND EXISTS (SELECT 1 FROM "Subscriber" s WHERE s."username" = p_username);
  EXCEPTION WHEN others THEN
    v_named := false;
  END;
  PERFORM jointbox_radius_tenancy_record(
            CASE WHEN p_kind = 'auth-eap-id' THEN 'auth' ELSE p_kind END, v_reason,
            CASE WHEN v_named THEN p_username ELSE '' END,
            p_nas_ip, v_mode);
  RETURN CASE WHEN v_mode = 'enforce' THEN 'reject:' ELSE 'monitor:' END || v_reason;
END
$fn$;

-- Accounting-On / Accounting-Off close every open session recorded under the
-- NAS-IP-Address the router CLAIMS (and stamp nasreload for it). That
-- attribute is router-supplied, so a router of one company could close
-- another company's sessions with it. The packet is acted on only when the
-- claimed address is not another company's router and every open session
-- under it belongs to a subscriber the SENDING router may carry.
CREATE OR REPLACE FUNCTION jointbox_radius_tenancy_onoff(p_claimed_ip text, p_src_ip text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $fn$
DECLARE
  v_mode text := jointbox_radius_tenancy_mode();
  v_claimed inet;
  v_nas integer;
  v_reason text;
BEGIN
  IF v_mode = 'off' THEN RETURN 'allow'; END IF;
  BEGIN
    v_claimed := nullif(btrim(p_claimed_ip), '')::inet;
  EXCEPTION WHEN others THEN
    v_claimed := NULL;
  END;
  IF v_claimed IS NULL THEN RETURN 'allow'; END IF; -- matches no session row
  BEGIN
    SELECT r.nas_id, r.reason INTO v_nas, v_reason FROM jointbox_radius_nas(p_src_ip) r;
    IF v_reason IS NULL THEN
      v_reason := jointbox_radius_claim(p_src_ip, p_claimed_ip);
    END IF;
    IF v_reason IS NULL AND EXISTS (
         SELECT 1
           FROM (SELECT DISTINCT s."userId" AS owner
                   FROM "radacct" a JOIN "Subscriber" s ON s."username" = a."username"
                  WHERE a."nasipaddress" = v_claimed AND a."acctstoptime" IS NULL) o
          WHERE jointbox_radius_owner_on_nas(o.owner, v_nas) <> 'allow') THEN
      v_reason := 'onoff-foreign-sessions';
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'jointbox tenancy: on/off check failed (SQLSTATE %)', SQLSTATE;
    v_reason := 'check-error';
  END;
  IF v_reason IS NULL THEN RETURN 'allow'; END IF;
  PERFORM jointbox_radius_tenancy_record('acct-onoff', v_reason, '', p_src_ip, v_mode);
  RETURN CASE WHEN v_mode = 'enforce' THEN 'reject:' ELSE 'monitor:' END || v_reason;
END
$fn$;

-- SECURITY DEFINER hygiene: every function resolves names in THIS schema only,
-- with pg_temp last, so a caller's temporary table can never stand in for
-- "Subscriber" or "nas".
DO $pin$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'jointbox_company_root(integer)',
    'jointbox_radius_share_authorised(integer, integer)',
    'jointbox_radius_owner_on_nas(integer, integer)',
    'jointbox_radius_nas(text)',
    'jointbox_radius_authz(text, text)',
    'jointbox_radius_tenancy_mode()',
    'jointbox_radius_tenancy_record(text, text, text, text, text)',
    'jointbox_radius_claim(text, text)',
    'jointbox_radius_tenancy(text, text, text, text)',
    'jointbox_radius_tenancy_onoff(text, text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_temp', f, current_schema());
  END LOOP;
END
$pin$;
