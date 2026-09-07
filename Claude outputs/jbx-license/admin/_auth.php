<?php
/**
 * Admin session auth, CSRF, and shared page chrome.
 *
 * This UI can mint licences for your entire product, so treat it like online
 * banking: strong password, IP allowlist if your address is static, and never
 * reachable over plain HTTP.
 */
declare(strict_types=1);


// Not a page: refuse to execute if requested directly over HTTP.
// The .htaccess in this directory also blocks it, but that depends on
// the web server's config being honoured, and this does not.
if (PHP_SAPI !== 'cli'
    && basename((string) ($_SERVER['SCRIPT_FILENAME'] ?? '')) === basename(__FILE__)) {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../lib/licence.php';

// ---- force HTTPS -----------------------------------------------------------
$https = ($_SERVER['HTTPS'] ?? '') === 'on'
      || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https'
      || ($_SERVER['SERVER_PORT'] ?? '') === '443';

if (!$https && PHP_SAPI !== 'cli') {
    $host = $_SERVER['HTTP_HOST'] ?? 'panel.jointbox.net';
    $uri  = $_SERVER['REQUEST_URI'] ?? '/admin/';
    header('Location: https://' . $host . $uri, true, 301);
    exit;
}

header('X-Frame-Options: DENY');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('Strict-Transport-Security: max-age=31536000');

if (session_status() !== PHP_SESSION_ACTIVE) {
    session_set_cookie_params([
        'httponly' => true,
        'secure'   => true,
        'samesite' => 'Strict',
        'path'     => '/admin',
    ]);
    session_name('JBXADMIN');
    session_start();
}

// ---- optional IP allowlist -------------------------------------------------
$allow = jbx_cfg('admin_ip_allowlist', []);
if (is_array($allow) && $allow !== [] && !in_array(jbx_client_ip(), $allow, true)) {
    http_response_code(403);
    exit('Forbidden.');
}

/**
 * Verify a login against the admin_users table.
 * Returns the user row on success, or null.
 */
function jbx_admin_verify(string $user, string $pass): ?array
{
    try {
        $st = jbx_db()->prepare(
            'SELECT * FROM admin_users WHERE username = ? AND is_active = 1'
        );
        $st->execute([$user]);
        $row = $st->fetch();
    } catch (Throwable $e) {
        error_log('jbx admin_users lookup failed: ' . $e->getMessage());
        return null;
    }

    // Always run a hash comparison, even when the user does not exist, so the
    // response time does not reveal which usernames are real.
    $hash = is_array($row) ? (string) $row['pass_hash']
                           : '$2y$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    $ok = password_verify($pass, $hash);

    return ($ok && is_array($row)) ? $row : null;
}

function jbx_admin_logged_in(): bool
{
    if (empty($_SESSION['jbx_admin'])) {
        return false;
    }
    // 8-hour absolute session lifetime.
    if ((time() - (int) ($_SESSION['jbx_login_at'] ?? 0)) > 28800) {
        session_destroy();
        return false;
    }
    return true;
}

function jbx_require_admin(): void
{
    if (!jbx_admin_logged_in()) {
        header('Location: login.php');
        exit;
    }
}

function jbx_csrf(): string
{
    if (empty($_SESSION['jbx_csrf'])) {
        $_SESSION['jbx_csrf'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['jbx_csrf'];
}

function jbx_check_csrf(): void
{
    $given = $_POST['_csrf'] ?? '';
    if (!jbx_hash_equals($_SESSION['jbx_csrf'] ?? null, is_string($given) ? $given : '')) {
        http_response_code(419);
        exit('Session expired — please reload the page and try again.');
    }
}

function e($v): string
{
    return htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function jbx_flash(?string $msg = null, string $kind = 'ok'): ?array
{
    if ($msg !== null) {
        $_SESSION['jbx_flash'] = ['msg' => $msg, 'kind' => $kind];
        return null;
    }
    $f = $_SESSION['jbx_flash'] ?? null;
    unset($_SESSION['jbx_flash']);
    return $f;
}

function jbx_head(string $title): void
{
    $f = jbx_flash();
    ?><!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title><?= e($title) ?> — Jointbox Licences</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0b1020;--surface:#121a30;--surface2:#1a2340;--border:#26304d;
--text:#e7ecf6;--muted:#93a0bd;--g1:#6C3CE1;--g2:#E9408B;--ok:#22c55e;--warn:#f59e0b;--bad:#ef4444}
body{background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:#8ab4ff;text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}
header{background:rgba(11,16,32,.85);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:9}
.hin{display:flex;align-items:center;justify-content:space-between;height:60px;gap:16px;flex-wrap:wrap}
.logo{display:flex;align-items:center;gap:9px;font-weight:800;font-size:17px}
.spark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--g1),var(--g2));display:grid;place-items:center;font-size:15px}
nav.tabs{display:flex;gap:18px;font-size:13.5px;color:var(--muted)}
nav.tabs a.on{color:var(--text);font-weight:700}
h1{font-size:24px;font-weight:800;letter-spacing:-.02em;margin:26px 0 4px}
.sub{color:var(--muted);margin-bottom:20px;font-size:13.5px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:18px}
.card h2{font-size:16px;font-weight:750;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;color:var(--muted);font-weight:700;padding:9px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:10px;border-bottom:1px solid var(--border);vertical-align:top}
tr:last-child td{border-bottom:none}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
label{display:block;font-size:12.5px;color:var(--muted);margin:12px 0 5px;font-weight:600}
input,select,textarea{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:9px;
padding:9px 11px;color:var(--text);font:inherit}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--g1)}
.btn{display:inline-flex;align-items:center;gap:7px;border:none;border-radius:10px;padding:9px 18px;
font-weight:700;font-size:13.5px;cursor:pointer;background:linear-gradient(135deg,var(--g1),var(--g2));color:#fff}
.btn:hover{opacity:.92}
.btn-s{background:var(--surface2);color:var(--text);border:1px solid var(--border)}
.btn-d{background:#3a1620;color:#ffb4b4;border:1px solid #5c2030}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:700px){.row{grid-template-columns:1fr}}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:11.5px;font-weight:700}
.p-active{background:rgba(34,197,94,.15);color:#5ee69a}
.p-unactivated{background:rgba(147,160,189,.15);color:var(--muted)}
.p-suspended,.p-expired{background:rgba(245,158,11,.15);color:#fbbf24}
.p-revoked{background:rgba(239,68,68,.15);color:#fca5a5}
.flash{border-radius:10px;padding:12px 16px;margin:18px 0;font-size:13.5px;font-weight:600}
.f-ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.35);color:#7ff0ab}
.f-err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);color:#fca5a5}
.keybox{background:var(--bg);border:1px dashed var(--g2);border-radius:12px;padding:18px;text-align:center;
font-family:ui-monospace,monospace;font-size:21px;font-weight:700;letter-spacing:.06em;margin:14px 0}
.muted{color:var(--muted)}
.stat{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.stat>div{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center}
.stat .n{font-size:26px;font-weight:800}
.stat .l{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.scroll{overflow-x:auto}
</style></head><body>
<header><div class="wrap hin">
  <div class="logo"><span class="spark">✦</span> Licence Admin</div>
  <?php if (jbx_admin_logged_in()): ?>
  <nav class="tabs">
    <?php $cur = basename($_SERVER['SCRIPT_NAME'] ?? ''); ?>
    <a href="index.php"     class="<?= $cur === 'index.php' ? 'on' : '' ?>">Dashboard</a>
    <a href="licenses.php"  class="<?= $cur === 'licenses.php' ? 'on' : '' ?>">Licences</a>
    <a href="issue.php"     class="<?= $cur === 'issue.php' ? 'on' : '' ?>">Issue new</a>
    <a href="customers.php" class="<?= $cur === 'customers.php' ? 'on' : '' ?>">Customers</a>
    <a href="settings.php"  class="<?= $cur === 'settings.php' ? 'on' : '' ?>">Settings</a>
    <a href="logout.php">Sign out</a>
  </nav>
  <?php endif; ?>
</div></header>
<div class="wrap">
<?php if ($f): ?><div class="flash <?= $f['kind'] === 'ok' ? 'f-ok' : 'f-err' ?>"><?= e($f['msg']) ?></div><?php endif;
}

function jbx_foot(): void
{
    echo '</div></body></html>';
}
