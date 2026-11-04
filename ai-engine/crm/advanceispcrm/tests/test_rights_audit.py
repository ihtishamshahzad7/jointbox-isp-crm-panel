"""Per-user custom rights, administrator-only deletes, activity log and the System & activity panel."""
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

import crm_auth
import crm_data
import ispcrm
from auth_client import administrator_client


class RightsAndAuditTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings=crm_data.database_settings()
        cls.schema='crm_rights_test_'+uuid.uuid4().hex
        cls.original_data,cls.original_server=crm_data.connect_database,ispcrm.connect_database
        with psycopg.connect(**cls.settings,autocommit=True) as db:
            db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(cls.schema)))
        def connect():
            return psycopg.connect(**cls.settings,row_factory=dict_row,options='-c search_path='+cls.schema)
        cls.connect=staticmethod(connect)
        crm_data.connect_database=ispcrm.connect_database=connect
        try:
            crm_data.initialize_database()
            cls.server=ispcrm.ThreadingHTTPServer(('127.0.0.1',0),ispcrm.Handler)
            cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
            cls.base='http://127.0.0.1:'+str(cls.server.server_port)
            cls.admin,cls.admin_token=administrator_client(cls.base)
        except BaseException:
            cls.cleanup()
            raise

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

    def setUp(self):
        crm_auth._attempts.clear()

    def request(self,path,payload=None,opener=None,token=None,expected=200):
        client=opener or urllib.request.build_opener()
        request=urllib.request.Request(self.base+path,
            data=json.dumps(payload,default=ispcrm.json_value).encode() if payload is not None else None,
            headers={'Content-Type':'application/json','X-CRM-Token':token or ''})
        try:
            response=client.open(request)
        except urllib.error.HTTPError as exc:
            response=exc
        with response:
            result=json.load(response)
            self.assertEqual(response.status,expected,result)
        return result

    def user(self,role='Viewer',permissions=None):
        username='rights-'+uuid.uuid4().hex[:12]
        fields=dict(name='Rights '+role,username=username,designation=role,role=role,status='Active',staff_id=None,
                    password='sample-password-123',permissions=json.dumps(permissions) if permissions is not None else '')
        self.request('/api/users',dict(fields=fields),self.admin,self.admin_token)
        row=next(u for u in self.request('/api/state',opener=self.admin)['records']['Users'] if u['username']==username)
        return fields,row

    def login(self,username,password='sample-password-123',expected=200):
        client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        token=self.request('/api/auth/status',opener=client)['token']
        result=self.request('/api/auth/login',dict(username=username,password=password),client,token,expected)
        return client,result.get('token')

    def package(self):
        fields=dict(name='Rights '+uuid.uuid4().hex[:8],service_provider='Transworld Panel',speed_mbps=10,monthly_price=1000,monthly_cost=0,installation_fee=0,status='Active')
        self.request('/api/record',dict(section='Packages',fields=fields),self.admin,self.admin_token)
        with self.connect() as db:
            return db.execute('SELECT id FROM packages WHERE name=%s',(fields['name'],)).fetchone()['id']

    def test_custom_rights_replace_role_defaults(self):
        # A Viewer normally reads everything and edits nothing; custom rights narrow reads and grant one module's edits.
        _,row=self.user('Viewer',{'read':['Customers'],'write':['Packages','Areas'],'delete':['Customers']})
        self.assertEqual(row['permissions'],{'read':['Customers','Packages','Areas'],'write':['Packages','Areas']})
        client,token=self.login(row['username'])
        state=self.request('/api/state',opener=client)
        self.assertEqual(set(state['schemas']),{'Customers','Packages'})
        self.assertEqual(state['permissions']['delete'],[])
        self.assertIsNone(state['rights_catalog'])
        self.request('/api/record',dict(section='Packages',fields=dict(name='Custom rights pkg',service_provider='Transworld Panel',speed_mbps=5,monthly_price=500,monthly_cost=0,installation_fee=0,status='Active')),client,token)
        self.request('/api/record',dict(section='Expenses',fields={}),client,token,expected=403)
        operations=self.request('/api/operations',opener=client)
        self.assertEqual(set(operations['modules']),{'Areas'})
        self.assertTrue(operations['modules']['Areas']['write'])
        # Clearing custom rights restores the role defaults.
        fields=dict(row,password='',permissions='');fields.pop('id');fields.pop('created_at')
        self.request('/api/users',dict(id=row['id'],fields=fields),self.admin,self.admin_token)
        client,_=self.login(row['username'])
        self.assertIn('Payments',self.request('/api/state',opener=client)['schemas'])

    def test_unknown_or_user_admin_rights_are_rejected(self):
        username='rights-'+uuid.uuid4().hex[:12]
        for rights in ({'read':['Users']},{'read':['Nope']},{'read':'Customers'}):
            fields=dict(name='Bad',username=username,designation='x',role='Viewer',status='Active',staff_id=None,password='sample-password-123',permissions=json.dumps(rights))
            self.request('/api/users',dict(fields=fields),self.admin,self.admin_token,expected=400)

    def test_only_administrators_delete(self):
        package=self.package()
        _,manager=self.user('Manager')
        client,token=self.login(manager['username'])
        self.assertEqual(self.request('/api/state',opener=client)['permissions']['delete'],[])
        self.request('/api/record',dict(section='Packages',id=package,action='delete'),client,token,expected=403)
        self.request('/api/record',dict(section='Packages',id=package,action='delete'),self.admin,self.admin_token)

    def test_activity_log_and_system_panel(self):
        _,row=self.user('Accountant')
        self.login(row['username'],'wrong-password',expected=400)
        client,token=self.login(row['username'])
        self.request('/api/state',opener=client)
        self.request('/api/admin/system?part=overview',opener=client,expected=403)
        self.request('/api/auth/logout',{},client,token)
        activity=self.request('/api/admin/system?part=activity&user='+str(row['id']),opener=self.admin)['activity']
        actions=[a['action'] for a in activity]
        for expected in ('Failed sign-in','Sign in','View','Sign out'):
            self.assertIn(expected,actions)
        self.assertEqual(next(a for a in activity if a['action']=='Sign in')['status'],200)
        everything=json.dumps(self.request('/api/admin/system?part=activity&kind=changes',opener=self.admin)['activity'])
        self.assertNotIn('sample-password-123',everything)
        self.assertIn('[hidden]',everything)
        overview=self.request('/api/admin/system?part=overview',opener=self.admin)
        self.assertGreater(overview['database_bytes'],0)
        self.assertGreaterEqual(len(overview['online']),1)
        user=next(u for u in overview['users'] if u['id']==row['id'])
        self.assertEqual(user['sign_ins'],1)
        self.assertIsNotNone(user['last_sign_in'])


