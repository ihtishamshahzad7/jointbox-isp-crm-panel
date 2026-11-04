"""Export the bilingual manual to a standalone HTML file and an illustrated PDF."""
import base64
import html
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright
from user_manual_content import PAGES

ROOT = Path(__file__).resolve().parent


def esc(value):
    return html.escape(value)


def pair(en, ur, cls='pair'):
    terms = ['Save confirmed payment', 'Recharge customer', 'View profile', 'Issue stock', 'Return stock', 'Print / Save PDF', 'Customer app access', 'Advanced filters', 'Clear filters', 'Sign in', 'Sign out', 'Username', 'Password', 'Payment ID', 'Payments', 'Customers', 'Tickets', 'Inventory', 'Settings', 'Finance', 'Ledger', 'Reports']
    english = re.sub('|'.join(re.escape(t) for t in terms), lambda m:'<strong>'+m.group(0)+'</strong>',esc(en))
    return f'<div class="{cls}"><div lang="en">{english}</div><div lang="ur" dir="rtl">{esc(ur)}</div></div>'


def main():
    sheets = []
    cover = '''<section class="page cover"><div class="kicker">ISP CRM · FIRST-TIME USER GUIDE</div>
    <div class="mark">◈</div><h1>Your daily work,<br>step by step.</h1><h2 lang="ur" dir="rtl">روزمرہ کام کا آسان طریقہ<br>تصویروں اور خاکوں کے ساتھ</h2>
    <p class="languages">ENGLISH + اردو</p>'''
    cover += pair('A practical guide for office staff, accounts, support, technicians and storekeepers — with a separate section for customers.', 'دفتر، اکاؤنٹس، سپورٹ، ٹیکنیشن اور سٹور کیپر کے لیے عملی رہنمائی — صارفین کے لیے الگ حصہ بھی شامل ہے۔')
    cover += '<div class="cover-tags">CUSTOMERS · BILLING · STOCK · TICKETS · REPORTS</div>'
    cover += pair('Prepared for the local ISP CRM · 21 October 2026. Screens use fictional training data, not live customer records. Layout and visible buttons can vary by role and screen size.', 'مقامی آئی ایس پی سی آر ایم کے لیے تیار کردہ · ۲۱ اکتوبر ۲۰۲۶۔ تصویروں میں فرضی تربیتی ڈیٹا ہے، اصل صارفین کا ریکارڈ نہیں۔ کردار اور سکرین کے مطابق ترتیب اور بٹن مختلف ہو سکتے ہیں۔', 'pair cover-note') + '</section>'
    sheets.append(cover)
    toc = '<section class="page"><div class="kicker">QUICK FIND · آسان فہرست</div><h1>Find your task</h1><h2 lang="ur" dir="rtl">اپنا مطلوبہ کام تلاش کریں</h2><div class="toc">'
    for i,p in enumerate(PAGES):
        toc += f'<a href="#task-{i+1}"><span>{i+3:02d}</span><strong>{esc(p["title"])}</strong><b lang="ur" dir="rtl">{esc(p["urdu"])}</b></a>'
    toc += '</div></section>'
    sheets.append(toc)
    for i,p in enumerate(PAGES):
        section = f'<section class="page" id="task-{i+1}"><div class="sheet"><div class="kicker">ISP CRM · EASY USER MANUAL · ENGLISH / اردو</div><header><h1>{esc(p["title"])}</h1><h2 lang="ur" dir="rtl">{esc(p["urdu"])}</h2></header>'
        if p['image']:
            file = ROOT / 'manual_assets' / (p['image']+'.png')
            data = base64.b64encode(file.read_bytes()).decode()
            section += f'<figure><img src="data:image/png;base64,{data}" alt="Training screenshot: {esc(p["title"])}"><figcaption>SCREEN EXAMPLE · FICTIONAL TRAINING RECORDS <span lang="ur" dir="rtl">تربیتی تصویر — فرضی ریکارڈ</span></figcaption></figure>'
        if p['flow']:
            section += '<div class="flow"><pre class="mermaid">'+esc(p['flow'])+'</pre></div>'
            section += pair('Read this chart from top to bottom. Follow Yes/No arrows at each question.', 'خاکہ اوپر سے نیچے پڑھیں۔ ہر سوال پر Yes یعنی ہاں یا No یعنی نہیں کے تیر کے مطابق آگے بڑھیں۔', 'pair flow-caption')
        if p['steps']:
            section += '<div class="column-labels"><span>WHAT TO DO</span><span lang="ur" dir="rtl">کیا کرنا ہے</span></div>'
        for n,(en,ur) in enumerate(p['steps'],1):
            section += '<div class="step"><div class="step-number">'+str(n)+'</div>'+pair(en,ur)+'</div>'
        if p['table']:
            section += '<table><thead><tr><th>Term / role / problem</th><th>English</th><th lang="ur" dir="rtl">اردو</th></tr></thead><tbody>'
            for label,en,ur in p['table']:
                section += f'<tr><th>{esc(label)}</th><td>{esc(en)}</td><td lang="ur" dir="rtl">{esc(ur)}</td></tr>'
            section += '</tbody></table>'
        if p['note']:
            section += '<aside>'+pair(*p['note'])+'</aside>'
        section += '</div></section>'
        sheets.append(section)
    css = '''
    @page{size:A4 portrait;margin:12mm 12mm 14mm;}*{box-sizing:border-box;}
    body{font-family:Arial,sans-serif;color:#193447;margin:0;background:white;}
    .page{break-before:page;width:186mm;height:260mm;position:relative;} .page:first-child{break-before:auto;}
    .sheet{transform-origin:top left;} .kicker{font-size:10px;letter-spacing:1.5px;color:#4e7786;padding:0 0 9px;border-bottom:2px solid #1395a4;}
    header{padding:12px 0 9px;}h1{font-size:23px;line-height:1.2;margin:0 0 4px;color:#15394b;}h2{font-size:23px;font-weight:500;margin:0;color:#147989;line-height:1.65;}
    [lang=ur]{font-family:Arial,'Segoe UI',sans-serif;letter-spacing:normal;font-size:16px;line-height:1.85;text-align:right;padding-right:5px;}
    .pair{display:grid;grid-template-columns:1fr 1fr;gap:20px;font-size:13px;line-height:1.5;}
    .pair>div{min-width:0;}figure{margin:2px 0 12px;padding:8px;background:#f2f6f8;border:1px solid #d8e6eb;border-radius:9px;text-align:center;}
    figure img{max-width:100%;max-height:265px;object-fit:contain;display:block;margin:auto;}
    figcaption{font-size:8px;color:#557381;margin-top:6px;display:flex;justify-content:space-between;align-items:center;}figcaption [lang=ur]{font-size:11px;}
    .column-labels{display:grid;grid-template-columns:1fr 1fr;gap:20px;font-size:10px;font-weight:bold;color:#337384;margin:5px 0 0;padding-left:27px;}.column-labels [lang=ur]{font-size:12px;}
    .step{position:relative;padding:8px 0 8px 27px;border-bottom:1px solid #e7edef;break-inside:avoid;}.step-number{position:absolute;left:0;top:12px;background:#158b9b;color:white;border-radius:50%;width:19px;height:19px;text-align:center;font-size:11px;line-height:19px;}
    aside{margin-top:12px;background:#edf6f6;border-left:4px solid #1b97a0;padding:10px 12px;border-radius:3px;}aside .pair{font-size:12px;}aside [lang=ur]{font-size:15px;}
    table{width:100%;border-collapse:collapse;font-size:12px;line-height:1.5;margin-top:14px;}td,th{padding:8px;border:1px solid #d8e4e8;text-align:left;vertical-align:top;}thead{background:#e8f3f5;}tbody th{width:23%;}td[lang=ur]{width:40%;font-size:15px;}
    .flow{height:310px;display:flex;align-items:center;justify-content:center;margin:4px 0 8px;background:#f7fafb;border:1px solid #dce8ec;border-radius:8px;}.flow svg{display:block;max-height:300px;max-width:100%;}.flow-caption{font-size:11px;color:#527583;margin:0 0 8px;}.flow-caption [lang=ur]{font-size:13px;}
    .cover{padding-top:20px;} .cover .mark{font-size:90px;color:#1495a3;margin:45px 0 20px;} .cover h1{font-size:51px;line-height:1.1;letter-spacing:-1.5px;} .cover h2{font-size:33px;line-height:1.9;margin:24px 0;}
    .languages{color:#167d8d;font-size:19px;font-weight:bold;letter-spacing:2px;margin:24px 0;}.cover .pair{font-size:15px;}.cover .pair [lang=ur]{font-size:18px;}.cover-tags{padding:20px 0;font-size:11px;letter-spacing:1.5px;border-top:1px solid #cee1e6;margin-top:30px;}.cover-note{margin-top:20px;}.cover .cover-note{font-size:11px;}.cover .cover-note [lang=ur]{font-size:14px;}
    .toc{margin-top:14px;}.toc a{display:grid;grid-template-columns:25px 1fr 1fr;gap:10px;align-items:center;text-decoration:none;color:inherit;border-bottom:1px solid #e5ecef;padding:5px 0;font-size:11px;}.toc a span{font-size:12px;color:#198391;}.toc a b[lang=ur]{font-size:13px;font-weight:400;line-height:1.6;}
    '''
    document = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ISP CRM — English and Urdu User Manual</title><style>'+css+'</style></head><body>'+''.join(sheets)+'</body></html>'
    with sync_playwright() as p:
        browser=p.chromium.launch(channel='msedge',headless=True)
        page=browser.new_page(viewport={'width':800,'height':1120})
        page.set_content(document)
        page.add_script_tag(path=str(ROOT/'mermaid.min.js'))
        page.evaluate('''async () => {mermaid.initialize({startOnLoad:false,theme:'base',securityLevel:'strict',themeVariables:{fontFamily:'Arial',fontSize:'15px',primaryColor:'#e5f3f5',primaryTextColor:'#193447',primaryBorderColor:'#3590a0',lineColor:'#507d8d'},flowchart:{htmlLabels:false,rankSpacing:20,nodeSpacing:20}});await mermaid.run();await document.fonts.ready;for(const svg of document.querySelectorAll('.flow svg')){const v=svg.viewBox.baseVal,s=Math.min(670/v.width,300/v.height);svg.style.maxWidth='none';svg.style.width=(v.width*s)+'px';svg.style.height=(v.height*s)+'px';}}''')
        # Keep every lesson together on a page and report any scale applied.
        fit=page.evaluate('''() => [...document.querySelectorAll('.page')].map((p,i)=>{const s=p.querySelector('.sheet')||p;const available=1000;const h=s.scrollHeight;const factor=h>available?available/h:1;if(factor<1&&s!==p){s.style.transform=`scale(${factor})`;s.style.width=(100/factor)+'%';}return {page:i+1,height:h,scale:factor};})''')
        if any(v['scale']<0.85 for v in fit):
            raise RuntimeError('Manual pages need shortening: '+json.dumps([v for v in fit if v['scale']<0.85]))
        page.emulate_media(media='print')
        page.pdf(path=str(ROOT/'ISP_CRM_USER_MANUAL_EN_UR.pdf'),prefer_css_page_size=True,print_background=True,display_header_footer=True,header_template='<div></div>',footer_template='<div style="font-family:Arial;font-size:9px;color:#537482;width:100%;padding:0 12mm;display:flex;justify-content:space-between"><span>ISP CRM · English / Urdu · Training guide</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>')
        # Save rendered SVGs and embedded screenshots, so HTML works offline too.
        page.evaluate("document.querySelectorAll('script').forEach(s=>s.remove())")
        (ROOT/'ISP_CRM_USER_MANUAL_EN_UR.html').write_text(page.content(),encoding='utf-8')
        page.locator('#task-11').screenshot(path=str(ROOT/'manual_assets'/'manual-page-preview.png'))
        page.locator('#task-2').screenshot(path=str(ROOT/'manual_assets'/'manual-flow-preview.png'))
        pdf=(ROOT/'ISP_CRM_USER_MANUAL_EN_UR.pdf').read_bytes()
        page_count=len(re.findall(rb'/Type\s*/Page\b',pdf))
        report={'expected_pages':len(sheets),'pdf_pages':page_count,'rendered_flowcharts':page.locator('.flow svg').count(),'screenshot_pages':sum(bool(p['image']) for p in PAGES),'pdf_bytes':len(pdf),'page_layout':fit}
        (ROOT/'manual_assets'/'manual-validation.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        browser.close()
        if page_count != len(sheets):
            raise RuntimeError(f'Unexpected PDF pagination: {page_count} instead of {len(sheets)}')
        print(json.dumps({k:v for k,v in report.items() if k!='page_layout'},indent=2))


if __name__=='__main__':
    main()
