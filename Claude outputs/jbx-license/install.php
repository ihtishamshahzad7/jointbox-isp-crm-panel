<?php
/**
 * ===========================================================================
 *  JOINTBOX LICENCE SERVER — ONE-RUN INSTALLER
 * ===========================================================================
 *
 *  Open  https://panel.jointbox.net/install.php  in a browser once.
 *
 *  It does everything:
 *    · checks PHP has what it needs
 *    · tests the database connection
 *    · creates all tables and seeds the plan catalogue
 *    · GENERATES your Ed25519 signing keypair directly into private/
 *      (the secret key is created on the server and never travels anywhere)
 *    · writes private/jbx-config.php for you
 *    · creates your first admin login
 *    · locks itself so it cannot be run a second time
 *
 *  Afterwards you change your username and password in the admin UI under
 *  Settings — no file editing, ever.
 *
 *  DELETE THIS FILE once you have finished. The lock stops it being re-run,
 *  but deleting it removes the question entirely.
 * ===========================================================================
 */
declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');   // never leak paths/credentials to the browser

const JBX_PRIVATE_DIR = __DIR__ . '/../private';
const JBX_CONFIG_FILE = JBX_PRIVATE_DIR . '/jbx-config.php';
const JBX_SK_FILE     = JBX_PRIVATE_DIR . '/jbx_license_ed25519.sk';
const JBX_PK_FILE     = JBX_PRIVATE_DIR . '/jbx_license_ed25519.pk';
const JBX_LOCK_FILE   = JBX_PRIVATE_DIR . '/.installed';

// ---------------------------------------------------------------------------
// Session, used only to carry a CSRF token across the two page loads.
// ---------------------------------------------------------------------------
session_name('JBXINSTALL');
session_start();
if (empty($_SESSION['csrf'])) {
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
}

