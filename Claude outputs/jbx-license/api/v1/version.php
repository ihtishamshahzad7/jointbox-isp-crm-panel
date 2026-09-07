<?php
/**
 * GET /api/v1/version
 *
 * Latest panel version. Harmless, unauthenticated, and gives the agent a
 * reason to call home that the customer sees value in.
 */
declare(strict_types=1);

require_once __DIR__ . '/../../lib/licence.php';

jbx_json_out(200, [
    'ok'          => true,
    'latest'      => '1.0.0',
    'min_supported' => '1.0.0',
    'changelog'   => 'https://panel.jointbox.net/documentation.html',
    'server_time' => time(),
]);
