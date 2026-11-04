"""Per-unit QR labels and immutable stock movement records."""
from uuid import uuid4
import re

def initialize(db):
    db.execute('''CREATE TABLE IF NOT EXISTS inventory_units(id BIGSERIAL PRIMARY KEY,inventory_id BIGINT NOT NULL REFERENCES inventory(id),qr_code TEXT NOT NULL UNIQUE,serial_number TEXT NOT NULL DEFAULT '',issue_id BIGINT REFERENCES stock_issues(id),state TEXT NOT NULL CHECK(state IN ('Available','Issued')),created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,request_key TEXT NOT NULL UNIQUE)''')
    db.execute("ALTER TABLE inventory_units ADD COLUMN IF NOT EXISTS condition TEXT NOT NULL DEFAULT 'Good' CHECK(condition IN ('Good','Damaged','Under repair'))")
    db.execute('''CREATE TABLE IF NOT EXISTS inventory_stocktakes(id BIGSERIAL PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,closed_at TIMESTAMPTZ,actor_name TEXT NOT NULL)''')
    db.execute('ALTER TABLE inventory_stocktakes ADD COLUMN IF NOT EXISTS snapshot JSONB')
    db.execute('''CREATE TABLE IF NOT EXISTS inventory_stocktake_lines(stocktake_id BIGINT NOT NULL REFERENCES inventory_stocktakes(id),unit_id BIGINT NOT NULL REFERENCES inventory_units(id),expected BOOLEAN NOT NULL,seen BOOLEAN NOT NULL DEFAULT FALSE,baseline BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(stocktake_id,unit_id))''')
    db.execute('ALTER TABLE inventory_units ADD COLUMN IF NOT EXISTS receive_new BOOLEAN NOT NULL DEFAULT FALSE')
    db.execute('''CREATE TABLE IF NOT EXISTS inventory_movements(id BIGSERIAL PRIMARY KEY,unit_id BIGINT NOT NULL REFERENCES inventory_units(id),action TEXT NOT NULL,actor_name TEXT NOT NULL,issue_id BIGINT REFERENCES stock_issues(id),created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
    db.execute("ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT ''")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS inventory_units_serial ON inventory_units(inventory_id,serial_number) WHERE serial_number!=''")

def code(value):
    value=str(value or '').strip()
    if not re.fullmatch(r'ISPCRM:[a-f0-9]{32}',value):raise ValueError('Scan a valid ISP CRM inventory QR label.')
    return value

def available(db,inventory_id):
    return db.execute("SELECT COUNT(*) AS n FROM inventory_units WHERE inventory_id=%s AND state='Available'",(inventory_id,)).fetchone()['n']

def register(db,payload,user):
    key=payload.get('request_key')
    if not isinstance(key,str) or not 1<=len(key)<=100:raise ValueError('Missing registration request key.')
    db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',(key,))
    previous=db.execute('SELECT * FROM inventory_units WHERE request_key=%s',(key,)).fetchone()
    inventory_id=payload.get('inventory_id');serial=str(payload.get('serial_number','')).strip()
    if type(inventory_id) is not int or len(serial)>150:raise ValueError('Select an inventory item and a serial up to 150 characters.')
    receive=payload.get('receive_new',False)
    if type(receive) is not bool:raise ValueError('Invalid receipt choice.')
    if previous:
        if previous['inventory_id']!=inventory_id or previous['serial_number']!=serial or previous['receive_new']!=receive:raise ValueError('This registration request was already used.')
        return previous
    item=db.execute('SELECT * FROM inventory WHERE id=%s FOR UPDATE',(inventory_id,)).fetchone()
    if not item:raise ValueError('Inventory item does not exist.')
    if receive:
        db.execute('UPDATE inventory SET quantity=quantity+1 WHERE id=%s',(inventory_id,))
    elif item['quantity']<=available(db,inventory_id):
        raise ValueError('All available stock already has QR labels. Choose Receive new device to add stock.')
    unit=db.execute("INSERT INTO inventory_units(inventory_id,qr_code,serial_number,state,request_key,receive_new) VALUES (%s,%s,%s,'Available',%s,%s) RETURNING *",(inventory_id,'ISPCRM:'+uuid4().hex,serial,key,receive)).fetchone()
    db.execute('INSERT INTO inventory_movements(unit_id,action,actor_name) VALUES (%s,%s,%s)',(unit['id'],'Received' if receive else 'Existing stock registered',user['name']))
    return unit

def lookup(db,value):
    unit=db.execute('SELECT u.*,i.item,i.category,i.location FROM inventory_units u JOIN inventory i ON i.id=u.inventory_id WHERE u.qr_code=%s',(code(value),)).fetchone()
    if not unit:raise ValueError('QR label is not registered in this system.')
    history=list(db.execute('''SELECT m.*,s.issued_against,s.destination,s.quantity,c.name AS customer_name,c.payment_id,e.name AS employee_name FROM inventory_movements m LEFT JOIN stock_issues s ON s.id=m.issue_id LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN staff e ON e.id=s.employee_id WHERE m.unit_id=%s ORDER BY m.id DESC''',(unit['id'],)))
    return {'unit':unit,'movements':history}

def issue_unit(db,value,inventory_id):
    unit=db.execute('SELECT * FROM inventory_units WHERE qr_code=%s FOR UPDATE',(code(value),)).fetchone()
    if not unit or unit['inventory_id']!=inventory_id:raise ValueError('QR label belongs to a different inventory item.')
    if unit['state']!='Available':raise ValueError('This device is already issued. Scan it in Return mode first.')
    if unit['condition']!='Good':raise ValueError('Damaged or repair devices cannot be issued. Mark Good after inspection.')
    return unit

def issued(db,unit,issue_id,user):
    db.execute("UPDATE inventory_units SET state='Issued',issue_id=%s WHERE id=%s",(issue_id,unit['id']))
    db.execute("INSERT INTO inventory_movements(unit_id,action,actor_name,issue_id) VALUES (%s,'Issued',%s,%s)",(unit['id'],user['name'],issue_id))

def returned(db,issue_id,user):
    units=list(db.execute("UPDATE inventory_units SET state='Available' WHERE issue_id=%s AND state='Issued' RETURNING id",(issue_id,)))
    for unit in units:
        db.execute("INSERT INTO inventory_movements(unit_id,action,actor_name,issue_id) VALUES (%s,'Returned',%s,%s)",(unit['id'],user['name'],issue_id))

def set_condition(db,payload,user):
    unit=db.execute('SELECT * FROM inventory_units WHERE qr_code=%s FOR UPDATE',(code(payload.get('code')),)).fetchone()
    if not unit:raise ValueError('Device not found.')
    condition=payload.get('condition');notes=str(payload.get('notes','')).strip()
    if condition not in ('Good','Damaged','Under repair') or not notes or len(notes)>2000:raise ValueError('Choose a condition and enter inspection notes (up to 2000 characters).')
    if unit['condition']!=condition:
        db.execute('UPDATE inventory_units SET condition=%s WHERE id=%s',(condition,unit['id']))
        db.execute("INSERT INTO inventory_movements(unit_id,action,actor_name,notes) VALUES (%s,%s,%s,%s)",(unit['id'],'Condition: '+condition,user['name'],notes))
    return unit


def stocktake(db,payload,user):
    action=payload.get('action')
    db.execute("SELECT pg_advisory_xact_lock(hashtextextended('inventory-stocktake',0))")
    if action=='start_stocktake':
        run=db.execute('SELECT * FROM inventory_stocktakes WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').fetchone()
        if run:return run['id']
        run=db.execute('INSERT INTO inventory_stocktakes(actor_name) VALUES (%s) RETURNING id',(user['name'],)).fetchone()
        db.execute("INSERT INTO inventory_stocktake_lines(stocktake_id,unit_id,expected,baseline) SELECT %s,u.id,TRUE,COALESCE((SELECT MAX(m.id) FROM inventory_movements m WHERE m.unit_id=u.id),0) FROM inventory_units u WHERE u.state='Available'",(run['id'],))
        return run['id']
    rid=payload.get('stocktake_id')
    if type(rid) is not int:raise ValueError('Select a stocktake.')
    run=db.execute('SELECT * FROM inventory_stocktakes WHERE id=%s FOR UPDATE',(rid,)).fetchone()
    if not run or run['closed_at']:raise ValueError('Stocktake is closed or does not exist.')
    if action=='close_stocktake':
        from psycopg.types.json import Jsonb
        snapshot=stocktake_report(db,rid)['lines']
        db.execute('UPDATE inventory_stocktakes SET closed_at=CURRENT_TIMESTAMP,snapshot=%s WHERE id=%s',(Jsonb(snapshot),rid));return rid
    if action!='scan_stocktake':raise ValueError('Invalid stocktake action.')
    unit=db.execute('SELECT id FROM inventory_units WHERE qr_code=%s',(code(payload.get('code')),)).fetchone()
    if not unit:raise ValueError('Device not found.')
    db.execute('INSERT INTO inventory_stocktake_lines(stocktake_id,unit_id,expected,seen) VALUES (%s,%s,FALSE,TRUE) ON CONFLICT(stocktake_id,unit_id) DO UPDATE SET seen=TRUE',(rid,unit['id']))
    return rid


def stocktake_report(db,rid=None):
    run=db.execute('SELECT * FROM inventory_stocktakes WHERE id=%s',(rid,)).fetchone() if rid else db.execute('SELECT * FROM inventory_stocktakes ORDER BY id DESC LIMIT 1').fetchone()
    if not run:return {'run':None,'lines':[]}
    snapshot=run.pop('snapshot',None)
    if run['closed_at'] and snapshot is not None:return {'run':run,'lines':snapshot}
    lines=list(db.execute("""SELECT l.*,u.qr_code,u.serial_number,u.state,u.condition,i.item,
        COALESCE((SELECT MAX(m.id) FROM inventory_movements m WHERE m.unit_id=u.id),0)!=l.baseline AS changed
        FROM inventory_stocktake_lines l JOIN inventory_units u ON u.id=l.unit_id JOIN inventory i ON i.id=u.inventory_id WHERE l.stocktake_id=%s ORDER BY i.item,u.id""",(run['id'],)))
    return {'run':run,'lines':lines}
