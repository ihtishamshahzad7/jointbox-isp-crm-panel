<?php
declare(strict_types=1);
require_once __DIR__ . '/_auth.php';

if (jbx_admin_logged_in()) {
    jbx_audit('admin.logout', (string) $_SESSION['jbx_admin']);
}
session_destroy();
header('Location: login.php');
