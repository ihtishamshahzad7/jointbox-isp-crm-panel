"""Realistic fictional presentation, restricted to the isolated share-demo database."""
import re

def apply(db):
    name=db.execute('SELECT current_database() AS name').fetchone()['name']
    if not re.fullmatch(r'ispcrm_share_demo_[a-f0-9]{12}',name):raise ValueError('Presentation updates are restricted to the dedicated share-demo database.')
    db.execute('CREATE TABLE IF NOT EXISTS demo_presentation_state(version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)')
    if db.execute('SELECT 1 FROM demo_presentation_state WHERE version=1').fetchone():return
    staff_names=['Ahmed Farooq','Bilal Hussain','Sana Iqbal','Kashif Mahmood','Imran Saeed']
    for index,staff in enumerate(db.execute("SELECT id,name,role FROM staff WHERE name LIKE '[DEMO]%' ORDER BY id")):
        new=staff_names[index%len(staff_names)]
        db.execute("UPDATE staff SET name=%s,phone=%s,designation=%s,email=%s,address=%s WHERE id=%s",(new,f'03XX-XXX-{1101+index}',{'Technician':'Field Network Technician','Support':'Customer Support Officer','Collector':'Collection Officer'}.get(staff['role'],'Operations Officer'),new.lower().replace(' ','.')+'@example.com','Staff residence, Sector '+str(index+1),staff['id']))
    for package in db.execute("SELECT * FROM packages WHERE name LIKE '[DEMO]%' OR name LIKE '[DEMO BILLING]%' ORDER BY id"):
        tier='Value' if 'BILLING' in package['name'] else 'Fiber'
        new=f"{tier} {package['speed_mbps']} Mbps"
        db.execute('UPDATE packages SET name=%s,monthly_cost=%s WHERE id=%s',(new,round(float(package['monthly_price'])*.55,2),package['id']))
    billing_names=['Shahzaib Khan','Areeba Siddiqui','Muhammad Noman','Rabia Tariq','Faisal Mehmood','Hammad Yousaf']
    rows=list(db.execute("SELECT * FROM customers WHERE username LIKE 'demo.%' ORDER BY id"))
    for index,c in enumerate(rows):
        full=billing_names[int(c['username'][-2:])-1] if c['username'].startswith('demo.billing.') else c['name'].replace('[DEMO] ','').strip()
        username=full.lower().replace(' ','.')
        address=f'House {14+index}, Street {index%8+1}, '+['Model Town','Gulberg','Johar Town','Garden Town'][index%4]
        db.execute('UPDATE customers SET name=%s,username=%s,phone=%s,address=%s,email=%s WHERE id=%s',(full,username,f'03XX-XXX-{2101+index}',address,username+'@example.com',c['id']))
    db.execute('UPDATE customers c SET package=p.name FROM packages p WHERE c.package_id=p.id')
    for item in db.execute("SELECT id,item FROM inventory WHERE item LIKE '[DEMO]%' ORDER BY id"):
        db.execute("UPDATE inventory SET item=%s,location='Central Warehouse' WHERE id=%s",(item['item'].replace('[DEMO] ',''),item['id']))
    db.execute("UPDATE jobs SET title=replace(title,'[DEMO] ',''),notes='Customer site visit and service follow-up.' WHERE title LIKE '[DEMO]%'")
    db.execute("UPDATE tickets SET subject=replace(subject,'[DEMO] ',''),description=replace(replace(description,'[DEMO] ',''),'Sample task for dashboard preview; no real customer work.','Customer site visit and service follow-up.')")
    db.execute("UPDATE payments SET reference=replace(reference,'DEMO-','TXN-') WHERE reference LIKE 'DEMO-%'")
    db.execute("UPDATE invoices i SET customer_name=c.name,username=c.username,phone=c.phone,address=c.address,package_name=c.package FROM customers c WHERE i.customer_id=c.id")
    db.execute("UPDATE payment_receipts r SET customer_name=c.name,username=c.username,phone=c.phone,address=c.address,package_name=c.package,reference=replace(r.reference,'DEMO-','TXN-'),recorded_by=CASE WHEN r.recorded_by='Historical payment' THEN 'Accounts Office' ELSE r.recorded_by END FROM customers c WHERE r.customer_id=c.id")
    db.execute("UPDATE customer_service_charges SET description=replace(description,'[DEMO] ',''),created_by='Accounts Office' WHERE description LIKE '[DEMO]%'")
    db.execute("UPDATE inventory_units SET serial_number=replace(serial_number,'DEMO-ONT-','ONT-26-000') WHERE serial_number LIKE 'DEMO-ONT-%'")
    db.execute("UPDATE inventory_movements SET actor_name='Warehouse Admin' WHERE actor_name='Demo system'")
    db.execute("UPDATE app_users SET name='Ahsan Malik',designation='Operations Manager' WHERE username='demo-reviewer'")
    db.execute("UPDATE customer_notifications SET title=replace(title,'[DEMO] ',''),body=replace(replace(body,'[DEMO] ',''),'[DEMO BILLING] ','')")
    db.execute("UPDATE tickets t SET subject=CASE WHEN expiry_recovery_date IS NOT NULL THEN 'Equipment recovery - '||c.name ELSE replace(replace(t.subject,'[DEMO] ',''),'[DEMO BILLING] ','') END FROM customers c WHERE t.customer_id=c.id")
    db.execute("UPDATE ticket_events SET message=replace(replace(message,'[DEMO] ',''),'[DEMO BILLING] ','')")
    for index,employee in enumerate(db.execute('SELECT id FROM staff ORDER BY id')):
        db.execute('UPDATE staff SET employee_code=%s,monthly_salary=%s,allowances=%s,joining_date=%s WHERE id=%s',(f'EMP-{1001+index}',38000+index*2500,3000+index*500,'2025-04-01',employee['id']))
    db.execute('INSERT INTO demo_presentation_state(version) VALUES (1)')

if __name__=='__main__':
    import os,json
    from pathlib import Path
    config=json.loads(Path(__file__).with_name('.demo-share.local.json').read_text(encoding='utf-8'))
    os.environ['PGDATABASE']=config['database']
    import crm_data
    with crm_data.connect_database() as db:apply(db)
    print('Updated fictional names and records in the isolated shared demo.')
