<?php
/**
 * Loads the real configuration from OUTSIDE the web root.
 *
 * Nothing secret lives in this repo. The file below is placed once, by hand,
 * via Hostinger's File Manager, and is never deployed by Git.
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

function jbx_config(): array
{
    static $cfg = null;
    if ($cfg !== null) {
        return $cfg;
    }

    // public_html/lib/config.php  ->  ../../private/jbx-config.php
    $candidates = [
        dirname(__DIR__, 2) . '/private/jbx-config.php',
        dirname(__DIR__) . '/../private/jbx-config.php',
        getenv('JBX_CONFIG') ?: '',
    ];

    foreach ($candidates as $path) {
        if ($path !== '' && is_readable($path)) {
            /** @var array $loaded */
            $loaded = require $path;
            if (!is_array($loaded)) {
                throw new RuntimeException('jbx-config.php must return an array');
            }
            return $cfg = $loaded;
        }
    }

    http_response_code(500);
    header('Content-Type: text/plain');
    exit("Licence server is not configured: private/jbx-config.php not found.\n");
}

function jbx_cfg(string $key, $default = null)
{
    $c = jbx_config();
    return array_key_exists($key, $c) ? $c[$key] : $default;
}
