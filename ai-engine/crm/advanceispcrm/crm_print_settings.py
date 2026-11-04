"""Bill and receipt design: logo, company details and your own notes, shared by every printed receipt and invoice."""
import base64
import binascii
from psycopg.types.json import Jsonb

# (key, label, max length) shown in the Customise design form.
FIELDS = [('company_name', 'Company name', 120), ('tagline', 'Tagline under the name', 120), ('address', 'Address', 300),
          ('phone', 'Phone', 80), ('email', 'Email / website', 120),
          ('receipt_note', 'Receipt note (above the footer)', 600), ('receipt_footer', 'Receipt footer', 400),
          ('invoice_note', 'Bill note (payment instructions, bank details…)', 600), ('invoice_footer', 'Bill footer', 400)]
TOGGLES = [('hide_system_notes', 'Hide the CRM\'s explanatory notes on bills and receipts')]
LOGO_TYPES = {b'\x89PNG': 'image/png', b'\xff\xd8\xff': 'image/jpeg', b'RIFF': 'image/webp'}
MAX_LOGO = 1024 * 1024
EDITORS = ('Administrator', 'Manager')


def initialize(db):
    db.execute('''CREATE TABLE IF NOT EXISTS print_settings(
        id INTEGER PRIMARY KEY CHECK (id = 1), data JSONB NOT NULL DEFAULT '{}', logo BYTEA, logo_type TEXT,
        updated_by TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
    db.execute("INSERT INTO print_settings(id) VALUES (1) ON CONFLICT DO NOTHING")


def get(db, user):
    row = db.execute('SELECT data, logo_type, updated_at FROM print_settings WHERE id=1').fetchone()
    data = row['data'] if row else {}
    settings = {key: str(data.get(key) or '') for key, _, _ in FIELDS}
    settings.update({key: bool(data.get(key)) for key, _ in TOGGLES})
    return dict(settings=settings, has_logo=bool(row and row['logo_type']), version=row['updated_at'].timestamp() if row else 0,
                can_edit=user['role'] in EDITORS, fields=[dict(key=k, label=l, max=m) for k, l, m in FIELDS],
                toggles=[dict(key=k, label=l) for k, l in TOGGLES])


def check_editor(user):
    if user['role'] not in EDITORS:
        raise PermissionError('Only an administrator or manager can change the bill and receipt design.')


def save(db, user, payload):
    check_editor(user)
    action = payload.get('action', 'save')
    if action == 'save':
        raw = payload.get('settings')
        if not isinstance(raw, dict):
            raise ValueError('Invalid design settings.')
        data = {}
        for key, label, limit in FIELDS:
            value = str(raw.get(key) or '').strip()
            if len(value) > limit:
                raise ValueError(f'{label} must be {limit} characters or fewer.')
            data[key] = value
        for key, _ in TOGGLES:
            data[key] = raw.get(key) is True
        db.execute('UPDATE print_settings SET data=%s, updated_by=%s, updated_at=CURRENT_TIMESTAMP WHERE id=1', (Jsonb(data), user['name']))
    elif action == 'logo':
        try:
            content = base64.b64decode(str(payload.get('file') or ''), validate=True)
        except binascii.Error:
            raise ValueError('The logo could not be read. Choose it again.')
        if not content or len(content) > MAX_LOGO:
            raise ValueError('Use a logo image of 1 MB or smaller.')
        mime = next((m for magic, m in LOGO_TYPES.items() if content.startswith(magic)), None)
        if not mime or (mime == 'image/webp' and content[8:12] != b'WEBP'):
            raise ValueError('Use a PNG, JPG or WebP image for the logo.')
        db.execute('UPDATE print_settings SET logo=%s, logo_type=%s, updated_by=%s, updated_at=CURRENT_TIMESTAMP WHERE id=1', (content, mime, user['name']))
    elif action == 'remove_logo':
        db.execute('UPDATE print_settings SET logo=NULL, logo_type=NULL, updated_by=%s, updated_at=CURRENT_TIMESTAMP WHERE id=1', (user['name'],))
    else:
        raise ValueError('Invalid design request.')
    return get(db, user)


def logo(db):
    row = db.execute('SELECT logo, logo_type FROM print_settings WHERE id=1').fetchone()
    return (bytes(row['logo']), row['logo_type']) if row and row['logo_type'] else (None, None)
