"""Add expired demo accounts and unpaid monthly invoices for billing tests.

Run: python seed_billing_demo.py
Existing demo accounts are preserved, including any recharge tests already completed.
"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from crm_data import connect_database, initialize_database
from seed_demo import add_if_missing


def seed():
    initialize_database()
    today = datetime.now(ZoneInfo('Asia/Karachi')).date()
    month = today.strftime('%Y-%m')
    added_customers = added_invoices = 0
    results = []
    with connect_database() as db:
        db.execute('SELECT pg_advisory_xact_lock(73912402)')
        packages = []
        for speed, fee in ((10,1000),(20,1500),(30,2000)):
            package, _ = add_if_missing(db,'packages','name',dict(
                name=f'[DEMO BILLING] Test {speed} Mbps',speed_mbps=speed,
                monthly_price=fee,monthly_cost=0,installation_fee=0,status='Active'))
            packages.append(package)
        scenarios = [
            ('Cash recharge',1,'Suspended'),
            ('Card recharge',3,'Suspended'),
            ('Partial payment',7,'Suspended'),
            ('Receipt testing',15,'Suspended'),
            ('Disconnected account',30,'Disconnected'),
            ('Long overdue',45,'Disconnected'),
        ]
        for index,(scenario,days,status) in enumerate(scenarios,1):
            package = packages[(index-1)%len(packages)]
            expiry = today-timedelta(days=days)
            customer, inserted = add_if_missing(db,'customers','username',dict(
                name='[DEMO BILLING] '+scenario,username=f'demo.billing.expired{index:02}',
                phone='DEMO-NOT-A-REAL-NUMBER',address='Demo billing test account - no real address',
                email=f'expired{index:02}@example.test',customer_type='Residential',
                package=package['name'],package_id=package['id'],monthly_fee=package['monthly_price'],
                status=status,joined=expiry-timedelta(days=30),expiry_date=expiry))
            added_customers += int(inserted)
            invoice = db.execute('''INSERT INTO invoices(customer_id,billing_month,invoice_number,customer_name,username,phone,address,
                package_name,amount,issue_date,due_date,payment_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT(customer_id,billing_month) DO NOTHING''',
                (customer['id'],month,f'INV-{month.replace("-","")}-{customer["id"]:05d}',customer['name'],
                 customer['username'],customer['phone'],customer['address'],customer['package'],customer['monthly_fee'],
                 today,customer['expiry_date'],customer['payment_id']))
            added_invoices += invoice.rowcount
            results.append((customer['username'],customer['payment_id'],customer['status'],customer['expiry_date'],customer['monthly_fee']))
        # Verify only these demo accounts have been prepared; no payments are seeded.
        for username,payment_id,status,expiry,fee in results:
            row = db.execute('''SELECT COUNT(*) AS total FROM invoices i JOIN customers c ON c.id=i.customer_id
                WHERE c.username=%s AND i.billing_month=%s''',(username,month)).fetchone()
            if row['total'] != 1:
                raise ValueError('Demo invoice verification failed; rolling back.')
    print(f'Added {added_customers} demo customers and {added_invoices} monthly invoices. Existing records preserved.')
    for username,payment_id,status,expiry,fee in results:
        print(f'{username} | Customer payment ID {payment_id} | {status} | Expired {expiry} | Rs {fee:,.2f}')
    print('Search Customers for DEMO BILLING. New accounts have no payments; use Recharge to test cash/card, partial payments and receipts.')


if __name__ == '__main__':
    seed()
