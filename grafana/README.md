# Jointbox — Grafana network monitoring

A ready-to-run Grafana with the Postgres datasource and a **Jointbox — Network & Business**
dashboard provisioned automatically (online now, active subscribers, revenue,
traffic GB/hour, new sessions/hour, online-by-NAS, status pie).

## Run

```bash
cd grafana
# DB_PASSWORD = your jointbox DB password (printed by install.sh / in backend/.env)
DB_PASSWORD='<your-db-pass>' docker compose up -d
```

Open **http://<server-ip>:3009** and log in (default `admin` / `admin`, change on
first login). The dashboard appears automatically — no import needed.

## Options (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `DB_PASSWORD` | — (required) | jointbox Postgres password |
| `DB_HOST` | `host.docker.internal` | where Postgres runs (use the LAN IP if remote) |
| `DB_NAME` / `DB_USER` | `jointbox` | database / user |
| `GF_ADMIN_USER` / `GF_ADMIN_PASSWORD` | `admin` | Grafana login |

If Postgres only listens on localhost, either keep `host.docker.internal` (the
compose file maps it to the host) or set `DB_HOST` to the server's LAN IP —
`install.sh` already opens Postgres to the LAN.

## Add your own panels

The datasource is plain Postgres, so any panel is just SQL. Useful tables:
`radacct` (live/'closed sessions), `"Subscriber"`, `"Package"`, `"Nas"`,
`"LinkSignal"`, `"NetworkLog"`. Edit panels in the UI (allowed) or drop more
JSON into `dashboards/`.
