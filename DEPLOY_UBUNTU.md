# Jointbox — Ubuntu Deployment & OVA Appliance Guide

Ways to run Jointbox on Ubuntu, easiest first. Everything lives in the `deploy/` folder.

- **0. One-line install from GitHub** — publish once, end user runs a single command.
- **A. Docker** — one command, everything self-contained.
- **B. Native install script** — installs Node/Postgres/Redis/FreeRADIUS/Nginx directly on the OS.
- **C. Build your own OVA** — a ready-to-import virtual appliance with Jointbox pre-installed (how Zal Pro ships).

Target OS: Ubuntu 22.04 or 24.04 LTS. Minimum VM: 2 vCPU, 4 GB RAM, 40 GB disk.

The native installer sets up **everything an ISP needs**: Node 20, PostgreSQL (with the Jointbox + RADIUS schema via Prisma migrations), Redis, **FreeRADIUS 3 wired to the same PostgreSQL** (auth 1812, acct 1813, CoA 3799), Nginx on port 80, PM2 auto-start, and the firewall. The end user only installs Ubuntu and runs one command.

---

## 0. One-line install from GitHub (the goal)

### You (once): publish the repo
1. Create a **public** GitHub repo, e.g. `github.com/you/jointbox`.
2. From the project root, make sure `node_modules`, `.next`, `dist` are git-ignored (a `.gitignore` is included), then push:
   ```bash
   git init && git add . && git commit -m "Jointbox"
   git branch -M main
   git remote add origin https://github.com/you/jointbox.git
   git push -u origin main
   ```
3. Edit `deploy/bootstrap.sh` and set `REPO_URL` to your repo (or the end user passes `JOINTBOX_REPO=`).

### End user (on a fresh Ubuntu): one command
```bash
curl -fsSL https://raw.githubusercontent.com/you/jointbox/main/deploy/bootstrap.sh | sudo bash
```
That installs git, clones your repo to `/opt/jointbox`, and runs the full installer — Node, PostgreSQL, Redis, FreeRADIUS, Nginx, migrations, PM2. When it finishes it prints the panel URL. Nothing else to do.

Re-running the same command later pulls the latest code and re-installs (safe to repeat).

---

## Get the code onto the server

On the Ubuntu machine, put the project at `/opt/jointbox` (or anywhere). Options:
```bash
# via git (if you push it to a repo):
sudo git clone <your-repo-url> /opt/jointbox

# or copy from Windows with scp / WinSCP / a USB — copy the whole
# "Jointbox panel" folder BUT NOT node_modules/.next/dist (they rebuild).
```
Tip: before copying, delete `node_modules`, `.next`, `dist` to shrink from ~2 GB to ~3 MB.

---

## A. Docker (recommended)

Install Docker once:
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```
From the project root:
```bash
docker compose -f deploy/docker-compose.yml up -d --build
```
That builds backend + frontend, starts Postgres + Redis, runs migrations automatically, and exposes:
- Admin panel: `http://<server-ip>:3000`
- Portal: `http://<server-ip>:3000/portal`
- API: `http://<server-ip>:3001`

Manage it:
```bash
docker compose -f deploy/docker-compose.yml ps        # status
docker compose -f deploy/docker-compose.yml logs -f   # logs
docker compose -f deploy/docker-compose.yml down       # stop
```
Data persists in the `jointbox_db` volume. **Change `JWT_SECRET` and DB password** in `deploy/docker-compose.yml` before real use.

---

## B. Native install script

Runs the whole stack directly on the OS with PM2 keeping it alive and Nginx on port 80.
```bash
cd /opt/jointbox
sudo bash deploy/install-ubuntu.sh
```
It installs Node 20, PostgreSQL, Redis, Nginx, builds both apps, runs migrations, starts them under PM2 (auto-start on boot), and prints the URLs. After it finishes:
- Admin: `http://<server-ip>/`  (Nginx) or `:3000`
- Portal: `http://<server-ip>/portal`

Manage:
```bash
pm2 status          # both processes
pm2 logs            # live logs
pm2 restart all     # after code changes
```
Edit secrets afterwards in `/opt/jointbox/backend/.env`, then `pm2 restart jointbox-backend`.

---

## First-run: create an admin user

After either A or B, seed the first admin (if your DB is empty). From the backend folder (native) or `docker compose exec backend sh`:
```bash
npm run seed            # if a seed script is present
```
Or create one manually with psql / Prisma Studio (`npx prisma studio`). Then log in at the admin URL.

---

## C. Build your own OVA appliance

An OVA is a portable VM image with Ubuntu + Jointbox already installed — import it into VirtualBox/VMware and boot. This is exactly how commercial ISP panels distribute.

### 1. Create the base VM
- In **VirtualBox**: New VM → Linux / Ubuntu 64-bit → 4 GB RAM, 40 GB dynamic disk → install **Ubuntu Server 24.04 LTS** from ISO.
- During install: create a user (e.g. `jointbox`), enable OpenSSH.
- Network: leave as NAT for building; the appliance user switches to Bridged later.

### 2. Install Jointbox inside the VM
```bash
sudo apt update && sudo apt install -y git
sudo git clone <your-repo> /opt/jointbox     # or scp the source in
cd /opt/jointbox
sudo bash deploy/install-ubuntu.sh
```
Verify it works: browse to the VM's IP. Then **wipe secrets/history** so every copy starts clean:
```bash
# reset DB password + JWT on first boot instead of shipping real ones (optional hardening)
history -c
sudo cloud-init clean 2>/dev/null || true
sudo rm -f /etc/machine-id && sudo systemd-machine-id-setup
```

### 3. Shrink before export (smaller OVA)
```bash
sudo apt clean
sudo journalctl --vacuum-time=1d
# zero free space so the disk compresses well
sudo dd if=/dev/zero of=/zero.fill bs=1M 2>/dev/null || true; sudo rm -f /zero.fill
```
Shut the VM down: `sudo poweroff`.

### 4. Export the OVA
- **VirtualBox**: File → **Export Appliance** → pick the VM → format **OVF 2.0** → tick "Write Manifest" → export → produces `Jointbox.ova`.
- **VMware Workstation**: File → **Export to OVF**.
- **Command line** (VirtualBox): `VBoxManage export <VMNAME> -o Jointbox.ova`.

### 5. Ship / import
The `.ova` is a single file (~2–4 GB). To use it: **File → Import Appliance → select Jointbox.ova → Import**. Boot it, set the network to **Bridged**, note the IP (`ip a`), and open `http://<ip>/`.

### Make it plug-and-play (recommended polish)
- Set the app to auto-start on boot — the install script already does this via PM2 systemd and Docker `restart: unless-stopped`.
- Add a MOTD banner showing the panel URL: put the "open http://<ip>/" line in `/etc/motd`.
- Optionally add a firstboot script that regenerates `JWT_SECRET` and the DB password so every deployed copy is unique.

---

## Production notes
- Put a real domain + HTTPS in front: `sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx`.
- Change `JWT_SECRET` and the Postgres password from the defaults.
- Set up the backup job (see ADVANCEMENT.md Tier 1) — nightly `pg_dump` off the box.
- For a real ISP, FreeRADIUS runs alongside (this stack ships `freeradius-utils` for CoA; a full FreeRADIUS server + the schema is the same Postgres DB).