class InventoryBatchTest(RightsAndAuditTest):
    # Reuses the isolated server and helpers; only the tests below run for this class.
    test_custom_rights_replace_role_defaults=test_unknown_or_user_admin_rights_are_rejected=None
    test_only_administrators_delete=test_activity_log_and_system_panel=None

    def setUp(self):
        super().setUp()
        import uuid as _uuid
        with self.connect() as db:
            db.execute("INSERT INTO categories(name,status) VALUES ('Batch test cat','Active') ON CONFLICT DO NOTHING")
            self.house='Batch store '+_uuid.uuid4().hex[:6]
            import crm_operations as ops
            admin=db.execute("SELECT * FROM app_users WHERE role='Administrator' ORDER BY id LIMIT 1").fetchone()
            ops.save(db,admin,dict(module='Warehouses',request_key=str(_uuid.uuid4()),fields=dict(name=self.house,status='Active')))

    def line(self,item,qty=5,cost=100):
        return dict(item=item,category='Batch test cat',quantity=qty,unit_cost=cost,selling_price=cost+20,minimum_stock=1)

    def test_whole_batch_saved_together_or_not_at_all(self):
        tag=uuid.uuid4().hex[:6]
        saved=self.request('/api/inventory-batch',dict(location=self.house,lines=[self.line('ONU '+tag),self.line('Router '+tag,2,3000),self.line('Patch cord '+tag,50,40)]),self.admin,self.admin_token)
        with self.connect() as db:
            rows=db.execute('SELECT * FROM inventory WHERE id=ANY(%s) ORDER BY id',(saved['ids'],)).fetchall()
        self.assertEqual(len(rows),3)
        self.assertEqual({r['batch'] for r in rows},{saved['batch']})
        self.assertRegex(saved['batch'],r'^B-\d{4}-\d{3}$')
        self.assertEqual({r['location'] for r in rows},{self.house})
        self.assertEqual(sum(r['quantity'] for r in rows),57)
        # One bad line (zero quantity) rejects the whole batch; nothing from it is saved.
        bad=self.request('/api/inventory-batch',dict(location=self.house,lines=[self.line('Splitter '+tag),self.line('Cable '+tag,0)]),self.admin,self.admin_token,expected=400)
        self.assertIn('Line 2',bad['error'])
        with self.connect() as db:
            self.assertIsNone(db.execute('SELECT 1 FROM inventory WHERE item=%s',('Splitter '+tag,)).fetchone())
        self.request('/api/inventory-batch',dict(location=self.house,lines=[self.line('Dup '+tag),self.line('dup '+tag)]),self.admin,self.admin_token,expected=400)
        self.request('/api/inventory-batch',dict(location='No such store',lines=[self.line('X '+tag)]),self.admin,self.admin_token,expected=400)
        # A Viewer cannot add stock.
        _,viewer=self.user('Viewer')
        client,token=self.login(viewer['username'])
        self.request('/api/inventory-batch',dict(location=self.house,lines=[self.line('Y '+tag)]),client,token,expected=403)
        # Ordinary record saves now appear in the activity log with their page.
        self.package()
        changes=self.request('/api/admin/system?part=activity&kind=changes',opener=self.admin)['activity']
        self.assertTrue(any(a['section']=='Packages' and a['action']=='Create' for a in changes))

    def download(self,invoice_id):
        with self.admin.open(self.base+'/api/attachment-files/'+str(invoice_id)) as response:
            return response.read()

    def test_batch_invoice_is_stored_once_and_shown_on_every_item(self):
        import base64
        tag=uuid.uuid4().hex[:6]
        pdf=b'%PDF-1.4 batch invoice '+tag.encode()
        files=[dict(name='supplier-bill.pdf',content=base64.b64encode(pdf).decode())]
        # An invalid invoice rejects the batch before any stock is added.
        self.request('/api/inventory-batch',dict(location=self.house,lines=[self.line('Bad inv '+tag)],files=[dict(name='x.pdf',content=base64.b64encode(b'not a pdf').decode())]),self.admin,self.admin_token,expected=400)
        with self.connect() as db:
            self.assertIsNone(db.execute('SELECT 1 FROM inventory WHERE item=%s',('Bad inv '+tag,)).fetchone())
        saved=self.request('/api/inventory-batch',dict(location=self.house,lines=[self.line('OLT '+tag),self.line('SFP '+tag),self.line('Splicer '+tag)],files=files),self.admin,self.admin_token)
        self.assertEqual(saved['invoices'],1)
        listings=[self.request(f'/api/attachments/Inventory/{i}',opener=self.admin)['invoices'] for i in saved['ids']]
        self.assertTrue(all(len(l)==1 and l[0]['original_name']=='supplier-bill.pdf' for l in listings))
        for listing in listings:
            self.assertEqual(self.download(listing[0]['id']),pdf)
        with self.connect() as db:
            files_kept=db.execute('SELECT count(DISTINCT file_id) AS n FROM record_invoices WHERE record_id=ANY(%s)',(saved['ids'],)).fetchone()['n']
            self.assertEqual(files_kept,1)
            self.assertEqual(db.execute("SELECT count(*) AS n FROM record_invoices WHERE record_id=ANY(%s) AND length(content)>0",(saved['ids'],)).fetchone()['n'],0)
        # Removing it from one item keeps it on the others; removing the last copy frees the stored file.
        self.request('/api/attachments',dict(action='delete',id=listings[0][0]['id']),self.admin,self.admin_token)
        self.assertEqual(self.download(listings[1][0]['id']),pdf)
        for listing in listings[1:]:
            self.request('/api/attachments',dict(action='delete',id=listing[0]['id']),self.admin,self.admin_token)
        with self.connect() as db:
            self.assertIsNone(db.execute('SELECT 1 FROM invoice_files f WHERE NOT EXISTS (SELECT 1 FROM record_invoices r WHERE r.file_id=f.id)').fetchone())
        # Attaching later from one item can cover its whole batch.
        added=self.request('/api/attachments',dict(section='Inventory',record_id=saved['ids'][0],files=files,whole_batch=True),self.admin,self.admin_token)
        self.assertEqual(added['uploaded'],1)
        self.assertTrue(all(len(self.request(f'/api/attachments/Inventory/{i}',opener=self.admin)['invoices'])==1 for i in saved['ids']))


