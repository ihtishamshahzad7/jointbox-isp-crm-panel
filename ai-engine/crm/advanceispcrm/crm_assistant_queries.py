"""Deterministic read-only CRM lookups, using existing role-filtered records."""
import re
from datetime import date,timedelta,datetime
from zoneinfo import ZoneInfo
from decimal import Decimal
import crm_auth as auth
import crm_billing as billing
from crm_assistant_language import normalize

FIELDS={
 'Designations':('id','name','status'),
 'Categories':('id','name','status'),
 'TAT settings':('id','ticket_type','priority','hours'),
 'Users':('id','name','username','designation','role','status','staff_id'),
 'Customers':('id','payment_id','name','username','package','status','joined','expiry_date'),
 'Tickets':('id','subject','customer_id','assigned_to','type','priority','status','due_at'),
 'Inventory':('id','item','category','quantity','minimum_stock','location'),
 'Stock issues':('id','inventory_id','customer_id','employee_id','issued_against','quantity','issue_date','status','returned_at'),
 'Payments':('id','customer_id','amount','revenue_type','otc_type','payment_date','billing_month','method','reference'),
 'Expenses':('id','title','category','customer_id','payee','amount','expense_date','payment_date','status'),
 'Staff':('id','employee_code','name','designation','department','role','status','reports_to'),
 'Packages':('id','name','speed_mbps','monthly_price','monthly_cost','installation_fee','status'),
 'Equipment recovery':('id','customer_id','terminated_on','status','monthly_revenue_loss','recovered_at'),
 'Invoices':('id','customer_id','customer_name','invoice_number','billing_month','issue_date','amount','service_amount','previous_balance','total','paid','remaining'),
}

def period(question,today):
    q=normalize(question);day=date.fromisoformat(today)
    dates=re.findall(r'\b\d{4}-\d{2}-\d{2}\b',q)
    if dates:
        start=date.fromisoformat(dates[0]);end=date.fromisoformat(dates[-1])
        if end<start:raise ValueError('End date must be after the start date.')
        return start.isoformat(),end.isoformat()
    months=re.findall(r'\b\d{4}-\d{2}\b',q)
    if months:
        first=date.fromisoformat(months[0]+'-01');next_month=(first.replace(day=28)+timedelta(days=4)).replace(day=1)
        return first.isoformat(),(next_month-timedelta(days=1)).isoformat()
    if 'yesterday' in q:return ((day-timedelta(days=1)).isoformat(),)*2
    if 'today' in q or 'daily' in q:return (today,)*2
    recent=re.search(r'last (\d+) days?',q)
    if recent:
        days=int(recent.group(1))
        if not 1<=days<=366:raise ValueError('Use a date range of 1?366 days.')
        return (day-timedelta(days=days-1)).isoformat(),today
    if 'last month' in q:
        last=day.replace(day=1)-timedelta(days=1);return last.replace(day=1).isoformat(),last.isoformat()
    if 'this month' in q:return day.replace(day=1).isoformat(),today
    return None

