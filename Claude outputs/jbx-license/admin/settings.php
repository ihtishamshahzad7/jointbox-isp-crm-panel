<?php
/**
 * Change your own admin credentials, add or disable other admins, and read
 * back the public key.
 */
declare(strict_types=1);
require_once __DIR__ . '/_auth.php';
jbx_require_admin();

$db  = jbx_db();
$me  = (int) ($_SESSION['jbx_admin_id'] ?? 0);

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    jbx_check_csrf();
    $action = (string) ($_POST['action'] ?? '');

    try {
        switch ($action) {

            case 'change_password': {
                $cur  = (string) ($_POST['current_pass'] ?? '');
                $new  = (string) ($_POST['new_pass'] ?? '');
                $new2 = (string) ($_POST['new_pass2'] ?? '');

                // Require the current password even though the session is already
                // authenticated: it stops a borrowed/unlocked browser being turned
                // into permanent access.
                if (jbx_admin_verify((string) $_SESSION['jbx_admin'], $cur) === null) {
                    throw new RuntimeException('Your current password is not correct.');
                }
                if (strlen($new) < 12) {
                    throw new RuntimeException('The new password must be at least 12 characters.');
                }
                if ($new !== $new2) {
                    throw new RuntimeException('The two new passwords do not match.');
                }
                if ($new === $cur) {
                    throw new RuntimeException('The new password is the same as the old one.');
                }

                $db->prepare('UPDATE admin_users SET pass_hash = ? WHERE id = ?')
                   ->execute([password_hash($new, PASSWORD_BCRYPT, ['cost' => 12]), $me]);

                jbx_audit('admin.password_changed', (string) $_SESSION['jbx_admin']);

                // Force a fresh login so any other session using the old password
                // is invalidated too.
                session_destroy();
                session_start();
                jbx_flash('Password changed. Please sign in again.');
                header('Location: login.php');
                exit;
            }

            case 'change_username': {
                $cur  = (string) ($_POST['current_pass'] ?? '');
                $user = trim((string) ($_POST['new_user'] ?? ''));

                if (jbx_admin_verify((string) $_SESSION['jbx_admin'], $cur) === null) {
                    throw new RuntimeException('Your current password is not correct.');
                }
                if (!preg_match('/^[A-Za-z0-9_.-]{3,64}$/', $user)) {
                    throw new RuntimeException('Username must be 3–64 characters: letters, digits, '
                                             . 'dot, dash or underscore.');
                }

                try {
                    $db->prepare('UPDATE admin_users SET username = ? WHERE id = ?')
                       ->execute([$user, $me]);
                } catch (PDOException $e) {
                    throw new RuntimeException('That username is already taken.');
                }

                jbx_audit('admin.username_changed', $user,
                          'was ' . (string) $_SESSION['jbx_admin']);
                $_SESSION['jbx_admin'] = $user;
                jbx_flash('Username changed to ' . $user . '.');
                break;
            }

            case 'update_profile': {
                $db->prepare('UPDATE admin_users SET full_name = ?, email = ? WHERE id = ?')
                   ->execute([jbx_str($_POST, 'full_name', 120), jbx_str($_POST, 'email', 160), $me]);
                jbx_flash('Profile updated.');
                break;
            }

            case 'add_admin': {
                $cur  = (string) ($_POST['current_pass'] ?? '');
                $user = trim((string) ($_POST['new_admin_user'] ?? ''));
                $pass = (string) ($_POST['new_admin_pass'] ?? '');

                if (jbx_admin_verify((string) $_SESSION['jbx_admin'], $cur) === null) {
                    throw new RuntimeException('Your current password is not correct.');
                }
                if (!preg_match('/^[A-Za-z0-9_.-]{3,64}$/', $user)) {
                    throw new RuntimeException('Invalid username.');
                }
                if (strlen($pass) < 12) {
                    throw new RuntimeException('The new admin password must be at least 12 characters.');
                }

                try {
                    $db->prepare(
                        'INSERT INTO admin_users (username, pass_hash, email, is_active, created_at)
                         VALUES (?, ?, ?, 1, NOW())'
                    )->execute([
                        $user,
                        password_hash($pass, PASSWORD_BCRYPT, ['cost' => 12]),
                        jbx_str($_POST, 'new_admin_email', 160),
                    ]);
                } catch (PDOException $e) {
                    throw new RuntimeException('That username already exists.');
                }

                jbx_audit('admin.created', $user);
                jbx_flash('Admin "' . $user . '" created.');
                break;
            }

            case 'toggle_admin': {
                $target = (int) ($_POST['admin_id'] ?? 0);
                if ($target === $me) {
                    throw new RuntimeException('You cannot disable your own account.');
                }
                // Never leave the system with no way in.
                $activeOthers = (int) $db->query(
                    'SELECT COUNT(*) FROM admin_users WHERE is_active = 1'
                )->fetchColumn();

                $st = $db->prepare('SELECT username, is_active FROM admin_users WHERE id = ?');
                $st->execute([$target]);
                $row = $st->fetch();
                if (!$row) {
                    throw new RuntimeException('No such admin.');
                }
                if ((int) $row['is_active'] === 1 && $activeOthers <= 1) {
                    throw new RuntimeException('This is the last active admin — disabling it would '
                                             . 'lock everyone out.');
                }

                $db->prepare('UPDATE admin_users SET is_active = 1 - is_active WHERE id = ?')
                   ->execute([$target]);
                jbx_audit('admin.toggled', (string) $row['username'],
                          ((int) $row['is_active'] === 1 ? 'disabled' : 'enabled'));
                jbx_flash('Account ' . ((int) $row['is_active'] === 1 ? 'disabled' : 'enabled') . '.');
                break;
            }

            default:
                throw new RuntimeException('Unknown action.');
        }
    } catch (Throwable $e) {
        jbx_flash($e->getMessage(), 'err');
    }

    header('Location: settings.php');
    exit;
}