function h($v): string
{
    return htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

// ---------------------------------------------------------------------------
// Environment checks
// ---------------------------------------------------------------------------
function jbx_checks(): array
{
    $privateExists  = is_dir(JBX_PRIVATE_DIR);
    $privateMakable = $privateExists || @mkdir(JBX_PRIVATE_DIR, 0750, true);

    return [
        ['PHP 8.1 or newer', PHP_VERSION_ID >= 80100, PHP_VERSION,
         'Set the PHP version in hPanel → Advanced → PHP Configuration.'],
        ['sodium extension (Ed25519 signing)', extension_loaded('sodium'),
         extension_loaded('sodium') ? 'loaded' : 'missing',
         'Enable it in hPanel → Advanced → PHP Configuration → PHP Extensions.'],
        ['pdo_mysql extension', extension_loaded('pdo_mysql'),
         extension_loaded('pdo_mysql') ? 'loaded' : 'missing',
         'Enable it in hPanel → Advanced → PHP Configuration → PHP Extensions.'],
        ['private/ folder outside public_html', $privateMakable && is_writable(JBX_PRIVATE_DIR),
         $privateMakable ? (is_writable(JBX_PRIVATE_DIR) ? 'writable' : 'not writable') : 'cannot create',
         'Create a folder named "private" NEXT TO public_html in File Manager, '
         . 'and make sure it is writable (permissions 0750).'],
        ['random_bytes() available', function_exists('random_bytes'), 'yes', ''],
    ];
}

// ---------------------------------------------------------------------------
// Already installed?
// ---------------------------------------------------------------------------
$alreadyInstalled = is_file(JBX_LOCK_FILE);

// ---------------------------------------------------------------------------
// Run the install
// ---------------------------------------------------------------------------
$errors  = [];
$done    = false;
$summary = [];

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && !$alreadyInstalled) {

    if (!hash_equals((string) $_SESSION['csrf'], (string) ($_POST['_csrf'] ?? ''))) {
        $errors[] = 'Session expired. Reload the page and try again.';
    }

    $dbHost = trim((string) ($_POST['db_host'] ?? 'localhost'));
    $dbName = trim((string) ($_POST['db_name'] ?? ''));
    $dbUser = trim((string) ($_POST['db_user'] ?? ''));
    $dbPass = (string) ($_POST['db_pass'] ?? '');
    $adUser = trim((string) ($_POST['admin_user'] ?? ''));
    $adPass = (string) ($_POST['admin_pass'] ?? '');
    $adPas2 = (string) ($_POST['admin_pass2'] ?? '');
    $adMail = trim((string) ($_POST['admin_email'] ?? ''));

    if ($dbName === '' || $dbUser === '') {
        $errors[] = 'Database name and user are required.';
    }
    if (!preg_match('/^[A-Za-z0-9_.-]{3,64}$/', $adUser)) {
        $errors[] = 'Admin username must be 3–64 characters: letters, digits, dot, dash or underscore.';
    }
    if (strlen($adPass) < 12) {
        $errors[] = 'Admin password must be at least 12 characters. This login can mint licences '
                  . 'for your entire product.';
    }
    if ($adPass !== $adPas2) {
        $errors[] = 'The two admin passwords do not match.';
    }

    // ---- database ---------------------------------------------------------
    $pdo = null;
    if (!$errors) {
        try {
            // Accepts 'localhost', 'host:port', or a unix socket path.
            require_once __DIR__ . '/lib/db.php';
            $pdo = new PDO(
                jbx_dsn($dbHost, $dbName),
                $dbUser,
                $dbPass,
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                 PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                 PDO::ATTR_EMULATE_PREPARES => false]
            );
        } catch (PDOException $e) {
            // Show the driver's own message — it is the only useful thing here,
            // and it distinguishes "wrong password" from "unknown database".
            $errors[] = 'Could not connect to the database: ' . $e->getMessage();
        }
    }

    // ---- schema -----------------------------------------------------------
    if (!$errors && $pdo instanceof PDO) {
        $sqlFile = __DIR__ . '/sql/schema.sql';
        if (!is_readable($sqlFile)) {
            $errors[] = 'sql/schema.sql is missing. Upload the full repository.';
        } else {
            try {
                foreach (jbx_split_sql((string) file_get_contents($sqlFile)) as $stmt) {
                    $pdo->exec($stmt);
                }
                $tables = $pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN);
                $plans  = (int) $pdo->query('SELECT COUNT(*) FROM plans')->fetchColumn();
                $summary['tables'] = count($tables);
                $summary['plans']  = $plans;
            } catch (PDOException $e) {
                $errors[] = 'Failed while creating tables: ' . $e->getMessage();
            }
        }
    }

    // ---- signing keypair --------------------------------------------------
    $pkHex = null;
    if (!$errors) {
        if (is_file(JBX_SK_FILE)) {
            // Never silently replace a key that may already have signed
            // licences now living on customers' servers.
            $pkHex = is_file(JBX_PK_FILE) ? trim((string) file_get_contents(JBX_PK_FILE)) : null;
            if ($pkHex === null || $pkHex === '') {
                $errors[] = 'A signing key already exists at private/jbx_license_ed25519.sk but the '
                          . 'matching public key is missing. Restore it from your backup — do not '
                          . 'generate a new one, or every licence already issued will stop working.';
            } else {
                $summary['key'] = 'existing key kept';
            }
        } else {
            try {
                $pair = sodium_crypto_sign_keypair();
                $sk   = sodium_crypto_sign_secretkey($pair);
                $pk   = sodium_crypto_sign_publickey($pair);

                // Prove it works before anything depends on it.
                $probe = 'jbx-install-' . bin2hex(random_bytes(8));
                if (!sodium_crypto_sign_verify_detached(
                        sodium_crypto_sign_detached($probe, $sk), $probe, $pk)) {
                    throw new RuntimeException('generated keypair failed its own self-test');
                }

                if (file_put_contents(JBX_SK_FILE, sodium_bin2hex($sk) . "\n") === false) {
                    throw new RuntimeException('could not write ' . JBX_SK_FILE);
                }
                file_put_contents(JBX_PK_FILE, sodium_bin2hex($pk) . "\n");
                @chmod(JBX_SK_FILE, 0400);
                @chmod(JBX_PK_FILE, 0444);

                $pkHex = sodium_bin2hex($pk);
                $summary['key'] = 'new keypair generated and self-tested';
            } catch (Throwable $e) {
                $errors[] = 'Could not generate the signing keypair: ' . $e->getMessage();
            }
        }
    }

    // ---- config file ------------------------------------------------------
    if (!$errors) {
        $cfg = "<?php\n"
             . "/**\n"
             . " * Written by install.php on " . gmdate('Y-m-d H:i:s') . " UTC.\n"
             . " * This file is OUTSIDE public_html and must never be committed to git.\n"
             . " * Admin logins live in the admin_users table, not here — change them in\n"
             . " * the admin UI under Settings.\n"
             . " */\n"
             . "declare(strict_types=1);\n\n"
             . "return [\n"
             . "    'db_host' => " . var_export($dbHost, true) . ",\n"
             . "    'db_name' => " . var_export($dbName, true) . ",\n"
             . "    'db_user' => " . var_export($dbUser, true) . ",\n"
             . "    'db_pass' => " . var_export($dbPass, true) . ",\n\n"
             . "    'signing_key_path' => __DIR__ . '/jbx_license_ed25519.sk',\n"
             . "    'public_key_hex'   => " . var_export($pkHex, true) . ",\n\n"
             . "    // Only these IPs may reach /admin. Empty = no IP check.\n"
             . "    // If your office IP is static, putting it here is the cheapest\n"
             . "    // hardening step available to you.\n"
             . "    'admin_ip_allowlist' => [],\n\n"
             . "    'allow_auto_trial'   => true,\n"
             . "    'activate_rate_limit' => 5,\n"
             . "    'issuer' => 'panel.jointbox.net',\n"
             . "];\n";

        if (file_put_contents(JBX_CONFIG_FILE, $cfg) === false) {
            $errors[] = 'Could not write private/jbx-config.php. Check the folder is writable.';
        } else {
            @chmod(JBX_CONFIG_FILE, 0400);
            $summary['config'] = 'private/jbx-config.php written';
        }
    }

    // ---- first admin user -------------------------------------------------
    if (!$errors && $pdo instanceof PDO) {
        try {
            $existing = (int) $pdo->query('SELECT COUNT(*) FROM admin_users')->fetchColumn();
            if ($existing > 0) {
                $errors[] = 'An admin account already exists. Sign in at /admin/ instead, '
                          . 'or reset it from phpMyAdmin if you have lost the password.';
            } else {
                $pdo->prepare(
                    'INSERT INTO admin_users (username, pass_hash, email, is_active, created_at)
                     VALUES (?, ?, ?, 1, NOW())'
                )->execute([
                    $adUser,
                    password_hash($adPass, PASSWORD_BCRYPT, ['cost' => 12]),
                    $adMail !== '' ? $adMail : null,
                ]);

                $pdo->prepare(
                    'INSERT INTO audit_log (at, actor, action, target, detail, ip)
                     VALUES (NOW(), ?, ?, ?, ?, ?)'
                )->execute(['installer', 'install.completed', $adUser,
                            'tables=' . ($summary['tables'] ?? '?'), $_SERVER['REMOTE_ADDR'] ?? null]);

                $summary['admin'] = $adUser;
            }
        } catch (PDOException $e) {
            $errors[] = 'Could not create the admin account: ' . $e->getMessage();
        }
    }

    // ---- lock -------------------------------------------------------------
    if (!$errors) {
        file_put_contents(JBX_LOCK_FILE,
            "Installed " . gmdate('c') . " from " . ($_SERVER['REMOTE_ADDR'] ?? '?') . "\n");
        @chmod(JBX_LOCK_FILE, 0400);
        $done = true;
    }
}

