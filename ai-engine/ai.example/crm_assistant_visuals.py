"""Build chart-safe aggregate summaries without returning individual records."""
def graphical_summary(snapshot,question=''):
    result=snapshot.get('lookup')
    if result is not None and result.get('error'):return None
    metrics=[]
    labels={'sales':'Sales (billed MRC + paid OTC)','recorded_amount':'Recorded amount','current_charges':'Current invoice charges','account_balance':'Customer balance','new_customers':'New connections','activated_connections':'Activated connections'}
    def add(label,value,unit='count'):
        metrics.append({'label':label,'value':float(value),'unit':unit})
    if result is not None:
        for key,value in result.get('totals',{}).items():
            add(labels.get(key,key.replace('_',' ').capitalize()),value,'count' if key in ('new_customers','activated_connections') else 'PKR')
        if result['section']!='Sales':add('Matching records',result['matching_records'])
        if result['section']=='Customers' and len(result.get('records',[]))==1:
            row=result['records'][0]
            if row.get('account_balance') is not None and 'account_balance' not in result.get('totals',{}):add('Customer balance',row['account_balance'],'PKR')
        title=result['section']+' summary'
        period=' to '.join(result['period']) if result.get('period') else 'All matching permitted records'
    else:
        if any(word in question.lower() for word in ('how','explain','process','what is')):return None
        customers=snapshot.get('customers',{})
        if customers:
            add('Active customers',customers['active']);add('Expired customers',customers['expired_excluding_terminated'])
        tickets=snapshot.get('tickets',{})
        if tickets:add('Open tickets',tickets['open']);add('Overdue tickets',tickets['overdue'])
        inventory=snapshot.get('inventory',{})
        if inventory:add('Low-stock items',inventory['low_stock'])
        title='Workspace summary';period=snapshot.get('date_pkt','')+' PKT'
    if not metrics:return None
    return {'title':title,'period':period,'metrics':metrics[:6],'note':'Bars compare values within the same unit; counts and PKR are shown separately.'}
