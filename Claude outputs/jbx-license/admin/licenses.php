<?php
/**
 * Licence list, and licence detail with activation / hardware id management.
 */
declare(strict_types=1);
require_once __DIR__ . '/_auth.php';
jbx_require_admin();

$db = jbx_db();
$id = isset($_GET['id']) ? (int) $_GET['id'] : 0;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    jbx_check_csrf();
    $lid    = (int) ($_POST['license_id'] ?? 0);
    $action = (string) ($_POST['action'] ?? '');

    try {
        switch ($action) {
            case 'set_status':
                $new = (string) ($_POST['status'] ?? '');
                if (!in_array($new, ['active', 'suspended', 'revoked'], true)) {
                    throw new RuntimeException('Invalid status.');
                }
                $db->prepare('UPDATE licenses SET status = ? WHERE id = ?')->execute([$new, $lid]);
                jbx_audit('license.status', 'license#' . $lid, $new);
                jbx_flash('Status set to ' . $new . '. It takes effect on the next heartbeat — '
                        . 'the licence already on their server stays valid until it expires.');
                break;

            case 'set_paid_until':
                $d = jbx_str($_POST, 'paid_until', 10);
                if ($d !== null && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)) {
                    throw new RuntimeException('Date must be YYYY-MM-DD.');
                }
                $db->prepare('UPDATE licenses SET paid_until = ? WHERE id = ?')->execute([$d, $lid]);
                jbx_audit('license.paid_until', 'license#' . $lid, (string) $d);
                jbx_flash('Payment date updated to ' . ($d ?? 'none') . '.');
                break;

            case 'set_plan':
                $p = (string) ($_POST['plan_id'] ?? '');
                if (jbx_plan($p) === null) {
                    throw new RuntimeException('Unknown plan.');
                }
                $db->prepare('UPDATE licenses SET plan_id = ? WHERE id = ?')->execute([$p, $lid]);
                jbx_audit('license.plan', 'license#' . $lid, $p);
                jbx_flash('Plan changed to ' . $p . '. Applied at their next heartbeat.');
                break;

            case 'set_max_activations':
                $n = max(1, min(50, (int) ($_POST['max_activations'] ?? 1)));
                $db->prepare('UPDATE licenses SET max_activations = ? WHERE id = ?')->execute([$n, $lid]);
                jbx_audit('license.max_activations', 'license#' . $lid, (string) $n);
                jbx_flash('Allowed installs set to ' . $n . '.');
                break;

            case 'release_activation':
                // The rebind path: frees the hardware binding so the customer
                // can activate on a new server without a new key.
                $aid = (int) ($_POST['activation_id'] ?? 0);
                $db->prepare(
                    "UPDATE activations SET status = 'released' WHERE id = ? AND license_id = ?"
                )->execute([$aid, $lid]);
                jbx_audit('activation.released', 'activation#' . $aid);
                jbx_flash('Activation released. The customer can now activate on new hardware '
                        . 'with the same key.');
                break;

            case 'block_activation':
                $aid = (int) ($_POST['activation_id'] ?? 0);
                $db->prepare(
                    "UPDATE activations SET status = 'blocked' WHERE id = ? AND license_id = ?"
                )->execute([$aid, $lid]);
                jbx_audit('activation.blocked', 'activation#' . $aid);
                jbx_flash('Activation blocked. It will stop receiving renewals.');
                break;

            default:
                throw new RuntimeException('Unknown action.');
        }
    } catch (Throwable $e) {
        jbx_flash($e->getMessage(), 'err');
    }

    header('Location: licenses.php?id=' . $lid);
    exit;
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------
if ($id > 0) {
    $st = $db->prepare(
        'SELECT l.*, c.company, c.website, c.contact_name, c.email, c.phone, c.country,
                p.name AS plan_name, p.max_subscribers, p.validity_days, p.grace_days
           FROM licenses l
           JOIN customers c ON c.id = l.customer_id
           JOIN plans p     ON p.id = l.plan_id
          WHERE l.id = ?'
    );
    $st->execute([$id]);
    $L = $st->fetch();

    if (!$L) {
        jbx_head('Licence');
        echo '<h1>Not found</h1><p class="sub">No licence with that id.</p>';
        jbx_foot();
        exit;
    }

    $st = $db->prepare('SELECT * FROM activations WHERE license_id = ? ORDER BY activated_at DESC');
    $st->execute([$id]);
    $acts = $st->fetchAll();

    $st = $db->prepare(
        'SELECT h.* FROM heartbeats h
           JOIN activations a ON a.id = h.activation_id
          WHERE a.license_id = ? ORDER BY h.at DESC LIMIT 25'
    );
    $st->execute([$id]);
    $hbs = $st->fetchAll();

    $plans = $db->query('SELECT * FROM plans ORDER BY sort_order')->fetchAll();

    jbx_head('Licence ' . $L['license_key']);
    ?>
    <h1><?= e($L['company']) ?></h1>
    <p class="sub">
      <span class="mono"><?= e($L['license_key']) ?></span> ·
      <span class="pill p-<?= e($L['status']) ?>"><?= e($L['status']) ?></span>
      <?= $L['is_trial'] ? ' · <span class="pill p-unactivated">trial</span>' : '' ?>
    </p>

    <div class="card">
      <h2>Customer</h2>
      <table>
        <tr><th style="width:170px">Company</th><td><?= e($L['company']) ?></td></tr>
        <tr><th>Website</th><td><?= e($L['website'] ?? '—') ?></td></tr>
        <tr><th>Contact</th><td><?= e($L['contact_name'] ?? '—') ?></td></tr>
        <tr><th>Email</th><td><?= e($L['email'] ?? '—') ?></td></tr>
        <tr><th>Phone</th><td><?= e($L['phone'] ?? '—') ?></td></tr>
        <tr><th>Country</th><td><?= e($L['country'] ?? '—') ?></td></tr>
      </table>
    </div>

    <div class="card">
      <h2>Installed on (hardware binding)</h2>
      <?php if (!$acts): ?>
        <p class="muted">Not activated yet. The key has been issued but no installer has called home.</p>
      <?php else: ?>
      <div class="scroll"><table>
        <tr><th>Status</th><th>Hostname</th><th>Primary MAC</th><th>OS</th><th>Panel</th>
            <th>Public IP</th><th>Activated</th><th>Last seen</th><th></th></tr>
        <?php foreach ($acts as $a): ?>
        <tr>
          <td><span class="pill p-<?= $a['status'] === 'active' ? 'active' : 'suspended' ?>"><?= e($a['status']) ?></span></td>
          <td class="mono"><?= e($a['hostname'] ?? '—') ?></td>
          <td class="mono"><?= e($a['primary_mac'] ?? '—') ?></td>
          <td class="muted" style="font-size:12px"><?= e($a['os_release'] ?? '—') ?></td>
          <td class="mono"><?= e($a['panel_version'] ?? '—') ?></td>
          <td class="mono"><?= e($a['public_ip'] ?? '—') ?></td>
          <td style="font-size:12px"><?= e($a['activated_at']) ?></td>
          <td style="font-size:12px"><?= e($a['last_seen_at'] ?? 'never') ?></td>
          <td>
            <?php if ($a['status'] === 'active'): ?>
            <form method="post" style="display:inline" onsubmit="return confirm('Release this hardware binding? The customer will be able to activate the same key on a different server.')">
              <input type="hidden" name="_csrf" value="<?= e(jbx_csrf()) ?>">
              <input type="hidden" name="license_id" value="<?= (int) $L['id'] ?>">
              <input type="hidden" name="activation_id" value="<?= (int) $a['id'] ?>">
              <input type="hidden" name="action" value="release_activation">
              <button class="btn btn-s" style="padding:5px 11px;font-size:12px">Release</button>
            </form>
            <form method="post" style="display:inline" onsubmit="return confirm('Block this install? It stops receiving renewals and will lapse.')">
              <input type="hidden" name="_csrf" value="<?= e(jbx_csrf()) ?>">
              <input type="hidden" name="license_id" value="<?= (int) $L['id'] ?>">
              <input type="hidden" name="activation_id" value="<?= (int) $a['id'] ?>">
              <input type="hidden" name="action" value="block_activation">
              <button class="btn btn-d" style="padding:5px 11px;font-size:12px">Block</button>
            </form>
            <?php endif; ?>
          </td>
        </tr>
        <tr><td colspan="9" class="mono muted" style="font-size:11px;border-bottom:1px solid var(--border)">
          fingerprint · machine <?= e(substr((string) $a['fp_machine_id'], 0, 16)) ?>…
          · mac <?= e(substr((string) $a['fp_mac'], 0, 16)) ?>…
          · rootfs <?= e(substr((string) $a['fp_rootfs'], 0, 16)) ?>…
        </td></tr>
        <?php endforeach; ?>
      </table></div>
      <?php endif; ?>
    </div>

    <div class="card">
      <h2>Plan &amp; billing</h2>
      <div class="row">
        <form method="post">
          <input type="hidden" name="_csrf" value="<?= e(jbx_csrf()) ?>">
          <input type="hidden" name="license_id" value="<?= (int) $L['id'] ?>">
          <input type="hidden" name="action" value="set_plan">
          <label>Plan</label>
          <select name="plan_id">
            <?php foreach ($plans as $p): ?>
              <option value="<?= e($p['id']) ?>" <?= $p['id'] === $L['plan_id'] ? 'selected' : '' ?>>
                <?= e($p['name']) ?>
              </option>
            <?php endforeach; ?>
          </select>
          <div style="margin-top:10px"><button class="btn btn-s">Change plan</button></div>
        </form>

        <form method="post">
          <input type="hidden" name="_csrf" value="<?= e(jbx_csrf()) ?>">
          <input type="hidden" name="license_id" value="<?= (int) $L['id'] ?>">
          <input type="hidden" name="action" value="set_paid_until">
          <label>Paid until</label>
          <input name="paid_until" value="<?= e($L['paid_until'] ?? '') ?>" placeholder="YYYY-MM-DD">
          <div style="margin-top:10px"><button class="btn btn-s">Update payment date</button></div>
        </form>
      </div>

      <p class="muted" style="font-size:12.5px;margin-top:14px">
        Licences are re-signed every <?= (int) $L['validity_days'] ?> days by the heartbeat, with
        <?= (int) $L['grace_days'] ?> days of grace after that. Past <span class="mono">paid_until</span>
        the server stops re-signing, so the licence lapses on its own — you never need to revoke.
      </p>

      <form method="post" style="margin-top:8px">
        <input type="hidden" name="_csrf" value="<?= e(jbx_csrf()) ?>">
        <input type="hidden" name="license_id" value="<?= (int) $L['id'] ?>">
        <input type="hidden" name="action" value="set_max_activations">
        <label>Allowed simultaneous installs</label>
        <input name="max_activations" type="number" min="1" max="50" value="<?= (int) $L['max_activations'] ?>" style="max-width:120px">
        <div style="margin-top:10px"><button class="btn btn-s">Save</button></div>
      </form>
    </div>

    <div class="card">
      <h2>Licence status</h2>
      <form method="post">
        <input type="hidden" name="_csrf" value="<?= e(jbx_csrf()) ?>">
        <input type="hidden" name="license_id" value="<?= (int) $L['id'] ?>">
        <input type="hidden" name="action" value="set_status">
        <label>Set status</label>
        <select name="status">
          <?php foreach (['active', 'suspended', 'revoked'] as $s): ?>
            <option value="<?= $s ?>" <?= $s === $L['status'] ? 'selected' : '' ?>><?= $s ?></option>
          <?php endforeach; ?>
        </select>
        <p class="muted" style="font-size:12.5px;margin-top:8px">
          Suspending or revoking stops renewals. It does <strong>not</strong> reach into their
          server and switch anything off — their current licence remains valid until it expires.
          That is deliberate: an ISP's subscribers must never drop because of a billing dispute.
        </p>
        <div style="margin-top:12px"><button class="btn btn-d">Apply</button></div>
      </form>
    </div>

    <div class="card">
      <h2>Heartbeats</h2>
      <?php if (!$hbs): ?>
        <p class="muted">No heartbeats recorded yet.</p>
      <?php else: ?>
      <div class="scroll"><table>
        <tr><th>When</th><th>Subscribers</th><th>NAS</th><th>Panel</th><th>IP</th><th>Flags</th></tr>
        <?php foreach ($hbs as $h): ?>
        <tr><td class="mono" style="font-size:12px"><?= e($h['at']) ?></td>
            <td><?= $h['subscriber_count'] !== null ? number_format((int) $h['subscriber_count']) : '—' ?>
              <?php if ((int) $L['max_subscribers'] > 0 && (int) $h['subscriber_count'] > (int) $L['max_subscribers']): ?>
                <span class="pill p-suspended">over plan</span>
              <?php endif; ?>
            </td>
            <td><?= e($h['nas_count'] ?? '—') ?></td>
            <td class="mono"><?= e($h['panel_version'] ?? '—') ?></td>
            <td class="mono"><?= e($h['ip'] ?? '—') ?></td>
            <td><?= $h['tamper_flags'] ? '<span class="pill p-revoked">' . e($h['tamper_flags']) . '</span>' : '' ?></td>
        </tr>
        <?php endforeach; ?>
      </table></div>
      <?php endif; ?>
    </div>

    <p style="margin-bottom:30px"><a href="licenses.php">← All licences</a></p>
    <?php
    jbx_foot();
    exit;
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------
$q      = trim((string) ($_GET['q'] ?? ''));
$filter = (string) ($_GET['status'] ?? '');

$sql = 'SELECT l.*, c.company, p.name AS plan_name,
               (SELECT COUNT(*) FROM activations a WHERE a.license_id = l.id AND a.status = "active") AS installs,
               (SELECT MAX(a.last_seen_at) FROM activations a WHERE a.license_id = l.id) AS last_seen
          FROM licenses l
          JOIN customers c ON c.id = l.customer_id
          JOIN plans p     ON p.id = l.plan_id
         WHERE 1=1';
$args = [];

if ($q !== '') {
    $sql   .= ' AND (c.company LIKE ? OR l.license_key LIKE ? OR c.email LIKE ?)';
    $like   = '%' . $q . '%';
    $args[] = $like; $args[] = $like; $args[] = $like;
}
if (in_array($filter, ['unactivated', 'active', 'suspended', 'expired', 'revoked'], true)) {
    $sql   .= ' AND l.status = ?';
    $args[] = $filter;
}
$sql .= ' ORDER BY l.created_at DESC LIMIT 300';

$st = $db->prepare($sql);
$st->execute($args);
$rows = $st->fetchAll();

jbx_head('Licences');
?>
<h1>Licences</h1>
<p class="sub"><?= count($rows) ?> shown.</p>

<div class="card">
  <form method="get" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <div style="flex:1;min-width:200px">
      <label>Search company, key or email</label>
      <input name="q" value="<?= e($q) ?>">
    </div>
    <div style="min-width:150px">
      <label>Status</label>
      <select name="status">
        <option value="">any</option>
        <?php foreach (['unactivated', 'active', 'suspended', 'expired', 'revoked'] as $s): ?>
          <option value="<?= $s ?>" <?= $s === $filter ? 'selected' : '' ?>><?= $s ?></option>
        <?php endforeach; ?>
      </select>
    </div>
    <button class="btn btn-s">Filter</button>
  </form>
</div>

<div class="card">
  <div class="scroll"><table>
    <tr><th>Company</th><th>Key</th><th>Plan</th><th>Status</th><th>Installs</th>
        <th>Paid until</th><th>Last seen</th></tr>
    <?php foreach ($rows as $r): ?>
    <tr>
      <td><a href="licenses.php?id=<?= (int) $r['id'] ?>"><?= e($r['company']) ?></a>
        <?= $r['is_trial'] ? ' <span class="pill p-unactivated">trial</span>' : '' ?></td>
      <td class="mono"><?= e($r['license_key']) ?></td>
      <td><?= e($r['plan_name']) ?></td>
      <td><span class="pill p-<?= e($r['status']) ?>"><?= e($r['status']) ?></span></td>
      <td><?= (int) $r['installs'] ?><?= (int) $r['installs'] > (int) $r['max_activations'] ? ' <span class="pill p-suspended">over</span>' : '' ?></td>
      <td<?= ($r['paid_until'] && $r['paid_until'] < date('Y-m-d')) ? ' style="color:#fbbf24"' : '' ?>><?= e($r['paid_until'] ?? '—') ?></td>
      <td style="font-size:12px"><?= e($r['last_seen'] ?? '—') ?></td>
    </tr>
    <?php endforeach; ?>
  </table></div>
</div>
<?php jbx_foot();
