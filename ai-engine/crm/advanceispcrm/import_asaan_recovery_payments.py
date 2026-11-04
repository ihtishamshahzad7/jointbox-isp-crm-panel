"""One-time import of payments exported from Asaan Recovery (imports/asaan_recovery_collections.json).
Run after import_asaan_recovery.py, which imported the customers.

python import_asaan_recovery_payments.py           dry run: validates everything, then rolls back
python import_asaan_recovery_payments.py --commit  saves the payments

Payments are stored as MRC receipts for the billing month Asaan Recovery recorded, so they settle the October
invoices the CRM already raised. They are inserted directly rather than through the recharge flow, because
customer expiry dates were already set from these same payments. Rs 0 POS-sale rows are skipped.
"""
import json
import sys
import uuid
from datetime import datetime

from crm_data import connect_database, record_fields, column_name
from ispcrm import validate, ROOT

SOURCE = ROOT / 'imports' / 'asaan_recovery_collections.json'
# Asaan Recovery's "online" payments went to an "Unassigned Bank"; the CRM's wallet methods (Easypaisa, JazzCash,
# 1LINK) are reserved for verified gateway receipts, so these are recorded as bank transfers.
METHODS = {'cash': 'Cash', 'online': 'Bank transfer'}
REFERENCE_PREFIX = 'Asaan Recovery'


def main(commit):
    rows = [r for r in json.loads(SOURCE.read_text(encoding='utf-8-sig'))['items'] if r['amountPaid'] > 0]
    columns = [column_name(label) for label, _ in record_fields('Payments')] + ['request_key']
    with connect_database() as db:
        if db.execute('SELECT 1 FROM payments WHERE reference LIKE %s LIMIT 1', (REFERENCE_PREFIX + '%',)).fetchone():
            raise SystemExit('Asaan Recovery payments were already imported. Nothing changed.')
        customers = {r['username']: r['id'] for r in db.execute('SELECT id,username FROM customers')}
        missing = sorted({r['internetId'] for r in rows} - set(customers))
        if missing:
            raise SystemExit('Customers not found in the CRM: ' + ', '.join(missing))
        for index, r in enumerate(rows):
            note = r['comments'] or 'Payment'
            fields = dict(revenue_type='MRC', otc_type='Other', customer_id=customers[r['internetId']], amount=r['amountPaid'],
                          payment_date=r['paidDate'][:10], billing_month=datetime.strptime(r['monthLabel'], '%b %Y').strftime('%Y-%m'),
                          method=METHODS[r['paymentType']], reference=f"{REFERENCE_PREFIX}: {note}, collected by {r['collectedBy']}")
            values = validate('Payments', fields)
            # A stable key per source row makes an accidental re-run fail instead of duplicating receipts.
            key = str(uuid.uuid5(uuid.NAMESPACE_URL, f"asaan-recovery:{index}:{r['internetId']}:{r['paidDate']}:{r['monthLabel']}:{r['amountPaid']}"))
            db.execute(f'INSERT INTO payments ({", ".join(columns)}) VALUES ({", ".join("%s" for _ in columns)})', values + [key])

        total = db.execute('SELECT count(*) n, sum(amount) s FROM payments WHERE reference LIKE %s', (REFERENCE_PREFIX + '%',)).fetchone()
        print(f"Payments: {total['n']}, Rs {total['s']:,.0f}")
        for m in db.execute('''SELECT billing_month, count(*) n, sum(amount) s FROM payments WHERE reference LIKE %s
                GROUP BY billing_month ORDER BY billing_month''', (REFERENCE_PREFIX + '%',)):
            print(f"  {m['billing_month']}: {m['n']} payments, Rs {m['s']:,.0f}")
        unpaid = db.execute('''SELECT c.name, c.username, i.amount FROM invoices i JOIN customers c ON c.id=i.customer_id
                WHERE i.billing_month='2026-10' AND i.amount > (SELECT COALESCE(SUM(amount),0) FROM payments p
                WHERE p.customer_id=i.customer_id AND p.billing_month='2026-10' AND p.revenue_type='MRC') ORDER BY c.name''').fetchall()
        print(f'October bills still unpaid: {len(unpaid)}' + ''.join(f"\n  {u['name']} ({u['username']}) Rs {u['amount']:,.0f}" for u in unpaid))
        if commit:
            db.commit()
            print('Saved.')
        else:
            db.rollback()
            print('Dry run only; nothing saved. Re-run with --commit to save.')


if __name__ == '__main__':
    main('--commit' in sys.argv)
