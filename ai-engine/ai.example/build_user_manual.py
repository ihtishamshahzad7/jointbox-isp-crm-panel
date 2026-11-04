"""Build an illustrated bilingual training manual without accessing live CRM data."""
from pathlib import Path
import html
import json
import mimetypes
import re
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from crm_data import SCHEMAS, column_name
from crm_auth import ROLES, USER_SCHEMA

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / 'manual_assets'
ASSETS.mkdir(exist_ok=True)
DAY, MONTH = '2026-10-21', '2026-10'


def row(section, rid=1, **values):
    result = {'id': rid}
    for label, kind in SCHEMAS[section]:
        result[column_name(label)] = kind[0] if isinstance(kind, list) else 0 if kind in ('money', 'integer') else DAY if kind == 'date' else MONTH if kind == 'month' else None if kind in ('optionaldate', 'optionalstaff', 'optionalcustomer', 'assignee') else ''
    result.update(values)
    return result


def training_state():
    records = {s: [] for s in SCHEMAS}
    records['Packages'] = [row('Packages', name='Fiber 20 Mbps', speed_mbps=20, monthly_price=2000, monthly_cost=1100, installation_fee=1500)]
    records['Customers'] = [row('Customers', name='Ali Ahmed (Training)', username='ali.training', phone='03XX-XXX-0001', email='ali@example.com', address='Training House, Example Street', latitude=31.5204, longitude=74.3587, package='Fiber 20 Mbps', package_id=1, monthly_fee=2000, installation_charge=1500, joined='2026-10-01', expiry_date='2026-10-31', payment_id='100000001', recovery_status='Not required', account_balance=3000), row('Customers', 2, name='Sara Khan (Training)', username='sara.training', phone='03XX-XXX-0002', package='Fiber 20 Mbps', monthly_fee=2000, joined='2026-10-01', expiry_date='2026-10-16', payment_id='100000002', status='Suspended', account_balance=2000)]
    records['Staff'] = [row('Staff', name='Bilal (Training)', phone='03XX-XXX-0101', role='Technician', area='Training area', designation='Field Technician', employee_code='EMP-1001', monthly_salary=40000, net_salary=40000)]
    records['Inventory'] = [row('Inventory', item='Wi-Fi ONT (Training)', category='ONT', quantity=12, minimum_stock=3, unit_cost=2500, selling_price=3000, location='Main store'), row('Inventory', 2, item='Fiber drop cable', category='Fiber Drop Cable', quantity=180, minimum_stock=50, unit_cost=10, selling_price=15, location='Main store')]
    records['Categories'] = [row('Categories', name='ONT'), row('Categories', 2, name='Fiber Drop Cable')]
    records['Designations'] = [row('Designations', name='Field Technician')]
    records['Tickets'] = [row('Tickets', subject='Slow internet - training example', customer_id=1, assigned_to=1, type='Slow speed', description='Check signal and connection speed.', due_date='2026-10-22', created_at=DAY+'T09:00:00+05:00', updated_at=DAY+'T09:00:00+05:00', due_at='2026-10-22T09:00:00+05:00', tat_hours=24, resolved_at=None, recovery_id=None, expiry_recovery_date=None)]
    records['Payments'] = [row('Payments', customer_id=1, amount=500, method='Cash', reference='Training receipt', payment_date=DAY, recorded_by='Training administrator')]
    records['Expenses'] = [row('Expenses', title='Installation travel (Training)', customer_id=1, category='Fuel / Transport', payee='Field team', amount=500, status='Paid', payment_date=DAY, reference='Training expense')]
    records['Stock issues'] = [row('Stock issues', inventory_id=1, customer_id=1, employee_id=1, quantity=1, issue_date=DAY, unit_cost_at_issue=2500, unit_selling_price=3000, cost_estimated=False, returned_at=None)]
    records['Equipment recovery'] = [row('Equipment recovery', customer_id=2, monthly_revenue_loss=2000, employee_id=1, reason='Training: account closed', pending_items=[{'id':1,'inventory_id':1,'item':'Wi-Fi ONT (Training)','quantity':1,'employee_id':1,'issue_date':DAY}])]
    records['TAT settings'] = [row('TAT settings', ticket_type='Slow speed', hours=24)]
    user = {'id':1,'name':'Training administrator','username':'training.admin','role':'Administrator','designation':'Training account','staff_id':None}
    records['Users'] = [dict(user, status='Active')]
    invoice = {'id':1,'customer_id':1,'invoice_number':'INV-202610-00001','billing_month':MONTH,'customer_name':records['Customers'][0]['name'],'username':'ali.training','phone':'03XX-XXX-0001','address':'Training House, Example Street','payment_id':'100000001','package_name':'Fiber 20 Mbps','amount':2000,'paid':500,'previous_balance':0,'service_amount':0,'total':2000,'remaining':1500,'due':1500,'issue_date':'2026-10-01','due_date':'2026-10-31'}
    records.update({'Invoices':[invoice], 'Recharges':[], 'Inventory units':[]})
    schemas = {k:v for k,v in SCHEMAS.items() if k!='Jobs'}
    schemas['Users'] = USER_SCHEMA
    return {'schemas':schemas,'records':records,'user':user,'permissions':ROLES['Administrator'],'roles':ROLES,'token':'training-only','ticket_activity':[],'tat_settings':records['TAT settings']}


