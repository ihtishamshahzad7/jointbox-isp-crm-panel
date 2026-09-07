<?php
/**
 * Licence issuance and the fingerprint rule.
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

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/crypto.php';

/**
 * The 2-of-3 rule.
 *
 * A NIC swap or a disk reinstall changes one component; a different machine
 * changes all three. Requiring 2 of 3 to match means honest hardware
 * maintenance does not generate a support ticket, while cloning the licence
 * onto a second server still fails.
 *
 * Components the stored activation has as NULL are ignored rather than
 * counted as a match, so a partial fingerprint can never pass on its own.
 */
function jbx_fingerprint_matches(array $stored, array $incoming): bool
{
    $matches = 0;
    foreach (['fp_machine_id' => 'machine_id', 'fp_mac' => 'mac', 'fp_rootfs' => 'rootfs'] as $col => $key) {
        $a = $stored[$col] ?? null;
        $b = $incoming[$key] ?? null;
        if (is_string($a) && $a !== '' && is_string($b) && $b !== '' && hash_equals($a, $b)) {
            $matches++;
        }
    }
    return $matches >= 2;
}

/** Extract and sanity-check the three fingerprint hashes from a request. */
function jbx_read_fingerprint($fp): ?array
{
    if (!is_array($fp)) {
        return null;
    }
    $out = [];
    foreach (['machine_id', 'mac', 'rootfs'] as $k) {
        $v = $fp[$k] ?? null;
        // Each component must be a sha256 hex digest or absent.
        $out[$k] = (is_string($v) && preg_match('/^[a-f0-9]{64}$/', $v)) ? $v : null;
    }
    // Need at least two present, or the 2-of-3 rule can never be satisfied.
    return count(array_filter($out)) >= 2 ? $out : null;
}

function jbx_plan(string $planId): ?array
{
    $st = jbx_db()->prepare('SELECT * FROM plans WHERE id = ?');
    $st->execute([$planId]);
    $p = $st->fetch();
    return $p ?: null;
}

/**
 * Build and sign the licence blob for one activation.
 *
 * `exp` is deliberately short (plan.validity_days). The agent renews it on
 * every heartbeat while the licence is paid up, so non-payment lapses on its
 * own with no revocation list to maintain.
 */
function jbx_issue_signed_license(array $license, array $plan, array $activation): array
{
    $now = time();
    $validity = max(1, (int) $plan['validity_days']);
    $exp = $now + ($validity * 86400);

    $features = json_decode((string) $plan['features'], true);
    if (!is_array($features)) {
        $features = [];
    }

    $st = jbx_db()->prepare('SELECT company FROM customers WHERE id = ?');
    $st->execute([$license['customer_id']]);
    $company = (string) ($st->fetchColumn() ?: '');

    $claims = [
        'iss'        => (string) jbx_cfg('issuer', 'panel.jointbox.net'),
        'lid'        => (int) $license['id'],
        'aid'        => (int) $activation['id'],
        'key'        => (string) $license['license_key'],
        'plan'       => (string) $plan['id'],
        'max_subs'   => (int) $plan['max_subscribers'],
        'feat'       => array_values($features),
        'fp'         => [
            'machine_id' => $activation['fp_machine_id'],
            'mac'        => $activation['fp_mac'],
            'rootfs'     => $activation['fp_rootfs'],
        ],
        'company'    => $company,
        'trial'      => (bool) $license['is_trial'],
        'iat'        => $now,
        'exp'        => $exp,
        'grace_days' => (int) $plan['grace_days'],
    ];

    return [
        'jws'    => jbx_sign_license($claims),
        'claims' => $claims,
    ];
}

/**
 * Is this licence entitled to a fresh signed blob right now?
 * Returns null when it is, or an error code when it is not.
 */
function jbx_renewal_block(array $license): ?string
{
    if ($license['status'] === 'revoked')    { return 'LICENSE_REVOKED'; }
    if ($license['status'] === 'suspended')  { return 'LICENSE_SUSPENDED'; }

    // Trials have no paid_until; their short validity_days is the whole limit.
    if (!$license['is_trial'] && $license['paid_until'] !== null) {
        if (strtotime((string) $license['paid_until'] . ' 23:59:59') < time()) {
            return 'PAYMENT_OVERDUE';
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Small helpers shared by the API endpoints
// ---------------------------------------------------------------------------

function jbx_json_in(): array
{
    $raw = file_get_contents('php://input') ?: '';
    if (strlen($raw) > 64 * 1024) {
        jbx_json_out(413, ['ok' => false, 'error' => 'PAYLOAD_TOO_LARGE']);
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function jbx_json_out(int $status, array $body): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

/** Fixed-window rate limit, good enough for one unauthenticated endpoint. */
function jbx_rate_limit(string $bucket, int $max, int $windowSeconds = 3600): bool
{
    $db = jbx_db();
    $db->prepare(
        'INSERT INTO rate_limit (bucket, hits, window_at) VALUES (?, 1, NOW())
         ON DUPLICATE KEY UPDATE
           hits      = IF(window_at < (NOW() - INTERVAL ? SECOND), 1, hits + 1),
           window_at = IF(window_at < (NOW() - INTERVAL ? SECOND), NOW(), window_at)'
    )->execute([$bucket, $windowSeconds, $windowSeconds]);

    $st = $db->prepare('SELECT hits FROM rate_limit WHERE bucket = ?');
    $st->execute([$bucket]);

    return ((int) $st->fetchColumn()) <= $max;
}

/** Reject replayed requests. Returns false if this nonce was already used. */
function jbx_consume_nonce(?string $nonce): bool
{
    if (!is_string($nonce) || !preg_match('/^[a-f0-9]{32}$/', $nonce)) {
        return false;
    }
    try {
        jbx_db()->prepare('INSERT INTO nonces (nonce, seen_at) VALUES (?, NOW())')
                ->execute([$nonce]);
        return true;
    } catch (PDOException $e) {
        return false;   // duplicate primary key = replay
    }
}

function jbx_str(?array $src, string $key, int $max = 160): ?string
{
    $v = $src[$key] ?? null;
    if (!is_string($v)) {
        return null;
    }
    $v = trim(strip_tags($v));
    return $v === '' ? null : mb_substr($v, 0, $max);
}
