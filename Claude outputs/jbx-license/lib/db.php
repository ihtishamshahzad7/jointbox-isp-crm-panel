<?php
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

/**
 * Build a PDO DSN.
 *
 * Handles the three shapes hosts actually hand you:
 *   'localhost'                  → host
 *   'mysql.example.com:3306'     → host + port
 *   a unix socket path in $socket → unix_socket (some hosts, and local test rigs)
 */
function jbx_dsn(string $host, string $name, string $socket = ''): string
{
    if ($socket !== '') {
        return sprintf('mysql:unix_socket=%s;dbname=%s;charset=utf8mb4', $socket, $name);
    }

    // A leading slash means they pasted a socket path into the host field.
    if ($host !== '' && $host[0] === '/') {
        return sprintf('mysql:unix_socket=%s;dbname=%s;charset=utf8mb4', $host, $name);
    }

    $port = '';
    if (preg_match('/^(.+):(\d{1,5})$/', $host, $m)) {
        $host = $m[1];
        $port = ';port=' . $m[2];
    }

    return sprintf('mysql:host=%s%s;dbname=%s;charset=utf8mb4', $host, $port, $name);
}

function jbx_db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $dsn = jbx_dsn(
        (string) jbx_cfg('db_host', 'localhost'),
        (string) jbx_cfg('db_name'),
        (string) jbx_cfg('db_socket', '')
    );

    try {
        $pdo = new PDO($dsn, (string) jbx_cfg('db_user'), (string) jbx_cfg('db_pass'), [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
    } catch (PDOException $e) {
        // Never leak credentials or SQL into an HTTP response.
        error_log('jbx db connect failed: ' . $e->getMessage());
        http_response_code(503);
        header('Content-Type: application/json');
        exit(json_encode(['ok' => false, 'error' => 'DB_UNAVAILABLE']));
    }

    return $pdo;
}

function jbx_audit(string $action, ?string $target = null, ?string $detail = null, ?string $actor = null): void
{
    try {
        jbx_db()->prepare(
            'INSERT INTO audit_log (at, actor, action, target, detail, ip)
             VALUES (NOW(), ?, ?, ?, ?, ?)'
        )->execute([
            $actor ?? ($_SESSION['jbx_admin'] ?? 'system'),
            $action,
            $target,
            $detail,
            jbx_client_ip(),
        ]);
    } catch (Throwable $e) {
        error_log('jbx audit failed: ' . $e->getMessage());
    }
}

function jbx_client_ip(): string
{
    // Hostinger sits behind a proxy, so prefer the forwarded chain's first hop.
    foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'] as $k) {
        if (!empty($_SERVER[$k])) {
            $ip = trim(explode(',', (string) $_SERVER[$k])[0]);
            if (filter_var($ip, FILTER_VALIDATE_IP)) {
                return $ip;
            }
        }
    }
    return '0.0.0.0';
}