// ---------------------------------------------------------------------------
/**
 * Split a .sql file into statements.
 *
 * A naive explode(';') breaks on semicolons inside string literals and
 * comments, which schema.sql has plenty of, so track quoting and comment
 * state properly. It handles -- line comments, /* block comments, single and
 * double quotes, backticks, and backslash escapes — everything schema.sql uses.
 */
function jbx_split_sql(string $sql): array
{
    $out = [];
    $buf = '';
    $len = strlen($sql);
    $i   = 0;

    while ($i < $len) {
        $c  = $sql[$i];
        $c2 = $sql[$i + 1] ?? '';

        // line comment
        if (($c === '-' && $c2 === '-') || $c === '#') {
            while ($i < $len && $sql[$i] !== "\n") { $i++; }
            continue;
        }
        // block comment
        if ($c === '/' && $c2 === '*') {
            $end = strpos($sql, '*/', $i + 2);
            $i = $end === false ? $len : $end + 2;
            continue;
        }
        // quoted string / identifier
        if ($c === "'" || $c === '"' || $c === '`') {
            $quote = $c;
            $buf  .= $c;
            $i++;
            while ($i < $len) {
                if ($sql[$i] === '\\' && $quote !== '`') {
                    $buf .= substr($sql, $i, 2);
                    $i   += 2;
                    continue;
                }
                $buf .= $sql[$i];
                if ($sql[$i] === $quote) { $i++; break; }
                $i++;
            }
            continue;
        }
        if ($c === ';') {
            $stmt = trim($buf);
            if ($stmt !== '') { $out[] = $stmt; }
            $buf = '';
            $i++;
            continue;
        }
        $buf .= $c;
        $i++;
    }

    $stmt = trim($buf);
    if ($stmt !== '') { $out[] = $stmt; }

    return $out;
}

