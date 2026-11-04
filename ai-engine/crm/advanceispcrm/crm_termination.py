"""Termination audit and equipment recovery linked to actual stock returns."""
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
from crm_tat import default_hours

DEVICE_CATEGORIES=('ONT','ONU','OLT','Router','Switch','ONU / ONT','SFP / SFP+ Module','Media Converter','PoE Injector','Power Adapter','UPS','Battery','Splicing Machine','Optical Power Meter','OTDR')

def initialize(db):
    db.execute("ALTER TABLE customers ADD COLUMN IF NOT EXISTS recovery_status TEXT NOT NULL DEFAULT 'Not required'")
    db.execute('ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS recovery_required TEXT')
    db.execute("UPDATE stock_issues s SET recovery_required=CASE WHEN i.category=ANY(%s) THEN 'Yes' ELSE 'No' END FROM inventory i WHERE i.id=s.inventory_id AND s.recovery_required IS NULL",(list(DEVICE_CATEGORIES),))
    db.execute("ALTER TABLE stock_issues ALTER COLUMN recovery_required SET DEFAULT 'Yes'")
    db.execute('ALTER TABLE stock_issues ALTER COLUMN recovery_required SET NOT NULL')
    db.execute('ALTER TABLE equipment_recovery ADD COLUMN IF NOT EXISTS terminated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP')
    db.execute('ALTER TABLE equipment_recovery ADD COLUMN IF NOT EXISTS recovered_at TIMESTAMPTZ')
    db.execute('ALTER TABLE equipment_recovery ADD COLUMN IF NOT EXISTS terminated_by BIGINT REFERENCES app_users(id) ON DELETE SET NULL')
    db.execute('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS expiry_recovery_date DATE')
    db.execute('CREATE UNIQUE INDEX IF NOT EXISTS tickets_expiry_recovery_unique ON tickets(customer_id,expiry_recovery_date) WHERE expiry_recovery_date IS NOT NULL')
    db.execute('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS recovery_id BIGINT REFERENCES equipment_recovery(id) ON DELETE RESTRICT')


def resolve_expiry_recovery(db,customer_id,reason):
    tickets=list(db.execute("UPDATE tickets SET status='Resolved',resolution_notes=resolution_notes||%s,resolved_at=COALESCE(resolved_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE customer_id=%s AND expiry_recovery_date IS NOT NULL AND status NOT IN ('Resolved','Closed') RETURNING id", ('\n'+reason,customer_id)))
    for ticket in tickets:
        db.execute('INSERT INTO ticket_events(ticket_id,message) VALUES (%s,%s)',(ticket['id'],reason))


def generate_expiry_recovery(db,today=None):
    today=today or datetime.now(ZoneInfo('Asia/Karachi')).date()
    customers=list(db.execute("SELECT * FROM customers WHERE status!='Terminated' AND expiry_date<=%s ORDER BY id FOR UPDATE",(today-timedelta(days=5),)))
    for customer in customers:
        if db.execute("SELECT 1 FROM tickets WHERE customer_id=%s AND expiry_recovery_date IS NOT NULL AND (expiry_recovery_date=%s OR status NOT IN ('Resolved','Closed'))",(customer['id'],customer['expiry_date'])).fetchone():
            continue
        items=pending_items(db,customer['id'])
        now=datetime.now(ZoneInfo('Asia/Karachi'));hours=default_hours(db,'Equipment recovery','Normal');due=now+timedelta(hours=hours)
        description='Customer: '+customer['name']+' (Payment ID: '+customer['payment_id']+')\nConnection expired on '+customer['expiry_date'].isoformat()+'. Recharge the account or recover all required equipment.\n'+'\n'.join(f"ISS-{i['id']}: {i['item']} x {i['quantity']}" for i in items)
        if not items:
            description+='\nNo recoverable equipment is currently recorded against this customer.'
        ticket=db.execute("""INSERT INTO tickets(subject,customer_id,assigned_to,type,priority,status,due_date,description,resolution_notes,tat_hours,due_at,expiry_recovery_date)
            VALUES (%s,%s,NULL,'Equipment recovery','Normal','Open',%s,%s,'',%s,%s,%s) ON CONFLICT (customer_id,expiry_recovery_date) WHERE expiry_recovery_date IS NOT NULL DO NOTHING RETURNING id""",('Expiry recovery - '+customer['name'],customer['id'],due.date(),description,hours,due,customer['expiry_date'])).fetchone()
        if ticket:
            db.execute('INSERT INTO ticket_events(ticket_id,message) VALUES (%s,%s)',(ticket['id'],'System: Recovery ticket opened five or more days after expiry. Assign a recovery employee.'))


