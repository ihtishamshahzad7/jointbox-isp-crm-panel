<?php
/**
 * Generate the bcrypt hash for your admin password.
 *
 *   php tools/hash-password.php 'my-strong-password'
 *
 * Paste the output into jbx-config.php as 'admin_pass_hash'.
 * The plaintext password is never stored anywhere.
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("CLI only.\n");
}

$pw = $argv[1] ?? null;
if ($pw === null || $pw === '') {
    fwrite(STDERR, "Usage: php tools/hash-password.php 'your-password'\n");
    exit(1);
}

if (strlen($pw) < 12) {
    fwrite(STDERR, "Refusing: use at least 12 characters. This password can mint\n");
    fwrite(STDERR, "licences for your entire product.\n");
    exit(1);
}

echo password_hash($pw, PASSWORD_BCRYPT, ['cost' => 12]) . "\n";
