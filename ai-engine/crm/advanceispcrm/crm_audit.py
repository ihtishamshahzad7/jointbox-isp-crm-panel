"""Activity log of every staff request, sign-in history, live sessions and database statistics for administrators."""
import json
import logging
from pathlib import Path

import crm_data

# Never store secrets or uploaded file contents in the log.
SECRET_KEYS = ('password', 'token', 'csrf', 'secret')
BULKY_KEYS = ('documents', 'files', 'content', 'data_url', 'photo', 'image')
ONLINE_MINUTES = 5
BACKUPS = Path(__file__).parent / 'deploy' / 'backups'


def initialize(db):
    db.execute('''CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        user_id BIGINT, username TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, section TEXT NOT NULL DEFAULT '',
        record_id TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', method TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL DEFAULT '', status INTEGER, ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '')''')
    db.execute('CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at DESC)')
    db.execute('CREATE INDEX IF NOT EXISTS audit_log_user ON audit_log(user_id, at DESC)')
    for column, kind in (('created_at', 'TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP'), ('last_seen', 'TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP'),
                         ('ip', "TEXT NOT NULL DEFAULT ''"), ('user_agent', "TEXT NOT NULL DEFAULT ''")):
        db.execute(f'ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS {column} {kind}')


def scrub(value, depth=0):
    if isinstance(value, dict):
        return {k: ('[hidden]' if any(s in str(k).lower() for s in SECRET_KEYS) else '[file]' if str(k).lower() in BULKY_KEYS and value[k] else scrub(v, depth + 1))
                for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v, depth + 1) for v in value[:50]]
    if isinstance(value, str) and len(value) > 300:
        return value[:300] + '…'
    return value


def describe(method, path, payload):
    """Turn a request into (action, section, record id, detail) for the log."""
    payload = payload if isinstance(payload, dict) else {}
    section = str(payload.get('section') or payload.get('module') or '')
    rid = payload.get('id') or payload.get('record_id') or payload.get('customer_id') or ''
    names = {'/api/auth/login': 'Sign in', '/api/auth/logout': 'Sign out', '/api/auth/setup': 'Create first administrator',
             '/api/auth/password': 'Change own password', '/api/auth/forgot-password': 'Request password reset',
             '/api/auth/reset-password': 'Reset password', '/api/users': 'Save user account'}
    if method == 'GET':
        action = 'View'
        section = section or path.removeprefix('/api/').split('/')[0].replace('-', ' ').capitalize()
    elif path in names:
        action = names[path]
        section = section or ('Users' if path == '/api/users' else 'Account')
    else:
        act = payload.get('action')
        action = str(act).capitalize() if act else ('Edit' if rid else 'Create')
        section = section or path.removeprefix('/api/').replace('-', ' ').replace('/', ' › ').capitalize()
    fields = payload.get('fields') if isinstance(payload.get('fields'), dict) else {k: v for k, v in payload.items() if k not in ('section', 'module', 'id', 'action', 'request_key')}
    detail = json.dumps(scrub(fields), default=str, ensure_ascii=False) if fields else ''
    return action, section, str(rid), detail[:4000]


