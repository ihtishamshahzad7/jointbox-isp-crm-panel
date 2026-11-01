# UPLINKO ISP CRM — Update 1D MikroTik Staging Pilot Checklist

## Device pilot status: **NOT RUN / BLOCKED** — no non-production MikroTik available

No real router was reachable from this environment, so nothing below has been
executed. This is a ready-to-run checklist for **one non-production MikroTik NAS**
on a staging install. **Do not enable SNMP on production routers. Do not use
production credentials.**

## Preconditions

- A staging Uplinko deploy with the integration branch + validated migrations applied
  (DB snapshot taken first).
- `SNMP_ALLOWED_CIDRS` set to the test router's IP/CIDR only (deny-by-default).
- `SNMP_MONITOR` enabled on the primary instance; Redis available if multi-instance.
- A spare/lab MikroTik on a management network, reachable over UDP 161 from the panel host.
- Test credentials created only for the pilot.

## On the MikroTik (test device)

1. `/snmp community add name=<test-comm> addresses=<panel-ip>/32` **or** for v3:
   `/snmp community`/`/snmp` v3 USM user with **SHA auth + AES priv** (authPriv).
2. `/snmp set enabled=yes contact=... location=...`
3. Restrict access to the panel host IP (SNMP ACL), confirm UDP 161 open from the panel only.

## Pilot steps & pass criteria

| # | Step | Pass criteria |
|---|---|---|
| 1 | Configure the NAS in Uplinko (SNMPv3 authPriv; test credentials) | Saved; passphrases returned **masked**; config summary correct |
| 2 | Credential storage | DB `snmpV3AuthPass`/`snmpV3PrivPass`/`snmpCommunity` stored **encrypted**; never returned in any API/JSON/log |
| 3 | `SNMP_ALLOWED_CIDRS` enforcement | A target **outside** the allowlist is refused (Forbidden); the test IP inside it is allowed |
| 4 | Port validation | Non-integer / out-of-range port rejected at save |
| 5 | Test connectivity (`snmp-test`) | Returns uptime, sysDescr, interface count, CPU/memory (or "—" where unsupported — never fabricated 0) |
| 6 | SNMPv3 auth & privacy | authPriv succeeds; deliberately wrong passphrase → `auth_error` state, **no credential in the error** |
| 7 | Polling interval & timeout | Polls on the configured interval; a dropped device times out within the budget and does not stall others |
| 8 | Interface discovery | Interfaces enumerated with name/oper status/speed |
| 9 | Interface counters & rates | rx/tx bps plausible over ≥2 intervals; not above line speed |
| 10 | Counter reset / router reboot | After reboot (uptime regress) no false spike; baseline resets cleanly |
| 11 | Interface rename/change | Renamed interface handled without crash; new identity tracked |
| 12 | NAS unreachable → recovery | Unplug/stop SNMP → `unreachable`/`timeout` state + a single `unreachable` event (no storm); restore → `poll_recovered` event + `ok` |
| 13 | Event deduplication | Repeated failures of the same kind do **not** create a new event each poll; thresholds respect cooldown |
| 14 | Alert acknowledgement | `Ack` on an event marks it acknowledged; scoped to the NAS/tenant |
| 15 | Second NAS independence | A second monitored NAS keeps its own cadence/state while the first fails |
| 16 | No interference | PPPoE sessions, RADIUS auth, billing, and subscriber connectivity unaffected throughout |

## Rollback / cleanup after the pilot

- Disable SNMP on the test router; remove the pilot community/user.
- In Uplinko, disable SNMP on the NAS (writes a `monitoring_disabled` event, state → `disabled`).
- Restore the staging DB snapshot if desired.

Only after every row above passes on a real device should Stage 2 SNMP be
considered for production enablement.
