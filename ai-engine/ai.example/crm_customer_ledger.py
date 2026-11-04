"""Customer service charges, allocations and dated account ledger."""
from decimal import Decimal,InvalidOperation
from datetime import date
from uuid import UUID

def initialize(db):
    db.execute('''CREATE TABLE IF NOT EXISTS customer_service_charges(id BIGSERIAL PRIMARY KEY,customer_id BIGINT NOT NULL REFERENCES customers(id),description TEXT NOT NULL,service_date DATE NOT NULL,amount NUMERIC(15,2) NOT NULL CHECK(amount>0),created_by TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
    db.execute("ALTER TABLE customer_service_charges ADD COLUMN IF NOT EXISTS charge_type TEXT NOT NULL DEFAULT 'Service'")
    db.execute('ALTER TABLE customer_service_charges ADD COLUMN IF NOT EXISTS stock_issue_id BIGINT UNIQUE REFERENCES stock_issues(id)')
    db.execute('ALTER TABLE payments ADD COLUMN IF NOT EXISTS service_charge_id BIGINT REFERENCES customer_service_charges(id)')

def add_charge(db,payload,user):
    cid=payload.get('customer_id');description=str(payload.get('description','')).strip()
    if type(cid) is not int or not description or len(description)>300:raise ValueError('Select customer and describe the service (up to 300 characters).')
    day=date.fromisoformat(str(payload.get('service_date','')))
    try:amount=Decimal(str(payload.get('amount')))
    except InvalidOperation:raise ValueError('Enter a valid service amount.')
    if not amount.is_finite() or amount<=0 or amount>1_000_000_000 or amount!=amount.quantize(Decimal('.01')):raise ValueError('Service amount must be positive, with at most two decimal places.')
    key=str(UUID(str(payload.get('request_key',''))))
    customer=db.execute('SELECT status FROM customers WHERE id=%s FOR UPDATE',(cid,)).fetchone()
    if not customer:raise ValueError('Customer not found.')
    prior=db.execute('SELECT * FROM customer_service_charges WHERE request_key=%s',(key,)).fetchone()
    if prior:
        if prior['customer_id']!=cid or prior['description']!=description or prior['amount']!=amount or prior['service_date']!=day:raise ValueError('Request key already used with different service details.')
        return prior
    return db.execute('INSERT INTO customer_service_charges(customer_id,description,service_date,amount,created_by,request_key) VALUES (%s,%s,%s,%s,%s,%s) RETURNING *',(cid,description,day,amount,user['name'],key)).fetchone()

def charges(db,cid):
    return list(db.execute('''SELECT s.*,COALESCE(p.paid,0) AS paid,s.amount-COALESCE(p.paid,0) AS due FROM customer_service_charges s LEFT JOIN (SELECT service_charge_id,SUM(amount) AS paid FROM payments GROUP BY service_charge_id) p ON p.service_charge_id=s.id WHERE s.customer_id=%s ORDER BY s.service_date,s.id''',(cid,)))

def invoice_services(db,cid,month):
    rows=charges(db,cid);current=[s for s in rows if s['service_date'].strftime('%Y-%m')==month]
    return dict(items=current,amount=sum((s['amount'] for s in current),Decimal(0)),paid=sum((s['paid'] for s in current),Decimal(0)),previous=sum((s['due'] for s in rows if s['service_date'].strftime('%Y-%m')<month),Decimal(0)))

def ledger(db,customer):
    cid=customer['id'];entries=[]
    for i in db.execute('SELECT * FROM invoices WHERE customer_id=%s',(cid,)):
        entries.append(dict(date=i['issue_date'],reference=i['invoice_number'],description='Monthly subscription '+i['billing_month'],debit=i['amount'],credit=Decimal(0)))
    for s in charges(db,cid):entries.append(dict(date=s['service_date'],reference='SVC-'+str(s['id']),description=s['description'],debit=s['amount'],credit=Decimal(0)))
    if customer['installation_charge']:
        entries.append(dict(date=customer['joined'],reference='Installation',description='Agreed installation charge',debit=customer['installation_charge'],credit=Decimal(0)))
    for p in db.execute('SELECT * FROM payments WHERE customer_id=%s',(cid,)):
        if p['revenue_type']=='OTC' and p['otc_type']!='Installation' and not p['service_charge_id']:
            entries.append(dict(date=p['payment_date'],reference='OTC-'+str(p['id']),description=p['reference'] or p['otc_type']+' cash sale',debit=p['amount'],credit=Decimal(0)))
        entries.append(dict(date=p['payment_date'],reference='RCP-'+str(p['id']),description=p['revenue_type']+' payment · '+p['method'],debit=Decimal(0),credit=p['amount']))
    entries.sort(key=lambda e:(e['date'],bool(e['credit']),e['reference']))
    balance=Decimal(0)
    for entry in entries:
        balance+=entry['debit']-entry['credit'];entry['balance']=balance
    return dict(entries=entries,debits=sum((e['debit'] for e in entries),Decimal(0)),credits=sum((e['credit'] for e in entries),Decimal(0)),balance=balance)

def account_balances(db):
    rows=db.execute("""SELECT c.id,c.installation_charge+COALESCE(i.total,0)+COALESCE(s.total,0)-COALESCE(p.total,0)+COALESCE(p.cash_sales,0) AS balance
        FROM customers c
        LEFT JOIN (SELECT customer_id,SUM(amount) AS total FROM invoices GROUP BY customer_id) i ON i.customer_id=c.id
        LEFT JOIN (SELECT customer_id,SUM(amount) AS total FROM customer_service_charges GROUP BY customer_id) s ON s.customer_id=c.id
        LEFT JOIN (SELECT customer_id,SUM(amount) AS total,SUM(CASE WHEN revenue_type='OTC' AND otc_type!='Installation' AND service_charge_id IS NULL THEN amount ELSE 0 END) AS cash_sales FROM payments GROUP BY customer_id) p ON p.customer_id=c.id""")
    return {row['id']:row['balance'] for row in rows}


def bill_stock_issue(db,issue_id,issue,stock,user,customer,today):
    # Waived-off items are free, so they create no customer charge.
    if issue['issued_against']!='Customer' or not issue['unit_selling_price']:return
    amount=issue['unit_selling_price']*issue['quantity']
    discount=f" ({issue['discount_percent'].normalize():f}% off PKR {issue['list_price']:,.2f})" if issue.get('discount_percent') else ''
    description=f"{stock['item']} x {issue['quantity']} @ PKR {issue['unit_selling_price']:,.2f}{discount} (ISS-{issue_id})"
    db.execute("""INSERT INTO customer_service_charges(customer_id,description,service_date,amount,created_by,request_key,charge_type,stock_issue_id)
        VALUES (%s,%s,%s,%s,%s,%s,'Equipment',%s) ON CONFLICT(stock_issue_id) DO NOTHING""",(issue['customer_id'],description,issue['issue_date'],amount,user['name'],'stock-issue:'+str(issue_id),issue_id))
    from crm_billing import ensure_invoice
    ensure_invoice(db,customer,str(issue['issue_date'])[:7],today)
