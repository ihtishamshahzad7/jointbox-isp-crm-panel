"""Validate reporting relationships without changing application access roles."""

def validate_staff_hierarchy(db,fields,rid):
    raw=fields.get('reports_to')
    try:manager=int(raw) if raw not in ('',None) else None
    except (ValueError,TypeError):raise ValueError('Select a valid reporting manager.')
    visited={rid} if rid else set()
    current=manager
    while current is not None:
        if current in visited:raise ValueError('Reporting hierarchy cannot contain a cycle or report to itself.')
        visited.add(current)
        row=db.execute('SELECT reports_to FROM staff WHERE id=%s',(current,)).fetchone()
        if not row:raise ValueError('Reporting manager no longer exists.')
        current=row['reports_to']
    fields['reports_to']=manager
    name=str(fields.get('designation','')).strip()
    if name:
        prior=db.execute('SELECT designation FROM staff WHERE id=%s',(rid,)).fetchone() if rid else None
        active=db.execute("SELECT 1 FROM designations WHERE name=%s AND status='Active'",(name,)).fetchone()
        if not active and (not prior or prior['designation']!=name):raise ValueError('Select an active designation from Settings > Employee designations.')

def validate_designation(db,fields,rid):
    name=str(fields.get('name','')).strip()
    if not name or len(name)>150:raise ValueError('Enter a designation name up to 150 characters.')
    fields['name']=name
    if rid:
        prior=db.execute('SELECT name FROM designations WHERE id=%s FOR UPDATE',(rid,)).fetchone()
        if prior and prior['name']!=name:
            db.execute('UPDATE staff SET designation=%s WHERE designation=%s',(name,prior['name']))
