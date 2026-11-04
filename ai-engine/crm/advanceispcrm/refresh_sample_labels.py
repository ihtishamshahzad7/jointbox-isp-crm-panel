"""Rename only explicitly seeded sample records; preserve real records and all amounts."""
import re
import crm_data

BILLING_NAMES=['Shahzaib Khan','Areeba Siddiqui','Muhammad Noman','Rabia Tariq','Faisal Mehmood','Hammad Yousaf']

def apply(db):
    db.execute('''CREATE TABLE IF NOT EXISTS sample_seed_aliases(table_name TEXT NOT NULL,marker TEXT NOT NULL,original_key TEXT NOT NULL,record_id BIGINT NOT NULL,PRIMARY KEY(table_name,marker,original_key))''')
    changes=[]
    def remember(table,marker,original,rid):
        db.execute('INSERT INTO sample_seed_aliases VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING',(table,marker,original,rid))
    for c in list(db.execute("SELECT * FROM customers WHERE username LIKE 'demo.%' ORDER BY id")):
        if not re.fullmatch(r'demo\.(?:user[0-9]{2}|billing\.expired0[1-6])',c['username']) or not c['name'].startswith('[DEMO'):continue
        name=BILLING_NAMES[int(c['username'][-2:])-1] if '.billing.' in c['username'] else c['name'].replace('[DEMO] ','').strip()
        username=name.lower().replace(' ','.')
        if db.execute('SELECT 1 FROM customers WHERE username=%s AND id!=%s',(username,c['id'])).fetchone():username+='.'+str(c['id'])
        remember('customers','username',c['username'],c['id'])
        db.execute('UPDATE customers SET name=%s,username=%s,address=%s,phone=%s,email=%s WHERE id=%s',(name,username,f"House {12+c['id']}, Street {c['id']%8+1}, "+['Model Town','Gulberg','Johar Town','Garden Town'][c['id']%4],f"03XX-XXX-{2100+c['id']}",username+'@example.com',c['id']))
        changes.append(c['id'])
    for p in list(db.execute("SELECT * FROM packages WHERE name LIKE '[DEMO]%' OR name LIKE '[DEMO BILLING]%' ORDER BY id")):
        # Do not rename a package if it is shared with an actual customer.
        if db.execute('SELECT 1 FROM customers WHERE package_id=%s AND NOT(id=ANY(%s))',(p['id'],changes)).fetchone():continue
        name=('Value' if 'BILLING' in p['name'] else 'Fiber')+f" {p['speed_mbps']} Mbps"
        if db.execute('SELECT 1 FROM packages WHERE name=%s AND id!=%s',(name,p['id'])).fetchone():name+=' Plus'
        remember('packages','name',p['name'],p['id'])
        db.execute('UPDATE packages SET name=%s WHERE id=%s',(name,p['id']))
    if changes:
        db.execute('UPDATE customers c SET package=p.name FROM packages p WHERE c.package_id=p.id AND c.id=ANY(%s)',(changes,))
        db.execute('UPDATE invoices i SET customer_name=c.name,username=c.username,phone=c.phone,address=c.address,package_name=c.package FROM customers c WHERE i.customer_id=c.id AND c.id=ANY(%s)',(changes,))
        db.execute('UPDATE payment_receipts r SET customer_name=c.name,username=c.username,phone=c.phone,address=c.address,package_name=c.package FROM customers c WHERE r.customer_id=c.id AND c.id=ANY(%s)',(changes,))
        db.execute("UPDATE tickets t SET subject=CASE WHEN expiry_recovery_date IS NOT NULL THEN 'Equipment recovery - '||c.name ELSE replace(replace(t.subject,'[DEMO] ',''),'[DEMO BILLING] ','') END FROM customers c WHERE t.customer_id=c.id AND c.id=ANY(%s)",(changes,))
    return len(changes)

if __name__=='__main__':
    with crm_data.connect_database() as db:
        count=apply(db)
    print(f'Updated {count} seeded sample customers. Customer IDs and financial amounts preserved.')