def record(user, method, path, payload, status, ip, agent, username=''):
    try:
        action, section, rid, detail = describe(method, path, payload)
        if path == '/api/auth/login' and status != 200:
            action = 'Failed sign-in'
        # Looked up at call time so tests that point crm_data at an isolated schema log there.
        with crm_data.connect_database() as db:
            if user is None and username:
                user = db.execute('SELECT id, username FROM app_users WHERE lower(username)=%s', (username.strip().lower(),)).fetchone()
            db.execute('''INSERT INTO audit_log(user_id,username,action,section,record_id,detail,method,path,status,ip,user_agent)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                       (user['id'] if user else None, user['username'] if user else username[:80], action, section[:120], rid[:60],
                        detail, method, path[:300], status, ip[:64], (agent or '')[:300]))
    except Exception:
        # Logging must never break the request it describes.
        logging.exception('Could not write the activity log.')


def touch_session(db, token_hash):
    db.execute("UPDATE app_sessions SET last_seen=CURRENT_TIMESTAMP WHERE token_hash=%s AND last_seen<CURRENT_TIMESTAMP-INTERVAL '1 minute'", (token_hash,))


def overview(db):
    size = db.execute('SELECT pg_database_size(current_database()) AS bytes').fetchone()['bytes']
    tables = db.execute('''SELECT relname AS name, pg_total_relation_size(c.oid) AS bytes, c.reltuples::bigint AS rows
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname=current_schema()
        ORDER BY bytes DESC LIMIT 12''').fetchall()
    counts = {label: db.execute(f'SELECT count(*) AS n FROM {table}').fetchone()['n'] for label, table in
              (('Customers', 'customers'), ('Payments', 'payments'), ('Invoices', 'invoices'), ('Tickets', 'tickets'),
               ('Users', 'app_users'), ('Activity log entries', 'audit_log'))}
    online = db.execute(f'''SELECT u.name, u.username, u.role, s.ip, s.user_agent, s.created_at AS signed_in, s.last_seen
        FROM app_sessions s JOIN app_users u ON u.id=s.user_id
        WHERE s.expires_at>CURRENT_TIMESTAMP AND s.last_seen>CURRENT_TIMESTAMP-INTERVAL '{ONLINE_MINUTES} minutes'
        ORDER BY s.last_seen DESC''').fetchall()
    sessions = db.execute('SELECT count(*) AS n FROM app_sessions WHERE expires_at>CURRENT_TIMESTAMP').fetchone()['n']
    users = db.execute('''SELECT u.id, u.name, u.username, u.role, u.status, (u.permissions IS NOT NULL) AS custom_rights,
        (SELECT max(at) FROM audit_log a WHERE a.user_id=u.id AND a.action='Sign in' AND a.status=200) AS last_sign_in,
        (SELECT count(*) FROM audit_log a WHERE a.user_id=u.id AND a.action='Sign in' AND a.status=200) AS sign_ins,
        (SELECT max(last_seen) FROM app_sessions s WHERE s.user_id=u.id) AS last_seen
        FROM app_users u ORDER BY u.name''').fetchall()
    today = db.execute('''SELECT count(*) FILTER (WHERE action='Sign in' AND status=200) AS sign_ins,
        count(*) FILTER (WHERE action='Failed sign-in') AS failed, count(DISTINCT user_id) FILTER (WHERE action='Sign in' AND status=200) AS people,
        count(*) FILTER (WHERE method='POST' AND action NOT IN ('Sign in','Failed sign-in','Sign out')) AS changes
        FROM audit_log WHERE at>=date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Karachi') AT TIME ZONE 'Asia/Karachi' ''').fetchone()
    backups = sorted(BACKUPS.glob('*.dump'), key=lambda p: p.stat().st_mtime, reverse=True) if BACKUPS.exists() else []
    last_backup = {'name': backups[0].name, 'bytes': backups[0].stat().st_size, 'at': backups[0].stat().st_mtime} if backups else None
    return {'database_bytes': size, 'tables': tables, 'counts': counts, 'online': online, 'online_minutes': ONLINE_MINUTES,
            'active_sessions': sessions, 'users': users, 'today': today, 'last_backup': last_backup, 'backups': len(backups)}


def activity(db, query):
    """Newest-first activity with optional filters: user, action, text search and Karachi date range."""
    where, params = [], []
    if query.get('user'):
        where.append('user_id=%s'); params.append(int(query['user']))
    if query.get('kind') == 'logins':
        where.append("action IN ('Sign in','Failed sign-in','Sign out')")
    elif query.get('kind') == 'changes':
        where.append("method='POST' AND action NOT IN ('Sign in','Failed sign-in','Sign out')")
    if query.get('q'):
        where.append("(username||' '||action||' '||section||' '||record_id||' '||detail||' '||ip) ILIKE %s"); params.append('%' + query['q'] + '%')
    if query.get('from'):
        where.append("at>=(%s::date)::timestamp AT TIME ZONE 'Asia/Karachi'"); params.append(query['from'])
    if query.get('to'):
        where.append("at<((%s::date)+1)::timestamp AT TIME ZONE 'Asia/Karachi'"); params.append(query['to'])
    limit = min(max(int(query.get('limit') or 300), 1), 5000)
    sql = 'SELECT id,at,user_id,username,action,section,record_id,detail,method,path,status,ip,user_agent FROM audit_log'
    if where:
        sql += ' WHERE ' + ' AND '.join(where)
    return db.execute(sql + ' ORDER BY at DESC, id DESC LIMIT %s', params + [limit]).fetchall()
