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
    return db.execute('INSERT INTO inventory_transfers(from_inventory_id,to_inventory_id,quantity,from_warehouse,to_warehouse,units_moved,notes,actor_name,request_key) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *',
                      (source_id, match['id'], quantity, source['location'], target, move_units, notes, user['name'], request)).fetchone()


def history(db, limit=200):
    return list(db.execute('''SELECT t.*, i.item, i.batch FROM inventory_transfers t JOIN inventory i ON i.id=t.from_inventory_id
        ORDER BY t.id DESC LIMIT %s''', (limit,)))
