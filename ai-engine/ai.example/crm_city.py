"""City filter: narrows the CRM to customers whose area belongs to one city.

Customers link to a city through their Area (Operations > Areas > City). Records tied to
a customer (payments, invoices, tickets, stock issues, recoveries...) follow the customer.
Company-wide records with no customer (inventory, packages, business expenses, network
stock) stay visible in every city.
"""


def cities(db):
    # The Cities list (Operations > Company > Cities); before one exists, the cities typed on areas.
    listed = [r['name'] for r in db.execute("SELECT data->>'name' AS name FROM operations_records WHERE module='Cities' AND state!='Archived' AND data->>'status'='Active' ORDER BY lower(data->>'name')")]
    return listed or [r['city'] for r in db.execute("SELECT DISTINCT trim(data->>'city') AS city FROM operations_records WHERE module='Areas' AND state!='Archived' AND coalesce(trim(data->>'city'),'')<>'' ORDER BY 1")]


def scope(db, city):
    """Areas and customer ids for a city, or None for all cities (also for an unknown city)."""
    city = str(city or '').strip()
    match = next((c for c in cities(db) if c.lower() == city.lower()), None) if city else None
    if not match:
        return None
    rows = list(db.execute("SELECT trim(data->>'name') AS name, lower(trim(coalesce(data->>'city',''))) AS city FROM operations_records WHERE module='Areas'"))
    areas = {r['name'] for r in rows if r['city'] == match.lower()}
    other = {r['name'] for r in rows} - areas
    customers = {r['id'] for r in db.execute('SELECT id FROM customers WHERE trim(area)=ANY(%s) OR lower(city)=lower(%s)', (list(areas), match))}
    return dict(city=match, areas=areas, other_areas=other, customers=customers)


def filter_records(records, scope):
    if not scope:
        return records
    ids = scope['customers']
    for section, rows in records.items():
        if section == 'Customers':
            records[section] = [r for r in rows if r['id'] in ids]
        elif section == 'Staff':
            records[section] = [r for r in rows if (r.get('area') or '').strip() not in scope['other_areas']]
        elif rows and isinstance(rows[0], dict) and 'customer_id' in rows[0]:
            records[section] = [r for r in rows if r['customer_id'] is None or r['customer_id'] in ids]
    return records


def filter_operations(result, scope):
    if not scope:
        return result
    ids = scope['customers']

    def keep(row):
        if row['module'] == 'Areas':
            return (row['data'].get('name') or '').strip() in scope['areas']
        customer = row['data'].get('customer')
        return customer in (None, '') or int(customer) in ids
    result['records'] = [r for r in result['records'] if keep(r)]
    kept = {r['id'] for r in result['records']}
    result['events'] = [e for e in result['events'] if e['record_id'] in kept]
    result['lookups']['customer'] = [c for c in result['lookups']['customer'] if c['id'] in ids]
    return result
