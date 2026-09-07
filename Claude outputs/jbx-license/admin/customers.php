<?php
declare(strict_types=1);
require_once __DIR__ . '/_auth.php';
jbx_require_admin();

$db = jbx_db();
$q  = trim((string) ($_GET['q'] ?? ''));

$sql = 'SELECT c.*,
               (SELECT COUNT(*) FROM licenses l WHERE l.customer_id = c.id) AS licences,
               (SELECT COUNT(*) FROM licenses l
                  JOIN activations a ON a.license_id = l.id
                 WHERE l.customer_id = c.id AND a.status = "active") AS installs
          FROM customers c';
$args = [];
if ($q !== '') {
    $sql   .= ' WHERE c.company LIKE ? OR c.email LIKE ? OR c.website LIKE ?';
    $like   = '%' . $q . '%';
    $args   = [$like, $like, $like];
}
$sql .= ' ORDER BY c.created_at DESC LIMIT 300';

$st = $db->prepare($sql);
$st->execute($args);
$rows = $st->fetchAll();

jbx_head('Customers');
?>
<h1>Customers</h1>
<p class="sub"><?= count($rows) ?> shown.</p>

<div class="card">
  <form method="get" style="display:flex;gap:10px;align-items:flex-end">
    <div style="flex:1"><label>Search</label><input name="q" value="<?= e($q) ?>"></div>
    <button class="btn btn-s">Search</button>
  </form>
</div>

<div class="card">
  <div class="scroll"><table>
    <tr><th>Company</th><th>Contact</th><th>Email</th><th>Phone</th><th>Website</th>
        <th>Licences</th><th>Installs</th><th>Since</th></tr>
    <?php foreach ($rows as $c): ?>
    <tr>
      <td><strong><?= e($c['company']) ?></strong></td>
      <td><?= e($c['contact_name'] ?? '—') ?></td>
      <td><?= e($c['email'] ?? '—') ?></td>
      <td class="mono"><?= e($c['phone'] ?? '—') ?></td>
      <td><?= e($c['website'] ?? '—') ?></td>
      <td><?= (int) $c['licences'] ?></td>
      <td><?= (int) $c['installs'] ?></td>
      <td style="font-size:12px"><?= e(substr((string) $c['created_at'], 0, 10)) ?></td>
    </tr>
    <?php endforeach; ?>
  </table></div>
</div>
<p style="margin-bottom:30px"><a class="btn" href="issue.php">Issue a licence</a></p>
<?php jbx_foot();
