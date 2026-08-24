# IP Allocation Register — Routed Client Prefixes

Authoritative record of routed blocks delegated to corporate / P2P clients.

> **This file is a mirror, not the source of truth.** The live register lives in
> the `prefix_allocation` table and is served by `/prefixes`. Keep this file in
> step when provisioning by hand; once the UI is in use, generate it from the
> API instead of editing it. Two hand-maintained copies of the same fact is
> exactly how a prefix gets issued twice.

---

## Address space

| Pool | CIDR | Kind | Hands out | Purpose |
|---|---|---|---|---|
| Customer public space | `103.115.196.0/24` | PUBLIC | `/29` | Routed blocks delegated to clients |
| P2P transit links | `10.152.0.0/16` | TRANSIT | `/30` | Point-to-point link addressing |

Confirm both against the ranges you actually hold — they were inferred from the
first provisioned client and are yours to correct in `prefix_pool`.

---

## Active allocations

| # | Client | VLAN | Transit /30 | Our IP | Client IP | Delegated prefix | uRPF | Ingress ACL | Provisioned |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Zubair | 651 | `10.152.0.0/30` | `10.152.0.1` | `10.152.0.2` | `103.115.196.8/29` | Enabled | `ACL-CLIENT-ZUBAIR-IN` | 23-Aug-2026 |

### Consumed so far

- **Public:** `103.115.196.8/29` — 8 addresses of the /24. Note the /24 is
  allocated from `.8`, so `103.115.196.0/29` is still free.
- **Transit:** `10.152.0.0/30`.
- **VLANs in use:** 651.

---

## Client record — Zubair

```
====================================================
Client Name      : Zubair
VLAN             : 651
VLAN Name        : vlan651-Zubair
Link Type        : P2P /30
Client IP        : 10.152.0.2/30
Cisco End IP     : 10.152.0.1/30
Allocated Prefix : 103.115.196.8/29
Static Route     : ip route 103.115.196.8/29 10.152.0.2
Provisioned Date : 23-Aug-2026
uRPF             : Enabled
Ingress ACL      : ACL-CLIENT-ZUBAIR-IN
====================================================
```

### Usable addresses handed to the client

`103.115.196.8/29` — network `.8`, broadcast `.15`, **usable `.9` – `.14`** (6 hosts).

### Router configuration as applied

```
vlan 651
 name vlan651-Zubair
!
interface Vlan651
 description Client-Zubair-P2P-23Aug2026
 no shutdown
 mtu 1500
 ip address 10.152.0.1/30
 ip verify unicast source reachable-via rx
 ip access-group ACL-CLIENT-ZUBAIR-IN in
!
ip route 103.115.196.8/29 10.152.0.2 name Client-Zubair
!
ip access-list ACL-CLIENT-ZUBAIR-IN
 10 permit ip 103.115.196.8/29 any
 20 deny ip any any log
```

### Decommission (when this client leaves)

```
no ip route 103.115.196.8/29 10.152.0.2
no interface Vlan651
no vlan 651
no ip access-list ACL-CLIENT-ZUBAIR-IN
```

Then release in the register so the space returns to the pool:

```bash
curl -X DELETE localhost:3001/prefixes/<id> \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"reason":"Client terminated 2026-xx-xx"}'
```

Releasing keeps the historical row. That matters: when abuse on a prefix is
reported months later, you must still be able to say who held it at the time.

---

## Provisioning the next client

Do **not** pick a block by eye from the table above — ask the register, which
checks overlaps against both delegated prefixes and transit links:

```bash
# 1. What is free?
curl -s "localhost:3001/prefixes/pools/1/next-free?size=29" -H "Authorization: Bearer <t>"

# 2. Provision — allocates the block AND the /30, writes the record,
#    and returns the router config to paste.
curl -s -X POST localhost:3001/prefixes/provision \
  -H "Authorization: Bearer <t>" -H "Content-Type: application/json" \
  -d '{
        "clientName": "Ahmed",
        "poolId": 1,
        "transitPoolId": 2,
        "vlanId": 652,
        "size": 29
      }'
```

The response contains `config` (paste onto the router) and `summary` (the
handover sheet for the client). Names are derived automatically —
`vlan652-Ahmed`, `ACL-CLIENT-AHMED-IN`, `Client-Ahmed-P2P-<date>` — matching the
Zubair convention, and all overridable.

### Why generate rather than hand-write

The ACL, the static route and the interface address all repeat the same prefix.
Typed by hand, a single wrong digit in the ACL is a silent security hole — the
link comes up, traffic flows, and nothing looks wrong until the wrong source
range is permitted. Generating them from one stored record makes that class of
mistake impossible.

---

## Conventions

| Item | Pattern | Example |
|---|---|---|
| VLAN name | `vlan<id>-<Client>` | `vlan651-Zubair` |
| Interface description | `Client-<Name>-<LinkType>-<DDMonYYYY>` | `Client-Zubair-P2P-23Aug2026` |
| Ingress ACL | `ACL-CLIENT-<NAME>-IN` | `ACL-CLIENT-ZUBAIR-IN` |
| Static route name | `Client-<Name>` | `Client-Zubair` |
| Transit addressing | `.1` = our end, `.2` = client end | `10.152.0.1` / `10.152.0.2` |
| MTU | 1500 unless the client asks otherwise | `1500` |
| uRPF | Enabled by default (`reachable-via rx`) | — |
| ACL policy | permit client prefix, then `deny ip any any log` | — |

**On the trailing `deny ip any any log`:** the implicit deny at the end of a
Cisco ACL is invisible. Making it explicit and logged means that during an
incident you can answer "is the ACL dropping this?" from the logs instead of
guessing.
