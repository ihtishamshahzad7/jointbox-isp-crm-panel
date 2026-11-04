"""Confirmed payment and customer recharge integration tests."""
import json
import concurrent.futures
from datetime import timedelta
from unittest.mock import patch
import crm_recharge
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


class RechargeTest(unittest.TestCase):
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

    def recharge_customer(self, **changes):
        today=crm_recharge.local_today()
        return self.customer(joined=(today-timedelta(days=60)).isoformat(),expiry_date=(today-timedelta(days=1)).isoformat(),status='Suspended',**changes)[1]

    def pay(self, customer, amount=1000, month=None, request_key=None, expected=200):
        today=crm_recharge.local_today()
        fields=dict(customer_id=customer['id'],amount=amount,payment_date=today.isoformat(),billing_month=month or today.strftime('%Y-%m'),method='Cash',reference='Confirmed test receipt')
        return self.request('/api/record',dict(section='Payments',fields=fields,request_key=request_key or str(uuid.uuid4())),expected)

    def stored_customer(self, rid):
        with self.connect() as db:
            return db.execute('SELECT * FROM customers WHERE id=%s',(rid,)).fetchone()

    def test_service_invoice_ledger_and_allocated_payments(self):
        day=crm_recharge.local_today();month=day.strftime('%Y-%m')
        _,customer=self.customer(installation_charge=0)
        saved=self.request('/api/invoices',dict(customer_id=customer['id'],billing_month=month))
        payload=dict(customer_id=customer['id'],description='Router installation labour',service_date=day.isoformat(),amount=500,request_key=str(uuid.uuid4()))
        service=self.request('/api/customer-services',payload)['service']
        self.assertEqual(self.request('/api/customer-services',payload)['service']['id'],service['id'])
        bill=self.request('/api/invoices/'+str(saved['id']))
        self.assertEqual(float(bill['services']['amount']),500)
        self.assertEqual(float(bill['total']),1500)
        self.pay(customer,1500,expected=400)
        self.pay(customer,1000)
        bill=self.request('/api/invoices/'+str(saved['id']))
        self.assertEqual(float(bill['balance']),500)
        fields=dict(customer_id=customer['id'],amount=200,payment_date=day.isoformat(),billing_month=month,method='Cash',reference='Service collection',revenue_type='OTC',otc_type='Service',service_charge_id=service['id'])
        key=str(uuid.uuid4());payment=dict(section='Payments',fields=fields,request_key=key)
        self.request('/api/record',payment);self.request('/api/record',payment)
        self.assertEqual(float(self.request('/api/invoices/'+str(saved['id']))['balance']),300)
        self.request('/api/record',dict(section='Payments',fields=dict(fields,amount=301),request_key=str(uuid.uuid4())),400)
        self.request('/api/record',dict(section='Payments',fields=dict(fields,amount=300),request_key=str(uuid.uuid4())))
        profile=self.request('/api/customers/'+str(customer['id'])+'/profile')
        self.assertEqual(float(profile['ledger']['debits']),1500)
        self.assertEqual(float(profile['ledger']['credits']),1500)
        self.assertEqual(float(profile['ledger']['balance']),0)
        self.assertEqual(len(profile['records']['Payments']),3)
        self.assertEqual(float(profile['services'][0]['due']),0)
        prior=(day.replace(day=1)-timedelta(days=1)).isoformat()
        self.request('/api/customer-services',dict(payload,request_key=str(uuid.uuid4()),description='Previous month visit',service_date=prior,amount=250))
        bill=self.request('/api/invoices/'+str(saved['id']))
        self.assertEqual(float(bill['previous_balance']),250)
        self.assertEqual(float(bill['balance']),250)
        self.request('/api/customer-services',payload,401,anonymous=True)

    def test_expired_recovery_ticket_lifecycle(self):
        import crm_termination
        day=crm_recharge.local_today()
        customer=self.customer(joined=(day-timedelta(days=60)).isoformat(),expiry_date=(day-timedelta(days=4)).isoformat(),status='Suspended')[1]
        with self.connect() as db:
            crm_termination.generate_expiry_recovery(db,day)
            self.assertIsNone(db.execute('SELECT id FROM tickets WHERE customer_id=%s',(customer['id'],)).fetchone())
            db.execute('UPDATE customers SET expiry_date=%s WHERE id=%s',(day-timedelta(days=5),customer['id']))
            crm_termination.generate_expiry_recovery(db,day)
            crm_termination.generate_expiry_recovery(db,day)
            tickets=list(db.execute('SELECT * FROM tickets WHERE customer_id=%s',(customer['id'],)))
            self.assertEqual(len(tickets),1)
            self.assertEqual(tickets[0]['status'],'Open')
            ticket_id=tickets[0]['id']
        self.pay(customer,500)
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT status FROM tickets WHERE id=%s',(ticket_id,)).fetchone()['status'],'Open')
        self.pay(customer,500)
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT status FROM tickets WHERE id=%s',(ticket_id,)).fetchone()['status'],'Resolved')
            # A distinct expiry cycle can open a new recovery ticket.
            db.execute('UPDATE customers SET expiry_date=%s WHERE id=%s',(day-timedelta(days=6),customer['id']))
            crm_termination.generate_expiry_recovery(db,day)
            self.assertEqual(db.execute("SELECT COUNT(*) AS n FROM tickets WHERE customer_id=%s AND status='Open'",(customer['id'],)).fetchone()['n'],1)
            crm_termination.refresh_recovery(db,customer['id'])
            self.assertEqual(db.execute("SELECT COUNT(*) AS n FROM tickets WHERE customer_id=%s AND status='Open'",(customer['id'],)).fetchone()['n'],0)
            crm_termination.generate_expiry_recovery(db,day)
            self.assertEqual(db.execute('SELECT COUNT(*) AS n FROM tickets WHERE customer_id=%s',(customer['id'],)).fetchone()['n'],2)

    def test_installation_charges_and_receipts(self):
        customer=self.recharge_customer()
        self.assertEqual(float(customer['installation_charge']),2000)
        fields=dict(customer_id=customer['id'],amount=500,payment_date=crm_recharge.local_today().isoformat(),billing_month=crm_recharge.local_today().strftime('%Y-%m'),method='Cash',reference='Installation deposit',revenue_type='OTC',otc_type='Installation')
        key=str(uuid.uuid4())
        payload=dict(section='Payments',fields=fields,request_key=key)
        self.request('/api/record',payload)
        self.request('/api/record',payload)
        quote=self.request('/api/customers/'+str(customer['id'])+'/billing?month='+fields['billing_month'])
        self.assertEqual(float(quote['installation_due']),1500)
        self.assertEqual(float(quote['paid']),0)
        self.assertEqual(self.stored_customer(customer['id'])['status'],'Suspended')
        payment=next(p for p in self.request('/api/state')['records']['Payments'] if p['customer_id']==customer['id'])
        receipt=self.request('/api/receipts/'+str(payment['id']))['receipt']
        self.assertEqual(receipt['otc_type'],'Installation')
        fields['amount']=1501
        self.request('/api/record',dict(section='Payments',fields=fields,request_key=str(uuid.uuid4())),400)
        fields['amount']=1500
        self.request('/api/record',dict(section='Payments',fields=fields,request_key=str(uuid.uuid4())))
        profile=self.request('/api/customers/'+str(customer['id'])+'/profile')
        self.assertEqual(float(profile['installation']['due']),0)

    def incoming(self, provider, payload, expected=200, signed=True):
        import hashlib,hmac,time
        raw=json.dumps(payload).encode()
        stamp=str(int(time.time()))
        secret='test-only-bridge-key-not-a-real-secret-'+provider
        signature=hmac.new(secret.encode(),stamp.encode()+b'.'+provider.encode()+b'.'+raw,hashlib.sha256).hexdigest() if signed else 'invalid'
        req=urllib.request.Request(self.base+'/api/payments/incoming',data=raw,headers={'Content-Type':'application/json','X-CRM-Payment-Provider':provider,'X-CRM-Payment-Timestamp':stamp,'X-CRM-Payment-Signature':signature})
        try:
            response=urllib.request.urlopen(req)
        except urllib.error.HTTPError as error:
            response=error
        with response:
            result=json.load(response)
            self.assertEqual(response.status,expected,result)
            return result

    def test_online_receipts_match_payment_id_require_signature_and_deduplicate(self):
        import os,crm_gateway
        from datetime import datetime,timezone
        keys={env:'test-only-bridge-key-not-a-real-secret-'+provider for provider,env in crm_gateway.PROVIDERS.items()}
        with patch.dict(os.environ,keys):
            for provider in crm_gateway.PROVIDERS:
                customer=self.recharge_customer()
                payload=dict(payment_id=customer['payment_id'],amount='1000',status='paid',transaction_id='online-'+uuid.uuid4().hex,paid_at=datetime.now(timezone.utc).isoformat())
                self.incoming(provider,payload,expected=403,signed=False)
                self.incoming(provider,dict(payload,status='pending'),expected=400)
                self.assertEqual(self.stored_customer(customer['id'])['status'],'Suspended')
                result=self.incoming(provider,payload)
                self.assertTrue(result['recharge']['activated'])
                repeat=self.incoming(provider,payload)
                self.assertEqual(repeat['id'],result['id'])
                receipt=self.request('/api/receipts/'+str(result['id']))['receipt']
                self.assertEqual(receipt['method'],provider)
                self.assertEqual(receipt['reference'],payload['transaction_id'])
                self.incoming(provider,dict(payload,amount='999'),expected=400)
                self.assertEqual(self.stored_customer(customer['id'])['status'],'Active')
                profile=self.request(f"/api/customers/{customer['id']}/profile")
                self.assertEqual(len(profile['records']['Payments']),1)
                self.assertEqual(profile['records']['Payments'][0]['method'],provider)
                self.request('/api/record',dict(section='Payments',fields=dict(customer_id=customer['id'],amount=1000,payment_date=crm_recharge.local_today().isoformat(),billing_month=crm_recharge.local_today().strftime('%Y-%m'),method=provider,reference='fake')),403)
                self.request('/api/record',dict(section='Payments',id=result['id'],action='delete'),403)
        with patch.dict(os.environ,{'CRM_1LINK_BRIDGE_SECRET':''}):
            self.incoming('1LINK',{},expected=503)

    def test_permanent_receipt_snapshot_access_and_existing_payment_backfill(self):
        customer=self.recharge_customer()
        key=str(uuid.uuid4())
        result=self.pay(customer,200,request_key=key)
        self.assertEqual(result['receipt_number'],'RCP-'+str(result['id']))
        saved=self.request('/api/receipts/'+str(result['id']))['receipt']
        self.assertEqual(saved['payment_id'],customer['payment_id'])
        self.assertEqual(saved['amount'],200)
        self.assertEqual(saved['method'],'Cash')
        self.assertFalse(saved['activated'])
        self.assertFalse(saved['imported'])
        self.assertTrue(saved['recorded_by'])
        self.assertEqual(self.pay(customer,200,request_key=key)['receipt_number'],result['receipt_number'])
        with self.connect() as db:
            db.execute("UPDATE customers SET name='Changed name',address='Changed address' WHERE id=%s",(customer['id'],))
        self.assertEqual(self.request('/api/receipts/'+str(result['id']))['receipt'],saved)
        self.request('/api/record',dict(section='Payments',id=result['id'],action='delete'),400)
        self.request('/api/receipts/'+str(result['id']),expected=401,anonymous=True)
        self.request('/api/receipts/999999999',expected=404)
        self.request('/api/receipts/invalid',expected=400)
        with self.connect() as db:
            old=db.execute("INSERT INTO payments(customer_id,amount,payment_date,billing_month,method,reference) VALUES (%s,10,%s,'2025-01','Cash','Legacy') RETURNING id",(customer['id'],crm_recharge.local_today())).fetchone()['id']
        crm_data.initialize_database()
        old_receipt=self.request('/api/receipts/'+str(old))['receipt']
        self.assertTrue(old_receipt['imported'])
        self.assertEqual(old_receipt['amount'],10)
        crm_data.initialize_database()
        self.assertEqual(self.request('/api/receipts/'+str(old))['receipt'],old_receipt)

    def test_partial_activation_and_next_month_arrears_settlement(self):
        today=crm_recharge.local_today()
        month=today.strftime('%Y-%m')
        customer=self.recharge_customer()
        with self.connect() as db:
            db.execute('UPDATE customers SET monthly_fee=2000 WHERE id=%s',(customer['id'],))
        fields=dict(customer_id=customer['id'],amount=800,payment_date=today.isoformat(),billing_month=month,method='Cash',reference='Approved partial activation')
        key=str(uuid.uuid4())
        quote=self.request(f"/api/customers/{customer['id']}/billing?month={month}")
        self.assertEqual(quote['due'],2000)
        result=self.request('/api/record',dict(section='Payments',fields=fields,activate_partial=True,request_key=key))
        self.assertTrue(result['recharge']['activated'])
        self.assertTrue(result['recharge']['partial_activation'])
        self.assertEqual(result['recharge']['outstanding_amount'],1200)
        receipt=self.request('/api/receipts/'+str(result['id']))['receipt']
        self.assertTrue(receipt['partial_activation'])
        self.assertEqual(receipt['outstanding_amount'],1200)
        self.assertEqual(self.stored_customer(customer['id'])['status'],'Active')
        repeated=self.request('/api/record',dict(section='Payments',fields=fields,activate_partial=True,request_key=key))
        self.assertEqual(repeated['id'],result['id'])
        next_day=(today.replace(day=28)+timedelta(days=4)).replace(day=1)
        next_month=next_day.strftime('%Y-%m')
        invoice_id=self.request('/api/invoices',dict(customer_id=customer['id'],billing_month=next_month))['id']
        invoice=self.request('/api/invoices/'+str(invoice_id))
        self.assertEqual(invoice['invoice']['amount'],2000)
        self.assertEqual(invoice['previous_balance'],1200)
        self.assertEqual(invoice['total'],3200)
        self.assertEqual(invoice['balance'],3200)
        # Current summary counts the subscription charge once, not the rollover twice.
        profile=self.request(f"/api/customers/{customer['id']}/profile")
        self.assertEqual(sum(i['amount']-i['paid'] for i in profile['invoices']),3200)
        with patch('crm_recharge.local_today',return_value=next_day):
            payment=self.request('/api/record',dict(section='Payments',fields=dict(customer_id=customer['id'],amount=3200,payment_date=next_day.isoformat(),billing_month=next_month,method='Card',reference='Settles arrears and subscription'),request_key=str(uuid.uuid4())))
        self.assertTrue(payment['recharge']['activated'])
        settled=self.request('/api/invoices/'+str(invoice_id))
        self.assertEqual(settled['balance'],0)
        third_month=(next_day.replace(day=28)+timedelta(days=4)).replace(day=1).strftime('%Y-%m')
        quote=self.request(f"/api/customers/{customer['id']}/billing?month={third_month}")
        self.assertEqual(quote['previous_balance'],0)
        self.assertEqual(quote['due'],2000)

    def test_partial_without_approval_stays_inactive_and_later_payment_clears_arrears(self):
        today=crm_recharge.local_today()
        customer=self.recharge_customer()
        self.assertFalse(self.pay(customer,400)['recharge']['activated'])
        self.assertEqual(self.stored_customer(customer['id'])['status'],'Suspended')
        next_month=(today.replace(day=28)+timedelta(days=4)).replace(day=1).strftime('%Y-%m')
        iid=self.request('/api/invoices',dict(customer_id=customer['id'],billing_month=next_month))['id']
        self.assertEqual(self.request('/api/invoices/'+str(iid))['previous_balance'],600)
        self.assertTrue(self.pay(customer,600)['recharge']['activated'])
        # A late payment for the original month reduces the next bill immediately.
        self.assertEqual(self.request('/api/invoices/'+str(iid))['previous_balance'],0)
        self.assertEqual(self.request('/api/invoices/'+str(iid))['balance'],1000)

    def test_otc_does_not_pay_subscription_or_activate_customer(self):
        today=crm_recharge.local_today()
        customer=self.recharge_customer()
        month=today.strftime('%Y-%m')
        invoice_id=self.request('/api/invoices',dict(customer_id=customer['id'],billing_month=month))['id']
        fields=dict(revenue_type='OTC',customer_id=customer['id'],amount=3500,payment_date=today.isoformat(),billing_month=month,method='Cash',reference='Router purchase')
        result=self.request('/api/record',dict(section='Payments',fields=fields,request_key=str(uuid.uuid4())))
        self.assertFalse(result['recharge']['activated'])
        self.assertEqual(self.stored_customer(customer['id'])['status'],'Suspended')
        self.assertEqual(self.request('/api/receipts/'+str(result['id']))['receipt']['revenue_type'],'OTC')
        self.assertEqual(self.request('/api/invoices/'+str(invoice_id))['paid'],0)
        self.assertEqual(self.request(f"/api/customers/{customer['id']}/billing?month={month}")['due'],1000)
        self.request('/api/record',dict(section='Payments',fields=fields,activate_partial=True,request_key=str(uuid.uuid4())),400)
        self.request('/api/record',dict(section='Payments',fields=dict(fields,reference=''),request_key=str(uuid.uuid4())),400)
        self.assertFalse(self.pay(customer,600)['recharge']['activated'])
        next_month=(today.replace(day=28)+timedelta(days=4)).replace(day=1).strftime('%Y-%m')
        self.assertEqual(self.request(f"/api/customers/{customer['id']}/billing?month={next_month}")['previous_balance'],400)
        self.assertTrue(self.pay(customer,400)['recharge']['activated'])
        self.assertEqual(self.request('/api/invoices/'+str(invoice_id))['paid'],1000)
        profile=self.request(f"/api/customers/{customer['id']}/profile")
        self.assertEqual(profile['invoices'][0]['paid'],1000)
        self.assertEqual(len(profile['records']['Payments']),3)

    def test_card_receipt_manually_activates_customer(self):
        customer=self.recharge_customer()
        today=crm_recharge.local_today()
        result=self.request('/api/record',dict(section='Payments',request_key=str(uuid.uuid4()),fields=dict(customer_id=customer['id'],amount=1000,payment_date=today.isoformat(),billing_month=today.strftime('%Y-%m'),method='Card',reference='POS receipt')))
        self.assertTrue(result['recharge']['activated'])

    def test_concurrent_duplicate_receipt_does_not_double_charge(self):
        customer=self.recharge_customer()
        key=str(uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.pay(customer,request_key=key),range(2)))
        self.assertEqual(results[0]['id'],results[1]['id'])
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) AS n FROM payments WHERE customer_id=%s',(customer['id'],)).fetchone()['n'],1)

    def test_partial_payment_activation_retry_and_history(self):
        customer=self.recharge_customer()
        first=self.pay(customer,600)
        self.assertFalse(first['recharge']['activated'])
        self.assertEqual(self.stored_customer(customer['id'])['status'],'Suspended')
        key=str(uuid.uuid4())
        second=self.pay(customer,400,request_key=key)
        self.assertTrue(second['recharge']['activated'])
        expected_expiry=crm_recharge.local_today()+timedelta(days=30)
        self.assertEqual(self.stored_customer(customer['id'])['expiry_date'],expected_expiry)
        retry=self.pay(customer,400,request_key=key)
        self.assertEqual(retry['id'],second['id'])
        self.assertFalse(self.pay(customer,100)['recharge']['activated'])
        self.assertEqual(self.stored_customer(customer['id'])['expiry_date'],expected_expiry)
        self.pay(customer,401,request_key=key,expected=400)
        self.request('/api/record',dict(section='Payments',id=first['id'],action='delete'),400)
        self.request('/api/record',dict(section='Payments',id=second['id'],action='delete'),400)
        profile=self.request(f"/api/customers/{customer['id']}/profile")
        self.assertEqual(len(profile['recharges']),1)
        self.assertEqual(profile['recharges'][0]['received_amount'],1000)
        self.assertEqual(profile['customer']['status'],'Active')
        self.assertEqual(len(profile['records']['Payments']),3)

    def test_unexpired_validity_preserved_and_other_month_not_activated(self):
        today=crm_recharge.local_today()
        _,customer=self.customer(joined=(today-timedelta(days=30)).isoformat(),expiry_date=(today+timedelta(days=10)).isoformat(),status='Disconnected')
        self.assertFalse(self.pay(customer,month=(today.replace(day=1)-timedelta(days=1)).strftime('%Y-%m'))['recharge']['activated'])
        self.assertEqual(self.stored_customer(customer['id'])['status'],'Disconnected')
        self.assertTrue(self.pay(customer)['recharge']['activated'])
        self.assertEqual(self.stored_customer(customer['id'])['expiry_date'],today+timedelta(days=40))

    def test_concurrent_partial_receipts_only_renew_once(self):
        customer=self.recharge_customer()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.pay(customer,600),range(2)))
        self.assertEqual(sum(result['recharge']['activated'] for result in results),1)
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) AS n FROM customer_recharges WHERE customer_id=%s',(customer['id'],)).fetchone()['n'],1)
        self.assertEqual(self.stored_customer(customer['id'])['expiry_date'],crm_recharge.local_today()+timedelta(days=30))

    def test_rollback_and_invalid_payment(self):
        customer=self.recharge_customer()
        with patch('crm_recharge.apply_recharge',side_effect=ValueError('Simulated activation failure')):
            self.pay(customer,expected=400)
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) AS n FROM payments WHERE customer_id=%s',(customer['id'],)).fetchone()['n'],0)
        self.assertEqual(self.stored_customer(customer['id'])['status'],'Suspended')
        with patch('crm_recharge.save_receipt',side_effect=ValueError('Simulated receipt save failure')):
            self.pay(customer,expected=400)
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) AS n FROM payments WHERE customer_id=%s',(customer['id'],)).fetchone()['n'],0)
            self.assertEqual(db.execute('SELECT COUNT(*) AS n FROM customer_recharges WHERE customer_id=%s',(customer['id'],)).fetchone()['n'],0)
        self.assertEqual(self.stored_customer(customer['id'])['status'],'Suspended')
        self.pay(customer,0,expected=400)
        today=crm_recharge.local_today()
        self.request('/api/record',dict(section='Payments',fields=dict(customer_id=customer['id'],amount=1000,payment_date=(today+timedelta(days=1)).isoformat(),billing_month=today.strftime('%Y-%m'),method='Cash',reference='')),400)
        self.assertTrue(self.pay(customer)['recharge']['activated'])

    def test_read_only_role_cannot_recharge(self):
        customer=self.recharge_customer()
        self.request('/api/record',dict(section='Payments',fields={}),401,anonymous=True)
        import http.cookiejar
        username='recharge-viewer-'+uuid.uuid4().hex
        self.request('/api/users',dict(fields=dict(latitude='0',longitude='0',name='Viewer',username=username,designation='Viewer',role='Viewer',status='Active',staff_id=None,password='viewer-password-123')))
        original_client,original_token=self.client,self.token
        try:
            self.client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            self.token=self.request('/api/auth/status')['token']
            self.token=self.request('/api/auth/login',dict(username=username,password='viewer-password-123'))['token']
            self.pay(customer,expected=403)
            self.request('/api/receipts/999999999',expected=404)
        finally:
            self.client,self.token=original_client,original_token
        self.assertEqual(self.stored_customer(customer['id'])['status'],'Suspended')

if __name__=='__main__':
    unittest.main()
