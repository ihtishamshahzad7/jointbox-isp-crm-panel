"""Payment-reference and private customer document integration tests."""
import base64
import concurrent.futures
import http.cookiejar
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


class CustomerDocumentsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings=crm_data.database_settings();cls.schema='crm_documents_test_'+uuid.uuid4().hex
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

    def request(self,path,payload=None,expected=200,client=None,token=None,raw=False):
        request=urllib.request.Request(self.base+path,data=json.dumps(payload,default=ispcrm.json_value).encode() if payload is not None else None,
            headers={'Content-Type':'application/json','X-CRM-Token':token or self.token})
        try:
            response=(client or self.client).open(request)
        except urllib.error.HTTPError as exc:
            response=exc
        with response:
            data=response.read();self.assertEqual(response.status,expected,data[:200]);return (data,response.headers) if raw else json.loads(data)

    def fields(self):
        return dict(latitude='0',longitude='0',name='Document customer',phone='0',address='',username='doc-'+uuid.uuid4().hex,
                    package=str(self.package),monthly_fee=1,status='Active',joined='2026-10-19')

    def document(self,content=b'%PDF-1.4\nSample document\n%%EOF',name='identity.pdf'):
        return dict(name=name,document_type='Identity - front',content=base64.b64encode(content).decode())

    def customer(self,documents=None):
        fields=self.fields()
        result=self.request('/api/record',dict(section='Customers',fields=fields,documents=documents or []))
        return fields,result['id']

    def test_customer_profile_filters_related_data_and_permissions(self):
        fields,rid=self.customer([self.document()])
        _,other=self.customer()
        updates=dict(fields,email='customer@example.test',cnic='12345-1234567-1',customer_type='Business')
        self.request('/api/record',dict(section='Customers',id=rid,fields=updates))
        # Older clients omitting the optional identity fields must preserve them.
        self.request('/api/record',dict(section='Customers',id=rid,fields=fields))
        for customer_id in (rid,other):
            self.request('/api/record',dict(section='Payments',fields=dict(customer_id=customer_id,amount=125,payment_date='2026-10-19',billing_month='2026-10',method='Cash',reference='Profile test')))
        profile=self.request(f'/api/customers/{rid}/profile')
        self.assertEqual(profile['customer']['email'],'customer@example.test')
        self.assertEqual(profile['customer']['customer_type'],'Business')
        self.assertEqual(len(profile['records']['Payments']),1)
        self.assertEqual(profile['records']['Payments'][0]['customer_id'],rid)
        self.assertEqual(len(profile['documents']),1)
        self.assertTrue(profile['documents'][0]['uploaded_name'])
        self.assertNotIn('content',profile['documents'][0])
        anonymous=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.request(f'/api/customers/{rid}/profile',expected=401,client=anonymous)
        self.request('/api/customers/999999999/profile',expected=404)
        username='profile-viewer-'+uuid.uuid4().hex
        self.request('/api/users',dict(fields=dict(latitude='0',longitude='0',name='Profile viewer',username=username,designation='Viewer',role='Viewer',status='Active',staff_id=None,password='viewer-password-123')))
        viewer=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        token=self.request('/api/auth/status',client=viewer)['token']
        self.request('/api/auth/login',dict(username=username,password='viewer-password-123'),client=viewer,token=token)
        restricted=self.request(f'/api/customers/{rid}/profile',client=viewer)
        self.assertFalse(restricted['access']['documents'])
        self.assertEqual(restricted['documents'],[])

    def test_deployment_coordinates_create_update_validation_and_preservation(self):
        fields=self.fields();fields.update(latitude='-33.1234567',longitude='151.7654321')
        rid=self.request('/api/record',dict(section='Customers',fields=fields))['id']
        profile=self.request(f'/api/customers/{rid}/profile')['customer']
        self.assertAlmostEqual(profile['latitude'],-33.1234567,places=7)
        self.assertAlmostEqual(profile['longitude'],151.7654321,places=7)
        fields.update(latitude='0',longitude='0')
        self.request('/api/record',dict(section='Customers',id=rid,fields=fields))
        legacy=dict(fields);legacy.pop('latitude');legacy.pop('longitude')
        self.request('/api/record',dict(section='Customers',id=rid,fields=legacy))
        self.assertEqual(self.request(f'/api/customers/{rid}/profile')['customer']['latitude'],0)
        for lat,lon in [('91','0'),('0','181'),('NaN','0'),('0','Infinity'),('','1'),('','')]:
            self.request('/api/record',dict(section='Customers',fields=dict(self.fields(),latitude=lat,longitude=lon)),400)
        missing=self.fields();missing.pop('latitude');missing.pop('longitude')
        self.request('/api/record',dict(section='Customers',fields=missing),400)
        self.request('/api/record',dict(section='Customers',id=rid,fields=dict(fields,latitude='',longitude='')),400)
        crm_data.initialize_database()
        saved=self.request(f'/api/customers/{rid}/profile')['customer']
        self.assertEqual(saved['latitude'],0)
        self.assertEqual(saved['longitude'],0)

    def test_payment_ids_unique_immutable_and_concurrent(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            rows=list(pool.map(lambda _:self.customer(),range(6)))
        ids=[]
        with self.connect() as db:
            for _,rid in rows:
                ids.append(db.execute('SELECT payment_id FROM customers WHERE id=%s',(rid,)).fetchone()['payment_id'])
        self.assertEqual(len(ids),len(set(ids)))
        for payment_id in ids:self.assertRegex(payment_id,r'^[0-9]{9}$')
        fields,rid=rows[0];fields.update(username='renamed-'+uuid.uuid4().hex,payment_id='999999999')
        self.request('/api/record',dict(section='Customers',id=rid,fields=fields))
        crm_data.initialize_database()
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT payment_id FROM customers WHERE id=%s',(rid,)).fetchone()['payment_id'],ids[0])
            with self.assertRaises(psycopg.IntegrityError):
                with db.transaction():
                    db.execute("UPDATE customers SET payment_id='999999999' WHERE id=%s",(rid,))

    def test_creation_upload_download_and_later_documents(self):
        pdf=self.document();fields,rid=self.customer([pdf])
        listing=self.request(f'/api/customers/{rid}/documents')['documents'];self.assertEqual(len(listing),1)
        self.assertNotIn('content',listing[0]);self.assertNotIn('content',json.dumps(self.request('/api/state')))
        data,headers=self.request('/api/customer-documents/'+str(listing[0]['id']),raw=True)
        self.assertEqual(data,base64.b64decode(pdf['content']));self.assertIn('attachment',headers['Content-Disposition'])
        self.assertEqual(headers['X-Content-Type-Options'],'nosniff')
        png=self.document(b'\x89PNG\r\n\x1a\nSample image','../customer.png')
        self.request('/api/customer-documents',dict(customer_id=rid,documents=[png]))
        listing=self.request(f'/api/customers/{rid}/documents')['documents'];self.assertEqual(len(listing),2)
        self.assertEqual(listing[0]['original_name'],'customer.png')
        self.request('/api/customer-documents',dict(action='delete',id=listing[0]['id']))
        self.request('/api/customer-documents/'+str(listing[0]['id']),expected=404)
        self.assertEqual(len(self.request(f'/api/customers/{rid}/documents')['documents']),1)
        self.request('/api/record',dict(section='Customers',action='delete',id=rid),400)
        invoice=self.request('/api/invoices',dict(customer_id=rid,billing_month='2026-10'))
        saved=self.request('/api/invoices/'+str(invoice['id']))['invoice']
        with self.connect() as db:
            self.assertEqual(saved['payment_id'],db.execute('SELECT payment_id FROM customers WHERE id=%s',(rid,)).fetchone()['payment_id'])

    def test_invalid_documents_roll_back_customer_and_upload_batch(self):
        fields=self.fields()
        bad=self.document(b'<script>unsafe</script>','identity.pdf')
        self.request('/api/record',dict(section='Customers',fields=fields,documents=[self.document(),bad]),400)
        with self.connect() as db:
            self.assertFalse(db.execute('SELECT 1 FROM customers WHERE username=%s',(fields['username'],)).fetchone())
        _,rid=self.customer()
        for batch in [[bad],[self.document(name='malware.exe')],[self.document(b'','empty.pdf')],
                      [dict(self.document(),content='not base64!')],[self.document()]*6,
                      [self.document(b'%PDF-'+b'x'*(5*1024*1024),'large.pdf')]]:
            self.request('/api/customer-documents',dict(customer_id=rid,documents=batch),400)
        self.request('/api/customer-documents',dict(customer_id=rid,documents=[self.document(),bad]),400)
        self.assertEqual(self.request(f'/api/customers/{rid}/documents')['documents'],[])

    def test_private_documents_require_authorized_role(self):
        _,rid=self.customer([self.document()]);doc_id=self.request(f'/api/customers/{rid}/documents')['documents'][0]['id']
        anonymous=urllib.request.build_opener()
        self.request('/api/customer-documents/'+str(doc_id),expected=401,client=anonymous)
        username='viewer-'+uuid.uuid4().hex
        self.request('/api/users',dict(fields=dict(latitude='0',longitude='0',name='Viewer',username=username,designation='Viewer',role='Viewer',status='Active',staff_id=None,password='viewer-password-123')))
        viewer=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        token=self.request('/api/auth/status',client=viewer)['token']
        token=self.request('/api/auth/login',dict(username=username,password='viewer-password-123'),client=viewer,token=token)['token']
        self.request(f'/api/customers/{rid}/documents',expected=403,client=viewer)
        self.request('/api/customer-documents/'+str(doc_id),expected=403,client=viewer)
        self.request('/api/customer-documents',dict(customer_id=rid,documents=[self.document()]),403,viewer,token)


if __name__=='__main__':
    unittest.main()
