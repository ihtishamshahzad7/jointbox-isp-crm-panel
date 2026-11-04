# Hosting the CRM on a remote Windows PC

**Cloudflare Tunnel (current setup, `https://crm.advanceispcrm.win`):** no port forwarding is needed. With `cloudflared` installed and the tunnel created (`cloudflared tunnel login`, `tunnel create ispcrm`, `tunnel route dns ispcrm crm.advanceispcrm.win`, and `%USERPROFILE%\.cloudflared\config.yml` pointing at `http://127.0.0.1:3000`), run this in an Administrator PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File deploy\setup_remote.ps1 -Tunnel
```
It sets up the database service, the CRM startup task, daily backups and the `Cloudflared` service. Caddy and the router steps below apply only to the static-IP setup.

The CRM keeps running on `127.0.0.1:3000`. Caddy listens on ports 80/443, serves HTTPS for the PC's static public IP, and forwards requests to the CRM. PostgreSQL runs as a Windows service. All three start automatically at boot, with no user signed in.

## Requirements

- Windows 10/11 or Server, always on, with a static public IP.
- Router access to forward TCP **80** and **443** to this PC. Nothing else on the PC may use those ports (for example IIS or Skype).

## Setup

1. Copy the project folder to the PC, e.g. `C:\ispcrm`.
2. Copy `database.example.json` to `database.local.json` and set a strong `password`.
3. Open **PowerShell as Administrator** in the project folder and run, using your IP:
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\setup_remote.ps1 -PublicIP 203.0.113.10
   ```
4. When prompted, create the administrator account at http://localhost:3000 **on that PC**. Until an administrator exists, anyone who opens the site can create one, so the firewall stays closed until this is done.
5. On the router, forward TCP 80 and 443 to this PC's LAN address.
6. Open `https://<your IP>` from another network (mobile data works) to check it.

For password-reset emails, set `base_url` in `email.local.json` to `https://<your IP>`.

## Operation

- Logs: `deploy\logs\crm.log` and `deploy\logs\caddy.log`.
- Restart after changing code: `Stop-ScheduledTask 'ISP CRM'; Start-ScheduledTask 'ISP CRM'` (Administrator).
- Backups: the `ISP CRM Backup` task saves the database to `deploy\backups` every day at 02:00 and keeps the newest 14. Run `deploy\backup_db.ps1` for an immediate backup. Customer documents are stored in the database, so they're included. Copy backups off this machine regularly.
- An existing portable PostgreSQL in `%LOCALAPPDATA%\PostgreSQL16` (from a no-admin install) is moved to `C:\ProgramData\ispcrm` and registered as the `ispcrm-postgres` service, so existing data is kept. The original folder is left in place as a fallback.

## Certificates

Let's Encrypt certificates for bare IP addresses are short-lived (about 6 days), and Caddy renews them automatically. Ports 80 and 443 must stay reachable from the internet for renewal. If `caddy.log` shows certificate errors, the usual causes are a port that isn't forwarded or another program using it. A domain name (about $10/year) pointed at the IP works the same way: replace the IP in `Caddyfile.local` with the domain and restart the `ISP CRM HTTPS` task.
