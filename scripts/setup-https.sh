#!/bin/bash
# =============================================================================
# setup-https.sh — publish the panel on HTTPS using a Let's Encrypt certificate
#                  issued for the server's IP ADDRESS (no domain name needed).
#
#   Usage:  sudo bash scripts/setup-https.sh 202.141.236.43
#           sudo bash scripts/setup-https.sh 202.141.236.43 --staging   (dry run)
#
# WHY THIS EXISTS
# Serving a login page over plain HTTP on a public IP puts every client's
# password on the wire in cleartext. Until January 2026 there was no good fix
# for a bare IP — Let's Encrypt only issued certificates for domain names. It
# now issues them for IP addresses too, with a mandatory 160-hour (~6 day)
# lifetime, which is why renewal here is automated and non-negotiable.
#
# WHY CADDY AND NOT NGINX
# You said no nginx, and that stands. Caddy is a single binary with a six-line
# config for this job. It is used ONLY as a TLS terminator and reverse proxy —
# certbot owns the certificate, so none of Caddy's own ACME machinery is
# involved (its IP-certificate support was still unreliable at the time of
# writing; certbot's is not).
#
# WHAT IT DOES
#   443  → TLS, then: /api/* → backend 3001, everything else → frontend 3000
#   80   → ACME challenge, everything else redirected to HTTPS
# =============================================================================
set -e

IP="${1:-}"
STAGING=""
[ "${2:-}" = "--staging" ] && STAGING="--staging"

if [ -z "$IP" ]; then
  echo "Usage: sudo bash scripts/setup-https.sh <public-ip> [--staging]"; exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo — it installs packages and writes to /etc."; exit 1
fi

WEBROOT=/var/www/certbot
CADDYFILE=/etc/caddy/Caddyfile
LIVE="/etc/letsencrypt/live/$IP"

echo "🔐 Setting up HTTPS for https://$IP"
echo

# ── 1. Packages ──────────────────────────────────────────────────────────────
echo "📦 Installing caddy + certbot..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

# Certbot 5.4+ is required: --ip-address arrived in 5.3 and webroot support for
# IP identifiers in 5.4. Ubuntu's apt version is far older, so use snap.
if ! command -v certbot >/dev/null 2>&1 || ! certbot --help all 2>/dev/null | grep -q -- '--ip-address'; then
  echo "   installing certbot from snap (apt's build is too old for --ip-address)..."
  apt-get install -y -qq snapd
  snap install core >/dev/null 2>&1 || true
  snap refresh core >/dev/null 2>&1 || true
  apt-get remove -y -qq certbot >/dev/null 2>&1 || true
  snap install --classic certbot
  ln -sf /snap/bin/certbot /usr/bin/certbot
fi

certbot --version
if ! certbot --help all 2>/dev/null | grep -q -- '--ip-address'; then
  echo "❌ This certbot does not support --ip-address. IP certificates need 5.3+."
  echo "   Everything else is unchanged; nothing was broken. Stopping here."
  exit 1
fi

# ── 2. The port-80 redirect MUST go ──────────────────────────────────────────
# update-jointbox.sh installs an iptables rule sending :80 straight to :3000.
# With TLS in front that rule would swallow the ACME challenge AND bypass the
# redirect to HTTPS, so the certificate could never be issued or renewed.
echo "🧹 Removing the old port 80 → 3000 iptables bridge (Caddy owns :80 now)..."
while iptables -t nat -C PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 3000 2>/dev/null; do
  iptables -t nat -D PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 3000
done
while iptables -t nat -C OUTPUT -o lo -p tcp --dport 80 -j REDIRECT --to-ports 3000 2>/dev/null; do
  iptables -t nat -D OUTPUT -o lo -p tcp --dport 80 -j REDIRECT --to-ports 3000
done
netfilter-persistent save >/dev/null 2>&1 || true
# Leaves a marker so update-jointbox.sh knows not to put the bridge back.
touch /etc/jointbox-tls-enabled

# ── 3. Issue the certificate ─────────────────────────────────────────────────
mkdir -p "$WEBROOT"

# Caddy has to be serving the challenge path before certbot asks for it, so
# write a minimal config and start it first.
mkdir -p /etc/caddy
cat > "$CADDYFILE" <<EOF
{
	# We supply the certificate ourselves (certbot); Caddy must not try to
	# fetch its own or it will fight certbot for port 80.
	auto_https off
}

