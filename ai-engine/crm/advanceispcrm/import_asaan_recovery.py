"""One-time import of customers exported from Asaan Recovery (imports/asaan_recovery_customers.json).

python import_asaan_recovery.py           dry run: validates everything, then rolls back
python import_asaan_recovery.py --commit  saves the company, areas, packages and customers

Uses the CRM's own validation. Asaan Recovery holds no installation coordinates, so customers are
imported without a map pin (the new-customer form would require one); add pins later from each profile.
CNICs that are not 13 digits are left blank. Box names and PPPoE passwords have no CRM field and stay in the export.

Most exported customers lack install/recharge dates. Joined uses the install, recharge or last payment date, else the
import date. Expiry is 30 days after the latest recharge or payment (balances were all zero), else 30 days after
the import date, so no customer starts already expired (which would open recovery tickets).
"""
import json
import re
import sys
import uuid
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import crm_operations as operations
from crm_data import connect_database, initialize_database, record_fields, column_name
from ispcrm import validate

SOURCE = Path(__file__).parent / 'imports' / 'asaan_recovery_customers.json'
# Required by the package form; Asaan Recovery has no provider or cost, so correct these in Admin > Packages.
PACKAGE_PROVIDER = 'Transworld Panel'
PACKAGE_COST = '0'


def ops_save(db, user, module, fields):
    return operations.save(db, user, dict(module=module, request_key=str(uuid.uuid4()), fields=fields))


def main(commit):
    rows = json.loads(SOURCE.read_text(encoding='utf-8-sig'))['data']
    initialize_database()
    with connect_database() as db:
        user = db.execute("SELECT * FROM app_users WHERE role='Administrator' AND status='Active' ORDER BY id LIMIT 1").fetchone()
        if db.execute('SELECT 1 FROM customers WHERE username=ANY(%s) LIMIT 1', ([r['username'] for r in rows],)).fetchone():
            raise SystemExit('Some of these usernames already exist in the CRM; the import was probably run before. Nothing changed.')

        companies = {}
        for name in sorted({r['companyName'] for r in rows if r['companyName']}):
            companies[name] = ops_save(db, user, 'Companies', dict(name=name, status='Active'))['id']
        for name in sorted({r['areaName'] for r in rows if r['areaName']}):
            company = next(r['companyName'] for r in rows if r['areaName'] == name)
            ops_save(db, user, 'Areas', dict(name=name, company=companies.get(company), status='Active'))

        packages = {}
        for name in sorted({r['packageName'] for r in rows}):
            price = next(r['packageAmount'] for r in rows if r['packageName'] == name)
            fields = dict(name=name, service_provider=PACKAGE_PROVIDER, speed_mbps=re.match(r'\s*(\d+)', name).group(1),
                          monthly_price=price, monthly_cost=PACKAGE_COST, installation_fee='0', status='Active')
            values = validate('Packages', fields)
            columns = [column_name(label) for label, _ in record_fields('Packages')]
            packages[name] = db.execute(f'INSERT INTO packages ({", ".join(columns)}) VALUES ({", ".join("%s" for _ in values)}) RETURNING id', values).fetchone()['id']

        columns = [column_name(label) for label, _ in record_fields('Customers')] + ['package_id']
        blank_cnic = []
        date_sources = {}
        for r in rows:
            cnic = (r['cnic'] or '').strip()
            if cnic and not re.fullmatch(r'[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]', cnic):
                blank_cnic.append(f"{r['clientName']} ({cnic})")
                cnic = ''
            day = lambda k: date.fromisoformat(r[k][:10]) if r[k] else None
            joined = day('installDate') or day('rechargeDate') or day('lastPaymentDate') or date.today()
            renewed = max(filter(None, (day('rechargeDate'), day('lastPaymentDate'))), default=None)
            source = 'recharge/payment date' if renewed else 'import date'
            date_sources[source] = date_sources.get(source, 0) + 1
            renewed = max(renewed or date.today(), joined)
            fields = dict(name=r['clientName'].strip(), customer_type='Residential', cnic=cnic, phone=r['cell1'].strip(),
                          address=(r['address'] or '').strip(), area=r['areaName'] or '', latitude=r['latitude'], longitude=r['longitude'],
                          username=r['username'].strip(), package=r['packageName'], monthly_fee=r['packageAmount'],
                          installation_charge=r['installAmount'] or '0', status='Active' if r['status'] == 'Active' else 'Suspended',
                          joined=str(joined), expiry_date=str(renewed + timedelta(days=30)), promise_date=None)
            fields['area'] = operations.validate_customer_area(db, fields['area'])
            fields['city'] = operations.customer_city(db, '', fields['area'])
            values = validate('Customers', fields)
            db.execute(f'INSERT INTO customers ({", ".join(columns)}) VALUES ({", ".join("%s" for _ in columns)})', values + [packages[r['packageName']]])

        total = db.execute('SELECT count(*) AS n, sum(monthly_fee) AS fees FROM customers WHERE username=ANY(%s)', ([r['username'] for r in rows],)).fetchone()
        print(f"Company: {len(companies)}, areas: {len({r['areaName'] for r in rows})}, packages: {len(packages)}, customers: {total['n']} (monthly fees Rs {total['fees']:,.0f})")
        print('Expiry based on:', ', '.join(f'{k}: {v}' for k, v in date_sources.items()))
        span = db.execute('SELECT min(joined) j1, max(joined) j2, min(expiry_date) e1, max(expiry_date) e2 FROM customers WHERE username=ANY(%s)', ([r['username'] for r in rows],)).fetchone()
        print(f"Joined {span['j1']} .. {span['j2']}; expiry {span['e1']} .. {span['e2']}")
        if blank_cnic:
            print('CNIC left blank (not 13 digits):', '; '.join(blank_cnic))
        if commit:
            db.commit()
            print('Saved.')
        else:
            db.rollback()
            print('Dry run only; nothing saved. Re-run with --commit to save.')


if __name__ == '__main__':
    main('--commit' in sys.argv)
