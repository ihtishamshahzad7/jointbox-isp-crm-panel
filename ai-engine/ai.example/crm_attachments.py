"""Invoice files attached to inventory batches and expenses, stored in PostgreSQL.

Uploads are validated exactly like customer documents (PDF, JPG, PNG or WebP; 5 MB each).
"""
import crm_auth
import crm_documents

SECTIONS = {'Inventory': 'inventory', 'Expenses': 'expenses'}
METADATA = 'id,section,record_id,original_name,mime_type,byte_size,uploaded_at,uploaded_by_name'


def initialize(db):
    db.execute('''CREATE TABLE IF NOT EXISTS record_invoices(
        id BIGSERIAL PRIMARY KEY, section TEXT NOT NULL CHECK (section IN ('Inventory','Expenses')), record_id BIGINT NOT NULL,
        original_name TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, content BYTEA NOT NULL,
        uploaded_by_name TEXT NOT NULL, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
    db.execute('CREATE INDEX IF NOT EXISTS record_invoices_record ON record_invoices(section, record_id)')


def check(user, section, write=False):
    if section not in SECTIONS:
        raise ValueError('Invoices can be attached to inventory batches and expenses only.')
    if not crm_auth.allowed(user, section, 'write' if write else 'read'):
        raise PermissionError('Your role cannot ' + ('attach invoices to ' if write else 'view invoices for ') + section.lower() + '.')


def record_exists(db, section, record_id):
    if type(record_id) is not int or record_id <= 0:
        raise ValueError('Select a valid record.')
    return db.execute(f'SELECT 1 FROM {SECTIONS[section]} WHERE id=%s', (record_id,)).fetchone() is not None


def listing(db, user, section, record_id):
    check(user, section)
    return list(db.execute(f'SELECT {METADATA} FROM record_invoices WHERE section=%s AND record_id=%s ORDER BY id DESC', (section, record_id)))


def upload(db, user, section, record_id, files):
    check(user, section, write=True)
    uploads = crm_documents.validate_uploads([dict(file, document_type='Other') for file in files] if isinstance(files, list) else files)
    if not uploads:
        raise ValueError('Choose at least one invoice file.')
    if not record_exists(db, section, record_id):
        raise ValueError('This record no longer exists.')
    for _, name, mime, size, content in uploads:
        db.execute('INSERT INTO record_invoices(section,record_id,original_name,mime_type,byte_size,content,uploaded_by_name) VALUES (%s,%s,%s,%s,%s,%s,%s)',
                   (section, record_id, name, mime, size, content, user['name']))
    return len(uploads)


def remove(db, user, invoice_id):
    row = db.execute('SELECT section FROM record_invoices WHERE id=%s', (invoice_id,)).fetchone() if type(invoice_id) is int else None
    if not row:
        raise ValueError('Invoice does not exist.')
    check(user, row['section'], write=True)
    db.execute('DELETE FROM record_invoices WHERE id=%s', (invoice_id,))


def counts(db, section):
    return {r['record_id']: r['n'] for r in db.execute('SELECT record_id, count(*) AS n FROM record_invoices WHERE section=%s GROUP BY record_id', (section,))}
