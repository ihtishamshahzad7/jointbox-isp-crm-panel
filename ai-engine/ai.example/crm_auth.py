"""Local account authentication, sessions, and server-side role permissions."""
import hashlib
import hmac
import re
import secrets
import threading
import time
from http.cookies import SimpleCookie

import crm_data

BUSINESS = list(crm_data.SCHEMAS)
ROLES = {
    'Administrator': {'description': 'Full CRM access, user accounts, and settings.', 'read': BUSINESS + ['Users'], 'write': BUSINESS + ['Users'], 'delete': BUSINESS},
    'Manager': {'description': 'Manage operations, finances, packages, and inventory categories. No user administration.', 'read': BUSINESS, 'write': BUSINESS, 'delete': BUSINESS},
    'Accountant': {'description': 'Manage payments and expenses; view customer and package records.', 'read': ['Customers', 'Packages', 'Payments', 'Expenses'], 'write': ['Payments', 'Expenses'], 'delete': []},
    'Support': {'description': 'Manage customers and tickets; view staff and packages.', 'read': ['Customers', 'Staff', 'Packages', 'Jobs', 'Tickets'], 'write': ['Customers', 'Jobs', 'Tickets'], 'delete': []},
    'Technician': {'description': 'Update own assigned tickets; view customers, staff, stock, and own stock issues. Requires an employee link.', 'read': ['Customers', 'Staff', 'Inventory', 'Jobs', 'Tickets', 'Stock issues'], 'write': ['Jobs', 'Tickets'], 'delete': []},
    'Storekeeper': {'description': 'Manage inventory and stock issues; view customer, employee, and category lists.', 'read': ['Customers', 'Staff', 'Inventory', 'Stock issues', 'Categories'], 'write': ['Inventory', 'Stock issues'], 'delete': []},
    'Viewer': {'description': 'Read-only access to business modules. No user administration.', 'read': BUSINESS, 'write': [], 'delete': []},
}
for role in ('Accountant','Support','Storekeeper'):
    ROLES[role]['read'].append('Equipment recovery')

# Jobs are retained only as migration history; Tickets is the active workflow.
for permissions in ROLES.values():
    for action in ('read','write','delete'):
        permissions[action] = [section for section in permissions[action] if section != 'Jobs']

USER_SCHEMA = [('Name', 'text'), ('Username', 'text'), ('Designation', 'text'),
               ('Role', list(ROLES)), ('Status', ['Active', 'Inactive']), ('Staff ID', 'optionalstaff')]
PUBLIC_COLUMNS = 'id,name,username,designation,role,status,staff_id,created_at'
COOKIE = 'ispcrm_session'
_attempts = {}
_lock = threading.Lock()


def initialize_auth(db):
    db.execute('''CREATE TABLE IF NOT EXISTS app_users (
        id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL,
        designation TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Active',
        staff_id BIGINT REFERENCES staff(id) ON DELETE RESTRICT,
        password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )''')
    db.execute('CREATE UNIQUE INDEX IF NOT EXISTS app_users_username ON app_users(lower(username))')
    db.execute('CREATE UNIQUE INDEX IF NOT EXISTS app_users_staff ON app_users(staff_id) WHERE staff_id IS NOT NULL')
    import crm_password_recovery
    crm_password_recovery.initialize(db)
    db.execute('''CREATE TABLE IF NOT EXISTS app_sessions (
        token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        csrf TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
    )''')


def hash_password(password):
    if not isinstance(password, str) or not 10 <= len(password) <= 128:
        raise ValueError('Passwords must be 10–128 characters long.')
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 600000).hex()
    return f'pbkdf2_sha256$600000${salt}${digest}'


def verify_password(password, stored):
    if not isinstance(password, str) or len(password) > 128:
        return False
    try:
        algorithm, rounds, salt, expected = stored.split('$')
        if algorithm != 'pbkdf2_sha256':
            return False
        actual = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), int(rounds)).hex()
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def allowed(user, section, action='read'):
    if section == 'Equipment recovery' and action != 'read':
        return False
    if section == 'Jobs' and action != 'read':
        return False
    return section in ROLES.get(user['role'], {}).get(action, [])