def lookup(db,user,question,records,snapshot):
    q=normalize(question)
    if re.search(r'\bhow (do|to|can|does)|\bwhat is\b|\bexplain\b|\bprocess\b',q):return None
    if re.search(r'password|secret|api.?key|bank account|\bcnic\b|salary|salaries',q):return {'section':'Protected details','error':'The assistant does not retrieve passwords, API secrets, identity documents, bank details or employee salaries. Use the authorized employee screen for private staff information.'}
    if re.search(r'\bsales?\b',q):
        if not auth.allowed(user,'Payments'):return {'section':'Sales','error':'Your role does not have access to sales information.'}
        dates=period(question,snapshot['date_pkt'])
        def included(day):return not dates or dates[0]<=str(day)[:10]<=dates[1]
        invoices=[r for r in billing.monthly_invoices(db) if included(r['issue_date'])]
        otc=[r for r in records.get('Payments',[]) if r['revenue_type']=='OTC' and included(r['payment_date'])]
        new=[c for c in records.get('Customers',[]) if c.get('joined') and included(c['joined'])]
        recharges=list(db.execute('SELECT customer_id,activated_at FROM customer_recharges'))
        activated={r['customer_id'] for r in recharges if included(r['activated_at'].astimezone(ZoneInfo('Asia/Karachi')).date())}
        amount=sum((r['amount'] for r in invoices+otc),Decimal(0))
        return {'section':'Sales','matching_records':len(invoices)+len(otc),'shown':0,'period':dates,'date_field':'invoice issue / OTC receipt date','totals':{'sales':amount,'new_customers':len(new),'activated_connections':len(activated)},'records':[],'note':'Sales = MRC invoices raised plus paid OTC receipts, not total cash collection. Activated connections include renewals/reactivations; new connections use customer joining dates.'}
    section=None
    for candidate,pattern in [('TAT settings',r'tat settings|tat rules'),('Designations',r'list designations|show designations|available designations'),('Categories',r'categories'),('Users',r'user accounts|login accounts|list users'),('Invoices',r'invoice|monthly bill'),('Stock issues',r'issued|stock movements|stock issues'),('Equipment recovery',r'terminat|equipment recover|device recover'),('Payments',r'payment|receipt|collection'),('Expenses',r'expense'),('Tickets',r'ticket|complaint|tat'),('Inventory',r'inventory|low.?stock|stock|\bont\b|\bolt\b|fiber|splitter'),('Staff',r'employee|staff|hierarchy|designation'),('Packages',r'package|pricing'),('Customers',r'customer|connection|expired|expiry|balance|dues')]:
        if re.search(pattern,q):section=candidate;break
    matched=snapshot.get('matched_customers',[])
    if not section and matched:section='Customers'
    if not section:return None
    permission='Payments' if section=='Invoices' else section
    if not auth.allowed(user,permission):return {'section':section,'error':'Your role does not have access to '+section+'.'}
    requested_ids=re.findall(r'(?<!\d)\d{9}(?!\d)',q)
    named_customer=re.search(r'\bcustomer(?:\s+id)?\s+([a-z0-9_.@-]+)',q)
    generic={'balance','balances','dues','invoices','payments','tickets','equipment','list','count','summary','details','profile','status','expiry','names','accounts','connections','records','information'}
    if named_customer and named_customer.group(1) not in generic and not matched:return {'section':section,'error':'No matching customer name, username or payment ID found. Include the full name or 9-digit payment ID.'}
    if requested_ids and not any(str(c.get('payment_id')) in requested_ids for c in matched):return {'section':section,'error':'No matching customer payment ID found in your permitted records.'}
    rows=billing.monthly_invoices(db) if section=='Invoices' else list(records.get(section,[]))
    customer_ids={c['id'] for c in matched}
    if customer_ids and section not in ('Staff','Inventory','Packages'):
        rows=[r for r in rows if (r['id'] if section=='Customers' else r.get('customer_id')) in customer_ids]
    # An explicit record identifier takes precedence over broad text matching.
    record_id=re.search(r'\b(?:tkt|iss|rcp|inv)[- #]*(\d+)\b',q) if section in ('Tickets','Stock issues','Payments') else None
    if record_id:rows=[r for r in rows if r['id']==int(record_id.group(1))]
    if section=='Customers':
        if 'expired' in q:rows=[r for r in rows if r.get('expiry_date') and str(r['expiry_date'])<snapshot['date_pkt'] and r['status']!='Terminated']
        elif re.search(r'\bactive\b',q):rows=[r for r in rows if r['status']=='Active']
        if 'balance' in q or 'dues' in q:
            if not auth.allowed(user,'Payments'):return {'section':section,'error':'Your role does not have access to customer balances.'}
            from crm_customer_ledger import account_balances
            balances=account_balances(db)
            rows=[dict(r,account_balance=balances.get(r['id'],0)) for r in rows]
            if not customer_ids:rows=[r for r in rows if r['account_balance']>0];rows.sort(key=lambda r:r['account_balance'],reverse=True)
    matched_staff=[r['id'] for r in records.get('Staff',[]) if any(len(str(r.get(k,'')))>=3 and re.search(r'(?<!\w)'+re.escape(str(r.get(k,'')).lower())+r'(?!\w)',q) for k in ('name','employee_code'))]
    if matched_staff and section=='Staff':rows=[r for r in rows if r['id'] in matched_staff]
    if matched_staff and section=='Tickets' and re.search(r'assigned to|employee|staff',q):rows=[r for r in rows if r.get('assigned_to') in matched_staff]
    if section=='Payments':
        if re.search(r'\bmrc\b',q):rows=[r for r in rows if r['revenue_type']=='MRC']
        elif re.search(r'\botc\b',q):rows=[r for r in rows if r['revenue_type']=='OTC']
        for method in ('Cash','Card','JazzCash','Easypaisa','1LINK'):
            if re.search(r'\b'+method.lower()+r'\b',q):rows=[r for r in rows if r['method']==method];break
    if section=='Tickets':
        if 'unassigned' in q:rows=[r for r in rows if not r.get('assigned_to') and r['status'] not in ('Resolved','Closed')]
        elif 'open' in q:rows=[r for r in rows if r['status'] not in ('Resolved','Closed')]
        if 'overdue' in q:rows=[r for r in rows if r['status'] not in ('Resolved','Closed') and (r.get('due_at')<datetime.now(ZoneInfo('Asia/Karachi')) if r.get('due_at') else str(r.get('due_date',''))<snapshot['date_pkt'])]
    if section=='Inventory':
        if 'low' in q:rows=[r for r in rows if r['quantity']<=r['minimum_stock']]
        if 'out of stock' in q:rows=[r for r in rows if r['quantity']==0]
        categories=[word for word in ('ont','olt','fiber','splitter') if re.search(r'\b'+word+r'\b',q)]
        if categories:rows=[r for r in rows if any(word in (r['item']+' '+r['category']).lower() for word in categories)]
    if section=='Equipment recovery' and 'pending' in q:rows=[r for r in rows if r['status']=='Equipment recovery pending']
    dates=period(question,snapshot['date_pkt'])
    date_field={'Payments':'payment_date','Invoices':'issue_date','Expenses':'expense_date','Equipment recovery':'terminated_on','Stock issues':'issue_date','Customers':'expiry_date' if 'expir' in q else 'joined'}.get(section)
    invoice_month=re.search(r'\b(\d{4}-\d{2})(?!-\d)\b',q) if section=='Invoices' else None
    if invoice_month:
        rows=[r for r in rows if r['billing_month']==invoice_month.group(1)];dates=None;date_field=None
    if dates and date_field:rows=[r for r in rows if r.get(date_field) and dates[0]<=str(r[date_field])[:10]<=dates[1]]
    if dates and not date_field:return {'section':section,'error':'Date filtering is not supported for this lookup. Ask without dates or use the Reports section.'}
    staff={r['id']:r['name'] for r in records.get('Staff',[])};customers={r['id']:r['name'] for r in records.get('Customers',[])};items={r['id']:r['item'] for r in records.get('Inventory',[])}
    output=[]
    for r in rows[:20]:
        fields=FIELDS[section]+(('account_balance',) if section=='Customers' and 'account_balance' in r else ())
        entry={k:(str(r[k])[:200] if r.get(k) is not None else None) for k in fields if k in r}
        for key,names in [('customer_id',customers),('assigned_to',staff),('employee_id',staff),('reports_to',staff),('inventory_id',items)]:
            if r.get(key) in names:entry[key+'_name']=names[r[key]]
        output.append(entry)
    totals={}
    if section in ('Payments','Expenses'):totals['recorded_amount']=sum((r['amount'] for r in rows),Decimal(0))
    if section=='Invoices':totals['current_charges']=sum((r['amount']+r['service_amount'] for r in rows),Decimal(0))
    return {'section':section,'matching_records':len(rows),'shown':len(output),'period':dates,'date_field':date_field if dates else None,'totals':totals,'records':output,'note':'Showing at most 20 matching records. Totals include all matches; invoice charges exclude carried-forward balances. Expenses include statuses shown and are not necessarily paid.'}

def format_lookup(result):
    from crm_assistant_language import localize
    localized=localize(result)
    if localized is not None:return localized
    if result.get('error'):return result['error']
    lines=[f"{result['section']}: {result['matching_records']} matching records; showing {result['shown']}."]
    if result['period']:lines.append('Dates: '+' to '.join(result['period'])+' ('+result['date_field']+').')
    for key,value in result['totals'].items():lines.append(key.replace('_',' ').capitalize()+f': PKR {value:,.2f}')
    for row in result['records']:lines.append(' · '.join(key.replace('_',' ')+': '+str(value) for key,value in row.items() if value is not None))
    if not result['records']:lines.append('No matching records found in your permitted data.')
    lines.append(result['note']);return '\n'.join(lines)
