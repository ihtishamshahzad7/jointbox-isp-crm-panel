"""Desktop/mobile usability checks for the running demo and localhost assets."""
import json,re
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
config=json.loads((ROOT/'.demo-share.local.json').read_text())
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True,args=['--disable-gpu'])
    page=browser.new_page(viewport={'width':1440,'height':1000})
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('http://127.0.0.1:3001/',wait_until='domcontentloaded')
    expect(page.locator('#auth-submit')).to_be_enabled(timeout=30000)
    page.locator('#auth-username').fill('demo-reviewer');page.locator('#auth-password').fill(config['password']);page.locator('#auth-submit').click()
    expect(page.locator('#navigation .nav-customers')).to_be_visible(timeout=30000)
    assert page.locator('.nav-group-heading').all_text_contents()==['Workspace','Inventory','Finance','Team & settings']
    page.locator('.nav-customers').click()
    assert 'Account balance' in page.locator('#thead th').all_text_contents()
    expect(page.locator('#add')).to_have_text('+ Add customer')
    count=page.locator('#tbody tr').count();assert count>0
    name=page.locator('#tbody .customer-name-link').first.inner_text()
    page.locator('#search').fill(name)
    expect(page.locator('#clear-record-search')).to_be_visible()
    assert page.locator('#tbody tr').count()>=1
    page.locator('#clear-record-search').click();expect(page.locator('#tbody tr')).to_have_count(count)
    page.get_by_role('button',name='Monthly invoices',exact=False).click()
    expect(page.locator('#title')).to_have_text('Monthly Invoices')
    assert 'Stock / services' in page.locator('#thead th').all_text_contents()
    assert page.locator('#tbody tr').count()>0
    page.get_by_label('Invoice month',exact=True).fill('2099-01')
    expect(page.locator('#tbody tr')).to_have_count(0)
    page.get_by_label('Invoice month',exact=True).fill('')
    assert page.locator('#tbody tr').count()>0
    page.locator('.nav-customers').click()
    page.screenshot(path=str(ROOT/'workspace-preview-desktop.png'),full_page=True)
    page.locator('.nav-tickets').click();headers=page.locator('#thead th').all_text_contents();assert 'Description' not in headers and 'Resolution notes' not in headers
    page.evaluate("state.permissions={...state.permissions,write:[],delete:[]};render()")
    expect(page.locator('#access-mode-note')).to_be_visible();expect(page.locator('#add')).to_be_hidden()
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Page overflows phone viewport'
    page.locator('#menu-toggle').click();expect(page.locator('.nav-group-heading').first).to_be_visible()
    page.screenshot(path=str(ROOT/'workspace-preview-mobile.png'),full_page=True)
    assert not errors,errors
    local=browser.new_page()
    local.goto('http://127.0.0.1:3000/',wait_until='domcontentloaded');expect(local.locator('#auth-submit')).to_be_enabled(timeout=30000)
    for asset in ('app.js','modern.css','dashboard.js'):
        first=page.request.get('http://127.0.0.1:3001/'+asset);second=page.request.get('http://127.0.0.1:3000/'+asset)
        assert first.ok and second.ok and first.body()==second.body(),asset
    browser.close()
print('PASS: grouped navigation, customer search/reset, compact tickets, view-only guidance, mobile width and matching localhost/demo assets.')
