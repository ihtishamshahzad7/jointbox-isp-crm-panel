<?php
/**
 * Issue a new licence: pick or create a customer, pick a plan, set paid_until.
 * Prints the key for you to hand over.
 */
declare(strict_types=1);
require_once __DIR__ . '/_auth.php';
jbx_require_admin();

$db      = jbx_db();
$plans   = $db->query('SELECT * FROM plans WHERE is_trial = 0 ORDER BY sort_order')->fetchAll();
$custs   = $db->query('SELECT id, company FROM customers ORDER BY company LIMIT 500')->fetchAll();
$issued  = null;

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    jbx_check_csrf();

    try {
        $db->beginTransaction();

        // ---- customer -----------------------------------------------------
        $customerId = (int) ($_POST['customer_id'] ?? 0);
        if ($customerId === 0) {
            $company = jbx_str($_POST, 'company', 160);
            if ($company === null) {
                throw new RuntimeException('Company name is required for a new customer.');
            }
            $db->prepare(
                'INSERT INTO customers (company, website, contact_name, email, phone, country, notes, created_at)
                 VALUES (?,?,?,?,?,?,?,NOW())'
            )->execute([
                $company,
                jbx_str($_POST, 'website', 160),
                jbx_str($_POST, 'contact_name', 120),
                jbx_str($_POST, 'email', 160),
                jbx_str($_POST, 'phone', 40),
                jbx_str($_POST, 'country', 60),
                jbx_str($_POST, 'notes', 2000),
            ]);
            $customerId = (int) $db->lastInsertId();
            jbx_audit('customer.created', 'customer#' . $customerId, $company);
        }

        // ---- plan ---------------------------------------------------------
        $planId = (string) ($_POST['plan_id'] ?? '');
        if (jbx_plan($planId) === null) {
            throw new RuntimeException('Unknown plan.');
        }

        $paidUntil = jbx_str($_POST, 'paid_until', 10);
        if ($paidUntil !== null && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $paidUntil)) {
            throw new RuntimeException('Paid-until must be YYYY-MM-DD.');
        }

        $maxAct = max(1, min(50, (int) ($_POST['max_activations'] ?? 1)));

        // ---- key ----------------------------------------------------------
        $key = null;
        for ($i = 0; $i < 5; $i++) {
            $candidate = jbx_generate_license_key();
            try {
                $db->prepare(
                    "INSERT INTO licenses
                       (license_key, customer_id, plan_id, status, hmac_secret,
                        paid_until, max_activations, is_trial, created_at, created_by)
                     VALUES (?,?,?, 'unactivated', ?, ?, ?, 0, NOW(), ?)"
                )->execute([
                    $candidate, $customerId, $planId, jbx_new_hmac_secret(),
                    $paidUntil, $maxAct, $_SESSION['jbx_admin'],
                ]);
                $key = $candidate;
                break;
            } catch (PDOException $e) {
                if ($i === 4) { throw $e; }   // 5 collisions on 95 bits: impossible in practice
            }
        }

        $licenseId = (int) $db->lastInsertId();
        jbx_audit('license.issued', 'license#' . $licenseId, "$planId key=$key");

        $db->commit();

        $issued = ['key' => $key, 'id' => $licenseId, 'plan' => $planId, 'paid_until' => $paidUntil];
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        jbx_flash($e->getMessage(), 'err');
        header('Location: issue.php');
        exit;
    }
}

jbx_head('Issue licence');
?>
<h1>Issue a licence</h1>
<p class="sub">Creates an unactivated key. It becomes active the moment the customer's installer calls home.</p>

<?php if ($issued): ?>
<div class="card" style="border-color:#E9408B">
  <h2>Licence created — hand this key to the customer</h2>
  <div class="keybox"><?= e($issued['key']) ?></div>
  <p class="muted" style="text-align:center;font-size:13px">
    Plan <strong><?= e($issued['plan']) ?></strong>
    <?= $issued['paid_until'] ? ' · paid until ' . e($issued['paid_until']) : ' · no payment date set' ?>
  </p>
  <p class="muted" style="margin-top:14px;font-size:13px">
    They enter it at the installer prompt. The panel binds it to that server's hardware on first
    contact, so the same key will not activate a second machine unless you raise
    <span class="mono">max_activations</span> or release the old activation.
  </p>
  <div style="margin-top:14px;text-align:center">
    <a class="btn btn-s" href="licenses.php?id=<?= (int) $issued['id'] ?>">Open licence</a>
    <a class="btn btn-s" href="issue.php">Issue another</a>
  </div>
</div>
<?php endif; ?>

<form method="post">
<input type="hidden" name="_csrf" value="<?= e(jbx_csrf()) ?>">

<div class="card">
  <h2>Customer</h2>
  <label>Existing customer</label>
  <select name="customer_id" id="cust">
    <option value="0">— create a new customer below —</option>
    <?php foreach ($custs as $c): ?>
      <option value="<?= (int) $c['id'] ?>"><?= e($c['company']) ?></option>
    <?php endforeach; ?>
  </select>

  <div id="newcust">
    <div class="row">
      <div><label>Company name *</label><input name="company"></div>
      <div><label>Website</label><input name="website" placeholder="example.net"></div>
    </div>
    <div class="row">
      <div><label>Contact person</label><input name="contact_name"></div>
      <div><label>Email</label><input name="email" type="email"></div>
    </div>
    <div class="row">
      <div><label>Phone / WhatsApp</label><input name="phone"></div>
      <div><label>Country</label><input name="country" value="Pakistan"></div>
    </div>
    <label>Notes</label><textarea name="notes" rows="2"></textarea>
  </div>
</div>

<div class="card">
  <h2>Plan &amp; billing</h2>
  <div class="row">
    <div>
      <label>Plan</label>
      <select name="plan_id" required>
        <?php foreach ($plans as $p): ?>
          <option value="<?= e($p['id']) ?>">
            <?= e($p['name']) ?> — PKR <?= number_format((int) $p['price_pkr_month']) ?>/mo,
            <?= ((int) $p['max_subscribers']) === 0 ? 'unlimited' : number_format((int) $p['max_subscribers']) ?> subscribers
          </option>
        <?php endforeach; ?>
      </select>
    </div>
    <div>
      <label>Paid until (YYYY-MM-DD)</label>
      <input name="paid_until" placeholder="<?= e(date('Y-m-d', strtotime('+1 month'))) ?>"
             value="<?= e(date('Y-m-d', strtotime('+1 month'))) ?>">
    </div>
  </div>
  <label>Allowed simultaneous installs</label>
  <input name="max_activations" type="number" min="1" max="50" value="1">
  <p class="muted" style="font-size:12.5px;margin-top:6px">
    Leave at 1 unless the customer genuinely runs more than one panel. This is the number the
    dashboard's cloning alert compares against.
  </p>
  <div style="margin-top:18px"><button class="btn">Generate licence key</button></div>
</div>
</form>

<script>
  var sel = document.getElementById('cust'), box = document.getElementById('newcust');
  function sync(){ box.style.display = sel.value === '0' ? 'block' : 'none'; }
  sel.addEventListener('change', sync); sync();
</script>
<?php jbx_foot();