def public_user(user):
    return {key: user[key] for key in ('id', 'name', 'username', 'designation', 'role', 'status', 'staff_id')}


def cookie_token(headers):
    cookie = SimpleCookie()
    try:
        cookie.load(headers.get('Cookie', ''))
        return cookie[COOKIE].value if COOKIE in cookie else ''
    except Exception:
        return ''


def current_session(headers):
    token = cookie_token(headers)
    if not token:
        return None
    with crm_data.connect_database() as db:
        return db.execute('''SELECT u.*,s.csrf FROM app_sessions s JOIN app_users u ON u.id=s.user_id
            WHERE s.token_hash=%s AND s.expires_at>CURRENT_TIMESTAMP AND u.status='Active' ''',
            (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()


def new_session(db, user_id):
    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    db.execute('DELETE FROM app_sessions WHERE expires_at<=CURRENT_TIMESTAMP')
    db.execute("INSERT INTO app_sessions(token_hash,user_id,csrf,expires_at) VALUES (%s,%s,%s,CURRENT_TIMESTAMP+INTERVAL '8 hours')",
               (hashlib.sha256(token.encode()).hexdigest(), user_id, csrf))
    return f'{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800', csrf


def check_attempts(address):
    with _lock:
        recent = [t for t in _attempts.get(address, []) if t > time.monotonic() - 900]
        _attempts[address] = recent
        if len(recent) >= 10:
            raise ValueError('Too many unsuccessful sign-ins. Try again in 15 minutes.')


def failed_attempt(address):
    with _lock:
        _attempts.setdefault(address, []).append(time.monotonic())


def login(username, password, address):
    check_attempts(address)
    with crm_data.connect_database() as db:
        user = db.execute('SELECT * FROM app_users WHERE lower(username)=%s', (str(username).strip().lower(),)).fetchone()
        if not user or user['status'] != 'Active' or not verify_password(password, user['password_hash']):
            # A fixed-cost verification also runs for an unknown/inactive account.
            if not user or user['status'] != 'Active':
                hashlib.pbkdf2_hmac('sha256', b'invalid', b'ispcrm-login-check', 600000)
            failed_attempt(address)
            raise ValueError('Incorrect username or password, or account inactive.')
        cookie, csrf = new_session(db, user['id'])
    with _lock:
        _attempts.pop(address, None)
    return user, cookie, csrf


def save_user(db, fields, rid=None, setup=False):
    # Lock account administration to protect the last active administrator.
    db.execute('SELECT pg_advisory_xact_lock(73912402)')
    if setup and db.execute('SELECT 1 FROM app_users LIMIT 1').fetchone():
        raise ValueError('Setup is already complete. Sign in to manage users.')
    existing = db.execute('SELECT * FROM app_users WHERE id=%s FOR UPDATE', (rid,)).fetchone() if rid else None
    if rid and not existing:
        raise ValueError('User does not exist.')
    name, username, designation = (str(fields.get(key, '')).strip() for key in ('name', 'username', 'designation'))
    username = username.lower()
    role, status = fields.get('role', 'Viewer'), fields.get('status', 'Active')
    if not name or not designation or not re.fullmatch(r'[a-z0-9][a-z0-9._@-]{2,79}', username):
        raise ValueError('Enter a name, designation, and a username of 3–80 letters, numbers, dots, underscores, @ or hyphens.')
    if role not in ROLES or status not in ('Active', 'Inactive'):
        raise ValueError('Select a valid role and account status.')
    staff_id = fields.get('staff_id')
    if staff_id in ('', None):
        staff_id = None
    else:
        try:
            staff_id = int(staff_id)
        except (ValueError, TypeError):
            raise ValueError('Select a valid employee.')
        if not db.execute('SELECT 1 FROM staff WHERE id=%s', (staff_id,)).fetchone():
            raise ValueError('Select an existing employee.')
    if role == 'Technician' and staff_id is None:
        raise ValueError('Technician accounts must be linked to a staff record for assigned jobs and tickets.')
    if existing and existing['role'] == 'Administrator' and existing['status'] == 'Active' and (role != 'Administrator' or status != 'Active'):
        if db.execute("SELECT count(*) AS count FROM app_users WHERE role='Administrator' AND status='Active'").fetchone()['count'] <= 1:
            raise ValueError('Keep at least one active administrator.')
    password = fields.get('password', '')
    password_hash = hash_password(password) if password else existing['password_hash'] if existing else None
    if not password_hash:
        raise ValueError('Set a password for the new user.')
    values = [name, username, designation, role, status, staff_id, password_hash]
    if rid:
        result = db.execute(f'''UPDATE app_users SET name=%s,username=%s,designation=%s,role=%s,status=%s,staff_id=%s,password_hash=%s
            WHERE id=%s RETURNING {PUBLIC_COLUMNS}''', values + [rid]).fetchone()
        db.execute('DELETE FROM app_sessions WHERE user_id=%s', (rid,))
        db.execute('DELETE FROM password_resets WHERE user_id=%s', (rid,))
    else:
        result = db.execute(f'''INSERT INTO app_users(name,username,designation,role,status,staff_id,password_hash)
            VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING {PUBLIC_COLUMNS}''', values).fetchone()
    return result


def check_scoped_write(db, user, section, rid, fields):
    if user['role'] != 'Technician':
        return
    if not rid or section not in ('Tickets', 'Jobs'):
        raise PermissionError('Technicians can update only their assigned tickets and jobs.')
    record = db.execute(f'SELECT * FROM {crm_data.table_name(section)} WHERE id=%s FOR UPDATE', (rid,)).fetchone()
    owner = 'assigned_to' if section == 'Tickets' else 'staff_id'
    if not record or record[owner] != user['staff_id']:
        raise PermissionError('This record is not assigned to your employee account.')
    editable = ('status', 'resolution_notes', 'description') if section == 'Tickets' else ('status', 'notes')
    for label, _ in crm_data.SCHEMAS[section]:
        key = crm_data.column_name(label)
        if key not in editable and str(fields.get(key, '')).strip() != str(record[key] if record[key] is not None else ''):
            raise PermissionError('Contact a manager to change assignment, customer, priority, or due date.')


def read_records(db, user):
    records = {}
    for section in BUSINESS:
        if not allowed(user, section):
            records[section] = []
            continue
        query = f'SELECT * FROM {crm_data.table_name(section)}'
        params = []
        if user['role'] == 'Technician' and section in ('Tickets', 'Jobs', 'Stock issues'):
            column = {'Tickets': 'assigned_to', 'Jobs': 'staff_id', 'Stock issues': 'employee_id'}[section]
            query += f' WHERE {column}=%s'
            params.append(user['staff_id'])
        records[section] = list(db.execute(query + ' ORDER BY id DESC', params))
        if section in ('Inventory', 'Expenses'):
            invoices = {r['record_id']: r['n'] for r in db.execute('SELECT record_id, count(*) AS n FROM record_invoices WHERE section=%s GROUP BY record_id', (section,))}
            for row in records[section]:
                row['invoice_count'] = invoices.get(row['id'], 0)
        if section == 'Stock issues':
            photos = {r['issue_id'] for r in db.execute('SELECT issue_id FROM stock_issue_photos')}
            for issue in records[section]:
                issue['has_photo'] = issue['id'] in photos
    if user['role'] not in ('Administrator','Manager'):
        for employee in records.get('Staff',[]):
            for key in crm_data.STAFF_PRIVATE:
                employee.pop(key,None)
    else:
        for employee in records.get('Staff',[]):
            employee['net_salary']=employee['monthly_salary']+employee['allowances']-employee['deductions']
    if allowed(user, 'Users'):
        records['Users'] = list(db.execute(f'SELECT {PUBLIC_COLUMNS} FROM app_users ORDER BY id DESC'))
    return records
