"""Inventory issue integration tests using an isolated PostgreSQL schema."""
import concurrent.futures
import json
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from decimal import Decimal

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

import crm_data
import ispcrm
from auth_client import administrator_client
import crm_attachments


class StockIssuesTest(unittest.TestCase):
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

    def test_inventory_batch_persists_and_old_updates_preserve_it(self):
        fields=dict(item='Batched ONT',category='ONT',batch=' LOT-2026-001 ',quantity=5,minimum_stock=1,unit_cost=1000,selling_price=1500,location='Main Store')
        status,result=self.post(fields=fields,section='Inventory')
        self.assertEqual(status,200,result)
        rid=result['id']
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT batch FROM inventory WHERE id=%s',(rid,)).fetchone()['batch'],'LOT-2026-001')
            self.assertEqual(db.execute('SELECT batch FROM inventory WHERE id=%s',(self.stock,)).fetchone()['batch'],'')
        fields.pop('batch')
        fields['quantity']=6
        self.assertEqual(self.post(fields=fields,rid=rid,section='Inventory')[0],200)
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT batch FROM inventory WHERE id=%s',(rid,)).fetchone()['batch'],'LOT-2026-001')
        fields['batch']='X'*101
        self.assertEqual(self.post(fields=fields,rid=rid,section='Inventory')[0],400)

    def test_customer_discount_and_waive_off(self):
        charge=lambda rid:self.connect().execute('SELECT amount,description FROM customer_service_charges WHERE stock_issue_id=%s',(rid,)).fetchone()
        status,result=self.post(self.fields(quantity=2,unit_selling_price='1500',charge_mode='Discount',discount_percent='10'))
        self.assertEqual(status,200,result)
        issue=self.issues()[-1]
        self.assertEqual((issue['unit_selling_price'],issue['list_price'],issue['discount_percent'],issue['waived']),(Decimal('1350.00'),Decimal('1500.00'),Decimal('10.00'),False))
        self.assertEqual(charge(issue['id'])['amount'],Decimal('2700.00'));self.assertIn('10% off PKR 1,500.00',charge(issue['id'])['description'])
        status,result=self.post(self.fields(quantity=1,charge_mode='Waived'))
        self.assertEqual(status,200,result)
        waived=self.issues()[-1]
        self.assertEqual((waived['unit_selling_price'],waived['waived']),(Decimal('0.00'),True));self.assertIsNone(charge(waived['id']))
        self.assertEqual(self.quantity(),7)
        self.assertEqual(self.post(self.fields(quantity=1,unit_selling_price='1500',charge_mode='Discount',discount_percent='100'))[0],400)
        self.assertEqual(self.post(self.fields(quantity=1,unit_selling_price='0',charge_mode='Charge'))[0],400)
        self.assertEqual(self.quantity(),7)

    def test_administrator_can_delete_issue(self):
        self.assertEqual(self.post(self.fields(quantity=2,unit_selling_price='1500'))[0],200)
        issue=self.issues()[-1]
        self.assertEqual(self.quantity(),8)
        with self.connect() as db:
            with self.assertRaises(PermissionError):ispcrm.Handler.delete_stock_issue(None,db,issue['id'],dict(id=None,name='Manager',role='Manager'))
        status,result=self.post(rid=issue['id'],action='delete')
        self.assertEqual(status,200,result)
        self.assertEqual(self.quantity(),10)
        self.assertEqual(self.issues(),[])
        with self.connect() as db:
            self.assertIsNone(db.execute('SELECT 1 FROM customer_service_charges WHERE stock_issue_id=%s',(issue['id'],)).fetchone())
        # Once the customer has paid for the item, the entry is kept.
        self.assertEqual(self.post(self.fields(quantity=1,unit_selling_price='1500'))[0],200)
        paid=self.issues()[-1]
        with self.connect() as db:
            charge=db.execute('SELECT id FROM customer_service_charges WHERE stock_issue_id=%s',(paid['id'],)).fetchone()['id']
            db.execute("INSERT INTO payments(revenue_type,otc_type,customer_id,amount,payment_date,billing_month,method,reference,service_charge_id) VALUES ('OTC','Equipment',%s,1500,'2026-10-19','2026-10','Cash','paid',%s)",(self.customer,charge))
        self.assertEqual(self.post(rid=paid['id'],action='delete')[0],400)
        self.assertEqual(self.quantity(),9)

    def test_device_details_and_photo_are_saved(self):
        import base64
        png=b'\x89PNG\r\n\x1a\n'+b'label-photo'*10
        status,result=self.post(self.fields(quantity=1,unit_selling_price='1500',device_make=' Huawei ',device_model='HG8145V5',device_mac='00-1a-2b-3c-4d-5e',device_serial='4857544312345678',device_photo='data:image/png;base64,'+base64.b64encode(png).decode()))
        self.assertEqual(status,200,result)
        issue=self.issues()[-1]
        self.assertEqual((issue['device_make'],issue['device_model'],issue['device_mac'],issue['device_serial']),('Huawei','HG8145V5','00:1A:2B:3C:4D:5E','4857544312345678'))
        with self.opener.open(self.base+f'/api/stock-issues/{issue["id"]}/photo') as response:
            self.assertEqual((response.headers['Content-Type'],response.read()),('image/png',png))
        self.assertEqual(self.post(self.fields(quantity=1,unit_selling_price='1500',device_photo='data:image/gif;base64,'+base64.b64encode(b'GIF89a....').decode()))[0],400)
        self.assertEqual(self.quantity(),9)

    def test_issue_without_employee_is_allowed(self):
        status,result=self.post(self.fields(employee_id='',issued_against='Network',customer_id='',destination='Main Bazar FDB',quantity=2))
        self.assertEqual(status,200,result)
        self.assertEqual(self.quantity(),8)
        self.assertIsNone(self.issues()[-1]['employee_id'])

    def invoice_call(self,path,body=None):
        request=urllib.request.Request(self.base+path,data=json.dumps(body).encode() if body is not None else None,headers={'X-CRM-Token':self.token,'Content-Type':'application/json'})
        try:response=self.opener.open(request)
        except urllib.error.HTTPError as exc:response=exc
        with response:
            raw=response.read()
            return response.status,(json.loads(raw) if response.headers.get_content_type()=='application/json' else raw)

    def test_invoices_attach_to_batches_and_expenses(self):
        import base64
        pdf=b'%PDF-1.4\n% supplier invoice\n';png=b'\x89PNG\r\n\x1a\n'+b'receipt'*5
        status,result=self.invoice_call('/api/attachments',dict(section='Inventory',record_id=self.stock,files=[dict(name='Supplier invoice.pdf',content=base64.b64encode(pdf).decode())]))
        self.assertEqual((status,result.get('uploaded')),(200,1),result)
        status,expense=self.post(fields=dict(customer_id='',title='Fuel',category='Fuel / Transport',payee='PSO',amount='5000',expense_date='2026-10-20',status='Paid',method='Cash',payment_date='2026-10-20',reference='F-1',notes=''),section='Expenses')
        self.assertEqual(status,200,expense)
        self.assertEqual(self.invoice_call('/api/attachments',dict(section='Expenses',record_id=expense['id'],files=[dict(name='fuel.png',content=base64.b64encode(png).decode())]))[0],200)
        status,listing=self.invoice_call(f'/api/attachments/Inventory/{self.stock}')
        self.assertEqual([i['original_name'] for i in listing['invoices']],['Supplier invoice.pdf'])
        status,body=self.invoice_call('/api/attachment-files/'+str(listing['invoices'][0]['id']))
        self.assertEqual((status,body),(200,pdf))
        # A file whose content is not really a PDF is refused; so is an unsupported section.
        self.assertEqual(self.invoice_call('/api/attachments',dict(section='Inventory',record_id=self.stock,files=[dict(name='fake.pdf',content=base64.b64encode(b'not a pdf').decode())]))[0],400)
        self.assertEqual(self.invoice_call('/api/attachments',dict(section='Customers',record_id=self.customer,files=[dict(name='x.pdf',content=base64.b64encode(pdf).decode())]))[0],400)
        with self.connect() as db:
            with self.assertRaises(PermissionError):crm_attachments.listing(db,dict(id=None,name='Support',role='Support',staff_id=None),'Inventory',self.stock)
        self.assertEqual(self.post(rid=expense['id'],section='Expenses',action='delete')[0],200)
        with self.connect() as db:
            self.assertIsNone(db.execute("SELECT 1 FROM record_invoices WHERE section='Expenses' AND record_id=%s",(expense['id'],)).fetchone())
        invoice_id=listing['invoices'][0]['id']
        self.assertEqual(self.invoice_call('/api/attachments',dict(action='delete',id=invoice_id))[0],200)
        self.assertEqual(self.invoice_call(f'/api/attachments/Inventory/{self.stock}')[1]['invoices'],[])

    def test_new_batches_are_numbered_automatically(self):
        import crm_recharge
        prefix='B-'+crm_recharge.local_today().strftime('%y%m')+'-'
        fields=dict(item='Batch router',category='Router',quantity=5,minimum_stock=1,unit_cost=3000,selling_price=4000,location='Main Store')
        ids=[self.post(fields=dict(fields,batch=''),section='Inventory')[1]['id'] for _ in range(2)]
        ids.append(self.post(fields=dict(fields,batch='SUPPLIER-77',unit_cost=3200),section='Inventory')[1]['id'])
        with self.connect() as db:
            rows={r['id']:r for r in db.execute('SELECT id,batch,unit_cost FROM inventory WHERE id=ANY(%s)',(ids,))}
        numbers=sorted(rows[i]['batch'] for i in ids[:2])
        self.assertTrue(all(b.startswith(prefix) and b[len(prefix):].isdigit() for b in numbers),numbers)
        self.assertEqual(int(numbers[1][len(prefix):]),int(numbers[0][len(prefix):])+1)
        self.assertEqual((rows[ids[2]]['batch'],rows[ids[2]]['unit_cost']),('SUPPLIER-77',Decimal('3200.00')))

    def quantity(self):
        with self.connect() as db:
            return db.execute('SELECT quantity FROM inventory WHERE id=%s',(self.stock,)).fetchone()['quantity']

    def issues(self):
        with self.connect() as db:
            return list(db.execute('SELECT * FROM stock_issues WHERE inventory_id=%s ORDER BY id',(self.stock,)))

    def qr_request(self,payload=None,code=None,expected=200,anonymous=False,label=False):
        path='/api/inventory-qr'
        if code is not None:
            from urllib.parse import urlencode
            path+='?'+urlencode(dict(code=code,label='1' if label else '0'))
        request=urllib.request.Request(self.base+path,data=json.dumps(payload).encode() if payload is not None else None,headers={'X-CRM-Token':self.token,'Content-Type':'application/json'})
        try:response=(urllib.request.build_opener() if anonymous else self.opener).open(request)
        except urllib.error.HTTPError as error:response=error
        with response:
            raw=response.read()
            self.assertEqual(response.status,expected,raw[:300])
            return raw if label else json.loads(raw)

    def test_customer_stock_is_billed_once_at_selling_price(self):
        import crm_customer_ledger as ledger
        with self.connect() as db:
            customer=db.execute('SELECT * FROM customers WHERE id=%s',(self.customer,)).fetchone()
            before=ledger.account_balances(db)[self.customer]
        key=uuid.uuid4().hex
        fields=self.fields(quantity=2,unit_selling_price=1500,issue_date='2027-02-12')
        self.assertEqual(self.post(fields,request_key=key)[0],200)
        self.assertEqual(self.post(fields,request_key=key)[0],200)
        self.assertEqual(self.quantity(),8)
        issue=self.issues()[0]
        with self.connect() as db:
            charges=list(db.execute('SELECT * FROM customer_service_charges WHERE stock_issue_id=%s',(issue['id'],)))
            self.assertEqual(len(charges),1)
            self.assertEqual(charges[0]['amount'],3000)
            self.assertEqual(charges[0]['charge_type'],'Equipment')
            self.assertEqual(str(charges[0]['service_date']),'2027-02-12')
            invoice=db.execute("SELECT * FROM invoices WHERE customer_id=%s AND billing_month='2027-02'",(self.customer,)).fetchone()
            self.assertEqual(invoice['amount'],1000)
            self.assertEqual(ledger.invoice_services(db,self.customer,'2027-02')['amount'],3000)
            self.assertEqual(ledger.account_balances(db)[self.customer],before+4000)
            self.assertEqual(ledger.account_balances(db)[self.customer],ledger.ledger(db,customer)['balance'])
        self.assertEqual(issue['unit_cost_at_issue'],1000)
        self.assertEqual(issue['unit_selling_price'],1500)
        self.assertEqual(self.post(dict(fields,unit_selling_price=1600),request_key=key)[0],400)

    def test_network_stock_and_invalid_customer_price_do_not_create_charges(self):
        self.assertEqual(self.post(self.fields(unit_selling_price=0))[0],400)
        self.assertEqual(self.quantity(),10)
        self.assertEqual(self.post(self.fields(issued_against='Network',customer_id='',destination='POP cabinet',unit_selling_price=2000))[0],200)
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) AS n FROM customer_service_charges WHERE stock_issue_id IN (SELECT id FROM stock_issues WHERE inventory_id=%s)',(self.stock,)).fetchone()['n'],0)

    def test_device_inspection_and_stocktake_snapshot(self):
        import crm_inventory_qr as qr
        payload=dict(inventory_id=self.stock,serial_number='COUNT-DEVICE',receive_new=False,request_key=uuid.uuid4().hex)
        unit=self.qr_request(payload)['unit']
        self.qr_request(dict(action='condition',code=unit['qr_code'],condition='Damaged',notes='Broken port'))
        self.assertEqual(self.post(self.fields(quantity=1,qr_code=unit['qr_code']))[0],400)
        start=self.qr_request(dict(action='start_stocktake'))['stocktake_id']
        self.assertEqual(self.qr_request(dict(action='start_stocktake'))['stocktake_id'],start)
        self.qr_request(dict(action='scan_stocktake',stocktake_id=start,code=unit['qr_code']))
        self.qr_request(dict(action='scan_stocktake',stocktake_id=start,code=unit['qr_code']))
        self.qr_request(dict(action='close_stocktake',stocktake_id=start))
        with self.connect() as db:
            report=qr.stocktake_report(db,start)
            line=next(l for l in report['lines'] if l['unit_id']==unit['id'])
            self.assertTrue(line['seen']);self.assertTrue(line['expected'])
            self.assertEqual(line['condition'],'Damaged')
        self.qr_request(dict(action='condition',code=unit['qr_code'],condition='Good',notes='Port repaired and tested'))
        self.qr_request(dict(action='scan_stocktake',stocktake_id=start,code=unit['qr_code']),expected=400)
        with self.connect() as db:
            frozen=qr.stocktake_report(db,start)
            self.assertEqual(frozen['lines'],report['lines'])
        self.assertEqual(self.post(self.fields(quantity=1,qr_code=unit['qr_code']))[0],200)
        self.assertEqual(self.quantity(),9)

    def test_qr_receive_issue_return_and_history(self):
        payload=dict(inventory_id=self.stock,serial_number='QR-TEST',receive_new=False,request_key=uuid.uuid4().hex)
        unit=self.qr_request(payload)['unit']
        self.assertEqual(self.quantity(),10)
        self.assertEqual(self.qr_request(payload)['unit']['id'],unit['id'])
        self.qr_request(dict(payload,receive_new=True),expected=400)
        self.assertIn(b'<svg',self.qr_request(code=unit['qr_code'],label=True))
        self.qr_request(code=unit['qr_code'],expected=401,anonymous=True)
        self.assertEqual(self.post(self.fields(quantity=10))[0],400) # QR devices cannot leave without scan.
        key=uuid.uuid4().hex
        fields=self.fields(quantity=1,qr_code=unit['qr_code'])
        self.assertEqual(self.post(fields,request_key=key)[0],200)
        self.assertEqual(self.post(fields,request_key=key)[0],200)
        self.assertEqual(self.quantity(),9)
        self.assertEqual(self.post(fields)[0],400)
        self.assertEqual(self.post(dict(fields,qr_code='ISPCRM:'+uuid.uuid4().hex),request_key=key)[0],400)
        details=self.qr_request(code=unit['qr_code'])
        self.assertEqual(details['unit']['state'],'Issued')
        self.assertEqual(details['movements'][0]['employee_name'],'Test employee')
        self.assertEqual(details['movements'][0]['customer_name'],'Test customer')
        issue=details['unit']['issue_id']
        self.assertEqual(self.post(rid=issue,action='return')[0],200)
        self.assertEqual(self.post(rid=issue,action='return')[0],200)
        self.assertEqual(self.quantity(),10)
        details=self.qr_request(code=unit['qr_code'])
        self.assertEqual(details['unit']['state'],'Available')
        self.assertEqual([r['action'] for r in details['movements']],['Returned','Issued','Existing stock registered'])
        self.assertEqual(self.post(fields)[0],200) # Same physical device may be reissued.

    def test_qr_new_receipt_serial_rollback_and_concurrent_issue(self):
        payload=dict(inventory_id=self.stock,serial_number='NEW-DEVICE',receive_new=True,request_key=uuid.uuid4().hex)
        unit=self.qr_request(payload)['unit']
        self.assertEqual(self.quantity(),11)
        self.qr_request(payload)
        self.assertEqual(self.quantity(),11)
        self.qr_request(dict(payload,request_key=uuid.uuid4().hex),expected=400)
        self.assertEqual(self.quantity(),11)
        fields=self.fields(quantity=1,qr_code=unit['qr_code'])
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.post(fields)[0],range(2)))
        self.assertEqual(sorted(results),[200,400])
        self.assertEqual(self.quantity(),10)
        self.assertEqual(len(self.qr_request(code=unit['qr_code'])['movements']),2)

    def test_customer_activation_costs_snapshot_expenses_and_returns(self):
        with self.connect() as db:
            customer=db.execute("INSERT INTO customers(name,phone,address,username,package,monthly_fee,status,joined) VALUES ('Cost test','0','',%s,'Legacy',1000,'Active','2026-10-19') RETURNING id",('cost-'+uuid.uuid4().hex,)).fetchone()['id']
        self.assertEqual(self.post(self.fields(customer_id=customer))[0],200)
        issue=self.issues()[0]
        self.assertEqual(issue['unit_cost_at_issue'],1000)
        self.assertFalse(issue['cost_estimated'])
        def costs():
            with self.opener.open(self.base+f'/api/customers/{customer}/profile') as response:
                data=json.load(response)
                self.assertTrue(data['access']['costs'])
                return data['costs']
        self.assertEqual(costs()['inventory_cost'],3000)
        with self.connect() as db:
            db.execute('UPDATE inventory SET unit_cost=9999 WHERE id=%s',(self.stock,))
        self.assertEqual(costs()['inventory_cost'],3000)
        for status,amount,allocation in [('Paid',500,customer),('Pending',200,customer),('Cancelled',900,customer),('Paid',10000,None)]:
            fields=dict(customer_id=allocation,title='Additional labour',category='Other',payee='Installer',amount=amount,expense_date='2026-10-19',status=status,method='Cash',payment_date='2026-10-19' if status=='Paid' else '',reference='',notes='')
            self.assertEqual(self.post(fields,section='Expenses')[0],200)
        report=costs()
        self.assertEqual(report['additional_cost'],700)
        self.assertEqual(report['total'],3700)
        self.assertEqual(len(report['expenses']),3)
        self.assertEqual(self.post(rid=issue['id'],action='return')[0],200)
        report=costs()
        self.assertEqual(report['inventory_cost'],0)
        self.assertEqual(report['returned_cost'],3000)
        self.assertEqual(report['total'],700)
        self.assertEqual(self.post(self.fields(customer_id=customer,quantity=1))[0],200)
        self.assertEqual(costs()['total'],10699)
        crm_data.initialize_database()
        self.assertEqual(costs()['total'],10699)

    def test_destinations_retries_returns_and_stale_stock(self):
        key=uuid.uuid4().hex
        self.assertEqual(self.post(self.fields(),request_key=key)[0],200)
        self.assertEqual(self.post(self.fields(),request_key=key)[0],200)
        self.assertEqual(self.quantity(),7)
        self.assertEqual(len(self.issues()),1)
        self.assertEqual(self.post(self.fields(quantity=4),request_key=key)[0],400)
        for destination in ['System','Network']:
            self.assertEqual(self.post(self.fields(issued_against=destination,destination='Test '+destination,quantity=1))[0],200)
        self.assertEqual(self.quantity(),5)
        self.assertIsNone(self.issues()[-1]['customer_id'])
        issue=self.issues()[0]
        self.assertEqual(self.post(rid=issue['id'],action='return')[0],200)
        self.assertEqual(self.post(rid=issue['id'],action='return')[0],200)
        self.assertEqual(self.quantity(),8)
        self.assertEqual(self.issues()[0]['status'],'Returned')
        self.assertTrue(self.issues()[0]['returned_at'])
        self.assertEqual(self.post(self.fields(),rid=issue['id'])[0],400)
        # An administrator may delete an already returned entry; stock is not returned twice.
        self.assertEqual(self.post(rid=issue['id'],action='delete')[0],200)
        self.assertEqual(self.quantity(),8)
        with self.connect() as db:
            stock=db.execute('SELECT * FROM inventory WHERE id=%s',(self.stock,)).fetchone()
        self.assertEqual(self.post(stock,rid=self.stock,section='Inventory',original_quantity=10)[0],400)
        self.assertEqual(self.quantity(),8)
        self.assertEqual(self.post(rid=self.stock,section='Inventory',action='delete')[0],400)
        self.assertEqual(self.post(rid=self.staff,section='Staff',action='delete')[0],400)
        self.assertEqual(self.post(rid=self.customer,section='Customers',action='delete')[0],400)

    def test_invalid_requests_leave_stock_unchanged(self):
        for changes in [dict(quantity=0),dict(quantity=-1),dict(quantity=1.5),dict(quantity=11),
                        dict(customer_id=None),dict(employee_id=999999),
                        dict(issued_against='System',destination=''),dict(issued_against='Network',destination=''),
                        dict(issued_against='Invalid'),dict(inventory_id=999999)]:
            with self.subTest(changes=changes):
                self.assertEqual(self.post(self.fields(**changes))[0],400)
                self.assertEqual(self.quantity(),10)
        self.assertEqual(self.issues(),[])

    def test_concurrent_issues_cannot_overdraw(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.post(self.fields(quantity=7))[0],range(2)))
        self.assertEqual(sorted(results),[200,400])
        self.assertEqual(self.quantity(),3)
        self.assertEqual(len(self.issues()),1)

    def test_concurrent_duplicate_and_return(self):
        key=uuid.uuid4().hex
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.post(self.fields(),request_key=key)[0],range(2)))
        self.assertEqual(results,[200,200])
        self.assertEqual(self.quantity(),7)
        self.assertEqual(len(self.issues()),1)
        rid=self.issues()[0]['id']
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.post(rid=rid,action='return')[0],range(2)))
        self.assertEqual(results,[200,200])
        self.assertEqual(self.quantity(),10)


if __name__=='__main__':
    unittest.main()
