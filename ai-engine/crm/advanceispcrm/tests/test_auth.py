"""Account/session/permission integration checks in an isolated PostgreSQL schema."""
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


class AuthenticationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings=crm_data.database_settings()
        cls.schema='crm_auth_test_'+uuid.uuid4().hex
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

    def test_email_recovery_single_use_expiry_and_session_revocation(self):
        from unittest.mock import patch
        import crm_password_recovery as recovery
        with self.connect() as db:
            staff=db.execute("INSERT INTO staff(name,phone,role,area,status,email) VALUES ('Recovery employee','0','Support','','Available','recovery@example.com') RETURNING id").fetchone()['id']
        fields,user=self.user(staff_id=staff)
        client,_=self.login(fields['username'])
        public=self.request('/api/auth/status')['token']
        with patch.object(recovery,'settings',return_value={}),patch.object(recovery,'send') as send:
            unknown=self.request('/api/auth/forgot-password',{'email':'unknown@example.com'},token=public)
            known=self.request('/api/auth/forgot-password',{'email':'recovery@example.com'},token=public)
            self.assertEqual(unknown,known)
            token=send.call_args.args[2]
            with self.connect() as db:
                saved=db.execute('SELECT * FROM password_resets WHERE user_id=%s',(user['id'],)).fetchone()
                self.assertNotEqual(saved['token_hash'],token)
            self.request('/api/auth/reset-password',{'token':token,'password':'new-recovery-password'},token=public)
            self.request('/api/state',opener=client,expected=401)
            self.request('/api/auth/reset-password',{'token':token,'password':'another-password'},token=public,expected=400)
            self.login(fields['username'],'new-recovery-password')
            with self.connect() as db:db.execute('DELETE FROM password_resets WHERE user_id=%s',(user['id'],))
            self.request('/api/auth/forgot-password',{'email':'recovery@example.com'},token=public)
            token=send.call_args.args[2]
            with self.connect() as db:db.execute("UPDATE password_resets SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE user_id=%s",(user['id'],))
            self.request('/api/auth/reset-password',{'token':token,'password':'another-password'},token=public,expected=400)

    def test_employee_codes_are_generated_and_stable(self):
        import concurrent.futures
        def register(_):
            with self.connect() as db:
                return db.execute("INSERT INTO staff(name,phone,role,area,status) VALUES ('Auto employee','0','Support','','Available') RETURNING id,employee_code").fetchone()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            employees=list(pool.map(register,range(8)))
        codes=[s['employee_code'] for s in employees]
        self.assertEqual(len(set(codes)),8)
        for code in codes:self.assertRegex(code,r'^EMP-\d{6,}$')
        with self.connect() as db:
            first=employees[0]
            db.execute('UPDATE staff SET phone=%s WHERE id=%s',('123',first['id']))
            self.assertEqual(db.execute('SELECT employee_code FROM staff WHERE id=%s',(first['id'],)).fetchone()['employee_code'],first['employee_code'])
            import crm_employee_codes
            crm_employee_codes.initialize(db)
            self.assertEqual(db.execute('SELECT employee_code FROM staff WHERE id=%s',(first['id'],)).fetchone()['employee_code'],first['employee_code'])

    def test_employee_hierarchy_rejects_self_and_circular_reporting(self):
        from crm_employee_hierarchy import validate_staff_hierarchy,validate_designation
        with self.connect() as db:
            first=db.execute("INSERT INTO staff(name,phone,role,area,status) VALUES ('Manager','0','Manager','','Available') RETURNING id").fetchone()['id']
            second=db.execute("INSERT INTO staff(name,phone,role,area,status,reports_to) VALUES ('Technician','0','Technician','','Available',%s) RETURNING id",(first,)).fetchone()['id']
            with self.assertRaisesRegex(ValueError,'cycle'):
                validate_staff_hierarchy(db,dict(reports_to=first),first)
            with self.assertRaisesRegex(ValueError,'cycle'):
                validate_staff_hierarchy(db,dict(reports_to=second),first)
            fields=dict(reports_to=first,designation='Network Engineer')
            validate_staff_hierarchy(db,fields,second)
            self.assertEqual(fields['reports_to'],first)
            with self.assertRaisesRegex(ValueError,'active designation'):
                validate_staff_hierarchy(db,dict(designation='Missing designation'),second)
            designation=db.execute("INSERT INTO designations(name,status) VALUES ('Test designation','Active') RETURNING id").fetchone()['id']
            db.execute("UPDATE staff SET designation='Test designation' WHERE id=%s",(second,))
            validate_designation(db,dict(name='Senior technician'),designation)
            self.assertEqual(db.execute('SELECT designation FROM staff WHERE id=%s',(second,)).fetchone()['designation'],'Senior technician')

    def test_staff_reporting_relationship_through_api(self):
        fields=dict(name='Reporting manager',phone='0',role='Manager',area='',status='Available',designation='Network Engineer',email='manager@example.com',reports_to='')
        self.request('/api/record',dict(section='Staff',fields=fields),self.admin,self.admin_token)
        rows=self.request('/api/state',opener=self.admin)['records']['Staff']
        manager=next(row for row in rows if row['email']==fields['email'])
        fields.update(name='Reporting employee',email='employee@example.com',reports_to=manager['id'])
        self.request('/api/record',dict(section='Staff',fields=fields),self.admin,self.admin_token)
        employee=next(row for row in self.request('/api/state',opener=self.admin)['records']['Staff'] if row['email']==fields['email'])
        self.assertEqual(employee['reports_to'],manager['id'])
        self.assertTrue(employee['employee_code'].startswith('EMP-'))
        fields.update(name=manager['name'],email=manager['email'],reports_to=employee['id'])
        self.request('/api/record',dict(section='Staff',id=manager['id'],fields=fields),self.admin,self.admin_token,expected=400)

    def test_assistant_requires_auth_and_respects_finance_permissions(self):
        from unittest.mock import patch
        import crm_assistant
        self.request('/api/assistant',dict(question='business summary'),expected=401)
        self.request('/api/assistant',dict(question='business summary'),self.admin,'wrong-token',expected=403)
        fields,_=self.user(role='Support')
        client,token=self.login(fields['username'])
        with patch.object(crm_assistant,'config',return_value=dict(enabled=False)):
            response=self.request('/api/assistant',dict(question='How do monthly invoices work?',mode='guide'),client,token)
            self.assertEqual(response['mode'],'guide')
            self.assertIn('Finance → Monthly invoices',response['answer'])
            self.assertNotIn('Collections:',response['answer'])
            response=self.request('/api/assistant',dict(question='business summary',mode='guide'),self.admin,self.admin_token)
            self.assertIn('Collections:',response['answer'])
            self.request('/api/assistant',dict(question='x'*2001),self.admin,self.admin_token,expected=400)

    def test_assistant_provider_uses_scoped_snapshot_without_secrets(self):
        from unittest.mock import patch,MagicMock
        import crm_assistant
        fake=MagicMock();fake.__enter__.return_value.read.return_value=json.dumps({'output':[{'type':'message','content':[{'type':'output_text','text':'Test AI answer'}]}]}).encode()
        fields,_=self.user(role='Support');client,token=self.login(fields['username'])
        with patch.object(crm_assistant,'config',return_value=dict(enabled=True,api_key='test-only-secret',model='test-model')),patch.object(crm_assistant.urllib.request,'urlopen',return_value=fake) as call:
            response=self.request('/api/assistant',dict(question='ticket summary',mode='ai'),client,token)
            self.assertEqual(response['answer'],'Test AI answer')
            request=call.call_args.args[0];body=json.loads(request.data)
            self.assertFalse(body['store'])
            self.assertNotIn('tools',body)
            self.assertNotIn('test-only-secret',request.data.decode())
            context=json.loads(body['input'][0]['content'])['workspace_snapshot']
            self.assertNotIn('finance',context)
            self.assertNotIn('salary',json.dumps(context))
            self.assertNotIn('password',json.dumps(context))

    def user(self,role='Viewer',staff_id=None):
        username='test-'+uuid.uuid4().hex
        fields=dict(name='Test '+role,username=username,designation=role,role=role,status='Active',staff_id=staff_id,password='sample-password-123')
        self.request('/api/users',dict(fields=fields),self.admin,self.admin_token)
        row=next(u for u in self.request('/api/state',opener=self.admin)['records']['Users'] if u['username']==username)
        return fields,row

    def login(self,username,password='sample-password-123',expected=200):
        client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        token=self.request('/api/auth/status',opener=client)['token']
        result=self.request('/api/auth/login',dict(username=username,password=password),client,token,expected)
        return client,result.get('token')

    def test_no_anonymous_access_and_no_password_leaks(self):
        self.request('/api/state',expected=401)
        self.request('/api/record',dict(section='Customers'),token=ispcrm.TOKEN,expected=401)
        status=self.request('/api/auth/status')
        self.assertFalse(status['setup_required'])
        self.assertIsNone(status['user'])
        self.request('/api/auth/setup',dict(name='Intruder',username='intruder',password='irrelevant-password'),token=status['token'],expected=400)
        state=self.request('/api/state',opener=self.admin)
        self.assertNotIn('password_hash',json.dumps(state))
        self.assertNotIn('password_hash',json.dumps(self.request('/api/auth/status',opener=self.admin)))
        self.request('/api/record',dict(section='Staff',fields={}),self.admin,ispcrm.TOKEN,403)

    def test_account_creation_validation_and_last_administrator(self):
        fields,row=self.user()
        self.request('/api/users',dict(fields=fields),self.admin,self.admin_token,400)
        self.request('/api/users',dict(fields=dict(fields,username='weak-'+uuid.uuid4().hex,password='short')),self.admin,self.admin_token,400)
        self.request('/api/users',dict(fields=dict(fields,username='tech-'+uuid.uuid4().hex,role='Technician')),self.admin,self.admin_token,400)
        self.request('/api/users',dict(id=row['id'],action='delete'),self.admin,self.admin_token,400)
        admin=self.request('/api/auth/status',opener=self.admin)['user']
        self.request('/api/users',dict(id=admin['id'],fields=dict(admin,status='Inactive')),self.admin,self.admin_token,400)
        self.request('/api/users',dict(id=admin['id'],fields=dict(admin,role='Viewer')),self.admin,self.admin_token,400)
        with self.connect() as db:
            stored=db.execute('SELECT password_hash FROM app_users WHERE id=%s',(row['id'],)).fetchone()['password_hash']
            self.assertNotEqual(stored,fields['password'])
            self.assertTrue(crm_auth.verify_password(fields['password'],stored))

    def test_viewer_and_manager_cannot_manage_accounts(self):
        for role in ['Viewer','Manager','Accountant','Support','Storekeeper']:
            fields,_=self.user(role)
            client,token=self.login(fields['username'])
            state=self.request('/api/state',opener=client)
            self.assertNotIn('Users',state['schemas'])
            self.assertNotIn('Users',state['records'])
            self.request('/api/users',dict(fields=fields),client,token,403)
            if role=='Viewer':
                self.request('/api/record',dict(section='Staff',fields={}),client,token,403)
            if role in ['Support','Storekeeper']:
                self.assertEqual(state['records']['Expenses'],[])
                self.assertNotIn('Expenses',state['schemas'])
                self.request('/api/record',dict(section='Expenses',fields={}),client,token,403)

    def test_technician_scope_and_assigned_ticket_resolution(self):
        with self.connect() as db:
            staff=[]
            for name in ['Tech A','Tech B']:
                staff.append(db.execute("INSERT INTO staff(name,phone,role,area,status) VALUES (%s,'0','Technician','','Available') RETURNING id",(name,)).fetchone()['id'])
            customer=db.execute("INSERT INTO customers(name,phone,address,username,package,monthly_fee,status,joined) VALUES ('Customer','0','','scope','Legacy',1000,'Active','2026-10-19') RETURNING id").fetchone()['id']
            tickets=[]
            for employee in staff:
                tickets.append(db.execute("""INSERT INTO tickets(subject,customer_id,assigned_to,type,priority,status,due_date,description,resolution_notes)
                    VALUES ('Issue',%s,%s,'Network outage','High','Open','2026-10-20','No connection','') RETURNING *""",(customer,employee)).fetchone())
        fields,_=self.user('Technician',staff[0]);client,token=self.login(fields['username'])
        state=self.request('/api/state',opener=client)
        self.assertEqual([t['id'] for t in state['records']['Tickets']],[tickets[0]['id']])
        self.assertEqual(state['records']['Invoices'],[])
        self.assertEqual(state['records']['Recharges'],[])
        own=dict(tickets[0],status='Resolved',resolution_notes='Fiber repaired.')
        self.request('/api/record',dict(section='Tickets',id=own['id'],fields=own),client,token)
        self.request('/api/record',dict(section='Tickets',id=own['id'],fields=dict(own,assigned_to=staff[1])),client,token,403)
        self.request('/api/record',dict(section='Tickets',id=own['id'],fields=dict(own,tat_hours=own['tat_hours']+1)),client,token,403)
        self.request('/api/record',dict(section='Tickets',id=tickets[1]['id'],fields=tickets[1]),client,token,403)
        self.request('/api/record',dict(section='Tickets',fields=own),client,token,403)
        self.request('/api/record',dict(section='Staff',fields={}),client,token,403)

    def test_password_change_logout_deactivation_and_expiry(self):
        fields,row=self.user();client,token=self.login(fields['username'])
        self.request('/api/auth/password',dict(current_password='incorrect',new_password='new-password-123'),client,token,400)
        self.request('/api/auth/password',dict(current_password=fields['password'],new_password='new-password-123'),client,token)
        self.request('/api/state',opener=client,expected=401)
        self.login(fields['username'],fields['password'],400)
        client,token=self.login(fields['username'],'new-password-123')
        self.request('/api/auth/logout',{},client,token)
        self.request('/api/state',opener=client,expected=401)
        client,token=self.login(fields['username'],'new-password-123')
        with self.connect() as db:
            db.execute("UPDATE app_sessions SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE user_id=%s",(row['id'],))
        self.request('/api/state',opener=client,expected=401)
        client,token=self.login(fields['username'],'new-password-123')
        self.request('/api/users',dict(id=row['id'],fields=dict(fields,status='Inactive',password='')),self.admin,self.admin_token)
        self.request('/api/state',opener=client,expected=401)
        self.login(fields['username'],'new-password-123',400)

    def test_login_attempt_limit(self):
        fields,_=self.user()
        for _ in range(10):
            self.login(fields['username'],'wrong-password',400)
        _,_=self.login(fields['username'],'sample-password-123',400)


if __name__=='__main__':
    unittest.main()