$st = $db->prepare('SELECT * FROM admin_users WHERE id = ?');
$st->execute([$me]);
$profile = $st->fetch() ?: ['full_name' => '', 'email' => '', 'last_login_at' => null, 'last_login_ip' => null];

$admins = $db->query('SELECT * FROM admin_users ORDER BY created_at')->fetchAll();
$pk     = (string) jbx_cfg('public_key_hex', '');

jbx_head('Settings');
?>
<h1>Settings</h1>
<p class="sub">
  Signed in as <strong><?= e($_SESSION['jbx_admin']) ?></strong>.
  <?php if ($profile['last_login_at']): ?>
    Last signed in <?= e($profile['last_login_at']) ?> from
    <span class="mono"><?= e($profile['last_login_ip'] ?? '?') ?></span>.
  <?php endif; ?>
</p>

<div class="card">
  <h2>Change password</h2>
  <form method="post">
    <input type="hidden" name="_csrf" value="<?= e(jbx_csrf()) ?>">
    <input type="hidden" name="action" value="change_password">
    <label>Current password</label>
    <input name="current_pass" type="password" autocomplete="current-password" required>
    <div class="row">
      <div><label>New password</label>
        <input name="new_pass" type="password" autocomplete="new-password" required minlength="12"></div>
      <div><label>Repeat new password</label>
        <input name="new_pass2" type="password" autocomplete="new-password" required minlength="12"></div>
    </div>
    <p class="muted" style="font-size:12.5px;margin-top:8px">
      Minimum 12 characters. You will be signed out and asked to sign in again, which also
      ends any other session that was using the old password.
    </p>
    <div style="margin-top:14px"><button class="btn">Change password</button></div>
  </form>
</div>

<div class="card">
  <h2>Change username</h2>
  <form method="post">
    <input type="hidden" name="_csrf" value="<?= e(jbx_csrf()) ?>">
    <input type="hidden" name="action" value="change_username">
    <div class="row">
      <div><label>New username</label>
        <input name="new_user" value="<?= e($_SESSION['jbx_admin']) ?>" required></div>
      <div><label>Confirm with your current password</label>
        <input name="current_pass" type="password" required></div>
    </div>
    <div style="margin-top:14px"><button class="btn btn-s">Change username</button></div>
  </form>
