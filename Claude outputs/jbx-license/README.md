# Jointbox Licence Server

Licence issuance and activation for on-premises Jointbox ISP panel installs.
Runs on Hostinger shared hosting (PHP 8 + MySQL) at panel.jointbox.net.

**This repository must be PRIVATE.** See DEPLOY.md for why.

## Setup

1. Create a MySQL database in hPanel
2. Create an empty `private/` folder next to `public_html` (permissions 0750)
3. Upload this repo into `public_html/`
4. Open `https://panel.jointbox.net/install.php` — it creates the tables,
   generates your signing keypair, writes the config and creates your admin login
5. Delete `install.php` and `sql/`, and back up `private/jbx_license_ed25519.sk`
6. Connect Hostinger GIT + auto-deploy webhook so `git push` deploys

Full detail, including the auto-sync setup, is in **DEPLOY.md**.

Admin credentials live in the `admin_users` table — change them in the admin UI
under **Settings**, never by editing a file.

## Verify

    php tools/selftest.php     # 32 crypto / key / fingerprint tests, no DB needed

## Layout

    install.php       One-run web installer (DELETE after setup)
    admin/            Licence admin UI (session auth, CSRF, HTTPS-only)
    api/v1/           activate.php, version.php
    lib/              config, db, crypto, licence logic  (blocked from HTTP)
    sql/schema.sql    Idempotent schema + plan seeds (DELETE after setup)
    tools/            selftest.php, plus genkeys.php / hash-password.php for
                      the manual path — the installer makes both optional
    private-example/  Reference copy of what install.php generates

## Design

`docs/LICENSING-PLANE.md` in the panel repo has the full design, including the
Go agent and the enforcement ladder. Two rules that must not be broken:

- **Licensing never touches RADIUS.** Auth, accounting and CoA keep working in
  every licence state. An ISP's subscribers must never drop over billing.
- **A network failure never downgrades licence state.** Only the licence's own
  `exp` does. Otherwise one Hostinger outage disables every customer at once.
