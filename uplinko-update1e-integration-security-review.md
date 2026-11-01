# UPLINKO ISP CRM — Update 1E Integration & Security Review

Reviewed against the **current local source** in `F:\Jointbox panel-update1b-integration`
(not just prior reports). Each control was confirmed present in the actual files.

## Stage 1
| Control | File (verified) | Finding |
|---|---|---|
| Atomic wallet update + idempotency | `backend/src/billing-ext/billing-ext.service.ts` | Uses `{ increment }` atomic update inside `$transaction`; `idempotencyKey` dedup present (9 refs). **OK** |
| Distributed login lockout, fail-closed | `backend/src/auth/auth.service.ts` | Redis `cache.incr/getCount`, `redisIsRequired`, `ServiceUnavailable` fail-closed (11 markers). **OK** |
| Secure first-boot admin | `backend/src/common/bootstrap-credentials.ts` | Present; generated creds, no hardcoded default. **OK** |
| Bounded router presence | `backend/src/subscribers/subscribers.service.ts` | `mapLimit` + `withTimeout` + single-flight guard (9 markers). **OK** |
| SQL-level reseller/dealer session scope | `backend/src/network/network.service.ts` | `scopedUsernames` pushed into the query (6 markers). **OK** |

## Stage 2 (SNMP)
| Control | File | Finding |
|---|---|---|
| SNMPv3 authPriv, no silent downgrade | `telemetry/device-health.service.ts`, `nas/nas-snmp-config.ts` | `createV3Session`; `normalizeSnmpVersion` throws on unknown; `assertSnmpConfigValid` requires complete auth/priv. **OK** |
| SNMP target allowlist (SSRF) | `nas/nas-snmp-config.ts` → `assertSnmpTargetAllowed`, enforced in `device-health.service.ts:session()` | Literal-IP only (no DNS → no rebind); `SNMP_ALLOWED_CIDRS` required (deny-by-default); `BlockList` IPv4/IPv6 family-aware; CIDR + port validated. **OK** |
| Secret encryption + masking | `nas/nas-credentials.ts` (`encField/decField/sanitizeNas`) | Community + v3 passphrases encrypted at rest, masked in API; legacy plaintext NOT auto-migrated. **OK** |
| Error redaction | `telemetry/device-health.service.ts` `classifyError` | Fixed operator-safe messages; raw errors/credentials never surfaced. **OK** |
| Tenant-scoped NAS authorization | `telemetry/telemetry.controller.ts` | All SNMP endpoints call `scope.assertNas` under Jwt + Permissions guards. **OK** |
| Concurrency/timeout, dedup, backoff, recovery, ack | `telemetry/snmp-monitor.service.ts` | Bounded `mapLimit`, per-NAS `withTimeout`, `inFlight` single-flight, `consecutiveFailures` backoff, transition-only events + cooldown, `ackEvent` (20 markers). **OK** |

## Existing functionality preserved
No changes in 1E to PPPoE/RADIUS/L2TP-IPsec/WireGuard/SSTP/billing/NAS provisioning/subscriber
or reseller code. The only 1E source edit is a **test-only** Windows platform guard. Stage
1/2 integration is additive and isolated; focused suites (110+37+27) pass (1C).

## Residual risks
- `SNMP_ALLOWED_CIDRS` is the single SSRF gate — must be set correctly per deployment.
- Live secret-in-logs and real-device auth verification remain for the MikroTik pilot.
- Legacy plaintext SNMP communities must be rotated/re-entered via the secured UI before a pilot.

**Security verdict: PASS (code review against current local source).**