http://$IP, http://:80 {
	handle /.well-known/acme-challenge/* {
		root * $WEBROOT
		file_server
	}
	handle {
		respond "Setting up HTTPS..." 200
	}
}
EOF
caddy validate --config "$CADDYFILE"
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
sleep 2

echo "📜 Requesting the certificate from Let's Encrypt..."
echo "   (IP certificates are always short-lived — 160 hours — so renewal is automatic.)"
certbot certonly $STAGING \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --preferred-profile shortlived \
  --webroot --webroot-path "$WEBROOT" \
  --ip-address "$IP" \
  --deploy-hook "systemctl reload caddy"

if [ ! -f "$LIVE/fullchain.pem" ]; then
  echo "❌ No certificate was issued. The panel is untouched and still on HTTP."
  echo "   Most likely cause: port 80 is not reachable from the internet."
  echo "   Check with:  curl -I http://$IP/.well-known/acme-challenge/test"
  exit 1
fi

# ── 4. Real config: TLS + reverse proxy ──────────────────────────────────────
echo "⚙️  Writing the live Caddy config..."
cat > "$CADDYFILE" <<EOF
{
	auto_https off
}

# ---------------------------------------------------------------------------
# HTTPS — the only address clients should ever use.
# ---------------------------------------------------------------------------
https://$IP {
	tls $LIVE/fullchain.pem $LIVE/privkey.pem

	# The browser may not call http://ip:3001 from an https:// page (mixed
	# content), so the API is served from the SAME origin under /api and
	# forwarded here. That is also why port 3001 can stay firewalled.
	handle_path /api/* {
		reverse_proxy 127.0.0.1:3001 {
			# Server-sent events (the live network feed) must not be buffered
			# or the feed arrives in one lump when the connection closes.
			flush_interval -1
		}
	}

	# Uploaded photos / CNIC images are served by the backend.
	handle /uploads/* {
		reverse_proxy 127.0.0.1:3001
	}

	handle {
		reverse_proxy 127.0.0.1:3000
	}

	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}
}

# ---------------------------------------------------------------------------
# HTTP — renewal challenges only; everything else goes to HTTPS.
# ---------------------------------------------------------------------------
http://$IP, http://:80 {
	handle /.well-known/acme-challenge/* {
		root * $WEBROOT
		file_server
	}
	handle {
		redir https://$IP{uri} permanent
	}
}
EOF

caddy validate --config "$CADDYFILE"
systemctl reload caddy || systemctl restart caddy

# ── 5. Tell the apps they are behind TLS ─────────────────────────────────────
ENVF="$(cd "$(dirname "$0")/.." && pwd)/backend/.env"
if [ -f "$ENVF" ]; then
  set_env() {
    if grep -qE "^[[:space:]]*$1=" "$ENVF"; then
      sed -i "s|^[[:space:]]*$1=.*|$1=$2|" "$ENVF"
    else
      echo "$1=$2" >> "$ENVF"
    fi
  }
  set_env FORCE_HTTPS 1
  set_env PUBLIC_HOST "$IP"
  set_env CORS_ORIGIN "https://$IP"
  echo "📝 backend/.env updated: FORCE_HTTPS, PUBLIC_HOST, CORS_ORIGIN"
fi

# ── 6. Prove it works ────────────────────────────────────────────────────────
echo
echo "🔍 Verifying..."
sleep 2
echo -n "   HTTPS responds : "; curl -sk -o /dev/null -w "%{http_code}\n" "https://$IP/" || echo "FAILED"
echo -n "   API through TLS: "; curl -sk -o /dev/null -w "%{http_code}\n" "https://$IP/api/health" || echo "FAILED"
echo -n "   HTTP redirects : "; curl -s -o /dev/null -w "%{http_code}\n" "http://$IP/" || echo "FAILED"
echo -n "   Cert expires   : "; openssl x509 -enddate -noout -in "$LIVE/fullchain.pem" 2>/dev/null | cut -d= -f2
echo -n "   Renewal timer  : "; systemctl is-active snap.certbot.renew.timer 2>/dev/null || echo "check: systemctl list-timers | grep certbot"
echo
echo "✅ Done. Restart the apps so they pick up the new .env:"
echo "     pm2 restart all --update-env"
echo
echo "   Clients should now use:  https://$IP"