def pending_items(db,customer_id):
    return list(db.execute("SELECT s.*,i.item FROM stock_issues s JOIN inventory i ON i.id=s.inventory_id WHERE s.customer_id=%s AND s.issued_against='Customer' AND s.status='Issued' AND s.recovery_required='Yes' ORDER BY s.id",(customer_id,)))


def terminate(db,customer_id,user,reason,employee_id=None):
    customer=db.execute('SELECT * FROM customers WHERE id=%s FOR UPDATE',(customer_id,)).fetchone()
    if not customer:
        raise ValueError('Customer does not exist.')
    previous=db.execute('SELECT * FROM equipment_recovery WHERE customer_id=%s ORDER BY id DESC LIMIT 1',(customer_id,)).fetchone()
    if customer['status']=='Terminated' and previous:
        return previous
    if not isinstance(reason,str) or not reason.strip() or len(reason)>2000:
        raise ValueError('Enter a termination reason (up to 2000 characters).')
    if employee_id is not None:
        if type(employee_id) is not int:
            raise ValueError('Select a valid recovery employee.')
        staff=db.execute('SELECT * FROM staff WHERE id=%s',(employee_id,)).fetchone()
        if not staff or staff['status']=='On leave':
            raise ValueError('Select an available employee.')
    items=pending_items(db,customer_id)
    now=datetime.now(ZoneInfo('Asia/Karachi'))
    status='Equipment recovery pending' if items else 'No equipment to recover'
    row=db.execute('''INSERT INTO equipment_recovery(customer_id,terminated_on,monthly_revenue_loss,status,employee_id,reason,terminated_by)
        VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *''',(customer_id,now.date(),customer['monthly_fee'],status,employee_id,reason.strip(),user['id'])).fetchone()
    db.execute("UPDATE customers SET status='Terminated',recovery_status=%s WHERE id=%s",(status,customer_id))
    if items:
        hours=default_hours(db,'Equipment recovery','Normal')
        due=now+timedelta(hours=hours)
        description='Customer: '+customer['name']+' (Payment ID: '+customer['payment_id']+')\nTermination: '+reason.strip()+'\nRecover equipment:\n'+'\n'.join(f"ISS-{i['id']}: {i['item']} x {i['quantity']}" for i in items)
        ticket=db.execute('''INSERT INTO tickets(subject,customer_id,assigned_to,type,priority,status,due_date,description,resolution_notes,tat_hours,due_at,recovery_id)
            VALUES (%s,%s,%s,'Equipment recovery','Normal','Open',%s,%s,'',%s,%s,%s) RETURNING id''',('Recover equipment - '+customer['name'],customer_id,employee_id,due.date(),description,hours,due,row['id'])).fetchone()
        db.execute('INSERT INTO ticket_events(ticket_id,message) VALUES (%s,%s)',(ticket['id'],user['name']+': Equipment recovery opened after termination.'))
    return row


def refresh_recovery(db,customer_id):
    if pending_items(db,customer_id):
        return
    resolve_expiry_recovery(db,customer_id,'Equipment recovered: all recovery-required stock returned to inventory.')
    rows=list(db.execute("UPDATE equipment_recovery SET status='Recovered',recovered_at=CURRENT_TIMESTAMP WHERE customer_id=%s AND status='Equipment recovery pending' RETURNING id",(customer_id,)))
    if not rows:
        return
    db.execute("UPDATE customers SET recovery_status='Recovered' WHERE id=%s",(customer_id,))
    for recovery in rows:
        tickets=list(db.execute("UPDATE tickets SET status='Resolved',resolution_notes=resolution_notes||%s,resolved_at=COALESCE(resolved_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE recovery_id=%s AND status NOT IN ('Resolved','Closed') RETURNING id",('\nAll recovery-required stock has been returned.',recovery['id'])))
        for ticket in tickets:
            db.execute('INSERT INTO ticket_events(ticket_id,message) VALUES (%s,%s)',(ticket['id'],'Equipment recovery completed: all required stock returned to inventory.'))
