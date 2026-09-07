<?php
/**
 * POST /api/v1/activate
 *
 * Called once by the installer on the customer's server. Binds the licence to
 * that machine's hardware fingerprint and returns a signed licence.
 *
 * This is the only unauthenticated endpoint in the system, so it is rate
 * limited, replay protected, and deliberately vague in its error messages
 * about whether a key exists.
 */
declare(strict_types=1);

require_once __DIR__ . '/../../lib/licence.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    jbx_json_out(405, ['ok' => false, 'error' => 'METHOD_NOT_ALLOWED']);
}

$ip = jbx_client_ip();
if (!jbx_rate_limit('activate:' . $ip, (int) jbx_cfg('activate_rate_limit', 5))) {
    jbx_audit('activate.rate_limited', $ip);
    jbx_json_out(429, ['ok' => false, 'error' => 'RATE_LIMITED']);
}

$in = jbx_json_in();

// ---- replay / clock guards -------------------------------------------------
$ts = isset($in['ts']) ? (int) $in['ts'] : 0;
if (abs(time() - $ts) > 300) {
    jbx_json_out(400, ['ok' => false, 'error' => 'CLOCK_SKEW',
        'message' => 'Server time is ' . gmdate('c') . '. Run: sudo timedatectl set-ntp true']);
}
if (!jbx_consume_nonce($in['nonce'] ?? null)) {
    jbx_json_out(400, ['ok' => false, 'error' => 'BAD_OR_REPLAYED_NONCE']);
}

// ---- fingerprint -----------------------------------------------------------
$fp = jbx_read_fingerprint($in['fingerprint'] ?? null);
if ($fp === null) {
    jbx_json_out(400, ['ok' => false, 'error' => 'BAD_FINGERPRINT',
        'message' => 'At least two of machine_id, mac and rootfs must be sha256 hex.']);
}

$hostname     = jbx_str($in, 'hostname', 120);
$primaryMac   = jbx_str($in, 'primary_mac', 24);
$panelVersion = jbx_str($in, 'panel_version', 32);
$osRelease    = jbx_str($in, 'os_release', 120);
$custIn       = is_array($in['customer'] ?? null) ? $in['customer'] : [];

$db = jbx_db();

// ---- resolve the licence ---------------------------------------------------
$rawKey = is_string($in['license_key'] ?? null) ? $in['license_key'] : '';
$key    = $rawKey === '' ? null : jbx_normalize_license_key($rawKey);

if ($rawKey !== '' && $key === null) {
    // Checksum failed: almost always a typo, so say so plainly. This leaks
    // nothing, because it is decided locally without touching the database.
    jbx_json_out(400, ['ok' => false, 'error' => 'MALFORMED_KEY',
        'message' => 'That licence key is not valid — please re-check the characters.']);
}

