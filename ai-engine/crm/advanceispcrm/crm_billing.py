"""Monthly subscription invoices and live arrears without double-counting carry-forward."""
from decimal import Decimal


def previous_balance(db, customer_id, month):
    charges=db.execute('SELECT COALESCE(SUM(amount),0) AS total FROM invoices WHERE customer_id=%s AND billing_month<%s',(customer_id,month)).fetchone()['total']
    paid=db.execute('''SELECT COALESCE(SUM(p.amount),0) AS total FROM payments p
        WHERE p.revenue_type='MRC' AND p.customer_id=%s AND p.billing_month<%s AND EXISTS
        (SELECT 1 FROM invoices i WHERE i.customer_id=p.customer_id AND i.billing_month=p.billing_month)''',(customer_id,month)).fetchone()['total']
    return max(Decimal(0),charges-paid)


def ensure_invoice(db, customer, month, today):
    # Callers serialize on the customer row; subscription snapshots remain immutable.
    if customer['status']=='Terminated':
        existing=db.execute('SELECT * FROM invoices WHERE customer_id=%s AND billing_month=%s',(customer['id'],month)).fetchone()
        if existing:
            return existing
        raise ValueError('New subscription bills cannot be raised for a terminated account.')
    prior=previous_balance(db,customer['id'],month)
    db.execute('''INSERT INTO invoices(customer_id,billing_month,invoice_number,customer_name,username,phone,address,
        package_name,amount,issue_date,due_date,payment_id,previous_balance)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT(customer_id,billing_month) DO NOTHING''',
        (customer['id'],month,f'INV-{month.replace("-","")}-{customer["id"]:05d}',customer['name'],customer['username'],
         customer['phone'],customer['address'],customer['package'],customer['monthly_fee'],today,customer['expiry_date'],customer['payment_id'],prior))
    return db.execute('SELECT * FROM invoices WHERE customer_id=%s AND billing_month=%s',(customer['id'],month)).fetchone()


def generate_monthly_invoices(db, today=None):
    """Bill active subscriptions for this month; never invent historical arrears."""
    if today is None:
        from datetime import datetime
        from zoneinfo import ZoneInfo
        today=datetime.now(ZoneInfo('Asia/Karachi')).date()
    month=today.strftime('%Y-%m')
    for customer in db.execute("SELECT * FROM customers WHERE status='Active' AND joined<=%s AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id=customers.id AND i.billing_month=%s) ORDER BY id FOR UPDATE",(today,month)).fetchall():
        ensure_invoice(db,customer,month,today)


def monthly_invoices(db):
    rows=list(db.execute("SELECT i.*,c.payment_id AS customer_payment_id,COALESCE(p.paid,0) AS paid FROM invoices i JOIN customers c ON c.id=i.customer_id LEFT JOIN (SELECT customer_id,billing_month,SUM(amount) AS paid FROM payments WHERE revenue_type='MRC' GROUP BY customer_id,billing_month) p ON p.customer_id=i.customer_id AND p.billing_month=i.billing_month ORDER BY i.billing_month DESC,i.id DESC"))
    from crm_customer_ledger import invoice_services
    for row in rows:
        services=invoice_services(db,row['customer_id'],row['billing_month'])
        row['service_amount']=services['amount']
        row['previous_balance']=previous_balance(db,row['customer_id'],row['billing_month'])+services['previous']
        row['total']=row['amount']+row['service_amount']+row['previous_balance']
        row['paid']+=services['paid']
        row['remaining']=max(Decimal(0),row['total']-row['paid'])
    return rows