$checks   = jbx_checks();
$allOk    = array_reduce($checks, fn($c, $r) => $c && $r[1], true);
$prefillH = $_POST['db_host'] ?? 'localhost';
$prefillN = $_POST['db_name'] ?? '';
$prefillU = $_POST['db_user'] ?? '';
$prefillA = $_POST['admin_user'] ?? '';
$prefillE = $_POST['admin_email'] ?? '';
?><!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install — Jointbox Licence Server</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0b1020;--surface:#121a30;--surface2:#1a2340;--border:#26304d;--text:#e7ecf6;
--muted:#93a0bd;--g1:#6C3CE1;--g2:#E9408B;--ok:#22c55e;--warn:#f59e0b;--bad:#ef4444}
body{background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:28px 16px}
.wrap{max-width:720px;margin:0 auto}
.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;margin-bottom:6px}
.spark{width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,var(--g1),var(--g2));display:grid;place-items:center;font-size:17px}
p.lead{color:var(--muted);margin-bottom:22px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;margin-bottom:18px}
.card h2{font-size:16px;font-weight:750;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
td{padding:8px 6px;border-bottom:1px solid var(--border);vertical-align:top}
tr:last-child td{border-bottom:none}
.y{color:#5ee69a;font-weight:800}.n{color:#fca5a5;font-weight:800}
label{display:block;font-size:12.5px;color:var(--muted);margin:14px 0 5px;font-weight:600}
input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:10px 12px;color:var(--text);font:inherit}
input:focus{outline:none;border-color:var(--g1)}
.btn{display:inline-flex;align-items:center;gap:7px;border:none;border-radius:10px;padding:11px 22px;font-weight:700;font-size:14px;cursor:pointer;background:linear-gradient(135deg,var(--g1),var(--g2));color:#fff;text-decoration:none}
.btn[disabled]{opacity:.4;cursor:not-allowed}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:640px){.row{grid-template-columns:1fr}}
.msg{border-radius:10px;padding:13px 16px;margin-bottom:16px;font-size:13.5px}
.m-err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);color:#fca5a5}
.m-ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.35);color:#7ff0ab}
.m-warn{background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.35);color:#fbbf24}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
.muted{color:var(--muted)}
.keybox{background:var(--bg);border:1px dashed var(--g2);border-radius:10px;padding:14px;margin:12px 0}
ol{margin:10px 0 0 20px}ol li{margin-bottom:8px;font-size:13.5px}
.hint{font-size:12px;color:var(--muted);margin-top:5px}
</style></head><body><div class="wrap">

<div class="logo"><span class="spark">✦</span> Jointbox Licence Server</div>

<?php if ($alreadyInstalled && !$done): ?>

  <p class="lead">Installer</p>
  <div class="msg m-warn">
    <strong>Already installed.</strong> This installer has been locked so it cannot be run again
    and overwrite your configuration.
  </div>
  <div class="card">
    <h2>What now</h2>
    <ol>
      <li><a href="admin/">Sign in to the admin panel</a> and change your credentials under
          <strong>Settings</strong> if you need to.</li>
      <li><strong>Delete <span class="mono">install.php</span></strong> from
          <span class="mono">public_html</span> — it is no longer needed.</li>
      <li>If you genuinely need to re-run setup, delete
          <span class="mono">private/.installed</span> first. Be aware that re-running will
          overwrite <span class="mono">jbx-config.php</span>; your signing key is never replaced.</li>
    </ol>
  </div>