def screenshots(browser):
    state = training_state()
    c = state['records']['Customers'][0]
    inv = state['records']['Invoices'][0]
    profile = {'customer':c,'records':{k:[r for r in state['records'][k] if r.get('customer_id')==1] for k in ('Payments','Tickets','Jobs','Stock issues')},'invoices':[inv],'documents':[],'recharges':[],'events':[], 'services':[], 'installation':{'charge':1500,'paid':0,'due':1500},'costs':None,'ledger':{'entries':[{'date':'2026-10-01','reference':inv['invoice_number'],'description':'Monthly subscription','debit':2000,'credit':0,'balance':2000},{'date':DAY,'reference':'RCP-1','description':'MRC payment - Cash','debit':0,'credit':500,'balance':1500}],'debits':3500,'credits':500,'balance':3000}, 'access':{'finance':True,'documents':True,'tickets':True,'hardware':True,'costs':False,'jobs':False}}
    receipt = dict(inv, receipt_number='RCP-000001', payment_record_id=1, revenue_type='MRC', otc_type='Other', amount=500, method='Cash', reference='Training receipt', payment_date=DAY, recorded_by='Training administrator', customer_status='Active', expiry_date='2026-10-31', activated=False, imported=False, saved_at=DAY+'T10:00:00+05:00')
    mode = {'login':True, 'customer_login':True}
    page = browser.new_page(viewport={'width':1440,'height':1000}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))

    def route_request(route):
        path = urlparse(route.request.url).path
        data, status = None, 200
        if path == '/api/auth/status':
            data = {'setup_required':False,'user':None if mode['login'] else state['user'],'token':'training-only'}
        elif path == '/api/state': data = state
        elif path.endswith('/profile'): data = profile
        elif path.endswith('/billing'): data = {'charge':2000,'paid':500,'previous_balance':0,'due':1500,'service_due':0,'installation_charge':1500,'installation_paid':0,'installation_due':1500,'billing_month':MONTH}
        elif path == '/api/assistant': data = {'ai_available':False}
        elif path == '/api/invoices/1': data = {'invoice':inv,'paid':500,'balance':1500,'credit':0,'previous_balance':0,'total':2000,'services':{'amount':0,'items':[]}}
        elif path == '/api/receipts/1': data = {'receipt':receipt}
        elif path == '/api/customer-app/state':
            if mode['customer_login']: data,status = {'error':'Sign in'},401
            else: data = {'customer':c,'must_change':False,'csrf':'training-only','current_due':1500,'billing_month':MONTH,'invoices':[inv],'receipts':[receipt],'tickets':state['records']['Tickets'],'notifications':[{'id':1,'title':'Training welcome','body':'Your account is ready. Contact support for help.','read_at':None,'created_at':DAY+'T09:00:00+05:00'}]}
        elif path.startswith('/api/'):
            data,status = {'error':'Training preview: saving is disabled.'},400
        if data is not None:
            route.fulfill(status=status, content_type='application/json', body=json.dumps(data)); return
        aliases = {'/':'index.html','/invoice':'invoice.html','/receipt':'receipt.html','/customer/':'customer-portal.html','/customer':'customer-portal.html','/customer/portal.js':'customer-portal.js','/customer/portal.css':'customer-portal.css','/customer/icon.svg':'customer-icon.svg','/customer/manifest.json':'customer-manifest.json'}
        filename = ROOT / 'web' / aliases.get(path,path.lstrip('/'))
        if filename.is_file(): route.fulfill(path=str(filename),content_type=mimetypes.guess_type(filename.name)[0] or 'application/octet-stream')
        else: route.fulfill(status=404,body='Not found')

    page.route('**/*', route_request)
    page.add_init_script("localStorage.setItem('ispcrm-theme','light');localStorage.setItem('ispcrm-layout','standard');")

    def shot(name, selector=None):
        page.wait_for_timeout(350)
        # Every screenshot identifies its fictional training content.
        page.evaluate("""() => {let n=document.getElementById('manual-training-label');if(!n){n=document.createElement('div');n.id='manual-training-label';document.body.append(n);}n.textContent='TRAINING EXAMPLE • FICTIONAL DATA';Object.assign(n.style,{position:'fixed',bottom:'10px',right:'12px',zIndex:'99999',background:'#123b4b',color:'white',padding:'7px 12px',borderRadius:'6px',font:'12px Arial',pointerEvents:'none'});} """)
        if selector:
            page.locator(selector).screenshot(path=str(ASSETS / (name+'.png')))
        else: page.screenshot(path=str(ASSETS / (name+'.png')))
        print('Screenshot:', name, flush=True)

    page.goto('https://manual.local/', wait_until='networkidle')
    shot('01-login')
    page.evaluate('showLogin(true)')
    shot('02-first-admin', '.auth-card')
    mode['login']=False
    page.reload(wait_until='networkidle')
    page.wait_for_function("typeof state!=='undefined' && state && document.getElementById('auth-panel').hidden")
    shot('03-dashboard')
    for section,name in [('Customers','04-customers'),('Inventory','10-inventory'),('Tickets','13-tickets'),('Expenses','16-expenses'),('Staff','17-staff'),('Packages','18-settings'),('Equipment recovery','15-recovery')]:
        page.evaluate('(s)=>navigate(s)',section); shot(name)
    page.evaluate("reportChoice='Collection Reports';navigate('Reports')")
    shot('21-reports')
    page.evaluate("navigate('Customers');openEditor()")
    shot('05-add-customer','#editor')
    page.evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close());navigate('Customers');profileCustomerId=1;profilePayload="+json.dumps(profile)+";renderCustomerProfile();document.getElementById('customer-profile').hidden=false;document.getElementById('records').hidden=true;")
    shot('06-profile')
    page.evaluate("profileTab='Finance';renderCustomerProfile()")
    shot('09-finance')
    page.evaluate("profileTab='Ledger';renderCustomerProfile()")
    shot('20-ledger')
    page.evaluate("rechargeCustomer(state.records.Customers[0])")
    shot('07-recharge','#editor')
    page.evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close());issueForProfile(state.records.Customers[0])")
    shot('11-issue-stock','#editor')
    page.evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close());navigate('Tickets');openEditor()")
    shot('14-new-ticket','#editor')
    page.goto('https://manual.local/invoice?id=1',wait_until='networkidle'); shot('08-invoice')
    page.goto('https://manual.local/receipt?id=1',wait_until='networkidle'); shot('08-receipt')
    page.goto('https://manual.local/customer/',wait_until='networkidle'); shot('19-customer-login')
    mode['customer_login']=False
    page.reload(wait_until='networkidle'); shot('19-customer-home')
    page.close()
    (ASSETS/'capture-check.json').write_text(json.dumps({'screenshots':len(list(ASSETS.glob('*.png'))),'browser_errors':errors},indent=2),encoding='utf-8')


if __name__ == '__main__':
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge',headless=True)
        screenshots(browser)
        browser.close()
