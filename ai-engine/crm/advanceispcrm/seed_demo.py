"""Add clearly marked demo records without replacing existing CRM data.

Run: python seed_demo.py
Re-running skips existing demo records and adds receipts for the current month.
"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from psycopg import sql

from crm_data import connect_database, initialize_database


def add_if_missing(db, table, marker, fields):
    alias_table=db.execute("SELECT to_regclass('sample_seed_aliases') AS existing").fetchone()['existing']
    if alias_table:
        alias=db.execute('SELECT record_id FROM sample_seed_aliases WHERE table_name=%s AND marker=%s AND original_key=%s',(table,marker,str(fields[marker]))).fetchone()
        if alias:
            existing=db.execute(sql.SQL('SELECT * FROM {} WHERE id=%s').format(sql.Identifier(table)),(alias['record_id'],)).fetchone()
            if existing:return existing,False
    existing = db.execute(
        sql.SQL('SELECT * FROM {} WHERE {}=%s ORDER BY id LIMIT 1').format(
            sql.Identifier(table), sql.Identifier(marker)), (fields[marker],)
    ).fetchone()
    if existing:
        return existing, False
    record = db.execute(
        sql.SQL('INSERT INTO {} ({}) VALUES ({}) RETURNING *').format(
            sql.Identifier(table),
            sql.SQL(', ').join(map(sql.Identifier, fields)),
            sql.SQL(', ').join(sql.Placeholder() for _ in fields)),
        list(fields.values()),
    ).fetchone()
    return record, True


def seed():
    initialize_database()
    today = datetime.now(ZoneInfo('Asia/Karachi')).date()
    month = today.strftime('%Y-%m')
    added = {table: 0 for table in ('packages', 'customers', 'staff', 'inventory', 'jobs', 'payments')}
    with connect_database() as db:
        # Avoid creating duplicates if two copies of this script run at once.
        db.execute('SELECT pg_advisory_xact_lock(73912401)')

        def add(table, marker, **fields):
            record, inserted = add_if_missing(db, table, marker, fields)
            added[table] += int(inserted)
            return record

        packages = []
        for speed, price in [(10, 1500), (20, 2500), (30, 3500), (50, 5000)]:
            packages.append(add('packages', 'name', name=f'[DEMO] Home {speed} Mbps',
                                speed_mbps=speed, monthly_price=price, monthly_cost=0,
                                installation_fee=2000, status='Active'))

        names = ['Ali Hassan', 'Sara Ahmed', 'Usman Khan', 'Ayesha Malik',
                 'Bilal Raza', 'Fatima Noor', 'Hamza Iqbal', 'Maryam Shah',
                 'Ahmed Saeed', 'Zainab Aslam', 'Omar Farooq', 'Hina Tariq',
                 'Fahad Saleem', 'Sana Javed', 'Danish Ali', 'Iqra Hassan',
                 'Haris Abbas', 'Nadia Imran', 'Saad Akram', 'Amna Khalid']
        customers = []
        areas = ['Model Town', 'Gulberg', 'Johar Town', 'Garden Town']
        for index, name in enumerate(names):
            package = packages[index % len(packages)]
            customers.append(add('customers', 'username',
                name=f'[DEMO] {name}', phone='DEMO-NOT-A-REAL-NUMBER',
                address=f'Demo House {index + 1}, {areas[index % len(areas)]}',
                username=f'demo.user{index + 1:02}', package=package['name'],
                package_id=package['id'], monthly_fee=package['monthly_price'],
                status='Active' if index < 16 else 'Suspended' if index < 19 else 'Disconnected',
                expiry_date=today - timedelta(days=15 + index * 8) + timedelta(days=30),
                joined=today - timedelta(days=15 + index * 8)))

        staff = []
        for name, role, status, area in [
            ('Technician A', 'Technician', 'Available', 'Model Town'),
            ('Technician B', 'Technician', 'On duty', 'Gulberg'),
            ('Support A', 'Support', 'Available', 'Office'),
            ('Collector A', 'Collector', 'Available', 'Johar Town'),
            ('Technician C', 'Technician', 'On leave', 'Garden Town'),
        ]:
            staff.append(add('staff', 'name', name=f'[DEMO] {name}',
                             phone='DEMO-NOT-A-REAL-NUMBER', role=role, area=area, status=status))

        for item, category, quantity, minimum, cost in [
            ('Dual-band ONT', 'ONT', 18, 5, 4500),
            ('8-port OLT', 'OLT', 2, 1, 85000),
            ('2-core fiber (meters)', 'Fiber - 2 Core', 2500, 500, 18),
            ('4-core fiber (meters)', 'Fiber - 4 Core', 300, 500, 28),
            ('1:8 PLC splitter', 'Splitter - 1:8', 4, 5, 850),
            ('1:16 PLC splitter', 'Splitter - 1:16', 12, 5, 1400),
            ('Outdoor joint closure', 'Fiber Joint Closure', 2, 3, 1800),
            ('SC/APC patch cord', 'Fiber Patch Cord', 40, 10, 250),
            ('Wi-Fi router', 'Router', 10, 3, 3500),
            ('Optical power meter', 'Optical Power Meter', 3, 1, 6500),
        ]:
            # Demo stock uses its own categories if a built-in was renamed or disabled.
            category_row = db.execute('SELECT status FROM categories WHERE name=%s', (category,)).fetchone()
            if not category_row or category_row['status'] != 'Active':
                category = '[DEMO] ' + category
                db.execute("INSERT INTO categories (name,status) VALUES (%s,'Active') ON CONFLICT (name) DO NOTHING", (category,))
            add('inventory', 'item', item='[DEMO] ' + item, category=category,
                quantity=quantity, minimum_stock=minimum, unit_cost=cost, location='Demo warehouse')

        jobs = [
            ('New fiber installation', 'Installation', 'Open', 0, 0, 1),
            ('Slow speed complaint', 'Complaint', 'In progress', 1, 1, 0),
            ('ONT replacement', 'Maintenance', 'Open', 2, 0, 2),
            ('Monthly payment collection', 'Collection', 'Open', 3, 3, 1),
            ('Fiber joint repair', 'Maintenance', 'In progress', 4, 1, -1),
            ('Connection activated', 'Installation', 'Completed', 5, 0, -3),
            ('Wi-Fi issue resolved', 'Complaint', 'Completed', 6, 2, -2),
            ('Payment collected', 'Collection', 'Completed', 7, 3, -1),
        ]
        for title, kind, status, customer, worker, offset in jobs:
            add('jobs', 'title', title='[DEMO] ' + title,
                customer_id=customers[customer]['id'], staff_id=staff[worker]['id'],
                type=kind, status=status, due_date=today + timedelta(days=offset),
                notes='Sample task for dashboard preview; no real customer work.')

        for index, customer in enumerate(customers[:15]):
            add('payments', 'reference', customer_id=customer['id'],
                amount=customer['monthly_fee'], payment_date=today.replace(day=1 + index % today.day),
                billing_month=month, method=['Cash', 'Bank transfer', 'Mobile wallet'][index % 3],
                reference=f'DEMO-{month}-user{index + 1:02}')
        from crm_jobs_migration import migrate_jobs
        migrate_jobs(db)
    return added


if __name__ == '__main__':
    for section, count in seed().items():
        print(f'{section}: {count} demo records added')
    print('Refresh http://localhost:3000 to see the dashboard. Demo records are labeled [DEMO] or DEMO-.')
