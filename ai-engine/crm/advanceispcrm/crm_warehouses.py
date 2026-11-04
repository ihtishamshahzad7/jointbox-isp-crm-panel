"""Warehouses: every inventory batch row sits in one warehouse (inventory.location holds its name).

Issuing stock, network devices and fiber cables deduct from the chosen batch row, so they deduct from that
row's warehouse. Transfers move quantity (and QR-tracked units when needed) into the same batch at another
warehouse, creating that row the first time.
"""
import uuid
from psycopg.types.json import Jsonb
import crm_auth
import crm_inventory_qr

DEFAULT = 'Main Store'


def initialize(db):
    db.execute('''CREATE TABLE IF NOT EXISTS inventory_transfers(
        id BIGSERIAL PRIMARY KEY, from_inventory_id BIGINT NOT NULL REFERENCES inventory(id),
        to_inventory_id BIGINT NOT NULL REFERENCES inventory(id), quantity INTEGER NOT NULL CHECK (quantity > 0),
        from_warehouse TEXT NOT NULL, to_warehouse TEXT NOT NULL, units_moved INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '', actor_name TEXT NOT NULL, request_key UUID UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
    # Value, transfer date and the movement (TRF-YYMM-NNN) that groups the lines moved together.
    db.execute('ALTER TABLE inventory_transfers ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(15,2)')
    db.execute('ALTER TABLE inventory_transfers ADD COLUMN IF NOT EXISTS transfer_date DATE')
    db.execute("ALTER TABLE inventory_transfers ADD COLUMN IF NOT EXISTS movement_no TEXT NOT NULL DEFAULT ''")
    # Earlier transfers: the batch's cost and the day they were saved (Pakistan time).
    db.execute('''UPDATE inventory_transfers t SET unit_cost=i.unit_cost FROM inventory i WHERE i.id=t.from_inventory_id AND t.unit_cost IS NULL''')
    db.execute("UPDATE inventory_transfers SET transfer_date=(created_at AT TIME ZONE 'Asia/Karachi')::date WHERE transfer_date IS NULL")
    if not db.execute("SELECT 1 FROM operations_records WHERE module='Warehouses' LIMIT 1").fetchone():
        # First run: one warehouse per location already typed on inventory, or a single Main Store.
        found = [r['location'] for r in db.execute("SELECT DISTINCT trim(location) AS location FROM inventory WHERE trim(location)<>'' ORDER BY 1")]
        for name in found or [DEFAULT]:
            db.execute("INSERT INTO operations_records(module,data,created_name) VALUES ('Warehouses',%s,'System')",
                       (Jsonb(dict(name=name, code='', branch=None, address='', keeper=None, status='Active')),))
    first = names(db)
    if first:
        db.execute("UPDATE inventory SET location=%s WHERE trim(location)=''", (DEFAULT if DEFAULT in first else first[0],))


def names(db, active=True):
    status = " AND data->>'status'='Active'" if active else ''
    return [r['name'] for r in db.execute(f"SELECT data->>'name' AS name FROM operations_records WHERE module='Warehouses' AND state!='Archived'{status} ORDER BY lower(data->>'name')")]


def check_inventory_warehouse(db, value, existing=None):
    value = str(value or '').strip()
    if existing and value == existing['location']:
        return value
    if value not in names(db):
        raise ValueError('Select a warehouse. Add warehouses in Operations → Inventory → Warehouses.')
    if existing and existing['quantity'] > 0 and existing['location']:
        raise ValueError('This batch still has stock in ' + existing['location'] + '. Use Transfer to move stock to another warehouse.')
    return value


def transfer_day(value):
    """The transfer date: today (Pakistan time) when not given; never in the future."""
    from datetime import date, datetime
    from zoneinfo import ZoneInfo
    today = datetime.now(ZoneInfo('Asia/Karachi')).date()
    if not value:
        return today
    try:
        day = date.fromisoformat(str(value))
    except ValueError:
        raise ValueError('Enter the transfer date as YYYY-MM-DD.')
    if day > today:
        raise ValueError('The transfer date cannot be in the future.')
    return day


def next_movement_no(db, day):
    prefix = 'TRF-' + day.strftime('%y%m') + '-'
    used = [int(r['movement_no'][len(prefix):]) for r in db.execute('SELECT DISTINCT movement_no FROM inventory_transfers WHERE movement_no LIKE %s', (prefix + '%',)) if r['movement_no'][len(prefix):].isdigit()]
    return prefix + f'{max(used, default=0) + 1:03d}'


def move(db, user, payload):
    """Move several batches from one warehouse to another in one go, under one movement number. All or nothing."""
    if not crm_auth.allowed(user, 'Inventory', 'write'):
        raise PermissionError('Your role cannot transfer inventory.')
    source, target = (str(payload.get(k) or '').strip() for k in ('from_warehouse', 'to_warehouse'))
    if source not in names(db, active=False):
        raise ValueError('Select the warehouse the stock is leaving.')
    if source == target:
        raise ValueError('Choose two different warehouses.')
    lines = payload.get('lines')
    if not isinstance(lines, list) or not 1 <= len(lines) <= 200 or any(not isinstance(line, dict) for line in lines):
        raise ValueError('Add between 1 and 200 items to move.')
    try:
        request = uuid.UUID(str(payload.get('request_key')))
    except (TypeError, ValueError):
        raise ValueError('Reload the page and try again.')
    ids = [line.get('inventory_id') for line in lines]
    if len(set(map(str, ids))) != len(ids):
        raise ValueError('Each batch can appear once; combine its quantities.')
    day = transfer_day(payload.get('transfer_date'))
    db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('movement:' + str(request),))
    done = db.execute('SELECT movement_no FROM inventory_transfers WHERE request_key=%s', (str(uuid.uuid5(request, '0')),)).fetchone()
    if done:
        return dict(movement_no=done['movement_no'], lines=[])
    db.execute('SELECT pg_advisory_xact_lock(55120933)')
    number, moved = next_movement_no(db, day), []
    for index, line in enumerate(lines):
        row = db.execute('SELECT item, batch, location FROM inventory WHERE id=%s', (line.get('inventory_id'),)).fetchone() if str(line.get('inventory_id', '')).isdigit() else None
        label = f"{row['item']}{' / ' + row['batch'] if row and row['batch'] else ''}" if row else 'unknown batch'
        try:
            if not row or row['location'] != source:
                raise ValueError(f'this batch is not in {source}')
            moved.append(transfer(db, user, dict(inventory_id=line.get('inventory_id'), quantity=line.get('quantity'), to_warehouse=target,
                                                  notes=payload.get('notes'), request_key=str(uuid.uuid5(request, str(index))),
                                                  transfer_date=day.isoformat(), movement_no=number)))
        except ValueError as exc:
            raise ValueError(f'Line {index + 1} ({label}): {exc}')
    return dict(movement_no=number, lines=moved)


def transfer(db, user, payload):
    if not crm_auth.allowed(user, 'Inventory', 'write'):
        raise PermissionError('Your role cannot transfer inventory.')
    try:
        source_id, quantity = int(payload.get('inventory_id')), int(payload.get('quantity'))
        request = str(uuid.UUID(str(payload.get('request_key'))))
    except (TypeError, ValueError):
        raise ValueError('Enter a whole quantity and reload the form.')
    target = str(payload.get('to_warehouse') or '').strip()
    notes = str(payload.get('notes') or '').strip()[:500]
    day = transfer_day(payload.get('transfer_date'))
    db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (request,))
    done = db.execute('SELECT * FROM inventory_transfers WHERE request_key=%s', (request,)).fetchone()
    if done:
        return done
    source = db.execute('SELECT * FROM inventory WHERE id=%s FOR UPDATE', (source_id,)).fetchone()
    if not source:
        raise ValueError('This batch no longer exists.')
    if target not in names(db):
        raise ValueError('Select an active destination warehouse.')
    if target == source['location']:
        raise ValueError('Choose a different warehouse from the one the stock is in.')
    if not 0 < quantity <= source['quantity']:
        raise ValueError(f"Enter a quantity between 1 and {source['quantity']}.")
    match = db.execute('SELECT * FROM inventory WHERE item=%s AND category=%s AND batch=%s AND location=%s AND unit_cost=%s AND selling_price IS NOT DISTINCT FROM %s ORDER BY id LIMIT 1 FOR UPDATE',
                       (source['item'], source['category'], source['batch'], target, source['unit_cost'], source['selling_price'])).fetchone()
    if not match:
        match = db.execute('INSERT INTO inventory(item,category,batch,quantity,minimum_stock,unit_cost,location,selling_price) VALUES (%s,%s,%s,0,%s,%s,%s,%s) RETURNING *',
                           (source['item'], source['category'], source['batch'], source['minimum_stock'], source['unit_cost'], target, source['selling_price'])).fetchone()
    # Keep quantity >= QR-tracked available units on both rows: move only as many tracked units as needed.
    tracked = crm_inventory_qr.available(db, source_id)
    move_units = max(0, tracked - (source['quantity'] - quantity))
    if move_units:
        db.execute("UPDATE inventory_units SET inventory_id=%s WHERE id IN (SELECT id FROM inventory_units WHERE inventory_id=%s AND state='Available' ORDER BY id LIMIT %s)",
                   (match['id'], source_id, move_units))
    db.execute('UPDATE inventory SET quantity=quantity-%s WHERE id=%s', (quantity, source_id))
    db.execute('UPDATE inventory SET quantity=quantity+%s WHERE id=%s', (quantity, match['id']))
    number = str(payload.get('movement_no') or '') or next_movement_no(db, day)
    return db.execute('''INSERT INTO inventory_transfers(from_inventory_id,to_inventory_id,quantity,from_warehouse,to_warehouse,units_moved,notes,actor_name,request_key,
        unit_cost,transfer_date,movement_no) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *''',
                      (source_id, match['id'], quantity, source['location'], target, move_units, notes, user['name'], request,
                       source['unit_cost'], day, number)).fetchone()


def history(db, limit=5000):
    return list(db.execute('''SELECT t.*, i.item, i.batch, i.category, t.quantity*COALESCE(t.unit_cost,0) AS value
        FROM inventory_transfers t JOIN inventory i ON i.id=t.from_inventory_id
        ORDER BY t.transfer_date DESC, t.id DESC LIMIT %s''', (limit,)))
