"""Customer expiry and saved monthly invoice integration tests."""
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


class CustomerInvoicesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings=crm_data.database_settings();cls.schema='crm_invoice_test_'+uuid.uuid4().hex
        cls.original_data,cls.original_server=crm_data.connect_database,ispcrm.connect_database
        with psycopg.connect(**cls.settings,autocommit=True) as db:
            db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(cls.schema)))
        def connect():
            return psycopg.connect(**cls.settings,row_factory=dict_row,options='-c search_path='+cls.schema)
        cls.connect=staticmethod(connect);crm_data.connect_database=ispcrm.connect_database=connect
        try:
            crm_data.initialize_database()
            with cls.connect() as db:
                cls.package=db.execute("INSERT INTO packages(name,speed_mbps,monthly_price,monthly_cost,installation_fee,status) VALUES ('Home',10,1000,500,2000,'Active') RETURNING id").fetchone()['id']
            cls.server=ispcrm.ThreadingHTTPServer(('127.0.0.1',0),ispcrm.Handler)
            cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
            cls.base='http://127.0.0.1:'+str(cls.server.server_port)
            cls.client,cls.token=administrator_client(cls.base)
        except BaseException:
            cls.cleanup();raise

    @classmethod
    def cleanup(cls):
        if hasattr(cls,'server'):
            cls.server.shutdown();cls.server.server_close();cls.thread.join()
        crm_data.connect_database,ispcrm.connect_database=cls.original_data,cls.original_server
        with psycopg.connect(**cls.settings,autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(cls.schema)))

    @classmethod
    def tearDownClass(cls):
        cls.cleanup()

    def request(self,path,payload=None,expected=200,anonymous=False):
        req=urllib.request.Request(self.base+path,data=json.dumps(payload,default=ispcrm.json_value).encode() if payload is not None else None,
                                  headers={'X-CRM-Token':self.token,'Content-Type':'application/json'})
        try:
            response=(urllib.request.build_opener() if anonymous else self.client).open(req)
        except urllib.error.HTTPError as exc:
            response=exc
        with response:
            data=json.load(response);self.assertEqual(response.status,expected,data);return data

    def customer(self,**changes):
        fields=dict(latitude='0',longitude='0',name='Invoice customer',phone='0',address='Test address',username='invoice-'+uuid.uuid4().hex,
                    package=str(self.package),monthly_fee=1,status='Active',joined='2026-01-31')
        fields.update(changes)
        self.request('/api/record',dict(section='Customers',fields=fields))
        row=next(c for c in self.request('/api/state')['records']['Customers'] if c['username']==fields['username'])
        return fields,row

    def test_automatic_monthly_generation_is_unique_and_skips_terminated(self):
        from datetime import date
        import crm_billing
        _,customer=self.customer()
        with self.connect() as db:
            crm_billing.generate_monthly_invoices(db,date(2027,1,1))
            crm_billing.generate_monthly_invoices(db,date(2027,1,2))
            crm_billing.generate_monthly_invoices(db,date(2027,2,1))
            rows=list(db.execute("SELECT * FROM invoices WHERE customer_id=%s AND billing_month IN ('2027-01','2027-02') ORDER BY billing_month",(customer['id'],)))
            self.assertEqual([r['billing_month'] for r in rows],['2027-01','2027-02'])
            self.assertEqual(rows[0]['amount'],1000)
            db.execute("UPDATE customers SET status='Terminated' WHERE id=%s",(customer['id'],))
            crm_billing.generate_monthly_invoices(db,date(2027,3,1))
            self.assertIsNone(db.execute("SELECT id FROM invoices WHERE customer_id=%s AND billing_month='2027-03'",(customer['id'],)).fetchone())

    def test_default_adjustable_expiry_and_validation(self):
        fields,row=self.customer()
        self.assertEqual(row['expiry_date'],'2026-03-02')
        fields['expiry_date']='2026-03-20'
        self.request('/api/record',dict(section='Customers',id=row['id'],fields=fields))
        fields.pop('expiry_date')
        fields['phone']='New phone'
        self.request('/api/record',dict(section='Customers',id=row['id'],fields=fields))
        persisted=next(c for c in self.request('/api/state')['records']['Customers'] if c['id']==row['id'])
        self.assertEqual(persisted['expiry_date'],'2026-03-20')
        fields['expiry_date']='2026-01-01'
        self.request('/api/record',dict(section='Customers',id=row['id'],fields=fields),400)
        fields['expiry_date']='invalid'
        self.request('/api/record',dict(section='Customers',id=row['id'],fields=fields),400)
        with self.connect() as db:
            inserted=db.execute("INSERT INTO customers(name,phone,address,username,package,monthly_fee,status,joined) VALUES ('Leap','0','','leap','Legacy',1000,'Active','2024-02-29') RETURNING expiry_date").fetchone()
            self.assertEqual(inserted['expiry_date'].isoformat(),'2024-03-30')
        crm_data.initialize_database()
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT expiry_date FROM customers WHERE id=%s',(row['id'],)).fetchone()['expiry_date'].isoformat(),'2026-03-20')

    def test_invoice_snapshot_reprints_and_month_specific_payments(self):
        fields,row=self.customer(expiry_date='2026-03-10')
        body=dict(customer_id=row['id'],billing_month='2026-03')
        invoice_id=self.request('/api/invoices',body)['id']
        self.assertEqual(self.request('/api/invoices',body)['id'],invoice_id)
        invoice=self.request('/api/invoices/'+str(invoice_id))
        self.assertEqual(invoice['invoice']['amount'],1000)
        self.assertEqual(invoice['invoice']['due_date'],'2026-03-10')
        fields.update(name='Changed customer',expiry_date='2026-04-20')
        self.request('/api/record',dict(section='Customers',id=row['id'],fields=fields))
        for month,amount in [('2026-03',200),('2026-02',500)]:
            self.request('/api/record',dict(section='Payments',fields=dict(customer_id=row['id'],amount=amount,payment_date='2026-03-01',billing_month=month,method='Cash',reference='')))
        result=self.request('/api/invoices/'+str(invoice_id))
        self.assertEqual(result['paid'],200);self.assertEqual(result['balance'],800)
        self.assertEqual(result['invoice']['customer_name'],'Invoice customer')
        self.assertEqual(result['invoice']['due_date'],'2026-03-10')
        self.request('/api/record',dict(section='Payments',fields=dict(customer_id=row['id'],amount=900,payment_date='2026-03-02',billing_month='2026-03',method='Cash',reference='')))
        result=self.request('/api/invoices/'+str(invoice_id))
        self.assertEqual(result['balance'],0);self.assertEqual(result['credit'],100)
        self.request('/api/invoices/'+str(invoice_id),expected=401,anonymous=True)
        self.request('/api/invoices',dict(body,billing_month='2026-13'),400)
        self.request('/api/invoices',dict(body,customer_id=999999),404)


if __name__=='__main__':
    unittest.main()
