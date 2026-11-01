# UPLINKO ISP CRM — Update 1E Live MikroTik Evidence Review

**Client environment:** a real MikroTik running Uplinko with ~16 subscribers, managed by
the user. The agent works **locally only** and has **no authorized connection** to the
client router or server — nothing here was executed against the live device, and must not be.

## Evidence status
As of this phase, **no live logs, screenshots, or observations have been supplied** for
Update 1E. The table classifies each feature accordingly; rows move to "Confirmed working in
the real client environment" only when you provide evidence to review.

| Feature | Classification | Notes |
|---|---|---|
| NAS connection + SNMP authentication | Reported by user, not independently verified | Provide a `snmp-test` result / screenshot |
| SNMPv3 monitoring + interface discovery | Not yet verified | Needs status panel + interface list from the live NAS |
| Traffic counters + monitoring updates | Not yet verified | Needs two+ interval samples from the live device |
| NAS health + event history | Not yet verified | Needs the Health tab / events list |
| Failure + recovery handling | Not yet verified | Safe test below (do NOT disrupt subscribers) |
| Event deduplication | Not yet verified | Observe that repeated failures create one event |
| Secret masking | Confirmed by automated tests + code review | `sanitizeNas`; confirm in UI that saved secrets show `••••` |
| PPPoE subscriber connectivity | Reported working (16 subs live) | Keep undisturbed |
| RADIUS auth + accounting | Reported working | Keep undisturbed |
| VPN management connectivity (L2TP/IPsec, WG, SSTP) | Reported/assumed; unchanged by this work | Not touched in 1E |
| Billing + wallet | Confirmed by automated tests; live not verified | Wallet concurrency proven in a disposable DB (1D) |

## Safe, non-disruptive checks you can run (never touch the 16 subscribers)
1. **SNMP read-only test:** NAS page → "Test SNMP". Expect uptime, sysDescr, interface
   count, CPU/memory (or "—" where unsupported). Read-only; does not change the router.
2. **Status/health:** open the NAS Health tab; confirm last-poll time advances and metrics
   populate. Read-only.
3. **Masking:** re-open NAS config; confirm SNMP community / v3 passphrases show masked.
4. **Recovery (optional, safe):** temporarily tighten the router's SNMP ACL to drop the
   panel's polls (does **not** affect PPPoE/RADIUS), confirm the NAS goes
   `unreachable`/`timeout` with **one** event, then restore the ACL and confirm a
   `poll_recovered` event + `ok`. **Do not** disable interfaces, reboot, or change
   PPPoE/RADIUS/VPN/credentials.

Please share the outputs/screenshots and I'll classify each row as confirmed or open an
investigation for anything that misbehaves.

## Risk to the 16 subscribers
**None introduced by this phase.** No live commands were run; the only code change is a
Windows-only test guard. SNMP monitoring is read-only and opt-in per NAS; the SSRF allowlist
(`SNMP_ALLOWED_CIDRS`) must be scoped to the test router before enabling.
