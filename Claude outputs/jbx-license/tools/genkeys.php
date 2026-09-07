<?php
/**
 * ===========================================================================
 *  GENERATE YOUR LICENCE SIGNING KEYPAIR — RUN THIS ON YOUR OWN MACHINE ONLY
 * ===========================================================================
 *
 *   php tools/genkeys.php
 *
 *  It writes two files into the current directory:
 *
 *    jbx_license_ed25519.sk   SECRET. This key IS your licensing business.
 *                             Upload to  /domains/panel.jointbox.net/private/
 *                             chmod 0400. Keep an ENCRYPTED OFFLINE BACKUP.
 *                             If you lose it, every licence in the field dies
 *                             and cannot be reissued.
 *
 *    jbx_license_ed25519.pk   PUBLIC. Safe to share. Goes into the Go agent
 *                             as a compiled-in constant, and into
 *                             jbx-config.php as 'public_key_hex'.
 *
 *  Do NOT run this on the web server. Do NOT commit the .sk file.
 *  Do NOT paste the .sk contents into a chat window, an email, or a ticket.
 * ===========================================================================
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("Refusing to run over HTTP. Run this from a terminal.\n");
}

if (!extension_loaded('sodium')) {
    fwrite(STDERR, "ERROR: the sodium extension is not available.\n");
    fwrite(STDERR, "On Ubuntu:  sudo apt install php-cli php-sodium\n");
    fwrite(STDERR, "On Windows: enable extension=sodium in php.ini\n");
    exit(1);
}

$skPath = 'jbx_license_ed25519.sk';
$pkPath = 'jbx_license_ed25519.pk';

foreach ([$skPath, $pkPath] as $p) {
    if (file_exists($p)) {
        fwrite(STDERR, "REFUSING TO OVERWRITE: $p already exists.\n");
        fwrite(STDERR, "If you regenerate the keypair, every licence already\n");
        fwrite(STDERR, "issued to a customer stops verifying. Move the old\n");
        fwrite(STDERR, "files aside deliberately if that is really what you want.\n");
        exit(1);
    }
}

$pair = sodium_crypto_sign_keypair();
$sk   = sodium_crypto_sign_secretkey($pair);
$pk   = sodium_crypto_sign_publickey($pair);

file_put_contents($skPath, sodium_bin2hex($sk) . "\n");
file_put_contents($pkPath, sodium_bin2hex($pk) . "\n");
@chmod($skPath, 0400);
@chmod($pkPath, 0444);

// Prove the pair actually works before you rely on it.
$msg = 'jointbox-selftest-' . bin2hex(random_bytes(8));
$sig = sodium_crypto_sign_detached($msg, $sk);
if (!sodium_crypto_sign_verify_detached($sig, $msg, $pk)) {
    fwrite(STDERR, "ERROR: generated keypair failed its own self-test. Do not use it.\n");
    exit(1);
}

echo "\n";
echo "  Keypair generated and self-tested OK.\n";
echo "  ---------------------------------------------------------------\n";
echo "  SECRET key : $skPath   <-- upload to private/, chmod 0400,\n";
echo "                                back up encrypted, never commit\n";
echo "  PUBLIC key : $pkPath\n\n";
echo "  Public key hex (paste into jbx-config.php as 'public_key_hex',\n";
echo "  and into the Go agent):\n\n";
echo '    ' . trim((string) file_get_contents($pkPath)) . "\n\n";
echo "  Next: add *.sk to .gitignore if you have not already.\n\n";