<?php elseif ($done): ?>

  <p class="lead">Installation complete.</p>
  <div class="msg m-ok"><strong>Everything is set up.</strong> The licence server is ready to issue keys.</div>

  <div class="card">
    <h2>What was created</h2>
    <table>
      <tr><td>Database tables</td><td class="y"><?= h($summary['tables'] ?? '?') ?> tables</td></tr>
      <tr><td>Plan catalogue</td><td class="y"><?= h($summary['plans'] ?? '?') ?> plans seeded</td></tr>
      <tr><td>Signing keypair</td><td class="y"><?= h($summary['key'] ?? '?') ?></td></tr>
      <tr><td>Configuration</td><td class="y"><?= h($summary['config'] ?? '?') ?></td></tr>
      <tr><td>Admin login</td><td class="y"><?= h($summary['admin'] ?? '?') ?></td></tr>
    </table>
  </div>

  <div class="card">
    <h2>Your public key</h2>
    <p class="muted" style="font-size:13px">
      This goes into the Go licence agent later. It is safe to share — it can only
      <em>verify</em> licences, never create them. You can always read it again in the admin
      panel under Settings.
    </p>
    <div class="keybox mono"><?= h($pkHex ?? (is_file(JBX_PK_FILE) ? trim((string) file_get_contents(JBX_PK_FILE)) : '')) ?></div>
  </div>

  <div class="card" style="border-color:#f59e0b">
    <h2>⚠ Do these three things now</h2>
    <ol>
      <li><strong>Delete <span class="mono">install.php</span> and the
          <span class="mono">sql/</span> folder</strong> from
          <span class="mono">public_html</span> in File Manager. Neither is needed again, and
          <span class="mono">sql/schema.sql</span> is the one file here that would still be
          readable on a server that ignores <span class="mono">.htaccess</span>. It holds no
          passwords, only table definitions — but there is no reason to leave it there.</li>
      <li><strong>Back up your signing key.</strong> Download
          <span class="mono">private/jbx_license_ed25519.sk</span> and keep it somewhere
          encrypted and offline. If you lose it, every licence you ever issue stops verifying
          and cannot be reissued — it is the single irreplaceable file in this system.</li>
      <li><strong>Confirm nothing is exposed.</strong> These must all return
          "not found":<br>
          <span class="mono">panel.jointbox.net/lib/config.php</span><br>
          <span class="mono">panel.jointbox.net/private/jbx_license_ed25519.sk</span>
      </li>
    </ol>
  </div>

  <p><a class="btn" href="admin/">Sign in to the admin panel →</a></p>

<?php else: ?>

  <p class="lead">One-run installer. Creates the tables, your signing key and your admin login.</p>

  <?php foreach ($errors as $e): ?>
    <div class="msg m-err"><?= h($e) ?></div>
  <?php endforeach; ?>

  <div class="card">
    <h2>Environment</h2>
    <table>
      <?php foreach ($checks as [$name, $pass, $detail, $fix]): ?>
      <tr>
        <td><?= h($name) ?><?php if (!$pass && $fix !== ''): ?>
            <div class="hint"><?= h($fix) ?></div><?php endif; ?></td>
        <td style="width:130px;text-align:right">
          <span class="<?= $pass ? 'y' : 'n' ?>"><?= $pass ? '✓' : '✕' ?></span>
          <span class="muted" style="font-size:12px"><?= h($detail) ?></span>
        </td>
      </tr>
      <?php endforeach; ?>
    </table>
  </div>

  <?php if (!$allOk): ?>
    <div class="msg m-err">
      Fix the items marked ✕ above, then reload this page. The installer will not run until
      the environment is ready.
    </div>
  <?php endif; ?>

  <form method="post">
    <input type="hidden" name="_csrf" value="<?= h($_SESSION['csrf']) ?>">

    <div class="card">
      <h2>Database</h2>
      <p class="muted" style="font-size:13px">
        From hPanel → Databases. Hostinger prefixes both names with your account id.
      </p>
      <label>Host</label>
      <input name="db_host" value="<?= h($prefillH) ?>" required>
      <div class="hint">Almost always <span class="mono">localhost</span> on Hostinger. A
        <span class="mono">host:port</span> or a socket path also works.</div>

      <div class="row">
        <div><label>Database name</label>
          <input name="db_name" value="<?= h($prefillN) ?>" placeholder="u558893159_paneljb" required></div>
        <div><label>Database user</label>
          <input name="db_user" value="<?= h($prefillU) ?>" placeholder="u558893159_paneljb" required></div>
      </div>
      <label>Database password</label>
      <input name="db_pass" type="password" required>
      <div class="hint">Typed here once and written straight into
        <span class="mono">private/jbx-config.php</span>. It is never displayed again.</div>
    </div>

    <div class="card">
      <h2>Your admin login</h2>
      <p class="muted" style="font-size:13px">
        Stored hashed in the database, so you can change it later in the admin panel under
        Settings without editing any files.
      </p>
      <div class="row">
        <div><label>Username</label>
          <input name="admin_user" value="<?= h($prefillA) ?>" placeholder="admin" required></div>
        <div><label>Email (optional)</label>
          <input name="admin_email" type="email" value="<?= h($prefillE) ?>"></div>
      </div>
      <div class="row">
        <div><label>Password</label><input name="admin_pass" type="password" required minlength="12"></div>
        <div><label>Repeat password</label><input name="admin_pass2" type="password" required minlength="12"></div>
      </div>
      <div class="hint">
        Minimum 12 characters. This login can issue licences for your entire product, so give it
        a password you use nowhere else.
      </div>
    </div>

    <p><button class="btn" <?= $allOk ? '' : 'disabled' ?>>Install now</button></p>
  </form>

<?php endif; ?>

<p class="muted" style="font-size:12px;margin-top:24px">Jointbox licence management</p>
</div></body></html>
