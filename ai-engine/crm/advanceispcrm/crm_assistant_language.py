"""Small, explicit Urdu/Roman Urdu intent vocabulary for offline CRM lookups."""
import re

def language(text):
    if re.search(r'[\u0600-\u06ff]',text):return 'ur'
    if re.search(r'\b(kitni|kitna|kitne|aaj|aj|ajj|kal|hoi|hui|hua|ha|hai|hain|batao|dikhao|baki|baqi|mahine|mahinay|pichlay|pichle)\b',text.lower()):return 'roman'
    return 'en'

def normalize(text):
    q=text.lower();terms=[]
    mappings=[
        (r'\b(aaj|aj|ajj)\b|آج','today'),
        (r'\bkal\b|گزشتہ روز|(?<!\w)کل(?!\w)','yesterday'),
        (r'\b(is|iss) (mahine|mahinay|maheene)\b|اس ماہ|اس مہینے','this month'),
        (r'\b(pichle|pichlay) (mahine|mahinay)\b|پچھلے ماہ|پچھلے مہینے','last month'),
        (r'\b(sali|sale|sales|sail|farokht)\b|فروخت|سیل','sales'),
        (r'\b(wasooli|wasuli|wusooli|collection|jama)\b|وصولی|وصولیاں|کلیکشن','collections'),
        (r'\b(adaigi|payment|paisa|paise)\b|ادائیگی|پیسے','payments'),
        (r'\b(baki|baqi|baqaya|bakaya|udhar)\b|بقایا|باقی','customer balance'),
        (r'\b(sarif|customer|gahak)\b|صارف|گاہک','customers'),
        (r'انوائس|ماہانہ بل','invoices'),
        (r'\b(shikayat|shikayaat)\b|شکایت|ٹکٹ','tickets'),
        (r'\b(kam stock)\b|کم اسٹاک|کم سٹاک','low stock'),
        (r'اسٹاک|سٹاک|سامان','inventory'),
        (r'\b(band account|expire)\b|میعاد ختم|ایکسپائر','expired customers'),
        (r'\b(mulazim|mulaazim|amla)\b|ملازم|عملہ','staff'),
        (r'\b(kharcha|kharche|akhrajat)\b|اخراجات|خرچہ','expenses'),
        (r'\b(tankhwa|tankhwah)\b|تنخواہ','salary'),
        (r'پاس ورڈ|خفیہ','password'),
    ]
    for pattern,intent in mappings:
        if re.search(pattern,q):terms.append(intent)
    return q+' '+' '.join(terms)

def localize(result):
    lang=result.get('language','en')
    if lang=='en':return None
    if result.get('error'):
        return ('یہ معلومات آپ کی اجازت یا دستیاب ریکارڈ کے مطابق فراہم نہیں کی جا سکتیں۔ نام، کسٹمر آئی ڈی یا تاریخ چیک کریں۔' if lang=='ur' else 'Yeh maloomat aap ki ijazat ya dastiyab records ke mutabiq nahi mil sakin. Naam, customer ID aur tareekh check karein.')
    names={'Sales':('فروخت','Sale'),'Payments':('وصولیاں / ادائیگیاں','Wasooliyan / payments'),'Customers':('صارفین','Customers'),'Invoices':('انوائس','Invoices'),'Tickets':('ٹکٹ','Tickets'),'Inventory':('اسٹاک','Stock'),'Expenses':('اخراجات','Akhrajat')}
    title=names.get(result['section'],(result['section'],result['section']))[0 if lang=='ur' else 1]
    lines=[('فروخت کی تفصیل' if lang=='ur' else 'Sale ki tafseel') if result['section']=='Sales' else f"{title}: {result['matching_records']} "+('ریکارڈ' if lang=='ur' else 'records')]
    if result.get('period'):lines.append(('تاریخ: ' if lang=='ur' else 'Tareekh: ')+' - '.join(result['period']))
    labels={'recorded_amount':('کل رقم','Kul raqam'),'current_charges':('موجودہ بل کی رقم','Maujooda bill ki raqam'),'sales':('بل شدہ MRC + وصول شدہ OTC','Bill shuda MRC + wasool shuda OTC'),'new_customers':('نئے کنکشن','Naye connections'),'activated_connections':('ریچارج پر فعال کنکشن','Recharge par active connections'),'account_balance':('بقایا رقم','Baqaya raqam')}
    for key,value in result.get('totals',{}).items():
        label=labels.get(key,(key,key))[0 if lang=='ur' else 1]
        lines.append(label+': '+('PKR ' if key not in ('new_customers','activated_connections') else '')+f'{value:,.2f}'.removesuffix('.00'))
    for row in result.get('records',[]):
        lines.append(' | '.join((labels.get(k,(k.replace('_',' '),k.replace('_',' ')))[0 if lang=='ur' else 1])+': '+str(v) for k,v in row.items() if v is not None))
    if not result['matching_records'] and result['section']!='Sales':lines.append('کوئی متعلقہ ریکارڈ نہیں ملا۔' if lang=='ur' else 'Koi mutaliqa record nahi mila.')
    lines.append('صرف آپ کی اجازت والے ریکارڈ دکھائے گئے ہیں۔' if lang=='ur' else 'Sirf aap ki ijazat walay records dikhaye gaye hain.')
    return '\n'.join(lines)
