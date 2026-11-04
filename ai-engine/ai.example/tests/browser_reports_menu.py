"""Exercise actual Reports navigation against the isolated local demo."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
config=json.loads((ROOT/'.demo-share.local.json').read_text())
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True,args=['--disable-gpu'])
    page=browser.new_page(viewport={'width':1366,'height':900})
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto('http://127.0.0.1:3001/',wait_until='domcontentloaded')
    expect(page.locator('#auth-submit')).to_be_enabled(timeout=30000)
    page.locator('#auth-username').fill('demo-reviewer')
    page.locator('#auth-password').fill(config['password'])
    expect(page.locator('#auth-submit')).to_be_enabled(timeout=30000)
    page.locator('#auth-submit').click()
    button=page.locator('#navigation .nav-reports')
    expect(button).to_be_visible(timeout=30000)
    submenu=page.locator('#report-submenu')
    expect(submenu).to_be_hidden()
    button.click();expect(submenu).to_be_visible();expect(button).to_have_attribute('aria-expanded','true')
    button.click();expect(submenu).to_be_hidden();expect(button).to_have_attribute('aria-expanded','false')
    button.click();expect(submenu).to_be_visible()
    submenu.get_by_role('button',name='Daily Sales Report',exact=True).click()
    expect(page.locator('.report-output h2')).to_have_text('Daily Sales Report')
    button.click();expect(submenu).to_be_hidden()
    button.click();expect(submenu).to_be_visible()
    expect(page.locator('.report-output h2')).to_have_text('Daily Sales Report')
    page.set_viewport_size({'width':390,'height':844})
    page.locator('#menu-toggle').click()
    button.click();expect(submenu).to_be_hidden()
    expect(page.locator('body')).to_have_class(__import__('re').compile(r'.*menu-open.*'))
    button.click();expect(submenu).to_be_visible()
    submenu.get_by_role('button',name='Monthwise Collection',exact=True).click()
    expect(page.locator('.report-output h2')).to_have_text('Monthwise Collection')
    assert 'menu-open' not in (page.locator('body').get_attribute('class') or '')
    assert not errors,errors
    browser.close()
print('PASS: desktop/mobile Reports open-close-reopen, report selection, preserved content and no browser script errors.')
