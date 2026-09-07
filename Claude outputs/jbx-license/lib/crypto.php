<?php
/**
 * Licence keys and Ed25519 signing.
 *
 * Two separate things live here, and it is worth keeping them straight:
 *
 *   1. The LICENCE KEY (JBX-4K7QW-9MXR2-H8TVN-3PLC6) is just an identifier a
 *      human can read down the phone. It carries no entitlement by itself and
 *      is safe to display. Its only clever property is a checksum, so a typo
 *      is rejected by the installer instantly instead of after a round trip.
 *
 *   2. The SIGNED LICENCE is the thing that actually grants access: a compact
 *      JWS the agent verifies offline with the embedded public key. Only this
 *      server can mint one, because only this server has the secret key.
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

require_once __DIR__ . '/config.php';

/** Crockford base32 — no I, L, O or U, so nothing is ambiguous when dictated. */
const JBX_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate a licence key: JBX- plus four groups of five.
 * 19 random characters (~95 bits) plus one checksum character.
 */
function jbx_generate_license_key(): string
{
    $chars = '';
    for ($i = 0; $i < 19; $i++) {
        // random_int is cryptographically secure; rand()/mt_rand() are not.
        $chars .= JBX_ALPHABET[random_int(0, 31)];
    }
    $chars .= jbx_key_checksum($chars);

    return 'JBX-' . implode('-', str_split($chars, 5));
}

/** Checksum character over the 19 payload characters. */
function jbx_key_checksum(string $payload19): string
{
    $sum = 0;
    $len = strlen($payload19);
    for ($i = 0; $i < $len; $i++) {
        $pos = strpos(JBX_ALPHABET, $payload19[$i]);
        if ($pos === false) {
            return '?';
        }
        // Position-weighted so transposed characters are caught too, which a
        // plain sum would miss.
        $sum += ($pos + 1) * ($i + 1);
    }
    return JBX_ALPHABET[$sum % 32];
}

/**
 * Normalise user input into canonical form, or null if it cannot be a key.
 * Accepts lowercase, missing dashes, and the classic O/0 and I/1 confusions.
 */
function jbx_normalize_license_key(string $input): ?string
{
    $s = strtoupper(trim($input));
    $s = preg_replace('/^JBX[-\s]*/', '', $s) ?? '';
    $s = preg_replace('/[^A-Z0-9]/', '', $s) ?? '';

    // Crockford's documented substitutions.
    $s = strtr($s, ['O' => '0', 'I' => '1', 'L' => '1', 'U' => 'V']);

    if (strlen($s) !== 20) {
        return null;
    }
    if (jbx_key_checksum(substr($s, 0, 19)) !== $s[19]) {
        return null;   // checksum failed — a typo, not a real key
    }

    return 'JBX-' . implode('-', str_split($s, 5));
}

// ---------------------------------------------------------------------------
// Ed25519
// ---------------------------------------------------------------------------

function jbx_signing_key(): string
{
    $path = (string) jbx_cfg('signing_key_path');
    if ($path === '' || !is_readable($path)) {
        error_log('jbx: signing key unreadable at ' . $path);
        http_response_code(500);
        header('Content-Type: application/json');
        exit(json_encode(['ok' => false, 'error' => 'SIGNING_KEY_MISSING']));
    }

    $hex = trim((string) file_get_contents($path));
    $raw = @sodium_hex2bin($hex);

    if (!is_string($raw) || strlen($raw) !== SODIUM_CRYPTO_SIGN_SECRETKEYBYTES) {
        error_log('jbx: signing key is malformed (expected 64-byte hex secret key)');
        http_response_code(500);
        header('Content-Type: application/json');
        exit(json_encode(['ok' => false, 'error' => 'SIGNING_KEY_INVALID']));
    }

    return $raw;
}

function jbx_b64url(string $bin): string
{
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

function jbx_b64url_decode(string $s): string
{
    $pad = strlen($s) % 4;
    if ($pad) {
        $s .= str_repeat('=', 4 - $pad);
    }
    return (string) base64_decode(strtr($s, '-_', '+/'), true);
}

/**
 * Mint a compact JWS: base64url(header).base64url(payload).base64url(signature)
 * This is the string written to /etc/jointbox/license.jws on the customer's box.
 */
function jbx_sign_license(array $claims): string
{
    $header = jbx_b64url((string) json_encode(
        ['alg' => 'EdDSA', 'typ' => 'JBXLIC', 'v' => 1],
        JSON_UNESCAPED_SLASHES
    ));
    $payload = jbx_b64url((string) json_encode($claims, JSON_UNESCAPED_SLASHES));

    $signingInput = $header . '.' . $payload;
    $sig = sodium_crypto_sign_detached($signingInput, jbx_signing_key());

    return $signingInput . '.' . jbx_b64url($sig);
}

/**
 * Verify a licence we minted. Used by tools/selftest.php and the admin UI —
 * the agent does the same thing in Go with the embedded public key.
 */
function jbx_verify_license(string $jws, ?string $publicKeyHex = null): ?array
{
    $parts = explode('.', $jws);
    if (count($parts) !== 3) {
        return null;
    }

    $pkHex = $publicKeyHex ?? (string) jbx_cfg('public_key_hex');
    $pk = @sodium_hex2bin($pkHex);
    if (!is_string($pk) || strlen($pk) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES) {
        return null;
    }

    $ok = sodium_crypto_sign_verify_detached(
        jbx_b64url_decode($parts[2]),
        $parts[0] . '.' . $parts[1],
        $pk
    );
    if (!$ok) {
        return null;
    }

    $claims = json_decode(jbx_b64url_decode($parts[1]), true);
    return is_array($claims) ? $claims : null;
}

/** Per-licence secret used to sign heartbeats. */
function jbx_new_hmac_secret(): string
{
    return bin2hex(random_bytes(32));
}

/** Constant-time compare that tolerates non-string input. */
function jbx_hash_equals($known, $given): bool
{
    return is_string($known) && is_string($given) && hash_equals($known, $given);
}
