<?php
declare(strict_types=1);
require_once __DIR__ . '/_auth.php';

if (jbx_admin_logged_in()) {
    header('Location: index.php');
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    jbx_check_csrf();

    // Throttle by IP so the login form cannot be brute forced.
    if (!jbx_rate_limit('adminlogin:' . jbx_client_ip(), 10, 900)) {
        jbx_audit('admin.login.rate_limited', jbx_client_ip(), null, 'anonymous');
        jbx_flash('Too many attempts. Wait 15 minutes and try again.', 'err');
        header('Location: login.php');
        exit;
    }

    $user = (string) ($_POST['user'] ?? '');
    $pass = (string) ($_POST['pass'] ?? '');

    $row = jbx_admin_verify($user, $pass);

    if ($row !== null) {
        session_regenerate_id(true);
        $_SESSION['jbx_admin']    = (string) $row['username'];
        $_SESSION['jbx_admin_id'] = (int) $row['id'];
        $_SESSION['jbx_login_at'] = time();

        jbx_db()->prepare(
            'UPDATE admin_users SET last_login_at = NOW(), last_login_ip = ? WHERE id = ?'
        )->execute([jbx_client_ip(), (int) $row['id']]);

        jbx_audit('admin.login.ok', $user, null, $user);
        header('Location: index.php');
        exit;
    }

    jbx_audit('admin.login.fail', $user, null, 'anonymous');
    jbx_flash('Incorrect username or password.', 'err');
    header('Location: login.php');
    exit;
}

// If nobody has been set up yet, say so plainly instead of letting someone
// stare at a login form that no password can open.
$noAdmins = false;
try {
    $noAdmins = ((int) jbx_db()->query('SELECT COUNT(*) FROM admin_users')->fetchColumn()) === 0;
} catch (Throwable $e) {
    $noAdmins = true;
}

jbx_head('Sign in');
?>
<div style="max-width:380px;margin:70px auto">
  <?php if ($noAdmins): ?>
  <div class="card" style="border-color:#f59e0b">
    <h2>Not set up yet</h2>
    <p class="muted" style="font-size:13.5px">
      No admin account exists. Open <span class="mono">/install.php</span> to create the
      database tables and your first login.
    </p>
    <div style="margin-top:14px"><a class="btn" href="../install.php">Run the installer</a></div>
  </div>
  <?php endif; ?>
  <div class="card">
    <h2>Sign in</h2>
    <form method="post">
      <input type="hidden" name="_csrf" value="<?= e(jbx_csrf()) ?>">
      <label>Username</label>
      <input name="user" autocomplete="username" autofocus required>
      <label>Password</label>
      <input name="pass" type="password" autocomplete="current-password" required>
      <div style="margin-top:18px"><button class="btn" style="width:100%;justify-content:center">Sign in</button></div>
    </form>
  </div>
  <p class="muted" style="text-align:center;font-size:12px">Jointbox licence management</p>
</div>
<?php jbx_foot();
