"""End-to-end operations and Digital theme test with disposable database records."""
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import json
import threading
import uuid
import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from playwright.sync_api import sync_playwright,expect
import crm_data
import crm_operations
import ispcrm

settings=crm_data.database_settings();schema='ops_browser_'+uuid.uuid4().hex
original_data,original_server=crm_data.connect_database,ispcrm.connect_database
with psycopg.connect(**settings,autocommit=True) as db:db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
def connect():return psycopg.connect(**settings,row_factory=dict_row,options='-c search_path='+schema)
crm_data.connect_database=ispcrm.connect_database=connect
server=None
try:
    crm_data.initialize_database()
    with connect() as db:
        staff=db.execute("INSERT INTO staff(name,phone,role,area,status,monthly_salary) VALUES ('Training technician','0','Technician','Example area','Available',40000) RETURNING id").fetchone()['id']
        customer=db.execute("INSERT INTO customers(name,phone,address,username,package,monthly_fee,status,joined) VALUES ('Training customer','0','Example street','training','Example package',2000,'Active',%s) RETURNING id",(crm_operations.today(),)).fetchone()['id']
    server=ispcrm.ThreadingHTTPServer(('127.0.0.1',0),ispcrm.Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    base='http://127.0.0.1:'+str(server.server_port)
    with sync_playwright() as p:
        browser=p.chromium.launch(channel='msedge',headless=True)
        page=browser.new_page(viewport={'width':1440,'height':1000});errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('response',lambda r:print('API rejection:',r.text(),flush=True) if '/api/operations' in r.url and r.status>=400 else None)
        page.goto(base,wait_until='networkidle')
        expect(page.locator('html')).to_have_attribute('data-skin','digital')
        expect(page.locator('html')).to_have_attribute('data-theme','light')
        page.locator('#auth-name').fill('Training administrator');page.locator('#auth-username').fill('training-admin');page.locator('#auth-password').fill('training-password-123');page.locator('#auth-submit').click()
        expect(page.locator('#auth-panel')).to_be_hidden(timeout=30000)
        page.get_by_role('button',name='Operations',exact=True).click()
        expect(page.locator('.ops-navigation')).to_be_visible()
        page.get_by_role('button',name='Companies',exact=True).click();page.get_by_role('button',name='+ Add companies',exact=True).click()
        d=page.locator('.ops-dialog');d.locator('[name=name]').fill('Training ISP');d.locator('[name=status]').select_option('Active');d.get_by_role('button',name='Save record',exact=True).click()
        expect(page.locator('.ops-content')).to_contain_text('Training ISP')
        page.get_by_role('button',name='Areas',exact=True).click();page.get_by_role('button',name='+ Add areas',exact=True).click()
        d=page.locator('.ops-dialog');d.locator('[name=name]').fill('Training area');d.locator('[name=company]').select_option(label='Training ISP');d.locator('[name=city]').fill('Example city');d.locator('[name=status]').select_option('Active');d.get_by_role('button',name='Save record',exact=True).click()
        expect(page.locator('.ops-content')).to_contain_text('Training area')
        page.wait_for_function("state.area_options?.includes('Training area')")
        page.evaluate("navigate('Customers');openEditor(state.records.Customers[0])")
        page.locator('#editor [name=area]').select_option('Training area');page.locator('#editor [name=latitude]').fill('31.52');page.locator('#editor [name=longitude]').fill('74.35');page.locator('#save').click()
        expect(page.locator('#editor')).to_be_hidden();expect(page.locator('#tbody')).to_contain_text('Training area')
        page.get_by_role('button',name='Operations',exact=True).click();expect(page.locator('.ops-navigation')).to_be_visible()
        page.get_by_role('button',name='Vendors',exact=True).click()
        page.get_by_role('button',name='+ Add vendors',exact=True).click()
        d=page.locator('.ops-dialog');d.locator('[name=name]').fill('Training supplier');d.get_by_role('button',name='Save record',exact=True).click()
        expect(page.locator('.ops-content')).to_contain_text('Training supplier')
        page.get_by_role('button',name='Payroll',exact=True).click();page.get_by_role('button',name='Generate month',exact=True).click()
        page.locator('.ops-dialog').get_by_role('button',name='Generate unpaid salary records',exact=True).click()
        expect(page.locator('.ops-content')).to_contain_text('Training technician')
        page.get_by_role('button',name='Pay / post expense',exact=True).click()
        page.locator('.ops-dialog').get_by_role('button',name='Confirm Pay / post expense',exact=True).click()
        expect(page.locator('.ops-content')).to_contain_text('Paid')
        page.wait_for_load_state('networkidle');expect(page.locator('.ops-content')).to_contain_text('Paid');page.screenshot(path=str(ROOT/'operations-digital-desktop.png'))
        page.reload(wait_until='networkidle');page.get_by_role('button',name='Operations',exact=True).click();page.get_by_role('button',name='Payroll',exact=True).click()
        expect(page.locator('.ops-content')).to_contain_text('Paid')
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),'Mobile page overflows horizontally'
        page.mouse.move(350,500)
        page.wait_for_timeout(250)
        assert page.locator('#sidebar').bounding_box()['x']+page.locator('#sidebar').bounding_box()['width']<=0,'Mobile navigation should be hidden until opened'
        page.locator('#menu-toggle').click();expect(page.locator('#sidebar')).to_be_in_viewport();page.keyboard.press('Escape');page.wait_for_timeout(300);expect(page.locator('html')).to_have_attribute('data-skin','digital')
        page.screenshot(path=str(ROOT/'operations-digital-mobile.png'))
        page.set_viewport_size({'width':1440,'height':1000})
        page.get_by_role('button',name='Customers',exact=True).first.click()
        expect(page.locator('#operations-workspace')).to_be_hidden()
        expect(page.locator('#title')).to_have_text('Customers')
        # Exercise the separate customer request UI with provisioned credentials.
        with connect() as db:password=__import__('crm_customer_portal').provision(db,customer);payment_id=db.execute('SELECT payment_id FROM customers WHERE id=%s',(customer,)).fetchone()['payment_id']
        portal=browser.new_page(viewport={'width':1000,'height':900});portal.on('pageerror',lambda e:errors.append(str(e)))
        portal.goto(base+'/customer/',wait_until='networkidle');portal.locator('[name=payment_id]').fill(payment_id);portal.locator('#login-form [name=password]').fill(password);portal.locator('#login-form button').click()
        expect(portal.locator('#password-panel')).to_be_visible();portal.locator('[name=current_password]').fill(password);portal.locator('[name=new_password]').fill('customer-password-123');portal.locator('#password-form button').click()
        expect(portal.locator('#app')).to_be_visible();portal.get_by_role('button',name='Requests',exact=True).click()
        form=portal.locator('#content form');form.locator('input').fill('Training support request');form.locator('textarea').fill('Please check the connection.');form.get_by_role('button',name='Submit request',exact=True).click()
        expect(portal.locator('#content')).to_contain_text('Pending')
        portal.get_by_role('button',name='Messages',exact=True).click();portal.locator('#content textarea').fill('Training message');portal.get_by_role('button',name='Send message',exact=True).click();expect(portal.locator('#content')).to_contain_text('Training message')
        assert not errors,errors
        print('PASS: companies, linked areas, customer assignment, Digital theme, payroll, expenses, mobile navigation and customer portal requests/messages.')
        browser.close()
finally:
    if server:server.shutdown();server.server_close();thread.join()
    crm_data.connect_database,ispcrm.connect_database=original_data,original_server
    with psycopg.connect(**settings,autocommit=True) as db:db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))
