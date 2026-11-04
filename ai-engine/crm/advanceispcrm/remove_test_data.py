"""Delete every [TEST] record added by seed_test_data.py, and anything attached to it.

Run: python remove_test_data.py

Rows that belong to a test record (its invoices, receipts, tickets, portal
account, history) are deleted. Your own records that merely point at a test
record (for example a real employee reporting to a test manager) are kept and
unlinked instead.
"""
import crm_data

# Children of these tables belong to them and are deleted with them.
OWNED = {'customers', 'payments', 'tickets', 'jobs', 'stock_issues', 'equipment_recovery', 'inventory_units', 'customer_portal_accounts',
         'operations_records', 'inventory_stocktakes', 'customer_service_charges'}
# Real rows in these tables are never deleted just because they point at a test record.
PROTECTED = {'customers', 'staff', 'app_users', 'inventory', 'packages'}
ORDER = ['operations_records', 'customers', 'tickets', 'expenses', 'app_users', 'staff', 'inventory', 'packages', 'designations', 'categories']


def references(db):
    rows = db.execute('''SELECT kcu.table_name AS child, kcu.column_name AS col, ccu.table_name AS parent, ccu.column_name AS parent_col, c.is_nullable
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name=ccu.constraint_name AND tc.table_schema=ccu.table_schema
        JOIN information_schema.columns c ON c.table_schema=kcu.table_schema AND c.table_name=kcu.table_name AND c.column_name=kcu.column_name
        WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema=current_schema()''').fetchall()
    graph = {}
    for r in rows:
        graph.setdefault(r['parent'], []).append(r)
    return graph


def tracked_ids(db, table):
    return [r['record_id'] for r in db.execute('SELECT record_id FROM test_data_records WHERE table_name=%s', (table,))]


def purge(db, graph, table, column, values, counts):
    if not values:
        return
    for ref in graph.get(table, []):
        keys = [r[ref['parent_col']] for r in db.execute(f'SELECT {ref["parent_col"]} FROM {table} WHERE {column}=ANY(%s)', (values,))]
        if not keys:
            continue
        if ref['child'] == table:
            # Self references (staff.reports_to): unlink rows that are not being deleted.
            db.execute(f'UPDATE {table} SET {ref["col"]}=NULL WHERE {ref["col"]}=ANY(%s) AND NOT {column}=ANY(%s)', (keys, values))
        elif ref['child'] in PROTECTED and table not in OWNED and ref['is_nullable'] == 'NO':
            raise SystemExit(f'Real {ref["child"]} records still use test {table}. Change them first; nothing was removed.')
        elif ref['child'] in PROTECTED and table not in OWNED:
            db.execute(f'UPDATE {ref["child"]} SET {ref["col"]}=NULL WHERE {ref["col"]}=ANY(%s) AND NOT id=ANY(%s)', (keys, tracked_ids(db, ref['child'])))
        elif table in OWNED or ref['is_nullable'] == 'NO':
            purge(db, graph, ref['child'], ref['col'], keys, counts)
        else:
            db.execute(f'UPDATE {ref["child"]} SET {ref["col"]}=NULL WHERE {ref["col"]}=ANY(%s)', (keys,))
    deleted = db.execute(f'DELETE FROM {table} WHERE {column}=ANY(%s)', (values,)).rowcount
    counts[table] = counts.get(table, 0) + deleted


def remove():
    counts = {}
    with crm_data.connect_database() as db:
        db.execute('SELECT pg_advisory_xact_lock(73912499)')
        if not db.execute("SELECT to_regclass('test_data_records') AS t").fetchone()['t']:
            return counts
        tracked = {}
        for row in db.execute('SELECT table_name, record_id FROM test_data_records'):
            tracked.setdefault(row['table_name'], []).append(row['record_id'])
        graph = references(db)
        customers = tracked.get('customers', [])
        ops_ids = tracked.get('operations_records', [])
        if customers:
            # Portal requests/messages and other operations rows created while testing these customers.
            ops_ids += [r['id'] for r in db.execute("SELECT id FROM operations_records WHERE data->>'customer' = ANY(%s)", ([str(c) for c in customers],))]
        if ops_ids:
            # Expenses posted by operations actions (Pay) on test records.
            tracked.setdefault('expenses', []).extend(r['id'] for r in db.execute('SELECT id FROM expenses WHERE reference = ANY(%s)', (['OPS-' + str(i) for i in ops_ids],)))
            tracked['operations_records'] = sorted(set(ops_ids))
        if db.execute("SELECT to_regclass('record_invoices') AS t").fetchone()['t']:
            for section, table in (('Inventory', 'inventory'), ('Expenses', 'expenses')):
                db.execute('DELETE FROM record_invoices WHERE section=%s AND record_id=ANY(%s)', (section, tracked.get(table, [])))
        areas = [r['name'] for r in db.execute("SELECT data->>'name' AS name FROM operations_records WHERE module='Areas' AND id=ANY(%s)", (tracked.get('operations_records', []),))]
        for table in ORDER:
            purge(db, graph, table, 'id', sorted(set(tracked.get(table, []))), counts)
        if areas:
            db.execute("UPDATE customers SET area='' WHERE area=ANY(%s)", (areas,))
        db.execute('DROP TABLE test_data_records')
    return counts


if __name__ == '__main__':
    counts = remove()
    if not counts:
        print('No test data found. Nothing was changed.')
    else:
        print('Removed test data:')
        for table, count in sorted(counts.items()):
            if count:
                print(f'  {table}: {count}')
