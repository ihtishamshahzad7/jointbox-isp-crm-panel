"""Render CRM_FLOWCHART.md into a PDF using local Mermaid and Playwright."""
from pathlib import Path
import html
import re
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent


def inline(value):
    return re.sub(r'`([^`]+)`', r'<code>\1</code>', html.escape(value))


def prose(value):
    output = []
    table = False
    for line in value.strip().splitlines():
        if line.startswith('|'):
            if re.fullmatch(r'[| :\-]+', line):
                continue
            if not table:
                output.append('<table>')
                table = True
            output.append('<tr>' + ''.join('<td>' + inline(c.strip()) + '</td>' for c in line.strip('|').split('|')) + '</tr>')
        else:
            if table:
                output.append('</table>')
                table = False
            if line.strip():
                output.append('<p>' + inline(line) + '</p>')
    if table:
        output.append('</table>')
    return ''.join(output)


def main():
    source = (ROOT / 'CRM_FLOWCHART.md').read_text(encoding='utf-8')
    sections = re.split(r'^## ', source, flags=re.M)[1:]
    pages = []
    count = 0
    for section in sections:
        title, body = section.split('\n', 1)
        match = re.search(r'```mermaid\n(.*?)```', body, flags=re.S)
        diagram = ''
        if match:
            count += 1
            diagram = '<div class="diagram"><pre class="mermaid">' + html.escape(match[1]) + '</pre></div>'
            body = body[:match.start()] + body[match.end():]
        pages.append('<section><div class="eyebrow">ISP CRM · APPLICATION LOGIC</div><h1>' + inline(title) + '</h1>' + diagram + '<div class="notes">' + prose(body) + '</div></section>')
    document = '''<!doctype html><html><head><meta charset="utf-8"><style>
    @page {size:A3 portrait; margin:15mm 16mm 18mm;}
    * {box-sizing:border-box} body {margin:0; font-family:Arial,sans-serif; color:#17304a;}
    section {break-before:page;} section:first-child {break-before:auto;}
    .eyebrow {font-size:12px;letter-spacing:2px;color:#52758d;margin-bottom:12px;}
    h1 {font-size:27px;margin:0 0 18px;border-bottom:3px solid #248a99;padding-bottom:12px;}
    .diagram {height:1120px;display:flex;align-items:center;justify-content:center;}
    .diagram svg {display:block;} .notes {font-size:14px;line-height:1.5;margin-top:14px;}
    p {margin:8px 0;} code {font-family:Consolas,monospace;font-size:12px;}
    table {border-collapse:collapse;width:100%;font-size:15px;margin-top:15px;}
    td {border:1px solid #c9d8e1;padding:9px;} tr:first-child {background:#e7f1f5;font-weight:bold;}
    </style></head><body>''' + ''.join(pages) + '</body></html>'
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)
        page = browser.new_page(viewport={'width': 1100, 'height': 1500})
        page.set_content(document)
        page.add_script_tag(path=str(ROOT / 'mermaid.min.js'))
        page.evaluate('''async () => {
          mermaid.initialize({startOnLoad:false, theme:'base', securityLevel:'strict',
            themeVariables:{fontFamily:'Arial',fontSize:'16px',primaryColor:'#e7f3f6',primaryTextColor:'#17304a',primaryBorderColor:'#368799',lineColor:'#52758d',secondaryColor:'#fff0cb',tertiaryColor:'#eef4fa'},
            flowchart:{htmlLabels:false,curve:'linear',nodeSpacing:24,rankSpacing:30}});
          await mermaid.run({querySelector:'.mermaid'});
          await document.fonts.ready;
          for (const svg of document.querySelectorAll('.diagram svg')) {
            const v=svg.viewBox.baseVal;
            const scale=Math.min(990/v.width,1110/v.height);
            svg.style.maxWidth='none'; svg.style.width=(v.width*scale)+'px';
            svg.style.height=(v.height*scale)+'px';
          }
        }''')
        rendered = page.locator('.diagram svg').count()
        if rendered != count or page.locator('.error-icon').count():
            raise RuntimeError(f'Diagram rendering failed: {rendered}/{count}')
        page.pdf(path=str(ROOT / 'CRM_FLOWCHART.pdf'), print_background=True,
                 prefer_css_page_size=True, display_header_footer=True,
                 header_template='<div></div>',
                 footer_template='<div style="font-size:10px;color:#52758d;width:100%;text-align:center">ISP CRM — Workflow reference · <span class="pageNumber"></span> / <span class="totalPages"></span></div>')
        page.screenshot(path=str(ROOT / 'flowchart-pdf-preview.png'), full_page=False)
        browser.close()
    print(f'Created CRM_FLOWCHART.pdf with {rendered} rendered diagrams.')


if __name__ == '__main__':
    main()