try {
    $db->beginTransaction();

    if ($key !== null) {
        $st = $db->prepare('SELECT * FROM licenses WHERE license_key = ? FOR UPDATE');
        $st->execute([$key]);
        $license = $st->fetch();

        if (!$license) {
            $db->rollBack();
            jbx_audit('activate.unknown_key', substr($key, 0, 9) . '…', null, 'installer');
            jbx_json_out(404, ['ok' => false, 'error' => 'UNKNOWN_KEY',
                'message' => 'This licence key is not recognised. Contact support.']);
        }
        if (in_array($license['status'], ['revoked', 'suspended'], true)) {
            $db->rollBack();
            jbx_json_out(403, ['ok' => false, 'error' => 'LICENSE_' . strtoupper($license['status']),
                'message' => 'This licence is not currently active. Please contact support.']);
        }
    } else {
        // ---- no key supplied: 24-hour trial ------------------------------
        if (!jbx_cfg('allow_auto_trial', true)) {
            $db->rollBack();
            jbx_json_out(400, ['ok' => false, 'error' => 'KEY_REQUIRED',
                'message' => 'A licence key is required for this installation.']);
        }

        // One trial per machine, ever. Binding to the fingerprint rather than
        // to the install is the whole point — otherwise reinstalling the OS
        // resets the trial and it is worthless.
        $st = $db->prepare(
            'SELECT l.* FROM activations a
             JOIN licenses l ON l.id = a.license_id
             WHERE l.is_trial = 1
               AND (a.fp_machine_id = ? OR a.fp_rootfs = ?)
             LIMIT 1'
        );
        $st->execute([$fp['machine_id'], $fp['rootfs']]);
        $existingTrial = $st->fetch();

        if ($existingTrial) {
            $db->rollBack();
            jbx_json_out(403, ['ok' => false, 'error' => 'TRIAL_ALREADY_USED',
                'message' => 'The trial period for this server has already been used. '
                           . 'Please enter a licence key.']);
        }

        $license = jbx_create_trial_license($db, $custIn, $hostname);
    }

    $plan = jbx_plan((string) $license['plan_id']);
    if ($plan === null) {
        $db->rollBack();
        jbx_json_out(500, ['ok' => false, 'error' => 'PLAN_MISSING']);
    }

    if (($block = jbx_renewal_block($license)) !== null) {
        $db->rollBack();
        jbx_json_out(403, ['ok' => false, 'error' => $block,
            'message' => 'This licence cannot be activated right now. Please contact support.']);
    }

    // ---- bind hardware ----------------------------------------------------
    $st = $db->prepare(
        "SELECT * FROM activations
         WHERE license_id = ? AND status = 'active' FOR UPDATE"
    );
    $st->execute([$license['id']]);
    $existing = $st->fetchAll();

    $activation = null;
    foreach ($existing as $row) {
        if (jbx_fingerprint_matches($row, $fp)) {
            $activation = $row;
            break;
        }
    }

    if ($activation === null && count($existing) >= (int) $license['max_activations']) {
        // Same licence, different machine. Do not silently allow it — this is
        // exactly the cloning case the fingerprint exists to catch. Hand the
        // operator the details your support desk needs to resolve it.
        $db->rollBack();
        jbx_audit('activate.already_bound', 'license#' . $license['id'],
            'incoming host=' . (string) $hostname . ' mac=' . (string) $primaryMac, 'installer');
        jbx_json_out(409, [
            'ok'    => false,
            'error' => 'ALREADY_ACTIVATED',
            'message' => 'This licence is already active on another server. '
                       . 'Ask support to release it, or use the rebind option.',
            'bound_to' => [
                'hostname'    => $existing[0]['hostname'],
                'primary_mac' => $existing[0]['primary_mac'],
                'since'       => $existing[0]['activated_at'],
            ],
        ]);
    }

    if ($activation === null) {
        $db->prepare(
            'INSERT INTO activations
               (license_id, fp_machine_id, fp_mac, fp_rootfs, primary_mac, hostname,
                public_ip, panel_version, os_release, activated_at, last_seen_at, rebind_year)
             VALUES (?,?,?,?,?,?,?,?,?,NOW(),NOW(),?)'
        )->execute([
            $license['id'], $fp['machine_id'], $fp['mac'], $fp['rootfs'],
            $primaryMac, $hostname, $ip, $panelVersion, $osRelease, (int) date('Y'),
        ]);
        $aid = (int) $db->lastInsertId();

        $st = $db->prepare('SELECT * FROM activations WHERE id = ?');
        $st->execute([$aid]);
        $activation = $st->fetch();

        jbx_audit('activate.new', 'license#' . $license['id'],
            'host=' . (string) $hostname . ' mac=' . (string) $primaryMac, 'installer');
    } else {
        // Re-activation on substantially the same box: refresh the drifted
        // component so the fingerprint stays current.
        $db->prepare(
            'UPDATE activations
                SET fp_machine_id = ?, fp_mac = ?, fp_rootfs = ?, primary_mac = ?,
                    hostname = ?, public_ip = ?, panel_version = ?, os_release = ?,
                    last_seen_at = NOW()
              WHERE id = ?'
        )->execute([
            $fp['machine_id'], $fp['mac'], $fp['rootfs'], $primaryMac,
            $hostname, $ip, $panelVersion, $osRelease, $activation['id'],
        ]);
        $activation = array_merge($activation, [
            'fp_machine_id' => $fp['machine_id'],
            'fp_mac'        => $fp['mac'],
            'fp_rootfs'     => $fp['rootfs'],
        ]);
        jbx_audit('activate.refresh', 'activation#' . $activation['id'], null, 'installer');
    }

    // ---- update the customer record from the install wizard ---------------
    jbx_merge_customer_details($db, (int) $license['customer_id'], $custIn);

    if ($license['status'] === 'unactivated') {
        $db->prepare("UPDATE licenses SET status = 'active' WHERE id = ?")
           ->execute([$license['id']]);
        $license['status'] = 'active';
    }

    $signed = jbx_issue_signed_license($license, $plan, $activation);

    $db->commit();
} catch (Throwable $e) {
    if ($db->inTransaction()) {
        $db->rollBack();
    }
    error_log('jbx activate failed: ' . $e->getMessage());
    jbx_json_out(500, ['ok' => false, 'error' => 'INTERNAL']);
}