class AssetBatchTest(RightsAndAuditTest):
    # Reuses the isolated server and helpers; only the tests below run for this class.
    test_custom_rights_replace_role_defaults=test_unknown_or_user_admin_rights_are_rejected=None
    test_only_administrators_delete=test_activity_log_and_system_panel=None

    def test_asset_batch_with_shared_invoice(self):
        import base64
        tag=uuid.uuid4().hex[:6]
        pdf=b'%PDF-1.4 asset invoice '+tag.encode()
        files=[dict(name='laptops.pdf',content=base64.b64encode(pdf).decode())]
        shared=dict(location='Head office '+tag,purchased_on='2026-10-20',condition='Good')
        lines=[dict(name='Laptop '+tag,serial='SN-1-'+tag,quantity=1,value=150000,notes='Manager'),
               dict(name='Laptop '+tag,serial='SN-2-'+tag,quantity=1,value=150000),dict(name='Chair '+tag,quantity=3,value=12000)]
        # Rejected batches save nothing: a serial on a multi-unit line, or a missing location.
        bad=self.request('/api/asset-batch',dict(shared,lines=[dict(name='Desk '+tag,serial='X',quantity=2,value=1)]),self.admin,self.admin_token,expected=400)
        self.assertIn('Line 1',bad['error'])
        self.request('/api/asset-batch',dict(shared,location='',lines=[dict(name='Desk '+tag,quantity=1,value=1)]),self.admin,self.admin_token,expected=400)
        saved=self.request('/api/asset-batch',dict(shared,lines=lines,files=files),self.admin,self.admin_token)
        self.assertEqual(len(saved['ids']),5)
        self.assertRegex(saved['batch'],r'^A-\d{4}-\d{3}$')
        state=self.request('/api/operations',opener=self.admin)
        assets=[r for r in state['records'] if r['id'] in saved['ids']]
        self.assertEqual({r['data']['batch'] for r in assets},{saved['batch']})
        self.assertEqual({r['data']['location'] for r in assets},{shared['location']})
        self.assertEqual(sorted(r['data']['serial'] for r in assets),sorted(['SN-1-'+tag,'SN-2-'+tag,'','','']))
        self.assertTrue(all(r['invoice_count']==1 for r in assets))
        self.assertIn('Batch',[f['name'] for f in state['modules']['Assets']['fields']])
        listing=self.request(f'/api/attachments/Assets/{saved["ids"][0]}',opener=self.admin)['invoices']
        with self.admin.open(self.base+'/api/attachment-files/'+str(listing[0]['id'])) as response:
            self.assertEqual(response.read(),pdf)
        # A later invoice can go on the whole batch from any one asset.
        self.request('/api/attachments',dict(section='Assets',record_id=saved['ids'][2],files=files,whole_batch=True),self.admin,self.admin_token)
        self.assertTrue(all(len(self.request(f'/api/attachments/Assets/{i}',opener=self.admin)['invoices'])==2 for i in saved['ids']))
        # Roles without Assets rights can neither add a batch nor see its invoices.
        _,viewer=self.user('Accountant')
        client,token=self.login(viewer['username'])
        self.request('/api/asset-batch',dict(shared,lines=lines),client,token,expected=403)
        self.request(f'/api/attachments/Assets/{saved["ids"][0]}',opener=client,expected=403)
        # The dashboard data carries assets only for roles allowed to see them.
        mine=[a for a in self.request('/api/state',opener=self.admin)['records']['Assets'] if a['id'] in saved['ids']]
        self.assertEqual(len(mine),5)
        self.assertEqual(sum(float(a['value']) for a in mine),2*150000+3*12000)
        self.assertNotIn('Assets',self.request('/api/state',opener=client)['records'])
        # Deleting an asset removes its invoice links; the shared files stay for the other assets.
        self.request('/api/operations',dict(module='Assets',id=saved['ids'][0],action='delete'),self.admin,self.admin_token)
        with self.connect() as db:
            self.assertIsNone(db.execute("SELECT 1 FROM record_invoices WHERE section='Assets' AND record_id=%s",(saved['ids'][0],)).fetchone())
        self.assertEqual(len(self.request(f'/api/attachments/Assets/{saved["ids"][1]}',opener=self.admin)['invoices']),2)


if __name__=='__main__':
    unittest.main()
