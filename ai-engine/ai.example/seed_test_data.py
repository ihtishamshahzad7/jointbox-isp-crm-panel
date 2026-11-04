"""Fill the CRM with removable [TEST] records across every section.

Run: python seed_test_data.py
Remove everything again with: python remove_test_data.py

Every row created here is recorded in test_data_records, so removal deletes
exactly these rows (and anything later attached to them) and nothing else.
"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import uuid

import crm_auth
import crm_customer_portal
import crm_data
import crm_operations as ops
import crm_recharge
import crm_tat
import ispcrm

PASSWORD = 'Test@12345'
TAG = '[TEST] '


def seed():
    crm_data.initialize_database()
    now = datetime.now(ZoneInfo('Asia/Karachi'))
    today = now.date()
    month = today.strftime('%Y-%m')
    summary = {}
    with crm_data.connect_database() as db:
        db.execute('SELECT pg_advisory_xact_lock(73912499)')
        db.execute('CREATE TABLE IF NOT EXISTS test_data_records(table_name TEXT NOT NULL, record_id BIGINT NOT NULL, PRIMARY KEY(table_name, record_id))')
        if db.execute('SELECT 1 FROM test_data_records LIMIT 1').fetchone():
            raise SystemExit('Test data is already loaded. Run python remove_test_data.py first to reload it.')
        admin = db.execute("SELECT * FROM app_users WHERE role='Administrator' AND status='Active' ORDER BY id LIMIT 1").fetchone()
        if not admin:
            raise SystemExit('Create the administrator account first (open the CRM once).')
        user = dict(id=admin['id'], name=admin['name'], role='Administrator', staff_id=None)

        def track(table, rid):
            db.execute('INSERT INTO test_data_records VALUES (%s,%s) ON CONFLICT DO NOTHING', (table, rid))
            summary[table] = summary.get(table, 0) + 1
            return rid

        def insert(table, **fields):
            columns = list(fields)
            row = db.execute(f'INSERT INTO {table} ({",".join(columns)}) VALUES ({",".join(["%s"] * len(columns))}) RETURNING *', [fields[c] for c in columns]).fetchone()
            track(table, row['id'])
            return row

        def op(module, **fields):
            row = ops.save(db, user, dict(module=module, fields=fields, request_key=str(uuid.uuid4())))
            track('operations_records', row['id'])
            return row

        # Company structure and network areas (customers must use an active area).
        company = op('Companies', name=TAG + 'Lahore Fiber Net', address='Main Boulevard, Gulberg III, Lahore', phone='042-0000000', email='info@example.com', status='Active')
        branch = op('Branches', name=TAG + 'Gulberg Head Office', code='TST-GLB', company=company['id'], address='Main Boulevard, Gulberg III', status='Active')
        zones = {name: op('Zones', name=TAG + name, branch=branch['id'], description='Test service zone') for name in ('Central Lahore', 'South Lahore')}
        area_centers = {'Gulberg': (31.5204, 74.3487, 'Central Lahore'), 'Model Town': (31.4826, 74.3239, 'Central Lahore'),
                        'Johar Town': (31.4697, 74.2728, 'South Lahore'), 'DHA Phase 5': (31.4626, 74.4085, 'South Lahore')}
        city = op('Cities', name=TAG + 'Lahore', province='Punjab', status='Active')['data']['name']
        for area, (_, _, zone) in area_centers.items():
            op('Areas', name=TAG + area, company=company['id'], city=city, zone=zones[zone]['id'], status='Active', notes='Test coverage area')
        for name in ('Network Operations', 'Customer Care', 'Finance'):
            op('Departments', name=TAG + name, status='Active')

        # Designations, employees and role logins.
        for name in ('Network Engineer', 'Field Technician', 'Customer Support Officer', 'Recovery Officer', 'Accounts Officer', 'Store Keeper'):
            insert('designations', name=TAG + name, status='Active')
        people = [
            ('Imran Siddiqui', 'Manager', 'Network Engineer', 'Network Operations', 'Gulberg', 'On duty', 95000),
            ('Waqas Ahmed', 'Technician', 'Field Technician', 'Network Operations', 'Model Town', 'On duty', 45000),
            ('Naveed Akhtar', 'Technician', 'Field Technician', 'Network Operations', 'Johar Town', 'Available', 42000),
            ('Kamran Javed', 'Technician', 'Field Technician', 'Network Operations', 'DHA Phase 5', 'On leave', 42000),
            ('Sadia Rehman', 'Support', 'Customer Support Officer', 'Customer Care', 'Office', 'Available', 40000),
            ('Usman Ghani', 'Collector', 'Recovery Officer', 'Finance', 'Gulberg', 'Available', 38000),
            ('Mehwish Anwar', 'Other', 'Accounts Officer', 'Finance', 'Office', 'Available', 55000),
            ('Tariq Mehmood', 'Other', 'Store Keeper', 'Network Operations', 'Warehouse', 'Available', 36000),
        ]
        staff = []
        for index, (name, role, designation, department, area, status, salary) in enumerate(people):
            staff.append(insert('staff', name=TAG + name, phone=f'0300-000{1001 + index}', role=role, area=area, status=status,
                                designation=TAG + designation, department=TAG + department, employment_type='Permanent',
                                joining_date=today - timedelta(days=400 - index * 30), monthly_salary=salary, allowances=5000, deductions=1000,
                                email=name.lower().replace(' ', '.') + '@example.com', gender='Not specified',
                                reports_to=None))
        manager = staff[0]
        db.execute('UPDATE staff SET reports_to=%s WHERE id=ANY(%s)', (manager['id'], [s['id'] for s in staff[1:]]))
        logins = [('test.manager', 'Manager', 0), ('test.technician', 'Technician', 1), ('test.support', 'Support', 4), ('test.accountant', 'Accountant', 6), ('test.storekeeper', 'Storekeeper', 7), ('test.viewer', 'Viewer', None)]
        for username, role, person in logins:
            insert('app_users', name=TAG + (staff[person]['name'].replace(TAG, '') if person is not None else 'Read-only Viewer'), username=username,
                   designation=staff[person]['designation'] if person is not None else TAG + 'Viewer', role=role, status='Active',
                   staff_id=staff[person]['id'] if person is not None else None, password_hash=crm_auth.hash_password(PASSWORD))

        # Packages and customers placed around Lahore for the network map.
        packages = [insert('packages', name=f'{TAG}Fiber {speed} Mbps', speed_mbps=speed, monthly_price=price, monthly_cost=round(price * .55),
                           installation_fee=3000, status='Active') for speed, price in ((10, 1800), (20, 2500), (50, 4000), (100, 6500))]
        names = ['Ali Hassan', 'Sara Ahmed', 'Usman Khan', 'Ayesha Malik', 'Bilal Raza', 'Fatima Noor', 'Hamza Iqbal', 'Maryam Shah',
                 'Ahmed Saeed', 'Zainab Aslam', 'Omar Farooq', 'Hina Tariq', 'Fahad Saleem', 'Sana Javed', 'Danish Ali', 'Iqra Hassan',
                 'Haris Abbas', 'Nadia Imran', 'Saad Akram', 'Amna Khalid', 'Raza Corporate Office', 'Noor Pharmacy', 'City Clinic', 'Green Cafe']
        offsets = [(-.006, -.004), (.004, .005), (-.003, .007), (.006, -.006), (.002, -.002), (-.005, .002)]
        customers = []
        for index, name in enumerate(names):
            area = list(area_centers)[index % 4]
            lat, lng, _ = area_centers[area]
            dlat, dlng = offsets[index % len(offsets)]
            package = packages[index % 4] if index < 20 else packages[3]
            status = 'Active' if index < 17 else 'Suspended' if index < 20 else 'Active' if index < 23 else 'Disconnected'
            joined = today - timedelta(days=40 + index * 11)
            expiry = today + timedelta(days=3 + index % 20) if status == 'Active' else today - timedelta(days=5 + index)
            username = 'test.' + name.lower().replace(' ', '.')
            customers.append(insert('customers', name=TAG + name, phone=f'0321-00{20101 + index}', address=f'House {12 + index}, Street {index % 9 + 1}, {area}, Lahore',
                                    username=username, email=username + '@example.com', customer_type='Business' if index >= 20 else 'Residential',
                                    package=package['name'], package_id=package['id'], monthly_fee=package['monthly_price'],
                                    installation_charge=package['installation_fee'], status=status, joined=joined, expiry_date=expiry,
                                    area=TAG + area, latitude=round(lat + dlat + index * .0004, 7), longitude=round(lng + dlng - index * .0003, 7)))

        # Payments go through the real recharge flow so invoices, receipts and renewals are created.
        for index, customer in enumerate(customers[:14]):
            amount = customer['monthly_fee'] if index % 5 else customer['monthly_fee'] / 2
            result = crm_recharge.save_payment(db, dict(request_key=str(uuid.uuid4()), fields=dict(
                customer_id=customer['id'], amount=str(amount), payment_date=str(today - timedelta(days=index % 6)), billing_month=month,
                method=['Cash', 'Bank transfer', 'Mobile wallet', 'Card'][index % 4], reference=f'TEST-{month}-{index + 1:03}',
                revenue_type='MRC', otc_type='Other')), user, ispcrm.validate)
            summary['payments'] = summary.get('payments', 0) + 1
        for customer in customers[14:18]:
            crm_recharge.save_payment(db, dict(request_key=str(uuid.uuid4()), fields=dict(
                customer_id=customer['id'], amount='3000', payment_date=str(today - timedelta(days=2)), billing_month=month,
                method='Cash', reference='TEST-INSTALL-' + str(customer['id']), revenue_type='OTC', otc_type='Installation')), user, ispcrm.validate)

        # Inventory (built-in categories when active).
        def category(name):
            row = db.execute('SELECT status FROM categories WHERE name=%s', (name,)).fetchone()
            if row and row['status'] == 'Active':
                return name
            created = db.execute("INSERT INTO categories(name,status) VALUES (%s,'Active') ON CONFLICT(name) DO NOTHING RETURNING id", (TAG + name,)).fetchone()
            if created:
                track('categories', created['id'])
            return TAG + name
        stock = {}
        for item, cat, qty, minimum, cost, price in [
            ('Huawei HG8145V5 ONT', 'ONT', 35, 10, 4500, 6000), ('ZTE C320 OLT', 'OLT', 2, 1, 185000, 0), ('TP-Link Archer C6 Router', 'Router', 12, 5, 6500, 8500),
            ('2-core drop cable (m)', 'Fiber Drop Cable', 3000, 1000, 18, 30), ('12-core fiber (m)', 'Fiber - 12 Core', 800, 1000, 65, 0), ('24-core fiber (m)', 'Fiber - 24 Core', 1500, 500, 110, 0),
            ('1:8 PLC splitter', 'Splitter - 1:8', 6, 10, 850, 0), ('1:16 PLC splitter', 'Splitter - 1:16', 14, 5, 1400, 0), ('Outdoor joint closure', 'Fiber Joint Closure', 3, 4, 1800, 0),
            ('SC/APC patch cord 3m', 'Fiber Patch Cord', 60, 20, 250, 400), ('16-port FDB', 'Fiber Distribution Box (FDB)', 8, 3, 3200, 0), ('Optical power meter', 'Optical Power Meter', 3, 1, 6500, 0)]:
            stock[item] = insert('inventory', item=TAG + item, category=category(cat), quantity=qty, minimum_stock=minimum, unit_cost=cost,
                                 location='Gulberg Warehouse', selling_price=price)

        # Tickets with TAT targets, some overdue and some resolved.
        tickets = [
            ('No internet since morning', 0, 1, 'Network outage', 'Urgent', 'Open', -5, ''),
            ('Slow speed in evening', 1, 2, 'Slow speed', 'High', 'In progress', -2, ''),
            ('Wrong amount on bill', 2, 4, 'Billing', 'Normal', 'Awaiting customer', -10, ''),
            ('New connection installation', 3, 1, 'Installation', 'Normal', 'Open', -1, ''),
            ('Router replacement', 4, 2, 'Equipment', 'Normal', 'Resolved', -30, 'Replaced router; speed test 48 Mbps.'),
            ('Fiber cut on street pole', 5, 3, 'Maintenance', 'High', 'Closed', -50, 'Spliced 4 cores and replaced closure.'),
            ('Wi-Fi coverage complaint', 6, 2, 'Complaint', 'Low', 'Open', -60, ''),
            ('Payment collection visit', 17, 5, 'Collection', 'Normal', 'Open', -3, ''),
            ('Intermittent disconnections', 8, 1, 'Network outage', 'High', 'Resolved', -20, 'Cleaned connector at FDB; light levels normal.'),
            ('Shift connection to new house', 9, None, 'Installation', 'Normal', 'Open', -1, ''),
        ]
        for subject, customer, assignee, kind, priority, status, hours_ago, resolution in tickets:
            created = now + timedelta(hours=hours_ago)
            hours = crm_tat.default_hours(db, kind, priority)
            due = created + timedelta(hours=hours)
            resolved = created + timedelta(hours=hours * .6) if status in ('Resolved', 'Closed') else None
            ticket = insert('tickets', subject=TAG + subject, customer_id=customers[customer]['id'], assigned_to=staff[assignee]['id'] if assignee is not None else None,
                            type=kind, priority=priority, status=status, due_date=due.date(), description=f'{subject} reported by customer.',
                            resolution_notes=resolution, tat_hours=hours, due_at=due, created_at=created, resolved_at=resolved)
            db.execute('INSERT INTO ticket_events(ticket_id,message) VALUES (%s,%s)', (ticket['id'], 'Test data: ticket created.'))

        # Expenses.
        for title, cat, payee, amount, days, status in [
            ('Upstream bandwidth - October', 'Bandwidth / Upstream', 'PTCL', 185000, 5, 'Paid'), ('POP rent - Gulberg', 'POP / Site rent', 'Building owner', 45000, 4, 'Paid'),
            ('Generator diesel', 'Generator fuel', 'PSO pump', 18500, 3, 'Paid'), ('Field vehicle fuel', 'Fuel / Transport', 'Shell', 12000, 2, 'Paid'),
            ('Electricity bill - POP', 'Electricity', 'LESCO', 32000, 8, 'Pending'), ('Trenching for DHA route', 'Civil works / Trenching', 'Civil contractor', 95000, 1, 'Pending'),
            ('SMS package', 'SMS / Communications', 'SMS vendor', 5000, 12, 'Paid'), ('Office supplies', 'Office supplies / Printing', 'Stationery shop', 3500, 6, 'Cancelled')]:
            day = today - timedelta(days=days)
            insert('expenses', title=TAG + title, category=cat, payee=payee, amount=amount, expense_date=day, status=status, method='Bank transfer',
                   payment_date=day if status == 'Paid' else None, reference=f'TEST-EXP-{days:02}', notes='Test data', customer_id=None)

        # Network: POPs, devices, links and fiber routes.
        pops = {name: op('POPs', name=TAG + name + ' POP', zone=zones[zone]['id'], address=f'{name}, Lahore', latitude=str(lat), longitude=str(lng))
                for name, zone, lat, lng in [('Gulberg', 'Central Lahore', 31.5180, 74.3440), ('Model Town', 'Central Lahore', 31.4836, 74.3256), ('Johar Town', 'South Lahore', 31.4700, 74.2760)]}
        device = {}
        for name, pop, kind, lat, lng in [
            ('Core Router', 'Gulberg', 'Router', 31.5181, 74.3441), ('OLT Gulberg', 'Gulberg', 'OLT', 31.5179, 74.3439), ('OLT Model Town', 'Model Town', 'OLT', 31.4836, 74.3256),
            ('OLT Johar Town', 'Johar Town', 'OLT', 31.4700, 74.2760), ('Aggregation Switch', 'Gulberg', 'Switch', 31.5182, 74.3443),
            ('FDB Gulberg-1', 'Gulberg', 'Distribution box', 31.5150, 74.3500), ('FDB Model Town-1', 'Model Town', 'Distribution box', 31.4790, 74.3200),
            ('FDB Johar-1', 'Johar Town', 'Distribution box', 31.4660, 74.2700), ('FDB DHA-1', 'Gulberg', 'Distribution box', 31.4626, 74.4085)]:
            device[name] = op('Network devices', name=TAG + name, pop=pops[pop]['id'], type=kind, host='10.10.0.' + str(len(device) + 1), latitude=str(lat), longitude=str(lng), notes='Test device')
        for a, b, medium, capacity in [('Core Router', 'Aggregation Switch', 'Ethernet', 10000), ('Aggregation Switch', 'OLT Gulberg', 'Fiber', 10000),
                                       ('Core Router', 'OLT Model Town', 'Fiber', 10000), ('OLT Model Town', 'OLT Johar Town', 'Fiber', 10000)]:
            op('Network links', from_device=device[a]['id'], to_device=device[b]['id'], medium=medium, capacity_mbps=str(capacity), notes='Test link')
        routes = [
            ('Backbone Gulberg - Model Town', 'Core Router', 'OLT Model Town', 'Backbone', 48, 'Active', [(31.5181, 74.3441), (31.5110, 74.3410), (31.5020, 74.3365), (31.4930, 74.3300), (31.4836, 74.3256)]),
            ('Backbone Model Town - Johar Town', 'OLT Model Town', 'OLT Johar Town', 'Backbone', 48, 'Active', [(31.4836, 74.3256), (31.4805, 74.3120), (31.4770, 74.2985), (31.4735, 74.2860), (31.4700, 74.2760)]),
            ('Feeder Gulberg block C', 'OLT Gulberg', 'FDB Gulberg-1', 'Feeder', 24, 'Active', [(31.5179, 74.3439), (31.5170, 74.3465), (31.5150, 74.3500)]),
            ('Feeder Model Town block J', 'OLT Model Town', 'FDB Model Town-1', 'Feeder', 12, 'Damaged', [(31.4836, 74.3256), (31.4815, 74.3232), (31.4790, 74.3200)]),
            ('Feeder Johar Town block G', 'OLT Johar Town', 'FDB Johar-1', 'Distribution', 12, 'Active', [(31.4700, 74.2760), (31.4682, 74.2731), (31.4660, 74.2700)]),
            ('Planned route to DHA Phase 5', 'Core Router', 'FDB DHA-1', 'Backbone', 24, 'Planned', [(31.5181, 74.3441), (31.5050, 74.3600), (31.4900, 74.3800), (31.4750, 74.3960), (31.4626, 74.4085)]),
        ]
        for name, a, b, cable, cores, status, points in routes:
            op('Fiber segments', name=TAG + name, from_device=device[a]['id'], to_device=device[b]['id'], cable_type=cable, core_count=cores, status=status,
               route='\n'.join(f'{lat}, {lng}' for lat, lng in points), notes='Test route')

        # People, purchasing, bandwidth, finance and communications.
        for index, person in enumerate(staff[:6]):
            for day in range(3):
                op('Attendance', employee=person['id'], date=str(today - timedelta(days=day)), status=['Present', 'Present', 'Leave', 'Half day'][(index + day) % 4], check_in='09:00', check_out='18:00', overtime_hours='0')
            op('Payroll', employee=person['id'], month=month, basic_salary=str(person['monthly_salary']), allowances='5000', deductions='1000', bonus='0', overtime_amount='0', incentive='0', notes='Test payroll')
        for title, person, days, priority, status in [('Survey DHA route poles', 1, 3, 'High', 'In progress'), ('Replace damaged closure Model Town', 2, 1, 'Urgent', 'Planned'),
                                                      ('Monthly OLT backup', 0, 7, 'Normal', 'Planned'), ('Stock count at warehouse', 7, 5, 'Low', 'Done')]:
            op('Tasks', title=TAG + title, employee=staff[person]['id'], due_date=str(today + timedelta(days=days)), priority=priority, status=status, description='Test task')
        vendor = op('Vendors', name=TAG + 'Fiber Supplies Co', contact='Asif', phone='042-1111111', email='sales@example.com', address='Hall Road, Lahore')
        op('Purchase bills', vendor=vendor['id'], invoice_number='TEST-PB-001', bill_date=str(today - timedelta(days=4)), item=stock['Huawei HG8145V5 ONT']['id'], quantity=20, unit_cost='4400', due_date=str(today + timedelta(days=10)), notes='Test purchase')
        op('Requisitions', title=TAG + 'Splitters for DHA', item=stock['1:8 PLC splitter']['id'], quantity=10, needed_by=str(today + timedelta(days=7)), reason='Stock below minimum')
        provider = op('Bandwidth providers', name=TAG + 'PTCL Upstream', phone='111-20-20-20', email='noc@example.com')
        link = op('Bandwidth items', name=TAG + '1 Gbps IP transit', capacity_mbps='1000', description='Primary upstream')
        op('Bandwidth bills', provider=provider['id'], item=link['id'], month=month, amount='185000', due_date=str(today + timedelta(days=5)))
        reseller = op('Resellers', name=TAG + 'Shadman Net', type='Bandwidth', company='Shadman Net', phone='0300-5555555', email='reseller@example.com', daily_tariff='0', status='Active')
        op('Reseller invoices', reseller=reseller['id'], month=month, description='100 Mbps bandwidth', amount='60000', due_date=str(today + timedelta(days=7)))
        cash = op('Cash accounts', name=TAG + 'Office cash', type='Cash', opening_balance='50000')
        op('Cash transactions', account=cash['id'], date=str(today), direction='In', amount='15000', description='Counter collections')
        op('Cash transactions', account=cash['id'], date=str(today), direction='Out', amount='3500', description='Tea and supplies')
        op('Notices', title=TAG + 'Scheduled maintenance Sunday 2-4 AM', body='Brief outage expected in Model Town during fiber repair.', audience='Everyone', published='Yes')
        op('Message templates', name=TAG + 'Payment reminder', channel='In-app', subject='Payment due', body='Your monthly bill is due. Please pay to avoid suspension.')
        op('Connection leads', name=TAG + 'Khalid Mehmood', phone='0333-0000001', address='Street 5, Johar Town', package=packages[1]['id'], status='New', notes='Walk-in enquiry')
        op('Connection leads', name=TAG + 'Rubina Clinic', phone='0333-0000002', address='Main Market, Gulberg', package=packages[3]['id'], status='Contacted', notes='Business plan')
        for customer, person, duty in [(0, 1, 'Installation'), (1, 5, 'Collection'), (2, 4, 'Support')]:
            op('Client assignments', customer=customers[customer]['id'], employee=staff[person]['id'], responsibility=duty)
        op('Collection approvals', customer=customers[17]['id'], amount=str(customers[17]['monthly_fee']), billing_month=month, payment_date=str(today), method='Cash', reference='TEST-COLLECT-1')

        # Customer portal: two accounts with a known password, plus requests and messages.
        portal = []
        for customer in customers[:2]:
            crm_customer_portal.provision(db, customer['id'])
            db.execute('UPDATE customer_portal_accounts SET password_hash=%s,must_change=FALSE WHERE customer_id=%s', (crm_auth.hash_password(PASSWORD), customer['id']))
            portal.append(db.execute('SELECT name,payment_id FROM customers WHERE id=%s', (customer['id'],)).fetchone())
        request = ops.customer_request(db, customers[0]['id'], dict(request_key=str(uuid.uuid4()), fields=dict(type='Package change', subject='Upgrade to 50 Mbps', details='Need more speed for work from home.', package=packages[2]['id'])))
        track('operations_records', request['id'])
        message = ops.customer_message(db, customers[1]['id'], dict(request_key=str(uuid.uuid4()), message='Is there any outage in my area today?'))
        track('operations_records', message['id'])
    return summary, portal


if __name__ == '__main__':
    summary, portal = seed()
    print('Test data added:')
    for table, count in sorted(summary.items()):
        print(f'  {table}: {count}')
    print(f'\nStaff logins (password {PASSWORD}): test.manager, test.technician, test.support, test.accountant, test.storekeeper, test.viewer')
    print('Customer portal (http://localhost:3000/customer):')
    for row in portal:
        print(f'  {row["name"]}: customer ID {row["payment_id"]}, password {PASSWORD}')
    print('\nEverything is labelled [TEST]. Remove it all with: python remove_test_data.py')
