"""The three themes (Light, Dark, Glossy), persistence, retired-theme migration and responsive navigation."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True)
    page=browser.new_page(viewport={'width':1440,'height':1050});errors=[];page.on('pageerror',lambda e:(errors.append(str(e)),print('Browser error:',str(e),flush=True)))
    page.goto('http://127.0.0.1:3001/');expect(page.locator('#auth-submit')).to_be_enabled(timeout=30000)
    page.locator('#auth-username').fill('demo-reviewer');page.locator('#auth-password').fill(json.loads((ROOT/'.demo-share.local.json').read_text())['password']);page.locator('#auth-submit').click()
    expect(page.locator('.dashboard-category')).to_have_count(6,timeout=30000)
    expect(page.locator('.studio-overview')).to_be_visible();expect(page.locator('.studio-activity')).to_be_visible()
    assert page.locator('#workspace-tabs').evaluate("(node)=>node.parentElement.classList.contains('app-topbar')")
    assert page.locator('[data-theme-choice]').evaluate_all('b=>b.map(x=>x.textContent)')==['Light','Dark','Glossy']
    for name,resolved,skin in [('digital','light','digital'),('dark','dark','default')]:
        page.locator('[data-theme-choice='+name+']').click();expect(page.locator('html')).to_have_attribute('data-skin',skin);expect(page.locator('html')).to_have_attribute('data-theme',resolved)
        expect(page.locator('#workspace-tabs')).to_be_visible();expect(page.locator('#sidebar')).to_have_css('width','78px')
        page.screenshot(path=str(ROOT/('workspace-preview-'+name+'.png')))
        page.reload();expect(page.locator('.dashboard-category')).to_have_count(6,timeout=30000);expect(page.locator('html')).to_have_attribute('data-skin',skin)
        page.get_by_role('navigation',name='Workspace shortcuts').get_by_role('button',name='Customers',exact=True).click();expect(page.locator('#title')).to_have_text('Customers')
        page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.locator('#menu-toggle').click();expect(page.locator('#sidebar')).to_be_in_viewport();page.keyboard.press('Escape');expect(page.locator('#sidebar')).not_to_be_in_viewport()
        page.screenshot(path=str(ROOT/('workspace-preview-'+name+'-mobile.png')))
        page.set_viewport_size({'width':1440,'height':1050});page.mouse.move(1200,80);expect(page.locator('#sidebar')).to_have_css('width','78px');page.locator('#workspace-tabs').get_by_role('button',name='Overview',exact=True).click()
    page.locator('[data-theme-choice=light]').click();expect(page.locator('.studio-overview')).to_be_visible();page.locator('#layout-toggle').click();expect(page.locator('html')).to_have_attribute('data-layout','standard');expect(page.locator('.studio-overview')).to_have_count(0);expect(page.locator('html')).to_have_attribute('data-skin','default');expect(page.locator('#workspace-tabs')).to_be_hidden()
    page.locator('#layout-toggle').click();expect(page.locator('.studio-overview')).to_be_visible();page.reload();expect(page.locator('.studio-overview')).to_be_visible(timeout=30000)
    # Someone who had picked a retired theme lands on its closest remaining one.
    for retired,skin,resolved in [('obsidian','default','dark'),('ember','digital','light'),('system','default','light')]:
        page.evaluate('t=>localStorage.setItem("ispcrm-theme",t)',retired);page.reload()
        expect(page.locator('html')).to_have_attribute('data-skin',skin);expect(page.locator('html')).to_have_attribute('data-theme',resolved)
    for asset in ('theme.js','app.js','modern.css'):
        local=page.request.get('http://127.0.0.1:3000/'+asset);demo=page.request.get('http://127.0.0.1:3001/'+asset);assert local.ok and demo.ok and local.body()==demo.body()
    assert not errors,errors
    browser.close()
print('PASS: three themes, saved preferences, retired-theme migration, pill navigation, compact sidebar, mobile layout and identical localhost/demo assets.')
