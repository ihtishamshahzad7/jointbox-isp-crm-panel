"""Integration checks against an isolated PostgreSQL schema.

Run: python -m unittest discover -s tests -p test_tickets.py
"""
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


class TicketWorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings = crm_data.database_settings()
        cls.schema = 'crm_ticket_test_' + uuid.uuid4().hex
        cls.original_data_connect = crm_data.connect_database
        cls.original_server_connect = ispcrm.connect_database
        with psycopg.connect(**cls.settings, autocommit=True) as db:
            db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(cls.schema)))
        def isolated_connect():
            return psycopg.connect(**cls.settings, row_factory=dict_row,
                                  options='-c search_path=' + cls.schema)
        cls.connect = staticmethod(isolated_connect)
        crm_data.connect_database = ispcrm.connect_database = isolated_connect
        try:
            crm_data.initialize_database()
            with cls.connect() as db:
                cls.customer = db.execute("""INSERT INTO customers
                    (name,phone,address,username,package,monthly_fee,status,joined)
                    VALUES ('Test customer','0','','ticket-test','Legacy',1000,'Active','2026-10-19')
                    RETURNING id""").fetchone()['id']
                cls.staff = []
                for name, status in [('Technician A', 'Available'), ('Technician B', 'On duty'), ('On leave', 'On leave')]:
                    cls.staff.append(db.execute("""INSERT INTO staff (name,phone,role,area,status)
                        VALUES (%s,'0','Technician','Test area',%s) RETURNING id""", (name, status)).fetchone()['id'])
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
        crm_data.connect_database = cls.original_data_connect
        ispcrm.connect_database = cls.original_server_connect
        with psycopg.connect(**cls.settings, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(cls.schema)))

    @classmethod
    def tearDownClass(cls):
        cls.cleanup()

    def state(self):
        with self.opener.open(self.base + '/api/state') as response:
            return json.load(response)

    def post(self, fields=None, rid=None, section='Tickets', action=None, expected=200):
        request = urllib.request.Request(self.base + '/api/record',
            data=json.dumps(dict(section=section, id=rid, fields=fields, action=action)).encode(),
            headers={'Content-Type': 'application/json', 'X-CRM-Token': self.token})
        try:
            response = self.opener.open(request)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            result = json.load(response)
            self.assertEqual(response.status, expected, result)
        return result

    def fields(self):
        return dict(subject='Test issue ' + uuid.uuid4().hex, customer_id=self.customer,
                    assigned_to=None, type='Network outage', priority='High', status='Open',
                    due_date='2026-10-20', description='Customer has no connection.', resolution_notes='')

    def find(self, subject):
        return next(t for t in self.state()['records']['Tickets'] if t['subject'] == subject)

    def test_customer_portal_scope_password_reset_and_notifications(self):
        import http.cookiejar
        import crm_billing
        import crm_recharge
        import crm_customer_portal
        with self.connect() as db:
            c=db.execute('SELECT * FROM customers WHERE id=%s',(self.customer,)).fetchone()
            month=crm_recharge.local_today().strftime('%Y-%m')
            crm_billing.ensure_invoice(db,c,month,crm_recharge.local_today())
            other=db.execute("INSERT INTO customers(name,phone,address,username,package,monthly_fee,status,joined) VALUES ('Private other','0','',%s,'Legacy',2000,'Active','2026-10-19') RETURNING *",('private-'+uuid.uuid4().hex,)).fetchone()
            crm_billing.ensure_invoice(db,other,month,crm_recharge.local_today())
            crm_customer_portal.notify(db,other['id'],'Private notification','Other customer only','private')
        def request(path,payload=None,client=None,token=None,expected=200,staff=False):
            headers={'Content-Type':'application/json'}
            if token:headers['X-CRM-Token' if staff else 'X-Customer-Token']=token
            req=urllib.request.Request(self.base+path,data=json.dumps(payload).encode() if payload is not None else None,headers=headers)
            try:response=(client or urllib.request.build_opener()).open(req)
            except urllib.error.HTTPError as e:response=e
            with response:
                result=json.load(response);self.assertEqual(response.status,expected,result);return result
        access=request('/api/customer-portal/access',{'customer_id':c['id']},self.opener,self.token,staff=True)
        client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        request('/api/customer-app/login',{'payment_id':c['payment_id'],'password':access['temporary_password']},client)
        state=request('/api/customer-app/state',client=client)
        self.assertTrue(state['must_change']);self.assertNotIn('customer',state)
        request('/api/customer-app/password',{'current_password':access['temporary_password'],'new_password':'customer-password-123'},client,expected=403)
        request('/api/customer-app/password',{'current_password':access['temporary_password'],'new_password':'customer-password-123'},client,state['csrf'])
        state=request('/api/customer-app/state',client=client)
        self.assertFalse(state['must_change']);self.assertEqual(state['customer']['id'],c['id'])
        self.assertEqual(len(state['invoices']),1)
        self.assertFalse(any(n['title']=='Private notification' for n in state['notifications']))
        request('/api/state',client=client,expected=401)
        request('/api/customer-portal/access',{'customer_id':other['id']},client,state['csrf'],expected=401)
        request('/api/customer-portal/notify',{'customer_id':c['id'],'title':'Network notice','body':'Maintenance tonight'},self.opener,self.token,staff=True)
        state=request('/api/customer-app/state',client=client)
        self.assertTrue(any(n['title']=='Network notice' for n in state['notifications']))
        first_count=len(state['notifications'])
        self.assertEqual(len(request('/api/customer-app/state',client=client)['notifications']),first_count)
        request('/api/customer-portal/access',{'customer_id':c['id']},self.opener,self.token,staff=True)
        request('/api/customer-app/state',client=client,expected=401)

    def test_employee_registration_salary_and_private_fields(self):
        import crm_auth
        self.post(dict(name='Field engineer',status='Active'),section='Designations')
        fields=dict(name='Full registration '+uuid.uuid4().hex,phone='03000000000',role='Technician',area='Zone A',status='Available',employee_code='EMP-'+uuid.uuid4().hex[:8],father_name='Parent',cnic='12345-1234567-1',date_of_birth='1995-02-01',gender='Male',email='employee@example.com',address='Test address',emergency_contact_name='Family',emergency_contact_phone='03000000001',designation='Field engineer',department='Operations',employment_type='Permanent',joining_date='2026-01-01',monthly_salary='40000',allowances='5000',deductions='1000',bank_name='Test bank',account_number='1234')
        self.post(fields,section='Staff')
        row=next(r for r in self.state()['records']['Staff'] if r['name']==fields['name'])
        self.assertEqual(float(row['net_salary']),44000)
        self.assertEqual(row['emergency_contact_name'],'Family')
        # Legacy API edits preserve new registration and salary information.
        self.post(dict(name=fields['name'],phone='03000000002',role='Technician',area='Zone B',status='On duty'),rid=row['id'],section='Staff')
        updated=next(r for r in self.state()['records']['Staff'] if r['id']==row['id'])
        self.assertEqual(float(updated['monthly_salary']),40000)
        self.assertEqual(updated['cnic'],fields['cnic'])
        self.post(dict(fields,deductions='50000'),rid=row['id'],section='Staff',expected=400)
        with self.connect() as db:
            for role in ('Support','Viewer','Storekeeper'):
                public=next(r for r in crm_auth.read_records(db,dict(role=role,staff_id=None))['Staff'] if r['id']==row['id'])
                self.assertNotIn('monthly_salary',public)
                self.assertNotIn('cnic',public)
                self.assertNotIn('account_number',public)
                self.assertEqual(public['designation'],'Field engineer')

    def test_admin_tat_rules_apply_to_new_tickets_only(self):
        import crm_tat
        rule=next(r for r in self.state()['records']['TAT settings'] if r['ticket_type']=='Network outage' and r['priority']=='High')
        self.post(dict(ticket_type='Network outage',priority='High',hours=7),rid=rule['id'],section='TAT settings')
        fields=self.fields()
        self.post(fields)
        row=self.find(fields['subject'])
        self.assertEqual(row['tat_hours'],7)
        self.post(dict(ticket_type='Network outage',priority='High',hours=9),rid=rule['id'],section='TAT settings')
        self.assertEqual(self.find(fields['subject'])['tat_hours'],7)
        self.post(dict(ticket_type='Network outage',priority='High',hours=0),rid=rule['id'],section='TAT settings',expected=400)
        self.post(dict(ticket_type='Network outage',priority='High',hours=721),rid=rule['id'],section='TAT settings',expected=400)
        self.post(rid=rule['id'],section='TAT settings',action='delete',expected=400)
        self.assertTrue(any(r['hours']==9 and r['ticket_type']=='Network outage' and r['priority']=='High' for r in self.state()['tat_settings']))
        self.post(dict(ticket_type='Network outage',priority='High',hours=4),rid=rule['id'],section='TAT settings')

    def test_job_migration_and_unified_ticket_types(self):
        from crm_jobs_migration import migrate_jobs
        sources=[]
        with self.connect() as db:
            for kind,status in [('Installation','Open'),('Complaint','In progress'),('Maintenance','Completed'),('Collection','Open')]:
                sources.append(db.execute("INSERT INTO jobs(title,customer_id,staff_id,type,status,due_date,notes) VALUES (%s,%s,%s,%s,%s,'2026-10-20','Preserve these notes') RETURNING *",('Legacy '+kind,self.customer,self.staff[0],kind,status)).fetchone())
            self.assertEqual(migrate_jobs(db),4)
            self.assertEqual(migrate_jobs(db),0)
            for source in sources:
                ticket=db.execute('SELECT * FROM tickets WHERE source_job_id=%s',(source['id'],)).fetchone()
                self.assertEqual(ticket['assigned_to'],source['staff_id'])
                self.assertEqual(ticket['customer_id'],source['customer_id'])
                self.assertEqual(ticket['due_date'],source['due_date'])
                self.assertIn(source['notes'],ticket['description'])
                self.assertEqual(ticket['type'],source['type'])
                self.assertEqual(ticket['status'],'Resolved' if source['status']=='Completed' else source['status'])
                self.assertTrue(db.execute('SELECT 1 FROM ticket_events WHERE ticket_id=%s',(ticket['id'],)).fetchone())
        self.assertNotIn('Jobs',self.state()['schemas'])
        self.post({},section='Jobs',expected=403)
        for kind in ['Installation','Complaint','Maintenance','Collection']:
            fields=self.fields();fields['type']=kind
            self.post(fields)
            self.assertEqual(self.find(fields['subject'])['type'],kind)

    def test_tat_target_changes_and_reopening_preserves_original_clock(self):
        from datetime import datetime,timedelta
        fields=self.fields();fields.update(tat_hours=2,assigned_to=self.staff[0])
        self.post(fields)
        row=self.find(fields['subject'])
        start=datetime.fromisoformat(row['created_at']);due=datetime.fromisoformat(row['due_at'])
        self.assertAlmostEqual((due-start).total_seconds(),7200,delta=5)
        self.assertEqual(row['tat_hours'],2)
        fields['tat_hours']=4
        self.post(fields,row['id'])
        changed=self.find(fields['subject'])
        self.assertAlmostEqual((datetime.fromisoformat(changed['due_at'])-start).total_seconds(),14400,delta=5)
        fields.update(status='Resolved',resolution_notes='Fixed')
        self.post(fields,row['id'])
        closed=self.find(fields['subject'])
        self.assertTrue(closed['resolved_at'])
        fields.update(status='Open',resolution_notes='')
        self.post(fields,row['id'])
        reopened=self.find(fields['subject'])
        self.assertIsNone(reopened['resolved_at'])
        self.assertEqual(reopened['due_at'],changed['due_at'])
        self.assertEqual(reopened['created_at'],row['created_at'])
        self.assertTrue(any('TAT: 4 hours' in e['message'] for e in self.state()['ticket_activity'] if e['ticket_id']==row['id']))
        for value in (0,721,'1.5','bad'):
            fields['tat_hours']=value
            self.post(fields,row['id'],expected=400)

    def test_assignment_resolution_reopening_and_history(self):
        fields = self.fields()
        self.post(fields)
        row = self.find(fields['subject'])
        self.assertIsNone(row['assigned_to'])
        self.assertIsNone(row['resolved_at'])
        self.assertTrue(row['created_at'])
        rid = row['id']
        fields.update(assigned_to=self.staff[0], status='In progress')
        self.post(fields, rid)
        fields['assigned_to'] = self.staff[1]
        self.post(fields, rid)
        fields['status'] = 'Resolved'
        self.post(fields, rid, expected=400)
        self.assertEqual(self.find(fields['subject'])['status'], 'In progress')
        fields['resolution_notes'] = 'Replaced damaged fiber and verified connectivity.'
        self.post(fields, rid)
        resolved = self.find(fields['subject'])['resolved_at']
        self.assertTrue(resolved)
        fields['status'] = 'Closed'
        self.post(fields, rid)
        self.assertEqual(self.find(fields['subject'])['resolved_at'], resolved)
        fields['status'] = 'Open'
        self.post(fields, rid)
        self.assertIsNone(self.find(fields['subject'])['resolved_at'])
        events = [e for e in self.state()['ticket_activity'] if e['ticket_id'] == rid]
        self.assertEqual(len(events), 6)
        self.assertTrue(any('Technician B' in e['message'] for e in events))
        self.post(rid=rid, action='delete', expected=400)
        self.post(rid=self.staff[1], section='Staff', action='delete', expected=400)
        self.post(rid=self.customer, section='Customers', action='delete', expected=400)

    def test_invalid_assignments_and_required_fields(self):
        fields = self.fields()
        fields['assigned_to'] = 999999
        self.post(fields, expected=400)
        fields['assigned_to'] = self.staff[2]
        self.post(fields, expected=400)
        fields.update(assigned_to=None, status='In progress')
        self.post(fields, expected=400)
        fields.update(status='Open', description=' ')
        self.post(fields, expected=400)
        fields.update(description='Actual description', priority='Invalid')
        self.post(fields, expected=400)
        fields.update(priority='Urgent', customer_id=999999)
        self.post(fields, expected=400)
        fields.update(customer_id=self.customer, assigned_to=self.staff[0], status='Closed', resolution_notes='')
        self.post(fields, expected=400)
        self.assertFalse(any(t['subject'] == fields['subject'] for t in self.state()['records']['Tickets']))

    def test_existing_assignee_on_leave_and_schema_restart(self):
        fields = self.fields()
        fields['assigned_to'] = self.staff[0]
        self.post(fields)
        rid = self.find(fields['subject'])['id']
        with self.connect() as db:
            db.execute("UPDATE staff SET status='On leave' WHERE id=%s", (self.staff[0],))
        try:
            fields.update(status='Resolved', resolution_notes='Completed before leave.')
            self.post(fields, rid)
            crm_data.initialize_database()
            self.assertEqual(self.find(fields['subject'])['resolution_notes'], fields['resolution_notes'])
        finally:
            with self.connect() as db:
                db.execute("UPDATE staff SET status='Available' WHERE id=%s", (self.staff[0],))


if __name__ == '__main__':
    unittest.main()