jbx_json_out(200, [
    'ok'          => true,
    'license'     => $signed['jws'],
    'hmac_secret' => $license['hmac_secret'],   // used to sign later heartbeats
    'license_key' => $license['license_key'],
    'plan'        => $plan['id'],
    'expires_at'  => gmdate('c', (int) $signed['claims']['exp']),
    'trial'       => (bool) $license['is_trial'],
    'server_time' => time(),
]);

// ---------------------------------------------------------------------------

function jbx_create_trial_license(PDO $db, array $custIn, ?string $hostname): array
{
    $company = jbx_str($custIn, 'company', 160)
        ?? ('Trial — ' . ($hostname ?? 'unknown host'));

    $db->prepare(
        'INSERT INTO customers (company, website, contact_name, email, phone, created_at)
         VALUES (?,?,?,?,?,NOW())'
    )->execute([
        $company,
        jbx_str($custIn, 'website', 160),
        jbx_str($custIn, 'contact_name', 120),
        jbx_str($custIn, 'email', 160),
        jbx_str($custIn, 'phone', 40),
    ]);
    $customerId = (int) $db->lastInsertId();

    // Retry on the astronomically unlikely key collision rather than 500.
    for ($attempt = 0; $attempt < 5; $attempt++) {
        $key = jbx_generate_license_key();
        try {
            $db->prepare(
                "INSERT INTO licenses
                   (license_key, customer_id, plan_id, status, hmac_secret,
                    is_trial, max_activations, created_at, created_by)
                 VALUES (?,?, 'trial', 'active', ?, 1, 1, NOW(), 'auto-trial')"
            )->execute([$key, $customerId, jbx_new_hmac_secret()]);
            break;
        } catch (PDOException $e) {
            if ($attempt === 4) {
                throw $e;
            }
        }
    }

    $st = $db->prepare('SELECT * FROM licenses WHERE id = ?');
    $st->execute([(int) $db->lastInsertId()]);
    $license = $st->fetch();

    jbx_audit('trial.created', 'license#' . $license['id'], $company, 'installer');

    return $license;
}

function jbx_merge_customer_details(PDO $db, int $customerId, array $in): void
{
    $map = [
        'website'      => jbx_str($in, 'website', 160),
        'contact_name' => jbx_str($in, 'contact_name', 120),
        'email'        => jbx_str($in, 'email', 160),
        'phone'        => jbx_str($in, 'phone', 40),
        'country'      => jbx_str($in, 'country', 60),
    ];

    $sets = [];
    $args = [];
    foreach ($map as $col => $val) {
        if ($val !== null) {
            // Only fill blanks — never overwrite what you typed in the admin UI
            // with whatever the installer prompt collected.
            $sets[] = "$col = COALESCE(NULLIF($col, ''), ?)";
            $args[] = $val;
        }
    }
    if ($sets === []) {
        return;
    }

    $args[] = $customerId;
    $db->prepare('UPDATE customers SET ' . implode(', ', $sets) . ' WHERE id = ?')
       ->execute($args);
}