</div>

<div class="card">
  <h2>Your details</h2>
  <form method="post">
    <input type="hidden" name="_csrf" value="<?= e(jbx_csrf()) ?>">
    <input type="hidden" name="action" value="update_profile">
    <div class="row">
      <div><label>Full name</label><input name="full_name" value="<?= e($profile['full_name'] ?? '') ?>"></div>
      <div><label>Email</label><input name="email" type="email" value="<?= e($profile['email'] ?? '') ?>"></div>
    </div>
    <div style="margin-top:14px"><button class="btn btn-s">Save</button></div>
  </form>
</div>

<div class="card">
  <h2>Admin accounts</h2>
  <div class="scroll"><table>
    <tr><th>Username</th><th>Email</th><th>Status</th><th>Last login</th><th>Created</th><th></th></tr>
    <?php foreach ($admins as $a): ?>
    <tr>
      <td><strong><?= e($a['username']) ?></strong><?= (int) $a['id'] === $me ? ' <span class="pill p-active">you</span>' : '' ?></td>
      <td><?= e($a['email'] ?? '—') ?></td>
      <td><span class="pill p-<?= ((int) $a['is_active'] === 1) ? 'active' : 'suspended' ?>">
        <?= ((int) $a['is_active'] === 1) ? 'active' : 'disabled' ?></span></td>
      <td style="font-size:12px"><?= e($a['last_login_at'] ?? 'never') ?></td>
      <td style="font-size:12px"><?= e(substr((string) $a['created_at'], 0, 10)) ?></td>
      <td>
        <?php if ((int) $a['id'] !== $me): ?>
        <form method="post" style="display:inline">
          <input type="hidden" name="_csrf" value="<?= e(jbx_csrf()) ?>">
          <input type="hidden" name="action" value="toggle_admin">
          <input type="hidden" name="admin_id" value="<?= (int) $a['id'] ?>">
          <button class="btn btn-s" style="padding:5px 11px;font-size:12px">
            <?= ((int) $a['is_active'] === 1) ? 'Disable' : 'Enable' ?></button>
        </form>
        <?php endif; ?>
      </td>
    </tr>
    <?php endforeach; ?>
  </table></div>
</div>

<div class="card">
  <h2>Add another admin</h2>
  <form method="post">
    <input type="hidden" name="_csrf" value="<?= e(jbx_csrf()) ?>">
    <input type="hidden" name="action" value="add_admin">
    <div class="row">
      <div><label>Username</label><input name="new_admin_user" required></div>
      <div><label>Email (optional)</label><input name="new_admin_email" type="email"></div>
    </div>
    <div class="row">
      <div><label>Password</label><input name="new_admin_pass" type="password" required minlength="12"></div>
      <div><label>Confirm with YOUR current password</label><input name="current_pass" type="password" required></div>
    </div>
    <div style="margin-top:14px"><button class="btn btn-s">Create admin</button></div>
  </form>
</div>

<div class="card">
  <h2>Licence signing key</h2>
  <p class="muted" style="font-size:13px">
    The <strong>public</strong> half of your signing keypair. This is what gets compiled into the
    Go licence agent so it can verify licences offline. Safe to share — it can verify, never mint.
  </p>
  <div class="keybox mono" style="font-size:12px"><?= e($pk !== '' ? $pk : 'not configured') ?></div>
  <p class="muted" style="font-size:12.5px">
    The secret half lives at <span class="mono">private/jbx_license_ed25519.sk</span> and is
    never shown here. If you have not backed it up somewhere encrypted and offline, do that now
    — it is the one file in this system that cannot be regenerated. Losing it means every licence
    you have ever issued stops verifying.
  </p>
</div>
<?php jbx_foot();
