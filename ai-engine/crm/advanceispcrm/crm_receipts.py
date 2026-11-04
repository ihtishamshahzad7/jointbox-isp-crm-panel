"""Permanent receipt snapshots, saved in the same transaction as payment."""


def initialize_receipts(db):
    db.execute('''CREATE TABLE IF NOT EXISTS payment_receipts (
        payment_record_id BIGINT PRIMARY KEY REFERENCES payments(id) ON DELETE RESTRICT,
        receipt_number TEXT NOT NULL UNIQUE, customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
        payment_id TEXT NOT NULL, customer_name TEXT NOT NULL, username TEXT NOT NULL,
        phone TEXT NOT NULL, address TEXT NOT NULL, package_name TEXT NOT NULL,
        amount NUMERIC(15,2) NOT NULL, payment_date DATE NOT NULL, billing_month TEXT NOT NULL,
        method TEXT NOT NULL, reference TEXT NOT NULL, recorded_by TEXT NOT NULL,
        customer_status TEXT NOT NULL, expiry_date DATE NOT NULL, activated BOOLEAN NOT NULL DEFAULT FALSE,
        imported BOOLEAN NOT NULL DEFAULT FALSE, saved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )''')
    db.execute("ALTER TABLE payment_receipts ADD COLUMN IF NOT EXISTS otc_type TEXT NOT NULL DEFAULT 'Other'")
    db.execute("ALTER TABLE payment_receipts ADD COLUMN IF NOT EXISTS revenue_type TEXT NOT NULL DEFAULT 'MRC'")
    db.execute('ALTER TABLE payment_receipts ADD COLUMN IF NOT EXISTS outstanding_amount NUMERIC(15,2) NOT NULL DEFAULT 0')
    db.execute('ALTER TABLE payment_receipts ADD COLUMN IF NOT EXISTS partial_activation BOOLEAN NOT NULL DEFAULT FALSE')
    # Copy of every deleted payment, for the Deleted Collections report.
    db.execute('''CREATE TABLE IF NOT EXISTS deleted_payments (
        payment_record_id BIGINT PRIMARY KEY, customer_id BIGINT, customer_name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
        area TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', amount NUMERIC(15,2) NOT NULL, payment_date DATE NOT NULL,
        billing_month TEXT NOT NULL, method TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '', revenue_type TEXT NOT NULL,
        otc_type TEXT NOT NULL DEFAULT 'Other', deleted_by TEXT NOT NULL, deleted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
    db.execute('''INSERT INTO payment_receipts(payment_record_id,receipt_number,customer_id,payment_id,customer_name,username,
        phone,address,package_name,amount,payment_date,billing_month,method,reference,recorded_by,customer_status,expiry_date,imported,revenue_type,otc_type)
        SELECT p.id,'RCP-'||p.id::text,c.id,c.payment_id,c.name,c.username,c.phone,c.address,c.package,p.amount,
        p.payment_date,p.billing_month,p.method,p.reference,'Historical payment',c.status,c.expiry_date,TRUE,p.revenue_type,p.otc_type
        FROM payments p JOIN customers c ON c.id=p.customer_id
        WHERE NOT EXISTS (SELECT 1 FROM payment_receipts r WHERE r.payment_record_id=p.id)
        ON CONFLICT(payment_record_id) DO NOTHING''')


def record_deletion(db, payment, user):
    db.execute('''INSERT INTO deleted_payments(payment_record_id,customer_id,customer_name,username,area,city,amount,payment_date,
        billing_month,method,reference,revenue_type,otc_type,deleted_by)
        SELECT p.id,p.customer_id,COALESCE(c.name,''),COALESCE(c.username,''),COALESCE(c.area,''),COALESCE(c.city,''),p.amount,p.payment_date,
        p.billing_month,p.method,p.reference,p.revenue_type,p.otc_type,%s
        FROM payments p LEFT JOIN customers c ON c.id=p.customer_id WHERE p.id=%s ON CONFLICT DO NOTHING''', (user.get('name') or 'Unknown', payment['id']))


def save_receipt(db, payment_record_id, user_id, activated=False, outstanding_amount=0, partial_activation=False):
    actor = db.execute('SELECT name FROM app_users WHERE id=%s', (user_id,)).fetchone() if user_id else None
    db.execute('''INSERT INTO payment_receipts(payment_record_id,receipt_number,customer_id,payment_id,customer_name,username,
        phone,address,package_name,amount,payment_date,billing_month,method,reference,recorded_by,customer_status,expiry_date,activated,outstanding_amount,partial_activation,revenue_type,otc_type)
        SELECT p.id,'RCP-'||p.id::text,c.id,c.payment_id,c.name,c.username,c.phone,c.address,c.package,p.amount,
        p.payment_date,p.billing_month,p.method,p.reference,%s,c.status,c.expiry_date,%s,%s,%s,p.revenue_type,p.otc_type
        FROM payments p JOIN customers c ON c.id=p.customer_id WHERE p.id=%s
        ON CONFLICT(payment_record_id) DO NOTHING''', (actor['name'] if actor else 'Verified online payment',activated,outstanding_amount,partial_activation,payment_record_id))
    receipt = db.execute('SELECT receipt_number FROM payment_receipts WHERE payment_record_id=%s', (payment_record_id,)).fetchone()
    if not receipt:
        raise ValueError('Could not save payment receipt.')
    return {'receipt_number': receipt['receipt_number'], 'receipt_url': '/receipt?id='+str(payment_record_id)}
