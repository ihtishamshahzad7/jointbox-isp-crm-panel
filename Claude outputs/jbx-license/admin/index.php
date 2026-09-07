<?php
declare(strict_types=1);
require_once __DIR__ . '/_auth.php';
jbx_require_admin();

$db = jbx_db();

$counts = $db->query(
    "SELECT
       (SELECT COUNT(*) FROM licenses WHERE status='active' AND is_trial=0)  AS paid_active,
       (SELECT COUNT(*) FROM licenses WHERE is_trial=1)                      AS trials,
       (SELECT COUNT(*) FROM licenses WHERE status='unactivated')            AS pending,
       (SELECT COUNT(*) FROM activations WHERE status='active')              AS installs,
       (SELECT COUNT(*) FROM licenses
          WHERE is_trial=0 AND status='active'
            AND paid_until IS NOT NULL AND paid_until < CURDATE())           AS overdue"
)->fetch();

// Installs that have gone quiet — either switched off, or the agent was removed.
$silent = $db->query(
    "SELECT a.*, l.license_key, l.status AS lic_status, c.company
       FROM activations a
       JOIN licenses l  ON l.id = a.license_id
       JOIN customers c ON c.id = l.customer_id
      WHERE a.status = 'active'
        AND (a.last_seen_at IS NULL OR a.last_seen_at < (NOW() - INTERVAL 7 DAY))
      ORDER BY a.last_seen_at IS NULL DESC, a.last_seen_at ASC
      LIMIT 15"
)->fetchAll();

// The same licence answering from more than one machine.
$cloned = $db->query(
    // max_activations must be in the GROUP BY to be referenced by HAVING.
    "SELECT l.id, l.license_key, l.max_activations, c.company, COUNT(*) AS n
       FROM activations a
       JOIN licenses l  ON l.id = a.license_id
       JOIN customers c ON c.id = l.customer_id
      WHERE a.status = 'active'
      GROUP BY l.id, l.license_key, l.max_activations, c.company
     HAVING n > l.max_activations
      ORDER BY n DESC LIMIT 15"
)->fetchAll();

$overdue = $db->query(
    "SELECT l.*, c.company FROM licenses l JOIN customers c ON c.id = l.customer_id
      WHERE l.is_trial = 0 AND l.status = 'active'
        AND l.paid_until IS NOT NULL AND l.paid_until < CURDATE()
      ORDER BY l.paid_until ASC LIMIT 15"
)->fetchAll();

$recent = $db->query(
    'SELECT * FROM audit_log ORDER BY at DESC LIMIT 20'
)->fetchAll();

jbx_head('Dashboard');
?>
<h1>Dashboard</h1>
<p class="sub">Signed in as <?= e($_SESSION['jbx_admin']) ?>.</p>

<div class="stat">
  <div><div class="n" style="color:#5ee69a"><?= (int) $counts['paid_active'] ?></div><div class="l">Paid active</div></div>
  <div><div class="n"><?= (int) $counts['installs'] ?></div><div class="l">Live installs</div></div>
  <div><div class="n" style="color:#93a0bd"><?= (int) $counts['trials'] ?></div><div class="l">Trials</div></div>
  <div><div class="n" style="color:#93a0bd"><?= (int) $counts['pending'] ?></div><div class="l">Not yet activated</div></div>
  <div><div class="n" style="color:<?= $counts['overdue'] > 0 ? '#fbbf24' : '#93a0bd' ?>"><?= (int) $counts['overdue'] ?></div><div class="l">Payment overdue</div></div>
</div>

<?php if ($overdue): ?>
<div class="card">
  <h2>⚠ Payment overdue — renewals have stopped</h2>
  <p class="muted" style="margin-bottom:12px;font-size:13px">
    These licences are past <span class="mono">paid_until</span>, so the server no longer issues
    fresh signed licences. Each one lapses on the customer's server once its current licence
    expires plus its grace period. Collect, or extend the date.
  </p>
  <div class="scroll"><table>
    <tr><th>Company</th><th>Licence</th><th>Plan</th><th>Paid until</th><th></th></tr>
    <?php foreach ($overdue as $r): ?>
    <tr>
      <td><?= e($r['company']) ?></td>
      <td class="mono"><?= e($r['license_key']) ?></td>
      <td><?= e($r['plan_id']) ?></td>
      <td style="color:#fbbf24"><?= e($r['paid_until']) ?></td>
      <td><a href="licenses.php?id=<?= (int) $r['id'] ?>">Open</a></td>
    </tr>
    <?php endforeach; ?>
  </table></div>
</div>
<?php endif; ?>

<?php if ($cloned): ?>
<div class="card">
  <h2>⚠ One licence, several machines</h2>
  <p class="muted" style="margin-bottom:12px;font-size:13px">
    More active installs than <span class="mono">max_activations</span> allows. Either the
    customer legitimately moved server and the old activation was never released, or the key
    is being shared. Open the licence to see both machines' hostname and MAC.
  </p>
  <div class="scroll"><table>
    <tr><th>Company</th><th>Licence</th><th>Active installs</th><th></th></tr>
    <?php foreach ($cloned as $r): ?>
    <tr><td><?= e($r['company']) ?></td><td class="mono"><?= e($r['license_key']) ?></td>
        <td style="color:#fbbf24"><?= (int) $r['n'] ?></td>
        <td><a href="licenses.php?id=<?= (int) $r['id'] ?>">Open</a></td></tr>
    <?php endforeach; ?>
  </table></div>
</div>
<?php endif; ?>

<div class="card">
  <h2>Quiet installs (no heartbeat in 7 days)</h2>
  <?php if (!$silent): ?>
    <p class="muted">Every active install has checked in recently.</p>
  <?php else: ?>
  <p class="muted" style="margin-bottom:12px;font-size:13px">
    A panel that stops calling home has been switched off, has lost outbound
    internet, or has had the agent removed. Worth a phone call either way.
  </p>
  <div class="scroll"><table>
    <tr><th>Company</th><th>Host</th><th>MAC</th><th>Last seen</th><th></th></tr>
    <?php foreach ($silent as $a): ?>
    <tr>
      <td><?= e($a['company']) ?></td>
      <td class="mono"><?= e($a['hostname'] ?? '—') ?></td>
      <td class="mono"><?= e($a['primary_mac'] ?? '—') ?></td>
      <td><?= $a['last_seen_at'] ? e($a['last_seen_at']) : '<span class="muted">never</span>' ?></td>
      <td><a href="licenses.php?id=<?= (int) $a['license_id'] ?>">Open</a></td>
    </tr>
    <?php endforeach; ?>
  </table></div>
  <?php endif; ?>
</div>

<div class="card">
  <h2>Recent activity</h2>
  <div class="scroll"><table>
    <tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr>
    <?php foreach ($recent as $r): ?>
    <tr><td class="mono" style="white-space:nowrap"><?= e($r['at']) ?></td>
        <td><?= e($r['actor']) ?></td>
        <td class="mono"><?= e($r['action']) ?></td>
        <td class="mono"><?= e($r['target'] ?? '') ?></td>
        <td class="muted"><?= e($r['detail'] ?? '') ?></td></tr>
    <?php endforeach; ?>
  </table></div>
</div>
<?php jbx_foot();
