"""Separate customer authentication and customer-scoped self-service data."""
import hashlib,secrets
from datetime import datetime,timedelta
from http.cookies import SimpleCookie
from zoneinfo import ZoneInfo
import crm_auth
import crm_billing
import crm_tat
import crm_customer_ledger as customer_ledger

COOKIE='ispcrm_customer'
def initialize(db):
    db.execute('''CREATE TABLE IF NOT EXISTS customer_portal_accounts(customer_id BIGINT PRIMARY KEY REFERENCES customers(id),password_hash TEXT NOT NULL,must_change BOOLEAN NOT NULL DEFAULT TRUE,enabled BOOLEAN NOT NULL DEFAULT TRUE)''')
    db.execute('''CREATE TABLE IF NOT EXISTS customer_portal_sessions(token_hash TEXT PRIMARY KEY,customer_id BIGINT NOT NULL REFERENCES customer_portal_accounts(customer_id),csrf TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL)''')
    db.execute('''CREATE TABLE IF NOT EXISTS customer_notifications(id BIGSERIAL PRIMARY KEY,customer_id BIGINT NOT NULL REFERENCES customers(id),title TEXT NOT NULL,body TEXT NOT NULL,event_key TEXT NOT NULL,read_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(customer_id,event_key))''')

def cookie(value,expires=False,secure=False):
    return f'{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict'+('; Max-Age=0' if expires else '; Max-Age=28800')+('; Secure' if secure else '')

def session(db,headers):
    jar=SimpleCookie()
    try:jar.load(headers.get('Cookie',''))
    except Exception:return None
    value=jar.get(COOKIE)
    if not value:return None
    return db.execute('''SELECT s.*,a.must_change FROM customer_portal_sessions s JOIN customer_portal_accounts a USING(customer_id) WHERE s.token_hash=%s AND s.expires_at>CURRENT_TIMESTAMP AND a.enabled''',(hashlib.sha256(value.value.encode()).hexdigest(),)).fetchone()

def provision(db,cid):
    if type(cid) is not int or not db.execute('SELECT id FROM customers WHERE id=%s FOR UPDATE',(cid,)).fetchone():raise ValueError('Select a valid customer.')
    password=secrets.token_urlsafe(12)
    db.execute('INSERT INTO customer_portal_accounts(customer_id,password_hash) VALUES (%s,%s) ON CONFLICT(customer_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,must_change=TRUE,enabled=TRUE',(cid,crm_auth.hash_password(password)))
    db.execute('DELETE FROM customer_portal_sessions WHERE customer_id=%s',(cid,))
    return password

def notify(db,cid,title,body,key):
    db.execute('INSERT INTO customer_notifications(customer_id,title,body,event_key) VALUES (%s,%s,%s,%s) ON CONFLICT(customer_id,event_key) DO NOTHING',(cid,title,body,key))

def refresh_notifications(db,customer):
    cid=customer['id'];today=datetime.now(ZoneInfo('Asia/Karachi')).date()
    for bill in db.execute('SELECT id,invoice_number,amount,billing_month FROM invoices WHERE customer_id=%s',(cid,)):
        notify(db,cid,'Monthly bill available',f"{bill['invoice_number']}: monthly charge PKR {bill['amount']:,.2f} for {bill['billing_month']}. Check Bills for your full balance.",'invoice:'+str(bill['id']))
    for payment in db.execute('SELECT receipt_number,amount,payment_record_id FROM payment_receipts WHERE customer_id=%s',(cid,)):
        notify(db,cid,'Payment received',f"PKR {payment['amount']:,.2f} received. Receipt {payment['receipt_number']}.",'receipt:'+str(payment['payment_record_id']))
    for ticket in db.execute('SELECT id,subject,status,updated_at FROM tickets WHERE customer_id=%s',(cid,)):
        notify(db,cid,'Support ticket update',f"TKT-{ticket['id']}: {ticket['subject']} ? {ticket['status']}.",'ticket:'+str(ticket['id'])+':'+ticket['updated_at'].isoformat())
    for service in customer_ledger.charges(db,cid):
        notify(db,cid,'Additional service charge',f"{service['description']}: PKR {service['amount']:,.2f}, service date {service['service_date'].isoformat()}. Included in that month's invoice.",'service:'+str(service['id']))
    remaining=(customer['expiry_date']-today).days
    if remaining<=3 and customer['status']!='Terminated':
        notify(db,cid,'Connection expired' if remaining<0 else 'Expiry reminder','Your connection expiry date is '+customer['expiry_date'].isoformat()+'. Check your balance before recharging.','expiry:'+customer['expiry_date'].isoformat()+('past' if remaining<0 else 'soon'))

def dashboard(db,cid):
    customer=db.execute('SELECT id,name,username,payment_id,package,monthly_fee,status,expiry_date FROM customers WHERE id=%s',(cid,)).fetchone()
    refresh_notifications(db,customer)
    invoices=list(db.execute('SELECT id,invoice_number,billing_month,amount,issue_date,due_date FROM invoices WHERE customer_id=%s ORDER BY billing_month DESC',(cid,)))
    for bill in invoices:
        previous=crm_billing.previous_balance(db,cid,bill['billing_month'])
        paid=db.execute("SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE customer_id=%s AND billing_month=%s AND revenue_type='MRC'",(cid,bill['billing_month'])).fetchone()['n']
        services=customer_ledger.invoice_services(db,cid,bill['billing_month']);previous+=services['previous'];paid+=services['paid']
        bill.update(services=services['items'],service_amount=services['amount'],previous_balance=previous,total=bill['amount']+services['amount']+previous,paid=paid,due=max(0,bill['amount']+services['amount']+previous-paid))
    receipts=list(db.execute('SELECT receipt_number,amount,payment_date,billing_month,method,revenue_type,otc_type FROM payment_receipts WHERE customer_id=%s ORDER BY payment_date DESC,payment_record_id DESC',(cid,)))
    tickets=list(db.execute('SELECT id,subject,type,status,created_at,due_at FROM tickets WHERE customer_id=%s ORDER BY id DESC',(cid,)))
    notifications=list(db.execute('SELECT id,title,body,read_at,created_at FROM customer_notifications WHERE customer_id=%s ORDER BY id DESC LIMIT 100',(cid,)))
    month=datetime.now(ZoneInfo('Asia/Karachi')).strftime('%Y-%m')
    charge=db.execute('SELECT amount FROM invoices WHERE customer_id=%s AND billing_month=%s',(cid,month)).fetchone()
    fee=charge['amount'] if charge else 0 if customer['status']=='Terminated' else customer['monthly_fee']
    paid=db.execute("SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE customer_id=%s AND billing_month=%s AND revenue_type='MRC'",(cid,month)).fetchone()['n']
    services=customer_ledger.invoice_services(db,cid,month)
    due=max(0,fee+crm_billing.previous_balance(db,cid,month)-paid)+services['previous']+services['amount']-services['paid']
    return dict(customer=customer,invoices=invoices,receipts=receipts,tickets=tickets,notifications=notifications,current_due=due,billing_month=month)
