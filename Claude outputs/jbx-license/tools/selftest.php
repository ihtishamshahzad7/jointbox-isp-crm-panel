<?php
/**
 * Proves the crypto and key logic work before any of it reaches production.
 *
 *   php tools/selftest.php
 *
 * Runs entirely in memory with a throwaway keypair — needs no database and no
 * config file, so it is safe to run anywhere.
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    exit("CLI only.\n");
}

// Stub the config so crypto.php can load without private/jbx-config.php.
$GLOBALS['__jbx_test_cfg'] = [];
require_once __DIR__ . '/../lib/crypto.php';

$pass = 0;
$fail = 0;

function ok(string $name, bool $cond): void
{
    global $pass, $fail;
    if ($cond) { $pass++; echo "  PASS  $name\n"; }
    else       { $fail++; echo "  FAIL  $name\n"; }
}

echo "\nJointbox licence server self-test\n\n";

// ---- licence keys ---------------------------------------------------------
echo "Licence keys\n";
$key = jbx_generate_license_key();
ok('generated key has the JBX- shape', (bool) preg_match('/^JBX(-[0-9A-Z]{5}){4}$/', $key));
ok('round-trips through normalisation', jbx_normalize_license_key($key) === $key);
ok('accepts lowercase input', jbx_normalize_license_key(strtolower($key)) === $key);
ok('accepts input with no dashes', jbx_normalize_license_key(str_replace('-', '', $key)) === $key);
ok('accepts surrounding whitespace', jbx_normalize_license_key("  $key \n") === $key);

// A single-character typo must be caught locally, without a database lookup.
$body    = str_replace(['JBX-', '-'], '', $key);
$typoPos = 3;
$orig    = $body[$typoPos];
$body[$typoPos] = JBX_ALPHABET[(strpos(JBX_ALPHABET, $orig) + 7) % 32];
ok('rejects a single-character typo', jbx_normalize_license_key('JBX-' . $body) === null);

// Transposition is the other common dictation error.
$t = str_replace(['JBX-', '-'], '', $key);
if ($t[4] !== $t[5]) {
    [$t[4], $t[5]] = [$t[5], $t[4]];
    ok('rejects two transposed characters', jbx_normalize_license_key('JBX-' . $t) === null);
} else {
    ok('rejects two transposed characters (skipped: identical chars)', true);
}

ok('rejects a short string', jbx_normalize_license_key('JBX-ABCDE') === null);
ok('rejects empty input', jbx_normalize_license_key('') === null);

// No ambiguous characters may ever appear in a generated key.
$amb = false;
for ($i = 0; $i < 500; $i++) {
    if (preg_match('/[ILOU]/', jbx_generate_license_key())) { $amb = true; break; }
}
ok('never generates I, L, O or U', !$amb);

// Uniqueness sanity check.
$seen = [];
for ($i = 0; $i < 5000; $i++) { $seen[jbx_generate_license_key()] = true; }
ok('5000 generated keys are all distinct', count($seen) === 5000);

// ---- Ed25519 --------------------------------------------------------------
echo "\nSigning\n";
$pair = sodium_crypto_sign_keypair();
$sk   = sodium_crypto_sign_secretkey($pair);
$pk   = sodium_crypto_sign_publickey($pair);

$skFile = sys_get_temp_dir() . '/jbx_selftest_' . bin2hex(random_bytes(4)) . '.sk';
file_put_contents($skFile, sodium_bin2hex($sk));

// Point the config functions at our throwaway key.
$cfgFile = sys_get_temp_dir() . '/jbx_selftest_cfg_' . bin2hex(random_bytes(4)) . '.php';
file_put_contents($cfgFile, '<?php return ' . var_export([
    'signing_key_path' => $skFile,
    'public_key_hex'   => sodium_bin2hex($pk),
    'issuer'           => 'selftest',
], true) . ';');
putenv('JBX_CONFIG=' . $cfgFile);

$claims = [
    'lid' => 42, 'plan' => 'professional', 'max_subs' => 5000,
    'feat' => ['olt', 'franchise'],
    'fp' => ['machine_id' => str_repeat('a', 64), 'mac' => str_repeat('b', 64), 'rootfs' => null],
    'iat' => time(), 'exp' => time() + 1209600,
];

$jws = jbx_sign_license($claims);
ok('produces a three-part compact JWS', count(explode('.', $jws)) === 3);

$back = jbx_verify_license($jws, sodium_bin2hex($pk));
ok('verifies with the matching public key', $back !== null);
ok('claims survive the round trip', $back !== null && $back['lid'] === 42 && $back['plan'] === 'professional');
ok('feature array survives', $back !== null && $back['feat'] === ['olt', 'franchise']);
ok('nested fingerprint survives', $back !== null && $back['fp']['machine_id'] === str_repeat('a', 64));

// The whole security model rests on this one: a tampered payload must fail.
$parts = explode('.', $jws);
$evil  = json_decode(jbx_b64url_decode($parts[1]), true);
$evil['max_subs'] = 999999;
$forged = $parts[0] . '.' . jbx_b64url((string) json_encode($evil)) . '.' . $parts[2];
ok('REJECTS a payload edited to raise the subscriber limit', jbx_verify_license($forged, sodium_bin2hex($pk)) === null);

$evil2 = $evil;
$evil2['exp'] = time() + 3153600000;   // a century
$forged2 = $parts[0] . '.' . jbx_b64url((string) json_encode($evil2)) . '.' . $parts[2];
ok('REJECTS a payload edited to extend expiry', jbx_verify_license($forged2, sodium_bin2hex($pk)) === null);

$otherPk = sodium_crypto_sign_publickey(sodium_crypto_sign_keypair());
ok('rejects a licence signed by a different key', jbx_verify_license($jws, sodium_bin2hex($otherPk)) === null);
ok('rejects a truncated licence', jbx_verify_license($parts[0] . '.' . $parts[1], sodium_bin2hex($pk)) === null);
ok('rejects garbage', jbx_verify_license('not-a-licence', sodium_bin2hex($pk)) === null);

// ---- fingerprint 2-of-3 ---------------------------------------------------
echo "\nFingerprint 2-of-3\n";
require_once __DIR__ . '/../lib/licence.php';

$A = str_repeat('1', 64);
$B = str_repeat('2', 64);
$C = str_repeat('3', 64);
$X = str_repeat('9', 64);

$stored = ['fp_machine_id' => $A, 'fp_mac' => $B, 'fp_rootfs' => $C];

ok('same machine matches',
    jbx_fingerprint_matches($stored, ['machine_id' => $A, 'mac' => $B, 'rootfs' => $C]));
ok('swapped NIC still matches (2 of 3)',
    jbx_fingerprint_matches($stored, ['machine_id' => $A, 'mac' => $X, 'rootfs' => $C]));
ok('reinstalled disk still matches (2 of 3)',
    jbx_fingerprint_matches($stored, ['machine_id' => $A, 'mac' => $B, 'rootfs' => $X]));
ok('different machine does NOT match',
    !jbx_fingerprint_matches($stored, ['machine_id' => $X, 'mac' => $X, 'rootfs' => $X]));
ok('only one component matching does NOT match',
    !jbx_fingerprint_matches($stored, ['machine_id' => $A, 'mac' => $X, 'rootfs' => $X]));

// A NULL stored component must never be treated as a match, or a mostly-empty
// fingerprint would pass against a mostly-empty activation.
$sparse = ['fp_machine_id' => $A, 'fp_mac' => null, 'fp_rootfs' => null];
ok('NULL stored components do not count as matches',
    !jbx_fingerprint_matches($sparse, ['machine_id' => $A, 'mac' => null, 'rootfs' => null]));

echo "\nFingerprint parsing\n";
ok('accepts two valid sha256 components',
    jbx_read_fingerprint(['machine_id' => $A, 'mac' => $B]) !== null);
ok('rejects a single component', jbx_read_fingerprint(['machine_id' => $A]) === null);
ok('rejects non-hex values',
    jbx_read_fingerprint(['machine_id' => 'nope', 'mac' => 'also-nope']) === null);
ok('rejects short hex',
    jbx_read_fingerprint(['machine_id' => 'abc123', 'mac' => 'def456']) === null);
ok('rejects a non-array', jbx_read_fingerprint('string') === null);

@unlink($skFile);
@unlink($cfgFile);

echo "\n  $pass passed, $fail failed\n\n";
exit($fail === 0 ? 0 : 1);
