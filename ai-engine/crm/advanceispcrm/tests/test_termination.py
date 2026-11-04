"""Inventory issue integration tests using an isolated PostgreSQL schema."""
import concurrent.futures
import json
import threading
import unittest
import urllib.error
import urllib.request
import uuid

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

import crm_data
import ispcrm
from auth_client import administrator_client


class TerminationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings = crm_data.database_settings()
        cls.schema = 'crm_stock_test_' + uuid.uuid4().hex
        cls.original_data = crm_data.connect_database
        cls.original_server = ispcrm.connect_database
        with psycopg.connect(**cls.settings, autocommit=True) as db:
            db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(cls.schema)))
        def connect():
            return psycopg.connect(**cls.settings, row_factory=dict_row, options='-c search_path=' + cls.schema)
        cls.connect = staticmethod(connect)
        crm_data.connect_database = ispcrm.connect_database = connect
        try:
            crm_data.initialize_database()
            with cls.connect() as db:
                cls.staff = db.execute("INSERT INTO staff(name,phone,role,area,status) VALUES ('Test employee','0','Technician','','Available') RETURNING id").fetchone()['id']
                cls.customer = db.execute("INSERT INTO customers(name,phone,address,username,package,monthly_fee,status,joined) VALUES ('Test customer','0','','test','Legacy',1000,'Active','2026-10-19') RETURNING id").fetchone()['id']
            cls.server = ispcrm.ThreadingHTTPServer(('127.0.0.1', 0), ispcrm.Handler)
            cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
            cls.thread.start()
            cls.base = 'http://127.0.0.1:' + str(cls.server.server_port)
            cls.opener, cls.token = administrator_client(cls.base)
        except BaseException:
            cls.cleanup()
            raise

    @classmethod
    def cleanup(cls):
        if hasattr(cls, 'server'):
            cls.server.shutdown()
            cls.server.server_close()
            cls.thread.join()
        crm_data.connect_database = cls.original_data
        ispcrm.connect_database = cls.original_server
        with psycopg.connect(**cls.settings, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(cls.schema)))

    @classmethod
    def tearDownClass(cls):
        cls.cleanup()

    def setUp(self):
        with self.connect() as db:
            self.stock = db.execute("INSERT INTO inventory(item,category,quantity,minimum_stock,unit_cost,location) VALUES (%s,'ONT',10,2,1000,'Store') RETURNING id", ('Item ' + uuid.uuid4().hex,)).fetchone()['id']

    def fields(self, **changes):
        return dict(dict(inventory_id=self.stock, issued_against='Customer', customer_id=self.customer,
                         destination='', employee_id=self.staff, quantity=3, issue_date='2026-10-19', notes=''), **changes)

    def post(self, fields=None, rid=None, action=None, request_key=None, section='Stock issues', **extra):
        payload=dict(section=section, fields=fields, id=rid, action=action, request_key=request_key or uuid.uuid4().hex, **extra)
        request=urllib.request.Request(self.base+'/api/record', data=json.dumps(payload,default=ispcrm.json_value).encode(), headers={'X-CRM-Token':self.token,'Content-Type':'application/json'})
        try:
            response=self.opener.open(request)
        except urllib.error.HTTPError as exc:
            response=exc
        with response:
            return response.status,json.load(response)

    def quantity(self):
        with self.connect() as db:
            return db.execute('SELECT quantity FROM inventory WHERE id=%s',(self.stock,)).fetchone()['quantity']

    def issues(self):
        with self.connect() as db:
            return list(db.execute('SELECT * FROM stock_issues WHERE inventory_id=%s ORDER BY id',(self.stock,)))

    def request(self,path,payload=None,expected=200,anonymous=False):
        request=urllib.request.Request(self.base+path,data=json.dumps(payload,default=ispcrm.json_value).encode() if payload is not None else None,headers={'Content-Type':'application/json','X-CRM-Token':self.token})
        try:
            response=(urllib.request.build_opener() if anonymous else self.opener).open(request)
        except urllib.error.HTTPError as error:
            response=error
        with response:
            body=json.load(response);self.assertEqual(response.status,expected,body);return body

    def fresh_customer(self):
        with self.connect() as db:
            return db.execute("INSERT INTO customers(name,phone,address,username,package,monthly_fee,status,joined) VALUES ('Termination test','0','',%s,'Legacy',2000,'Active','2026-10-19') RETURNING *",('termination-'+uuid.uuid4().hex,)).fetchone()

    def test_expiry_ticket_resolves_after_actual_device_returns(self):
        from crm_recharge import local_today
        import crm_termination
        from datetime import timedelta
        customer=self.fresh_customer();cid=customer['id']
        self.assertEqual(self.post(self.fields(customer_id=cid,quantity=1))[0],200)
        self.assertEqual(self.post(self.fields(customer_id=cid,quantity=1))[0],200)
        with self.connect() as db:
            db.execute('UPDATE customers SET joined=%s,expiry_date=%s WHERE id=%s',(local_today()-timedelta(days=60),local_today()-timedelta(days=5),cid))
            crm_termination.generate_expiry_recovery(db)
            ticket=db.execute('SELECT * FROM tickets WHERE customer_id=%s AND expiry_recovery_date IS NOT NULL',(cid,)).fetchone()
            self.assertIn(customer['name'],ticket['description'])
            self.assertIn(customer['payment_id'],ticket['description'])
            self.assertIn('ISS-',ticket['description'])
        issues=[i for i in self.issues() if i['customer_id']==cid]
        self.assertEqual(self.post(rid=issues[0]['id'],action='return')[0],200)
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT status FROM tickets WHERE id=%s',(ticket['id'],)).fetchone()['status'],'Open')
        self.assertEqual(self.post(rid=issues[1]['id'],action='return')[0],200)
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT status FROM tickets WHERE id=%s',(ticket['id'],)).fetchone()['status'],'Resolved')
            crm_termination.generate_expiry_recovery(db)
            self.assertEqual(db.execute('SELECT COUNT(*) AS n FROM tickets WHERE customer_id=%s',(cid,)).fetchone()['n'],1)
        self.assertEqual(self.quantity(),10)

    def test_recovery_stays_pending_until_all_stock_is_returned(self):
        customer=self.fresh_customer();cid=customer['id']
        self.assertEqual(self.post(self.fields(customer_id=cid,quantity=3))[0],200)
        self.assertEqual(self.post(self.fields(customer_id=cid,quantity=2))[0],200)
        result=self.request('/api/customers/terminate',dict(customer_id=cid,reason='Customer cancelled',employee_id=self.staff))['recovery']
        self.assertEqual(result['status'],'Equipment recovery pending')
        self.assertEqual(result['monthly_revenue_loss'],2000)
        self.assertEqual(self.request('/api/customers/terminate',dict(customer_id=cid,reason='Retry'))['recovery']['id'],result['id'])
        state=self.request('/api/state')
        recovery=next(r for r in state['records']['Equipment recovery'] if r['id']==result['id'])
        self.assertEqual(sum(i['quantity'] for i in recovery['pending_items']),5)
        ticket=next(t for t in state['records']['Tickets'] if t['recovery_id']==result['id'])
        self.assertEqual(ticket['type'],'Equipment recovery')
        self.assertEqual(ticket['assigned_to'],self.staff)
        self.assertEqual(self.post(dict(ticket,status='Resolved',resolution_notes='Not actually returned'),rid=ticket['id'],section='Tickets')[0],400)
        self.assertEqual(self.post(dict(customer,status='Active',package='Legacy'),rid=cid,section='Customers')[0],400)
        self.assertEqual(self.post({},rid=result['id'],section='Equipment recovery')[0],403)
        issues=[i for i in self.issues() if i['customer_id']==cid]
        self.assertEqual(self.post(rid=issues[0]['id'],action='return')[0],200)
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT recovery_status FROM customers WHERE id=%s',(cid,)).fetchone()['recovery_status'],'Equipment recovery pending')
        self.assertEqual(self.post(rid=issues[1]['id'],action='return')[0],200)
        self.assertEqual(self.quantity(),10)
        self.assertEqual(self.post(rid=issues[1]['id'],action='return')[0],200)
        self.assertEqual(self.quantity(),10)
        with self.connect() as db:
            customer=db.execute('SELECT * FROM customers WHERE id=%s',(cid,)).fetchone()
            self.assertEqual(customer['status'],'Terminated')
            self.assertEqual(customer['recovery_status'],'Recovered')
            self.assertEqual(db.execute('SELECT status FROM tickets WHERE id=%s',(ticket['id'],)).fetchone()['status'],'Resolved')
        self.assertEqual(self.post(self.fields(customer_id=cid))[0],400)
        from crm_recharge import local_today
        today=local_today()
        self.assertEqual(self.post(dict(customer_id=cid,amount=2000,payment_date=today.isoformat(),billing_month=today.strftime('%Y-%m'),method='Cash',reference='Settle balance'),section='Payments')[0],200)
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT status FROM customers WHERE id=%s',(cid,)).fetchone()['status'],'Terminated')
        self.request('/api/invoices',dict(customer_id=cid,billing_month='2030-01'),400)

    def test_nonrecoverable_items_and_repeat_termination_after_reactivation(self):
        customer=self.fresh_customer();cid=customer['id']
        self.assertEqual(self.post(self.fields(customer_id=cid,recovery_required='No'))[0],200)
        first=self.request('/api/customers/terminate',dict(customer_id=cid,reason='No company equipment'))['recovery']
        self.assertEqual(first['status'],'No equipment to recover')
        self.assertEqual(self.quantity(),7)
        with self.connect() as db:
            customer=db.execute('SELECT * FROM customers WHERE id=%s',(cid,)).fetchone()
        self.assertEqual(self.post(dict(customer,status='Active',package='Legacy'),rid=cid,section='Customers')[0],200)
        self.assertEqual(self.post(dict(customer,status='Terminated',package='Legacy'),rid=cid,section='Customers')[0],200)
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) AS n FROM equipment_recovery WHERE customer_id=%s',(cid,)).fetchone()['n'],2)
        self.request('/api/customers/terminate',dict(customer_id=cid,reason='No session'),401,anonymous=True)

    def test_concurrent_termination_is_idempotent(self):
        customer=self.fresh_customer()
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            rows=list(pool.map(lambda _:self.request('/api/customers/terminate',dict(customer_id=customer['id'],reason='Cancellation'))['recovery'],range(2)))
        self.assertEqual(rows[0]['id'],rows[1]['id'])
        self.request('/api/customers/terminate',dict(customer_id=999999,reason='Unknown'),400)
        another=self.fresh_customer()
        self.request('/api/customers/terminate',dict(customer_id=another['id'],reason=''),400)
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT status FROM customers WHERE id=%s',(another['id'],)).fetchone()['status'],'Active')

if __name__=='__main__':
    unittest.main()
