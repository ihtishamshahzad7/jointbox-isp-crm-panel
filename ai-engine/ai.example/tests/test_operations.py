"""Exercise money, stock, authorization and scheduling against an isolated schema."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import unittest
import uuid
import psycopg
from psycopg import sql
from psycopg.rows import dict_row
import crm_data
import crm_operations as ops
import ispcrm


class OperationsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings=crm_data.database_settings();cls.schema='ops_test_'+uuid.uuid4().hex
        with psycopg.connect(**cls.settings,autocommit=True) as db:db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(cls.schema)))
        cls.original=crm_data.connect_database
        cls.connect=staticmethod(lambda:psycopg.connect(**cls.settings,row_factory=dict_row,options='-c search_path='+cls.schema))
        crm_data.connect_database=cls.connect
        crm_data.initialize_database()

    @classmethod
    def tearDownClass(cls):
        crm_data.connect_database=cls.original
        with psycopg.connect(**cls.settings,autocommit=True) as db:db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(cls.schema)))

    def setUp(self):
        self.db=self.connect();self.addCleanup(self.db.close)
        self.db.execute("INSERT INTO staff(name,phone,role,area,status,monthly_salary,allowances,deductions) VALUES ('Test employee','0','Technician','','Available',40000,1000,500) RETURNING id")
        self.staff=self.db.fetchone()['id'] if hasattr(self.db,'fetchone') else self.db.execute('SELECT max(id) AS id FROM staff').fetchone()['id']
        self.customer=self.db.execute("INSERT INTO customers(name,phone,address,username,package,monthly_fee,status,joined) VALUES ('Test customer','0','',%s,'Legacy',2000,'Active',%s) RETURNING id",(uuid.uuid4().hex,ops.today())).fetchone()['id']
        self.item=self.db.execute("INSERT INTO inventory(item,category,quantity,minimum_stock,unit_cost,location) VALUES ('Test ONT','ONT',10,2,1000,'Store') RETURNING id").fetchone()['id']
        self.user=dict(id=None,name='Test administrator',role='Administrator',staff_id=None)

    def save(self,name,fields,**extra):
        return ops.save(self.db,self.user,dict(module=name,fields=fields,request_key=str(uuid.uuid4()),**extra))

    def action(self,r,act,user=None):return ops.action(self.db,user or self.user,dict(module=r['module'],id=r['id'],action=act),ispcrm.validate)

    def test_payroll_generate_and_pay_once(self):
        result=ops.generate_payroll(self.db,self.user,'2026-10');self.assertGreater(result['generated'],0)
        self.assertEqual(ops.generate_payroll(self.db,self.user,'2026-10')['generated'],0)
        r=self.db.execute("SELECT * FROM operations_records WHERE module='Payroll' AND data->>'employee'=%s",(str(self.staff),)).fetchone()
        a=self.action(r,'pay');b=self.action(r,'pay');self.assertEqual(a['data']['expense_id'],b['data']['expense_id'])
        expense=self.db.execute('SELECT amount FROM expenses WHERE id=%s',(a['data']['expense_id'],)).fetchone()
        self.assertEqual(expense['amount'],40500)

    def test_purchase_receive_and_pay_are_independently_idempotent(self):
        vendor=self.save('Vendors',dict(name='Supplier'))
        r=self.save('Purchase bills',dict(vendor=vendor['id'],invoice_number='B-1',bill_date=str(ops.today()),item=self.item,quantity=3,unit_cost='1000',due_date=str(ops.today())))
        self.action(r,'receive');self.action(r,'receive')
        self.assertEqual(self.db.execute('SELECT quantity FROM inventory WHERE id=%s',(self.item,)).fetchone()['quantity'],13)
        paid=self.action(r,'pay');self.assertEqual(paid['state'],'Paid');self.assertTrue(paid['data']['received_at'])
        self.assertEqual(self.action(r,'pay')['data']['expense_id'],paid['data']['expense_id'])

    def test_collection_approval_requires_finance_and_posts_once(self):
        r=self.save('Collection approvals',dict(customer=self.customer,amount='2000',billing_month=ops.today().strftime('%Y-%m'),payment_date=str(ops.today()),method='Cash'))
        with self.assertRaises(PermissionError):self.action(r,'approve',dict(id=None,name='Support',role='Support'))
        a=self.action(r,'approve');b=self.action(r,'approve');self.assertEqual(a['state'],'Posted');self.assertEqual(a['data']['payment_id'],b['data']['payment_id'])
        self.assertEqual(self.db.execute('SELECT count(*) AS n FROM payments WHERE customer_id=%s',(self.customer,)).fetchone()['n'],1)
        self.assertEqual(self.db.execute('SELECT count(*) AS n FROM payment_receipts WHERE customer_id=%s',(self.customer,)).fetchone()['n'],1)

    def test_in_app_delivery_only_and_no_external_success(self):
        r=self.save('Message queue',dict(customer=self.customer,channel='In-app',subject='Test',body='Hello'))
        self.action(r,'deliver');self.action(r,'deliver')
        self.assertEqual(self.db.execute('SELECT count(*) AS n FROM customer_notifications WHERE event_key=%s',('ops-message:'+str(r['id']),)).fetchone()['n'],1)
        sms=self.save('Message queue',dict(customer=self.customer,channel='SMS',subject='Test',body='Hello'))
        self.assertEqual(sms['state'],'Not configured')
        with self.assertRaises(ValueError):self.action(sms,'deliver')

    def test_schedule_applies_once_and_protects_terminated_account(self):
        r=self.save('Client schedules',dict(customer=self.customer,effective_date=str(ops.today()),action='Status change',requested_status='Suspended'))
        ops.run_due_schedules(self.db);ops.run_due_schedules(self.db)
        self.assertEqual(ops.record(self.db,r['id'])['state'],'Applied')
        self.assertEqual(self.db.execute('SELECT status FROM customers WHERE id=%s',(self.customer,)).fetchone()['status'],'Suspended')
        self.db.execute("UPDATE customers SET status='Terminated' WHERE id=%s",(self.customer,))
        blocked=self.save('Client schedules',dict(customer=self.customer,effective_date=str(ops.today()),action='Status change',requested_status='Active'))
        ops.run_due_schedules(self.db);self.assertEqual(ops.record(self.db,blocked['id'])['state'],'Blocked')

    def test_duplicate_key_conflict_and_stale_version(self):
        payload=dict(module='Vendors',fields={'name':'Unique'},request_key=str(uuid.uuid4()))
        a=ops.save(self.db,self.user,payload);self.assertEqual(a['id'],ops.save(self.db,self.user,payload)['id'])
        with self.assertRaises(ValueError):ops.save(self.db,self.user,dict(payload,fields={'name':'Different'}))
        with self.assertRaises(ValueError):ops.save(self.db,self.user,dict(module='Vendors',id=a['id'],version=0,fields={'name':'Changed'}))

    def test_reseller_overpayment_rejected(self):
        r=self.save('Resellers',dict(name='Reseller',type='Bandwidth',status='Active'))
        bill=self.save('Reseller invoices',dict(reseller=r['id'],month='2026-10',description='Bandwidth',amount='1000',due_date=str(ops.today())))
        fields=dict(invoice=bill['id'],amount='800',payment_date=str(ops.today()),method='Cash')
        self.save('Reseller receipts',fields)
        with self.assertRaises(ValueError):self.save('Reseller receipts',dict(fields,amount='300'))

    def test_customer_request_cannot_select_another_customer(self):
        result=ops.customer_request(self.db,self.customer,dict(fields=dict(customer=999999,type='Support',subject='Help',details='Connection issue'),request_key=str(uuid.uuid4())))
        r=ops.record(self.db,result['id']);self.assertEqual(r['data']['customer'],self.customer)
        ticket=self.action(r,'ticket');self.assertTrue(ticket['data']['ticket_id'])
        self.assertEqual(self.action(ticket,'ticket')['data']['ticket_id'],ticket['data']['ticket_id'])

    def test_viewer_cannot_write_and_private_people_modules_are_hidden(self):
        viewer=dict(id=None,name='Reader',role='Viewer',staff_id=None)
        self.assertFalse(ops.permitted(viewer,'Payroll'))
        with self.assertRaises(PermissionError):ops.save(self.db,viewer,dict(module='Vendors',fields={'name':'Denied'}))

    def test_csv_import_is_atomic_and_uses_package_price(self):
        package=self.db.execute("INSERT INTO packages(name,speed_mbps,monthly_price,monthly_cost,installation_fee,status) VALUES (%s,20,2000,1000,1500,'Active') RETURNING id",('Import '+uuid.uuid4().hex,)).fetchone()['id']
        username='import.'+uuid.uuid4().hex
        fields=dict(name='Imported',phone='0',username=username,package=str(package),latitude='31.52',longitude='74.35',monthly_fee='1')
        with self.assertRaises(ValueError):
            with self.db.transaction():ops.import_customers(self.db,self.user,[fields,dict(fields,username='broken',latitude='')],ispcrm.validate)
        self.assertIsNone(self.db.execute('SELECT 1 FROM customers WHERE username=%s',(username,)).fetchone())
        result=ops.import_customers(self.db,self.user,[fields],ispcrm.validate)
        c=self.db.execute('SELECT * FROM customers WHERE id=%s',(result['ids'][0],)).fetchone()
        self.assertEqual(c['monthly_fee'],2000);self.assertEqual(c['package_id'],package)

    def test_bulk_change_protects_terminated_and_has_history(self):
        self.db.execute("UPDATE customers SET status='Terminated' WHERE id=%s",(self.customer,))
        with self.assertRaises(ValueError):ops.bulk_status(self.db,self.user,[self.customer],'Active')
        self.db.execute("UPDATE customers SET status='Active' WHERE id=%s",(self.customer,))
        result=ops.bulk_status(self.db,self.user,[self.customer],'Suspended');self.assertEqual(result['updated'],1)
        self.assertEqual(self.db.execute("SELECT state FROM operations_records WHERE module='Customer requests' AND data->>'customer'=%s",(str(self.customer),)).fetchone()['state'],'Applied')

    def test_customer_messages_are_immutable_and_customer_scoped(self):
        result=ops.customer_message(self.db,self.customer,dict(message='Help please',request_key=str(uuid.uuid4()),customer=999,sender='Administrator'))
        r=ops.record(self.db,result['id']);self.assertEqual(r['data']['customer'],self.customer);self.assertEqual(r['data']['sender'],'Customer')
        with self.assertRaises(ValueError):ops.save(self.db,self.user,dict(module='Customer messages',id=r['id'],version=r['version'],fields=dict(customer=self.customer,message='Rewritten')))
        self.assertEqual(len(ops.customer_state(self.db,self.customer)['messages']),1)

    def test_archived_invoice_and_posted_reseller_invoice_are_protected(self):
        reseller=self.save('Resellers',dict(name='Reseller',type='Bandwidth',status='Active'))
        bill=self.save('Reseller invoices',dict(reseller=reseller['id'],month='2026-10',description='Bandwidth',amount='1000',due_date=str(ops.today())))
        self.save('Reseller receipts',dict(invoice=bill['id'],amount='500',payment_date=str(ops.today()),method='Cash'))
        with self.assertRaises(ValueError):self.action(bill,'archive')
        with self.assertRaises(ValueError):ops.save(self.db,self.user,dict(module='Reseller invoices',id=bill['id'],version=bill['version'],fields=dict(bill['data'],amount='100')))

    def test_mac_daily_tariff_preserves_one_saved_charge(self):
        r=self.save('Resellers',dict(name='MAC reseller',type='MAC',status='Active',daily_tariff='50'))
        ops.generate_mac_tariffs(self.db);ops.generate_mac_tariffs(self.db)
        self.assertEqual(self.db.execute("SELECT count(*) AS n FROM operations_records WHERE module='Reseller invoices' AND data->>'reseller'=%s",(str(r['id']),)).fetchone()['n'],1)
        ops.save(self.db,self.user,dict(module='Resellers',id=r['id'],version=r['version'],fields=dict(r['data'],daily_tariff='75')))
        ops.generate_mac_tariffs(self.db)
        self.assertEqual(self.db.execute("SELECT data->>'amount' AS amount FROM operations_records WHERE module='Reseller invoices' AND data->>'reseller'=%s",(str(r['id']),)).fetchone()['amount'],'50.00')

    def test_companies_and_areas_preserve_links_and_retry(self):
        company=self.save('Companies',dict(name='Example ISP',status='Active'))
        with self.assertRaises(ValueError):self.save('Areas',dict(name='No city yet',city='Lahore',status='Active'))
        if 'Lahore' not in ops.city_names(self.db):self.save('Cities',dict(name='Lahore',province='Punjab',status='Active'))
        fields=dict(name='Gulberg',company=company['id'],city='lahore',status='Active')
        payload=dict(module='Areas',fields=fields,request_key=str(uuid.uuid4()))
        area=ops.save(self.db,self.user,payload)
        self.assertEqual(ops.save(self.db,self.user,payload)['id'],area['id'])
        with self.assertRaises(ValueError):self.save('Areas',dict(fields,name='gulberg'))
        self.assertEqual(area['data']['city'],'Lahore')
        self.assertEqual(ops.customer_city(self.db,'','Gulberg'),'Lahore')
        with self.assertRaises(ValueError):ops.customer_city(self.db,'Karachi','Gulberg')
        self.assertIn('Gulberg',ops.area_options(self.db))
        self.assertEqual(ops.validate_customer_area(self.db,' Gulberg '),'Gulberg')
        self.db.execute('UPDATE customers SET area=%s WHERE id=%s',('Gulberg',self.customer))
        with self.assertRaises(ValueError):self.action(company,'archive')
        with self.assertRaises(ValueError):self.action(area,'archive')
        renamed=ops.save(self.db,self.user,dict(module='Areas',id=area['id'],version=area['version'],fields=dict(fields,name='Gulberg II')))
        self.assertEqual(self.db.execute('SELECT area FROM customers WHERE id=%s',(self.customer,)).fetchone()['area'],'Gulberg II')
        with self.assertRaises(ValueError):ops.save(self.db,self.user,dict(module='Areas',id=area['id'],version=area['version'],fields=dict(fields,name='Stale edit')))
        self.assertEqual(self.db.execute('SELECT area FROM customers WHERE id=%s',(self.customer,)).fetchone()['area'],'Gulberg II')
        self.assertEqual(renamed['version'],area['version']+1)

    def test_inactive_area_retained_for_existing_customer_only(self):
        area=self.save('Areas',dict(name='Old area',status='Active'))
        ops.save(self.db,self.user,dict(module='Areas',id=area['id'],version=area['version'],fields=dict(name='Old area',status='Inactive')))
        self.assertNotIn('Old area',ops.area_options(self.db))
        with self.assertRaises(ValueError):ops.validate_customer_area(self.db,'Old area')
        self.assertEqual(ops.validate_customer_area(self.db,'Old area',dict(area='Old area')),'Old area')
        self.assertEqual(ops.validate_customer_area(self.db,None),'')

    def test_cables_and_devices_are_issued_from_inventory(self):
        cable=self.db.execute("INSERT INTO inventory(item,category,quantity,minimum_stock,unit_cost,location) VALUES ('Test 12-core fiber (m)','Fiber - 12 Core',2000,100,60,'Store') RETURNING id").fetchone()['id']
        qty=lambda i:self.db.execute('SELECT quantity FROM inventory WHERE id=%s',(i,)).fetchone()['quantity']
        issued=lambda:self.db.execute("SELECT count(*) AS n FROM stock_issues WHERE status='Issued' AND issued_against='Network'").fetchone()['n']
        fields=dict(name='Feeder stock',cable_type='Feeder',core_count=12,status='Planned',route='34.12, 72.47\n34.13, 72.47',cable_stock_item=cable,installed_by=self.staff)
        r=self.save('Fiber segments',fields)
        self.assertEqual(qty(cable),2000);self.assertNotIn('stock_issue_id',r['data'])
        r=ops.save(self.db,self.user,dict(module='Fiber segments',id=r['id'],version=r['version'],fields=dict(fields,status='Active')))
        self.assertEqual(qty(cable),2000-1112);self.assertEqual(issued(),1)
        issue=self.db.execute('SELECT * FROM stock_issues WHERE id=%s',(r['data']['stock_issue_id'],)).fetchone()
        self.assertEqual((issue['quantity'],issue['employee_id']),(1112,self.staff));self.assertIn('Fiber segments OPS-'+str(r['id']),issue['destination'])
        r=ops.save(self.db,self.user,dict(module='Fiber segments',id=r['id'],version=r['version'],fields=dict(fields,status='Active',cable_used_m=1200)))
        self.assertEqual(qty(cable),800);self.assertEqual(issued(),1)
        with self.assertRaises(ValueError):ops.save(self.db,self.user,dict(module='Fiber segments',id=r['id'],version=r['version'],fields=dict(fields,status='Active',cable_used_m=5000)))
        self.action(r,'delete')
        self.assertEqual(qty(cable),2000);self.assertEqual(issued(),0)
        unassigned=self.save('Network devices',dict(name='FAT no installer',type='FAT',stock_item=self.item))
        self.assertIsNone(self.db.execute('SELECT employee_id FROM stock_issues WHERE id=%s',(unassigned['data']['stock_issue_id'],)).fetchone()['employee_id'])
        device=self.save('Network devices',dict(name='FAT stock',type='FAT',stock_item=self.item,installed_by=self.staff))
        self.assertEqual(qty(self.item),8)
        self.action(device,'delete');self.action(unassigned,'delete');self.assertEqual(qty(self.item),10)

    def test_delete_blocks_linked_and_posted_records(self):
        zone=self.save('Zones',dict(name='Delete zone'))
        pop=self.save('POPs',dict(name='Delete POP',zone=zone['id']))
        device=self.save('Network devices',dict(name='FAT-1',pop=pop['id'],type='FAT'))
        with self.assertRaises(PermissionError):self.action(device,'delete',dict(id=None,name='Support',role='Support',staff_id=None))
        with self.assertRaises(ValueError) as blocked:self.action(pop,'delete')
        self.assertIn('Network devices OPS-'+str(device['id']),str(blocked.exception))
        self.assertEqual(self.action(device,'delete')['state'],'Deleted')
        self.action(pop,'delete')
        self.assertIsNone(self.db.execute('SELECT 1 FROM operations_records WHERE id=ANY(%s)',([pop['id'],device['id']],)).fetchone())
        self.assertTrue(self.db.execute("SELECT 1 FROM operations_events WHERE record_id IS NULL AND action LIKE %s",('Deleted POPs OPS-'+str(pop['id'])+'%',)).fetchone())
        ops.generate_payroll(self.db,self.user,'2026-09')
        payroll=self.db.execute("SELECT * FROM operations_records WHERE module='Payroll' AND data->>'month'='2026-09' LIMIT 1").fetchone()
        paid=self.action(payroll,'pay')
        with self.assertRaises(ValueError):self.action(paid,'delete')

    def test_bandwidth_peak_once_per_provider_month(self):
        fields=dict(provider='Nayatel bandwidth',month='2031-01',peak_mbps='300',price_per_mbps='250')
        first=self.save('Bandwidth peaks',fields)
        with self.assertRaises(ValueError):self.save('Bandwidth peaks',fields)
        with self.assertRaises(ValueError):self.save('Bandwidth peaks',dict(fields,month='2031-02',peak_mbps='0'))
        self.save('Bandwidth peaks',dict(fields,provider='Transworld Bandwidth'))
        self.assertEqual(self.save('Bandwidth peaks',dict(fields,peak_mbps='320'),id=first['id'],version=first['version'])['data']['peak_mbps'],'320')

    def test_network_records_get_permanent_ids(self):
        import re
        zone=self.save('Zones',dict(name='ID zone'))
        pop=self.save('POPs',dict(name='ID POP',zone=zone['id']))
        first=self.save('Network devices',dict(name='ID FAT A',type='FAT'))
        second=self.save('Network devices',dict(name='ID FAT B',type='FAT'))
        dc=self.save('Network devices',dict(name='ID DC',type='Data center (DC)'))
        self.assertRegex(zone['data']['code'],r'^ZN-\d{3}$');self.assertRegex(pop['data']['code'],r'^POP-\d{3}$');self.assertRegex(dc['data']['code'],r'^DC-\d{3}$')
        number=lambda r:int(re.search(r'\d+$',r['data']['code']).group())
        self.assertEqual(number(second),number(first)+1)
        edited=self.save('Network devices',dict(name='ID FAT A renamed',type='Splitter'),id=first['id'],version=first['version'])
        self.assertEqual(edited['data']['code'],first['data']['code'])
        self.db.execute("UPDATE operations_records SET data=data-'code' WHERE id=%s",(second['id'],))
        ops.assign_network_codes(self.db)
        self.assertRegex(ops.record(self.db,second['id'])['data']['code'],r'^FAT-\d{3}$')

    def test_fiber_segment_route_length_and_kmz(self):
        import io,zipfile
        olt=self.save('Network devices',dict(name='Core OLT',type='OLT',latitude='34.12',longitude='72.47'))
        box=self.save('Network devices',dict(name='DB-01',type='Distribution box'))
        fields=dict(name='Feeder A',from_device=olt['id'],to_device=box['id'],cable_type='Feeder',core_count=24,status='Active',route='34.12, 72.47\n34.13 72.47; 34.13, 72.48')
        r=self.save('Fiber segments',fields)
        self.assertEqual(r['data']['route'],'34.1200000, 72.4700000\n34.1300000, 72.4700000\n34.1300000, 72.4800000')
        self.assertAlmostEqual(float(r['data']['length_m']),2033.7,delta=5)
        for route in ('34.12, 72.47','95, 72\n34, 72','abc, 72\n34, 72'):
            with self.assertRaises(ValueError):self.save('Fiber segments',dict(fields,route=route))
        with self.assertRaises(ValueError):self.save('Fiber segments',dict(fields,to_device=olt['id']))
        self.db.execute('UPDATE customers SET latitude=34.125,longitude=72.475 WHERE id=%s',(self.customer,))
        with zipfile.ZipFile(io.BytesIO(ops.kmz(self.db,self.user))) as archive:kml=archive.read('doc.kml').decode()
        self.assertIn('<LineString><tessellate>1</tessellate><coordinates>72.4700000,34.1200000,0 72.4700000,34.1300000,0 72.4800000,34.1300000,0</coordinates>',kml)
        self.assertIn('#fiber-active',kml);self.assertIn('Core OLT',kml);self.assertIn('Test customer',kml)
        self.assertNotIn('<name>DB-01</name>',kml)
        with self.assertRaises(PermissionError):ops.kmz(self.db,dict(id=None,name='Tech',role='Technician',staff_id=None))


if __name__=='__main__':unittest.main()
