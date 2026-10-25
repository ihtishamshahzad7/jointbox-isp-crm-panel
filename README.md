# Jointbox — ISP CRM / Billing Panel

Jointbox is a self-hosted CRM, billing, and network-operations panel for internet service providers. It manages subscriber provisioning and RADIUS AAA (FreeRADIUS), packages and pricing, invoicing and payments, a reseller/franchise hierarchy (ISP → Franchise → Dealer → Retailer, each with a prepaid wallet), network monitoring (MikroTik/NAS, fiber OLT/ONU, SNMP, syslog), support tickets, and reporting.

## Stack

- **Backend:** NestJS 11, Prisma 6.8 + PostgreSQL, Redis/BullMQ (optional — falls back to in-memory), FreeRADIUS on a shared Postgres schema, PM2 clustering.
- **Frontend:** Next.js 16 (React 19, Turbopack), Tailwind 4, SWR, recharts.

## Getting started

**Fresh Ubuntu 22.04/24.04 server — one command:**

```bash
curl -fsSL https://raw.githubusercontent.com/ihtishamshahzad7/jointbox-isp-crm-panel/main/install.sh -o /tmp/uplinko-install.sh && sudo bash /tmp/uplinko-install.sh
```

**Update an existing server:**

```bash
sudo bash /opt/jointbox/update-jointbox.sh
```

Both are idempotent, take backups before schema changes, and health-check the
API and panel before reporting success. Full details — requirements, ports,
backup/restore, verification, and troubleshooting — are in
[`docs/INSTALL.md`](docs/INSTALL.md). For local development setup, see `SETUP.md`.

## Where to look next

- `DOCUMENTATION.md` — feature and architecture overview.
- `SETUP.md` / `DEPLOYMENT_GUIDE.md` / `DEPLOY_UBUNTU.md` — install and deploy instructions.
- `ROADMAP.md` / `CHECKLIST.md` / `ADVANCEMENT.md` / `ADVANCED_FEATURES_ROADMAP.md` — feature gap analysis and forward roadmap.
- `HANDOFF.md` — current engineering state: what's deployed, what's decided, what's still open. Read this before debugging anything that "looks broken."
- `ISP_CRM_COMPLETION_ROADMAP.md` — consolidated build order across all of the above, including the internationalization work (multi-currency, tax profiles, broader payment gateways) needed to take this from a regional to a global-ready product.
- `TESTING.md` / `TEST_GUIDE.md` — how to run and write tests.

## License

Proprietary — internal project. Not licensed for redistribution.
