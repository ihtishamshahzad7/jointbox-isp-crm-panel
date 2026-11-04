"""Invoice files attached to inventory batches, expenses and assets, stored in PostgreSQL.

Uploads are validated exactly like customer documents (PDF, JPG, PNG or WebP; 5 MB each).
Assets are Operations records, so their access follows the Operations module rights.
"""
import crm_auth
import crm_documents

SECTIONS = {'Inventory': 'inventory', 'Expenses': 'expenses', 'Assets': 'operations_records'}
METADATA = 'id,section,record_id,original_name,mime_type,byte_size,uploaded_at,uploaded_by_name'


def initialize(db):
    db.execute('''CREATE TABLE IF NOT EXISTS record_invoices(
        id BIGSERIAL PRIMARY KEY, section TEXT NOT NULL CHECK (section IN ('Inventory','Expenses')), record_id BIGINT NOT NULL,
        original_name TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, content BYTEA NOT NULL,
        uploaded_by_name TEXT NOT NULL, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
    db.execute('CREATE INDEX IF NOT EXISTS record_invoices_record ON record_invoices(section, record_id)')
    # Look up the constraint on this schema's table (regclass follows the search path), not one of the same name elsewhere.
    allowed = db.execute("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='record_invoices_section_check' AND conrelid='record_invoices'::regclass").fetchone()
    if not allowed or 'Assets' not in allowed['d']:
        db.execute('ALTER TABLE record_invoices DROP CONSTRAINT IF EXISTS record_invoices_section_check')
        db.execute("ALTER TABLE record_invoices ADD CONSTRAINT record_invoices_section_check CHECK (section IN ('Inventory','Expenses','Assets'))")
    # A batch invoice is stored once in invoice_files and linked from every item of the batch.
    db.execute('''CREATE TABLE IF NOT EXISTS invoice_files(
        id BIGSERIAL PRIMARY KEY, content BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
    db.execute('ALTER TABLE record_invoices ADD COLUMN IF NOT EXISTS file_id BIGINT REFERENCES invoice_files(id) ON DELETE RESTRICT')
    db.execute('CREATE INDEX IF NOT EXISTS record_invoices_file ON record_invoices(file_id) WHERE file_id IS NOT NULL')


def check(user, section, write=False):
    if section not in SECTIONS:
        raise ValueError('Invoices can be attached to inventory batches, expenses and assets only.')
    if section == 'Assets':
        import crm_operations
        permitted = crm_operations.permitted(user, 'Assets', write)
    else:
        permitted = crm_auth.allowed(user, section, 'write' if write else 'read')
    if not permitted:
        raise PermissionError('Your role cannot ' + ('attach invoices to ' if write else 'view invoices for ') + section.lower() + '.')


def record_exists(db, section, record_id):
    if type(record_id) is not int or record_id <= 0:
        raise ValueError('Select a valid record.')
    if section == 'Assets':
        return db.execute("SELECT 1 FROM operations_records WHERE id=%s AND module='Assets'", (record_id,)).fetchone() is not None
    return db.execute(f'SELECT 1 FROM {SECTIONS[section]} WHERE id=%s', (record_id,)).fetchone() is not None


def batch_members(db, section, record_id):
    """Every record that shares this record's batch number (inventory batches and asset batches)."""
    if section == 'Inventory':
        batch = db.execute('SELECT batch FROM inventory WHERE id=%s', (record_id,)).fetchone()['batch']
        query = 'SELECT id FROM inventory WHERE batch=%s ORDER BY id'
    elif section == 'Assets':
        batch = db.execute("SELECT data->>'batch' AS batch FROM operations_records WHERE id=%s", (record_id,)).fetchone()['batch']
        query = "SELECT id FROM operations_records WHERE module='Assets' AND data->>'batch'=%s ORDER BY id"
    else:
        raise ValueError('Only inventory and asset invoices can be shared across a batch.')
    if not batch:
        raise ValueError('This record has no batch number.')
    return [r['id'] for r in db.execute(query, (batch,))]


def listing(db, user, section, record_id):
    check(user, section)
    return list(db.execute(f'SELECT {METADATA} FROM record_invoices WHERE section=%s AND record_id=%s ORDER BY id DESC', (section, record_id)))


def validate_files(files):
    uploads = crm_documents.validate_uploads([dict(file, document_type='Other') for file in files] if isinstance(files, list) else files)
    if not uploads:
        raise ValueError('Choose at least one invoice file.')
    return uploads


def upload(db, user, section, record_id, files, whole_batch=False):
    check(user, section, write=True)
    uploads = validate_files(files)
    if not record_exists(db, section, record_id):
        raise ValueError('This record no longer exists.')
    if whole_batch:
        attach_shared(db, user, section, batch_members(db, section, record_id), uploads)
        return len(uploads)
    for _, name, mime, size, content in uploads:
        db.execute('INSERT INTO record_invoices(section,record_id,original_name,mime_type,byte_size,content,uploaded_by_name) VALUES (%s,%s,%s,%s,%s,%s,%s)',
                   (section, record_id, name, mime, size, content, user['name']))
    return len(uploads)


def attach_shared(db, user, section, record_ids, uploads):
    """Store each file once and list it on every given record (e.g. all items of a stock batch)."""
    for _, name, mime, size, content in uploads:
        file_id = db.execute('INSERT INTO invoice_files(content) VALUES (%s) RETURNING id', (content,)).fetchone()['id']
        for record_id in record_ids:
            db.execute('''INSERT INTO record_invoices(section,record_id,original_name,mime_type,byte_size,content,uploaded_by_name,file_id)
                VALUES (%s,%s,%s,%s,%s,'',%s,%s)''', (section, record_id, name, mime, size, user['name'], file_id))


def content(db, invoice_id):
    return db.execute('''SELECT r.*, COALESCE(f.content, r.content) AS content FROM record_invoices r
        LEFT JOIN invoice_files f ON f.id=r.file_id WHERE r.id=%s''', (invoice_id,)).fetchone()


def prune(db):
    # A shared file is kept while any record still lists it.
    db.execute('DELETE FROM invoice_files f WHERE NOT EXISTS (SELECT 1 FROM record_invoices r WHERE r.file_id=f.id)')


def remove(db, user, invoice_id):
    row = db.execute('SELECT section FROM record_invoices WHERE id=%s', (invoice_id,)).fetchone() if type(invoice_id) is int else None
    if not row:
        raise ValueError('Invoice does not exist.')
    check(user, row['section'], write=True)
    db.execute('DELETE FROM record_invoices WHERE id=%s', (invoice_id,))
    prune(db)


def counts(db, section):
    return {r['record_id']: r['n'] for r in db.execute('SELECT record_id, count(*) AS n FROM record_invoices WHERE section=%s GROUP BY record_id', (section,))}
