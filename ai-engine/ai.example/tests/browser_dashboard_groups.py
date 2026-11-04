"""Verify grouped dashboard cards and customization in the running demo."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
settings=json.loads((ROOT/'.demo-share.local.json').read_text())
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True,args=['--disable-gpu'])
    page=browser.new_page(viewport={'width':1440,'height':1000})
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script("localStorage.setItem('ispcrm-layout','standard')")
    page.goto('http://127.0.0.1:3001/',wait_until='domcontentloaded')
    expect(page.locator('#auth-submit')).to_be_enabled(timeout=30000)
    page.locator('#auth-username').fill('demo-reviewer');page.locator('#auth-password').fill(settings['password']);page.locator('#auth-submit').click()
    expect(page.locator('.dashboard-category')).to_have_count(6,timeout=30000)
    expect(page.locator('[data-dashboard-card]')).to_have_count(21)
    titles=page.locator('.dashboard-category-heading h2').all_text_contents()
    assert titles==['Customers','Billing & balances','Collections','Expiry & renewals','Support & inventory','Terminations & revenue loss']
    ids=page.locator('[data-dashboard-card]').evaluate_all('(nodes)=>nodes.map(n=>n.dataset.dashboardCard)')
    assert len(ids)==len(set(ids))
    customer_group=page.locator('.dashboard-category').filter(has=page.get_by_role('heading',name='Customers',exact=True))
    expect(customer_group.locator('[data-dashboard-card]')).to_have_count(3)
    page.get_by_role('button',name='Customize Dashboard',exact=True).click()
    for label in ['Total clients','Active clients','New clients this month']:page.get_by_label(label,exact=True).uncheck()
    page.get_by_role('button',name='Save layout',exact=True).click();expect(customer_group).to_be_hidden()
    page.get_by_role('button',name='Customize Dashboard',exact=True).click();page.get_by_role('button',name='Show all',exact=True).click();page.get_by_role('button',name='Save layout',exact=True).click();expect(customer_group).to_be_visible()
    page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    expect(page.locator('.dashboard-category')).to_have_count(6)
    for asset in ['dashboard.js','business-dashboard.js','modern.css']:
        local=page.request.get('http://127.0.0.1:3000/'+asset);demo=page.request.get('http://127.0.0.1:3001/'+asset);assert local.ok and demo.ok and local.body()==demo.body()
    assert not errors,errors
    browser.close()
print('PASS: six dashboard categories, all 21 cards, hide/show customization, phone layout and identical localhost/demo assets.')
