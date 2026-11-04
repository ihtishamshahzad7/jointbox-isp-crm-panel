"""Extended ISP operations with validated records and atomic workflow actions.

External deliveries and provisioning are deliberately not simulated. This module
does not connect to a router, payment provider, SMS gateway or OTT service.
"""
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import csv
import io
import math
import uuid
from zoneinfo import ZoneInfo
from psycopg.types.json import Jsonb


def field(name, kind='text', required=True, options=None):
    return dict(name=name, kind=kind, required=required, options=options or [])


def module(group, fields, roles=(), note=''):
    return dict(group=group, fields=fields, roles=['Administrator','Manager',*roles], note=note)


PROVINCES=['Khyber Pakhtunkhwa','Punjab','Sindh','Balochistan','Islamabad Capital Territory','Gilgit-Baltistan','Azad Jammu and Kashmir']

MODULES = {
 'Cities':module('Company',[field('Name'),field('Province','choice',False,options=PROVINCES),field('Status','choice',options=['Active','Inactive'])],note='Cities you serve. Areas, companies and customers choose their city from this list, and the City picker at the top of the CRM shows these cities.'),
 'Companies':module('Company',[field('Name'),field('City','city',False),field('Address','textarea',False),field('Phone','text',False),field('Email','email',False),field('NTN','text',False),field('Status','choice',options=['Active','Inactive'])],note='Company directory. Companies group areas and branches; they are not separate security tenants.'),
 'Areas':module('Company',[field('Name'),field('Company','ref:Companies',False),field('City','city',False),field('Zone','ref:Zones',False),field('Status','choice',options=['Active','Inactive']),field('Notes','textarea',False)],note='Active areas are available in customer forms. Area names are unique across companies.'),
 'Branches':module('Company',[field('Name'),field('Code'),field('Company','ref:Companies',False),field('Address','textarea',False),field('Phone','text',False),field('Status','choice',options=['Active','Inactive'])],note='Branch directory. This does not impose branch isolation on existing CRM records.'),
 'Departments':module('People',[field('Name'),field('Manager','staff',False),field('Status','choice',options=['Active','Inactive'])]),
 'Attendance':module('People',[field('Employee','staff'),field('Date','date'),field('Status','choice',options=['Present','Absent','Leave','Half day']),field('Check in','text',False),field('Check out','text',False),field('Overtime hours','number',False)]),
 'Payroll':module('People',[field('Employee','staff'),field('Month','month'),field('Basic salary','money'),field('Allowances','money',False),field('Bonus','money',False),field('Overtime amount','money',False),field('Incentive','money',False),field('Deductions','money',False),field('Notes','textarea',False)],['Accountant'],note='Generate from the employee salary record, then Pay to post an expense once. No bank transfer is initiated.'),
 'Appraisals':module('People',[field('Employee','staff'),field('Period','month'),field('Rating','choice',options=['Excellent','Good','Needs improvement']),field('Review','textarea')]),
 'Tasks':module('Work',[field('Title'),field('Employee','staff',False),field('Due date','date'),field('Priority','choice',options=['Normal','Low','High','Urgent']),field('Status','choice',options=['Planned','In progress','Done','Cancelled']),field('Description','textarea',False)],['Support'],note='Internal task planning and history; separate from customer trouble tickets.'),
 'Problem categories':module('Work',[field('Name'),field('Description','textarea',False),field('Status','choice',options=['Active','Inactive'])],note='Custom problem category catalog for customer requests; current core ticket types remain available.'),
 'Vendors':module('Purchasing',[field('Name'),field('Contact','text',False),field('Phone','text',False),field('Email','email',False),field('Address','textarea',False)],['Storekeeper','Accountant']),
 'Requisitions':module('Purchasing',[field('Title'),field('Item','inventory'),field('Quantity','integer'),field('Needed by','date'),field('Reason','textarea',False)],['Storekeeper']),
 'Purchase bills':module('Purchasing',[field('Vendor','ref:Vendors'),field('Invoice number'),field('Bill date','date'),field('Item','inventory'),field('Quantity','integer'),field('Unit cost','money'),field('Due date','date'),field('Notes','textarea',False)],['Storekeeper','Accountant'],note='One item per purchase bill. Receive posts stock once; Pay records the outgoing payment as a Paid expense.'),
 'Warehouses':module('Inventory',[field('Name'),field('Code','text',False),field('Branch','ref:Branches',False),field('Address','textarea',False),field('Keeper','staff',False),field('Status','choice',options=['Active','Inactive'])],['Storekeeper'],note='Stores where stock is kept. Every inventory batch belongs to one warehouse; issuing stock and network devices or cables deduct from the warehouse of the batch chosen. Use Transfer on the Inventory page to move stock between warehouses.'),
 'Assets':module('Inventory',[field('Name'),field('Batch','text',False),field('Serial','text',False),field('Location'),field('Purchased on','date'),field('Value','money'),field('Condition','choice',options=['Good','Under repair','Damaged','Destroyed']),field('Notes','textarea',False)],['Storekeeper']),
 'Zones':module('Network',[field('Name'),field('Branch','ref:Branches',False),field('Description','textarea',False)]),
 'Sub zones':module('Network',[field('Name'),field('Zone','ref:Zones')]),
 'POPs':module('Network',[field('Name'),field('Zone','ref:Zones'),field('Address','text',False),field('Latitude','latitude',False),field('Longitude','longitude',False)]),
 'Network devices':module('Network',[field('Name'),field('POP','ref:POPs',False),field('Type','choice',options=['Data center (DC)','Router','OLT','Switch','FDT','FAT','Distribution box','Splitter','Joint closure','Other']),field('Host','text',False),field('Latitude','latitude',False),field('Longitude','longitude',False),field('Stock item','inventory',False),field('Installed by','staff',False),field('Notes','textarea',False)],note='Inventory/topology records. Choose a Stock item to deduct 1 unit from inventory as a Network stock issue; deleting the device returns it. Live monitoring and router API access are not configured.'),
 'Network links':module('Network',[field('From device','ref:Network devices'),field('To device','ref:Network devices'),field('Medium','choice',options=['Fiber','Ethernet','Wireless']),field('Capacity Mbps','number',False),field('Notes','textarea',False)]),
 'Fiber segments':module('Network',[field('Name'),field('From device','ref:Network devices',False),field('To device','ref:Network devices',False),field('Cable type','choice',options=['Drop','Distribution','Feeder','Backbone']),field('Core count','integer'),field('Status','choice',options=['Planned','Active','Damaged','Retired']),field('Route','route'),field('Cable stock item','inventory',False),field('Cable used m','integer',False),field('Installed by','staff',False),field('Notes','textarea',False)],note='Fiber cable paths. Draw the route on the map; length is calculated from it. Choose a Cable stock item to deduct the cable from inventory once the status is not Planned (Cable used m, or the route length if blank). Deleting the segment or setting it back to Planned returns the cable to stock.'),
 'Bandwidth peaks':module('Bandwidth',[field('Provider','choice',options=['Transworld Bandwidth','Nayatel bandwidth']),field('Month','month'),field('Peak Mbps','number'),field('Price per Mbps','money'),field('Notes','textarea',False)],['Accountant'],note='Enter each bandwidth provider\'s peak and price per Mbps every month. Package cost on that provider = peak × (package speed ÷ total speed billed on the provider that month) × price per Mbps. Transworld Panel packages keep their own Monthly cost.'),
 'Bandwidth items':module('Bandwidth',[field('Name'),field('Capacity Mbps','number'),field('Description','textarea',False)],['Accountant']),
 'Bandwidth providers':module('Bandwidth',[field('Name'),field('Phone','text',False),field('Email','email',False)],['Accountant']),
 'Bandwidth bills':module('Bandwidth',[field('Provider','ref:Bandwidth providers'),field('Item','ref:Bandwidth items'),field('Month','month'),field('Amount','money'),field('Due date','date')],['Accountant'],note='Provider payable ledger; Pay posts a bandwidth expense once.'),
 'Resellers':module('Bandwidth',[field('Name'),field('Type','choice',options=['Bandwidth','MAC']),field('Company','text',False),field('Phone','text',False),field('Email','email',False),field('Daily tariff','money',False),field('Status','choice',options=['Active','Inactive'])],['Accountant'],note='Reseller directory and local billing. Active MAC resellers with a positive daily tariff receive one local invoice per day. Separate reseller login/tenant is not implemented.'),
 'Reseller invoices':module('Bandwidth',[field('Reseller','ref:Resellers'),field('Month','month'),field('Description'),field('Amount','money'),field('Due date','date')],['Accountant']),
 'Reseller receipts':module('Bandwidth',[field('Invoice','ref:Reseller invoices'),field('Amount','money'),field('Payment date','date'),field('Method','choice',options=['Cash','Card','Bank transfer','Mobile wallet']),field('Reference','text',False)],['Accountant'],note='These receipts settle reseller invoices; they are separate from customer MRC receipts.'),
 'OTT subscriptions':module('Services',[field('Customer','customer'),field('Service'),field('Starts on','date'),field('Renews on','date'),field('Price','money'),field('Renewal','choice',options=['Manual','Automatic']),field('Status','choice',options=['Requested','Active','Paused','Cancelled'])],['Accountant','Support'],note='Local subscription tracking only. Provider activation and balance deductions are not connected.'),
 'Customer requests':module('Work',[field('Customer','customer'),field('Type','choice',options=['New connection','Package change','Status change','Support','Profile update']),field('Subject'),field('Details','textarea'),field('Package','package',False),field('Requested status','choice',False,options=['Active','Suspended','Disconnected'])],['Support'],note='Review, convert support to a ticket, or apply an approved package/status request.'),
 'Connection leads':module('Work',[field('Name'),field('Phone'),field('Address','textarea'),field('Package','package',False),field('Status','choice',options=['New','Contacted','Approved','Closed']),field('Notes','textarea',False)],['Support'],note='New-connection enquiries before a customer account exists. Register the approved connection through Customers.'),
 'Customer messages':module('Communications',[field('Customer','customer'),field('Message','textarea')],['Support'],note='Persistent in-app conversation. Sender identity is recorded automatically. The customer portal refreshes messages periodically.'),
 'Client schedules':module('Work',[field('Customer','customer'),field('Effective date','date'),field('Action','choice',options=['Package change','Status change']),field('Package','package',False),field('Requested status','choice',False,options=['Active','Suspended','Disconnected']),field('Reason','textarea',False)],['Support'],note='Due schedules run in the background every minute, or may be applied explicitly. No router configuration is changed.'),
 'Client assignments':module('Work',[field('Customer','customer'),field('Employee','staff'),field('Responsibility','choice',options=['Support','Collection','Installation','Account manager'])],['Support'],note='Assignment directory; this does not narrow existing core customer visibility.'),
 'Collection approvals':module('Finance',[field('Customer','customer'),field('Amount','money'),field('Billing month','month'),field('Payment date','date'),field('Method','choice',options=['Cash','Card','Bank transfer','Mobile wallet']),field('Reference','text',False)],['Accountant','Support','Technician'],note='Collectors submit confirmed collections. Finance approval posts one MRC payment and permanent receipt.'),
 'Discount requests':module('Finance',[field('Customer','customer'),field('Month','month'),field('Amount','money'),field('Reason','textarea')],['Accountant','Support'],note='Approval records a decision only. It does not amend saved invoices or reduce the core customer ledger.'),
 'Cash accounts':module('Finance',[field('Name'),field('Type','choice',options=['Cash','Bank']),field('Opening balance','money',False)],['Accountant'],note='Separate cashbook accounts; existing customer collections are not silently imported.'),
 'Cash transactions':module('Finance',[field('Account','ref:Cash accounts'),field('Date','date'),field('Direction','choice',options=['In','Out']),field('Amount','money'),field('Description')],['Accountant']),
 'Message templates':module('Communications',[field('Name'),field('Channel','choice',options=['In-app','SMS','Email']),field('Subject'),field('Body','textarea')],['Support']),
 'Message queue':module('Communications',[field('Customer','customer'),field('Channel','choice',options=['In-app','SMS','Email']),field('Subject'),field('Body','textarea')],['Support'],note='In-app delivery is available. SMS/email stay Not configured; no external message is sent.'),
 'Notices':module('Communications',[field('Title'),field('Body','textarea'),field('Audience','choice',options=['Staff','Customers','Everyone']),field('Published','choice',options=['Yes','No'])],['Support']),
 'Customer links':module('Services',[field('Name'),field('URL','url'),field('Type','choice',options=['FTP','Live TV','Support','Other']),field('Status','choice',options=['Active','Inactive'])]),
 'Business settings':module('Company',[field('Company name'),field('Address','textarea',False),field('Phone','text',False),field('Email','email',False),field('Receipt footer','textarea',False),field('Currency','choice',options=['PKR'])]),
}

IMMUTABLE={'Reseller receipts','Cash transactions','Customer messages'}
APPROVALS={'Requisitions','Collection approvals','Discount requests','Customer requests'}
FINANCE={'Administrator','Manager','Accountant'}


def today():return datetime.now(ZoneInfo('Asia/Karachi')).date()
def key(name):return name.lower().replace(' ','_')


def initialize(db):
    db.execute('''CREATE TABLE IF NOT EXISTS operations_records(
        id BIGSERIAL PRIMARY KEY, module TEXT NOT NULL, data JSONB NOT NULL,
        state TEXT NOT NULL DEFAULT 'Open', created_by BIGINT REFERENCES app_users(id),
        created_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, request_key UUID UNIQUE,
        version INTEGER NOT NULL DEFAULT 1)''')
    db.execute('CREATE INDEX IF NOT EXISTS operations_module_idx ON operations_records(module,id)')
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS operations_company_area_names ON operations_records(module,lower(trim(data->>'name'))) WHERE module IN ('Companies','Areas')")
    db.execute('''CREATE TABLE IF NOT EXISTS operations_events(
        id BIGSERIAL PRIMARY KEY, record_id BIGINT REFERENCES operations_records(id),
        actor TEXT NOT NULL, action TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
    assign_network_codes(db)
    create_cities_from_areas(db)
    # Customers without a city take it from their area.
    db.execute("""UPDATE customers c SET city=a.data->>'city' FROM operations_records a WHERE a.module='Areas' AND trim(a.data->>'name')=trim(c.area)
        AND c.city='' AND coalesce(trim(a.data->>'city'),'')<>''""")


# Network records get a permanent ID such as POP-001, FAT-012 or FBR-004 (never changed after it is given).
NETWORK_CODES={'Zones':'ZN','Sub zones':'SZ','POPs':'POP','Network links':'LNK','Fiber segments':'FBR'}
DEVICE_CODES={'Data center (DC)':'DC','Router':'RTR','OLT':'OLT','Switch':'SW','FDT':'FDT','FAT':'FAT','Distribution box':'DB','Splitter':'SPL','Joint closure':'JC','Other':'DEV'}


def network_prefix(module,data):
    if module=='Network devices':return DEVICE_CODES.get(data.get('type'),'DEV')
    return NETWORK_CODES.get(module)


def next_network_code(db,prefix):
    db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('network-code:'+prefix,))
    used=[r['code'][len(prefix)+1:] for r in db.execute("SELECT data->>'code' AS code FROM operations_records WHERE data->>'code' LIKE %s",(prefix+'-%',))]
    return f'{prefix}-{max((int(n) for n in used if n.isdigit()),default=0)+1:03d}'


def city_names(db,active=True):
    status=" AND data->>'status'='Active'" if active else ''
    return [r['name'] for r in db.execute(f"SELECT data->>'name' AS name FROM operations_records WHERE module='Cities' AND state!='Archived'{status} ORDER BY lower(data->>'name')")]


def city_name(db,value):
    """The saved spelling of a city from the Cities list, matched without regard to capitals."""
    value=str(value or '').strip()
    match=next((c for c in city_names(db,False) if c.casefold()==value.casefold()),None)
    if not match:raise ValueError(f'Add the city "{value}" in Operations → Company → Cities first.')
    return match


def create_cities_from_areas(db):
    # First run: the cities already typed on areas become the Cities list.
    if db.execute("SELECT 1 FROM operations_records WHERE module='Cities' LIMIT 1").fetchone():return
    found={}
    for r in db.execute("SELECT trim(data->>'city') AS city FROM operations_records WHERE module='Areas' AND coalesce(trim(data->>'city'),'')<>''"):
        found.setdefault(r['city'].casefold(),r['city'])
    for city in sorted(found.values()):
        db.execute("INSERT INTO operations_records(module,data,created_name) VALUES ('Cities',%s,'System')",(Jsonb(dict(name=city,province='',status='Active')),))


def assign_network_codes(db):
    for r in db.execute("SELECT id,module,data FROM operations_records WHERE module=ANY(%s) AND NOT data ? 'code' ORDER BY id",(list(NETWORK_CODES)+['Network devices'],)).fetchall():
        db.execute("UPDATE operations_records SET data=data||jsonb_build_object('code',%s::text) WHERE id=%s",(next_network_code(db,network_prefix(r['module'],r['data'])),r['id']))


def permitted(user, name, write=False):
    if name not in MODULES:return False
    # Custom rights assigned by an administrator replace the role defaults below.
    if user.get('permissions') and user['role']!='Administrator':return name in user['permissions']['write' if write else 'read']
    if user['role'] in MODULES[name]['roles']:return True
    if user['role']=='Viewer' and not write:return name not in ('Payroll','Attendance','Appraisals','Collection approvals')
    if user['role']=='Technician' and name=='Tasks':return True
    return False


def record(db, rid, name=None, lock=False):
    if type(rid) is not int or rid<=0:raise ValueError('Select a valid record.')
    r=db.execute('SELECT * FROM operations_records WHERE id=%s'+(' FOR UPDATE' if lock else ''),(rid,)).fetchone()
    if not r or (name and r['module']!=name):raise ValueError('Record not found.')
    return r


def audit(db,rid,user,action):
    db.execute('INSERT INTO operations_events(record_id,actor,action) VALUES (%s,%s,%s)',(rid,user['name'],action))


def amount(value, label='Amount', positive=False):
    try:n=Decimal(str(value))
    except (InvalidOperation,ValueError,TypeError):raise ValueError(label+' must be a valid amount.')
    if not n.is_finite() or n<0 or n>Decimal('1000000000') or n!=n.quantize(Decimal('.01')) or (positive and n<=0):raise ValueError(label+' must be a valid '+('positive ' if positive else '')+'amount with at most two decimal places.')
    return n.quantize(Decimal('.01'))


def validate(db,name,raw):
    if not isinstance(raw,dict):raise ValueError('Enter valid fields.')
    clean={}
    for f in MODULES[name]['fields']:
        k=key(f['name']);v=raw.get(k);kind=f['kind']
        if v in ('',None):
            if f['required']:raise ValueError(f['name']+' is required.')
            clean[k]=None if kind.startswith('ref:') or kind in ('staff','customer','inventory','package','latitude','longitude') else '0.00' if kind in ('money','number','integer') else ''
            continue
        if kind in ('money','number','integer','latitude','longitude'):
            try:n=Decimal(str(v))
            except InvalidOperation:raise ValueError(f['name']+' must be numeric.')
            lower=-90 if kind=='latitude' else -180 if kind=='longitude' else 0
            upper=90 if kind=='latitude' else 180 if kind=='longitude' else 1000000000
            if not n.is_finite() or not lower<=n<=upper:raise ValueError(f['name']+' is outside the supported range.')
            if kind=='integer' and (n!=int(n) or n<=0):raise ValueError(f['name']+' must be a positive whole number.')
            clean[k]=str(amount(v,f['name'])) if kind=='money' else int(n) if kind=='integer' else str(n)
        elif kind in ('date','month'):
            value=str(v);date.fromisoformat(value+'-01' if kind=='month' else value)
            if len(value)!=(7 if kind=='month' else 10):raise ValueError('Use a valid date or month.')
            clean[k]=value
        elif kind in ('customer','staff','inventory','package') or kind.startswith('ref:'):
            if isinstance(v,bool):raise ValueError('Invalid reference.')
            try:ref=int(v)
            except (ValueError,TypeError):raise ValueError('Select '+f['name']+'.')
            if kind.startswith('ref:'):
                linked=record(db,ref,kind[4:])
                if linked['state']=='Archived':raise ValueError(f['name']+' is archived.')
            else:
                table={'customer':'customers','staff':'staff','inventory':'inventory','package':'packages'}[kind]
                if not db.execute(f'SELECT id FROM {table} WHERE id=%s',(ref,)).fetchone():raise ValueError(f['name']+' does not exist.')
            clean[k]=ref
        elif kind=='route':
            clean[k]='\n'.join(f'{lat}, {lng}' for lat,lng in route_points(v))
        else:
            value=str(v).strip()
            if len(value)>(4000 if kind=='textarea' else 300):raise ValueError(f['name']+' is too long.')
            if kind=='choice' and value not in f['options']:raise ValueError('Select a valid '+f['name']+'.')
            if kind=='city':value=city_name(db,value)
            if kind=='url' and not value.startswith(('https://','http://')):raise ValueError('Use an http or https URL.')
            if kind=='email' and ('@' not in value or '.' not in value.rsplit('@',1)[-1]):raise ValueError('Enter a valid email.')
            clean[k]=value
    if name in ('POPs','Network devices') and ((clean['latitude'] is None)!=(clean['longitude'] is None)):raise ValueError('Enter both latitude and longitude.')
    if name=='Network links' and clean['from_device']==clean['to_device']:raise ValueError('A device cannot link to itself.')
    if name=='Fiber segments':
        if clean['from_device'] is not None and clean['from_device']==clean['to_device']:raise ValueError('A segment cannot start and end at the same device.')
        clean['length_m']=str(route_length(route_points(clean['route'])))
    if name=='Payroll' and payroll_total(clean)<0:raise ValueError('Deductions exceed total payroll earnings.')
    if name in ('Collection approvals','Reseller receipts') and date.fromisoformat(clean['payment_date'])>today():raise ValueError('Only confirmed payments may be entered; payment date cannot be in the future.')
    if name=='OTT subscriptions' and clean['renews_on']<clean['starts_on']:raise ValueError('Renewal date cannot precede subscription start.')
    if name in ('Purchase bills','Bandwidth bills','Reseller invoices','Reseller receipts','Cash transactions','Collection approvals','Discount requests'):
        amount(clean.get('amount',Decimal(clean.get('unit_cost','0'))*Decimal(clean.get('quantity',0))),positive=True)
    return clean


def route_points(value):
    text=str(value)
    if len(text)>40000:raise ValueError('Route is too long.')
    lines=[l.strip() for l in text.replace(';','\n').splitlines() if l.strip()]
    if len(lines)<2:raise ValueError('Route needs at least two "latitude, longitude" points, one per line.')
    if len(lines)>1000:raise ValueError('Route can have at most 1000 points.')
    points=[]
    for number,line in enumerate(lines,1):
        parts=line.replace(',',' ').split()
        if len(parts)!=2:raise ValueError(f'Route line {number}: use "latitude, longitude".')
        try:lat,lng=Decimal(parts[0]),Decimal(parts[1])
        except InvalidOperation:raise ValueError(f'Route line {number} must be numeric.')
        if not (lat.is_finite() and lng.is_finite() and -90<=lat<=90 and -180<=lng<=180):raise ValueError(f'Route line {number} is outside the supported range.')
        points.append((lat.quantize(Decimal('.0000001')),lng.quantize(Decimal('.0000001'))))
    return points


def route_length(points):
    total=0.0
    for (a,b),(c,d) in zip(points,points[1:]):
        a,b,c,d=(math.radians(float(v)) for v in (a,b,c,d))
        total+=2*6371008.8*math.asin(math.sqrt(math.sin((c-a)/2)**2+math.cos(a)*math.cos(c)*math.sin((d-b)/2)**2))
    return Decimal(str(round(total,1)))


def kmz(db,user):
    import zipfile
    from xml.sax.saxutils import escape
    import crm_auth
    if not permitted(user,'Fiber segments'):raise PermissionError('Your role cannot view the network map.')
    rows=list(db.execute("SELECT * FROM operations_records WHERE module IN ('POPs','Network devices','Fiber segments') AND state!='Archived' ORDER BY id"))
    names={r['id']:' · '.join(filter(None,[r['data'].get('code'),r['data'].get('name') or r['module']+' #'+str(r['id'])])) for r in rows}
    point=lambda lat,lng:f'<Point><coordinates>{lng},{lat},0</coordinates></Point>'
    def placemark(name,style,geometry,details):
        text=''.join(f'<b>{escape(k)}:</b> {escape(str(v))}<br/>' for k,v in details if v not in (None,''))
        return f'<Placemark><name>{escape(str(name))}</name><styleUrl>#{style}</styleUrl><description><![CDATA[{text}]]></description>{geometry}</Placemark>'
    def folder(title,items):return f'<Folder><name>{escape(title)} ({len(items)})</name>{"".join(items)}</Folder>'
    located=lambda module:[r for r in rows if r['module']==module and r['data'].get('latitude') is not None]
    pops=[placemark(names[r['id']],'pop',point(r['data']['latitude'],r['data']['longitude']),[('ID',r['data'].get('code')),('Address',r['data'].get('address'))]) for r in located('POPs')]
    devices=[placemark(names[r['id']],'device',point(r['data']['latitude'],r['data']['longitude']),[('ID',r['data'].get('code')),('Type',r['data'].get('type')),('POP',names.get(r['data'].get('pop'))),('Host',r['data'].get('host'))]) for r in located('Network devices')]
    segments=[]
    for r in rows:
        if r['module']!='Fiber segments':continue
        d=r['data'];path=' '.join(f'{lng},{lat},0' for lat,lng in route_points(d['route']))
        segments.append(placemark(names[r['id']],'fiber-'+d['status'].lower(),f'<LineString><tessellate>1</tessellate><coordinates>{path}</coordinates></LineString>',[('ID',d.get('code') or 'OPS-'+str(r['id'])),('Status',d['status']),('Cable type',d['cable_type']),('Cores',d['core_count']),('Length',f"{Decimal(d['length_m']):,} m"),('From',names.get(d.get('from_device'))),('To',names.get(d.get('to_device'))),('Notes',d.get('notes'))]))
    folders=[folder('Fiber segments',segments),folder('POPs',pops),folder('Network devices',devices)]
    if crm_auth.allowed(user,'Customers'):
        customers=[placemark(c['name'],'customer-active' if c['status']=='Active' else 'customer-other',point(c['latitude'],c['longitude']),[('Username',c['username']),('Status',c['status']),('Package',c['package']),('Area',c['area'])]) for c in db.execute('SELECT name,username,status,package,area,latitude,longitude FROM customers WHERE latitude IS NOT NULL ORDER BY name')]
        folders.append(folder('Customers',customers))
    icons=[('pop','shapes/ranger_station.png',1.2),('device','shapes/placemark_square.png',1.0),('customer-active','paddle/grn-circle.png',0.7),('customer-other','paddle/wht-circle.png',0.7)]
    styles=''.join(f'<Style id="{i}"><IconStyle><scale>{s}</scale><Icon><href>http://maps.google.com/mapfiles/kml/{h}</href></Icon></IconStyle></Style>' for i,h,s in icons)
    # KML colours are aabbggrr.
    styles+=''.join(f'<Style id="fiber-{k}"><LineStyle><color>{c}</color><width>4</width></LineStyle></Style>' for k,c in [('planned','ffed802f'),('active','ff1fae3c'),('damaged','ff3539e5'),('retired','ff888888')])
    kml=f'<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>ISP network map {today()}</name>{styles}{"".join(folders)}</Document></kml>'
    buffer=io.BytesIO()
    with zipfile.ZipFile(buffer,'w',zipfile.ZIP_DEFLATED) as archive:archive.writestr('doc.kml',kml)
    return buffer.getvalue()


def payroll_total(d):
    return sum((Decimal(d.get(k) or '0') for k in ('basic_salary','allowances','bonus','overtime_amount','incentive')),Decimal(0))-Decimal(d.get('deductions') or '0')


def save(db,user,payload):
    name=payload.get('module');rid=payload.get('id')
    if not permitted(user,name,True):raise PermissionError('Your role cannot change this module.')
    if name=='Areas':lock_areas(db)
    previous=record(db,rid,name,True) if rid is not None else None
    if previous and (name in IMMUTABLE or previous['state'] not in ('Open','Pending')):raise ValueError('This completed or posted record is immutable.')
    if previous and name=='Collection approvals' and user['role'] not in FINANCE and previous['created_by']!=user['id']:raise PermissionError('You may edit only your own pending collection submissions.')
    if previous and name=='Reseller invoices' and db.execute("SELECT 1 FROM operations_records WHERE module='Reseller receipts' AND data->>'invoice'=%s",(str(rid),)).fetchone():raise ValueError('An invoice with saved receipts cannot be changed.')
    if previous and name=='Cash accounts' and db.execute("SELECT 1 FROM operations_records WHERE module='Cash transactions' AND data->>'account'=%s",(str(rid),)).fetchone():raise ValueError('An account with posted transactions cannot change its opening agreement.')
    if user['role']=='Technician' and name=='Tasks':
        if not previous or previous['data'].get('employee')!=user['staff_id']:raise PermissionError('Only update tasks assigned to your employee account.')
        fields=payload.get('fields',{})
        if any(fields.get(k)!=v for k,v in previous['data'].items() if k not in ('status','description')):raise PermissionError('Contact a manager to change the task assignment or schedule.')
    clean=validate(db,name,payload.get('fields'))
    if name in ('Companies','Areas','Warehouses','Cities'):
        if not clean['name']:raise ValueError('Enter a name.')
        db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',(name+':'+clean['name'].casefold(),))
    if name=='Customer messages':clean['sender']='Customer' if user['id'] is None else user['name']
    if name in ('Attendance','Payroll'):
        period='date' if name=='Attendance' else 'month'
        db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',(name+':'+str(clean['employee'])+':'+clean[period],))
        if db.execute('SELECT 1 FROM operations_records WHERE module=%s AND data->>\'employee\'=%s AND data->>%s=%s AND id!=%s',(name,str(clean['employee']),period,clean[period],rid or 0)).fetchone():raise ValueError('This employee already has a record for that period.')
    if name=='Bandwidth peaks':
        db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('peak:'+clean['provider']+':'+clean['month'],))
        if Decimal(clean['peak_mbps'])<=0 or Decimal(clean['price_per_mbps'])<=0:raise ValueError('Peak and price per Mbps must be greater than zero.')
        if db.execute("SELECT 1 FROM operations_records WHERE module='Bandwidth peaks' AND data->>'provider'=%s AND data->>'month'=%s AND id!=%s AND state!='Archived'",(clean['provider'],clean['month'],rid or 0)).fetchone():raise ValueError(f"{clean['provider']} already has a peak for {clean['month']}. Edit that record instead.")
    if name=='Client schedules':
        if clean['action']=='Package change' and not clean['package']:raise ValueError('Select the requested package.')
        if clean['action']=='Status change' and not clean['requested_status']:raise ValueError('Select the requested status.')
    request=payload.get('request_key')
    try:request=str(uuid.UUID(str(request))) if request else None
    except ValueError:raise ValueError('Invalid request key.')
    if not previous and not request:raise ValueError('Reload the form to obtain a request key.')
    if request and not previous:
        db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',(request,))
        prior=db.execute('SELECT * FROM operations_records WHERE request_key=%s',(request,)).fetchone()
        if prior:
            # Saved data may also hold derived keys (length, stock issue), so compare only the submitted fields.
            if prior['module']!=name or any(prior['data'].get(k)!=v for k,v in clean.items()):raise ValueError('Request key already used for different details.')
            return prior
    if name in ('Companies','Areas','Warehouses','Cities') and db.execute("SELECT 1 FROM operations_records WHERE module=%s AND lower(trim(data->>'name'))=lower(%s) AND id!=%s",(name,clean['name'],rid or 0)).fetchone():raise ValueError('This name already exists. Edit the existing record instead.')
    if name=='Reseller receipts':
        invoice=record(db,clean['invoice'],'Reseller invoices',True)
        paid=sum((Decimal(r['data']['amount']) for r in db.execute("SELECT data FROM operations_records WHERE module='Reseller receipts' AND data->>'invoice'=%s",(str(invoice['id']),))),Decimal(0))
        if Decimal(clean['amount'])>Decimal(invoice['data']['amount'])-paid:raise ValueError('Payment exceeds remaining reseller invoice balance.')
    if network_prefix(name,clean):
        clean['code']=previous['data'].get('code') if previous and previous['data'].get('code') else next_network_code(db,network_prefix(name,clean))
    if previous:
        if payload.get('version')!=previous['version']:raise ValueError('This record changed. Reload it before saving.')
        if name=='Areas' and clean['name']!=previous['data']['name']:
            db.execute('UPDATE customers SET area=%s WHERE area=%s',(clean['name'],previous['data']['name']))
        if name=='Warehouses' and clean['name']!=previous['data']['name']:
            db.execute('UPDATE inventory SET location=%s WHERE location=%s',(clean['name'],previous['data']['name']))
        if name=='Cities' and clean['name']!=previous['data']['name']:
            old=previous['data']['name']
            db.execute("UPDATE operations_records SET data=jsonb_set(data,'{city}',to_jsonb(%s::text)) WHERE module IN ('Areas','Companies') AND lower(data->>'city')=lower(%s)",(clean['name'],old))
            db.execute('UPDATE customers SET city=%s WHERE lower(city)=lower(%s)',(clean['name'],old))
        r=db.execute('UPDATE operations_records SET data=%s,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=%s RETURNING *',(Jsonb(clean),rid)).fetchone()
    else:
        state='Pending' if name in APPROVALS else 'Not configured' if name=='Message queue' and clean['channel']!='In-app' else 'Queued' if name=='Message queue' else 'Open'
        r=db.execute('INSERT INTO operations_records(module,data,state,created_by,created_name,request_key) VALUES (%s,%s,%s,%s,%s,%s) RETURNING *',(name,Jsonb(clean),state,user['id'],user['name'],request)).fetchone()
    r=sync_stock(db,user,r,previous)
    audit(db,r['id'],user,'Updated' if previous else 'Created')
    return r


def issue_stock(db,item,quantity,employee,destination):
    import crm_inventory_qr
    stock=db.execute('SELECT * FROM inventory WHERE id=%s FOR UPDATE',(item,)).fetchone()
    if not stock:raise ValueError('Select an existing inventory item.')
    free=stock['quantity']-crm_inventory_qr.available(db,item)
    if quantity>free:
        raise ValueError(f'Not enough {stock["item"]} in stock: {quantity} needed, {max(free,0)} available'+(' (QR-labelled units must be issued by scanning them in Stock issues)' if free<stock['quantity'] else '')+'.')
    rid=db.execute('''INSERT INTO stock_issues(inventory_id,issued_against,customer_id,destination,employee_id,quantity,recovery_required,issue_date,status,notes,request_key,unit_cost_at_issue,cost_estimated,unit_selling_price)
        VALUES (%s,'Network',NULL,%s,%s,%s,'No',%s,'Issued',%s,%s,%s,FALSE,NULL) RETURNING id''',(item,destination[:300],employee,quantity,today(),'Issued automatically from '+destination,str(uuid.uuid4()),stock['unit_cost'])).fetchone()['id']
    db.execute('UPDATE inventory SET quantity=quantity-%s WHERE id=%s',(quantity,item))
    return rid


def return_stock(db,user,issue_id):
    import crm_inventory_qr
    issue=db.execute('SELECT * FROM stock_issues WHERE id=%s FOR UPDATE',(issue_id,)).fetchone() if issue_id else None
    if not issue or issue['status']!='Issued':return
    db.execute('UPDATE inventory SET quantity=quantity+%s WHERE id=%s',(issue['quantity'],issue['inventory_id']))
    db.execute("UPDATE stock_issues SET status='Returned',returned_at=CURRENT_TIMESTAMP WHERE id=%s",(issue_id,))
    crm_inventory_qr.returned(db,issue_id,user)


def sync_stock(db,user,r,previous):
    """Keep one Network stock issue matching the cable or device recorded on the map."""
    name=r['module']
    if name not in ('Fiber segments','Network devices'):return r
    d=dict(r['data']);issue_id=(previous['data'] if previous else d).get('stock_issue_id')
    if name=='Fiber segments':
        item=d.get('cable_stock_item') if d['status']!='Planned' else None
        used=Decimal(str(d.get('cable_used_m') or 0))
        quantity=int(used) if used>0 else math.ceil(Decimal(d['length_m']))
    else:
        item=d.get('stock_item');quantity=1
    current=db.execute('SELECT * FROM stock_issues WHERE id=%s FOR UPDATE',(issue_id,)).fetchone() if issue_id else None
    if item and current and current['status']=='Issued' and (current['inventory_id'],current['quantity'],current['employee_id'])==(item,quantity,d.get('installed_by')):
        d['stock_issue_id']=issue_id
    else:
        return_stock(db,user,issue_id);d.pop('stock_issue_id',None)
        if item:
            d['stock_issue_id']=issue_stock(db,item,quantity,d.get('installed_by'),f'{name} OPS-{r["id"]} {d.get("name","")}'.strip())
    if d!=r['data']:r=db.execute('UPDATE operations_records SET data=%s WHERE id=%s RETURNING *',(Jsonb(d),r['id'])).fetchone()
    return r


def set_state(db,r,user,state,extra=None):
    d=dict(r['data']);d.update(extra or {})
    r=db.execute('UPDATE operations_records SET state=%s,data=%s,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=%s RETURNING *',(state,Jsonb(d),r['id'])).fetchone()
    audit(db,r['id'],user,state)
    return r


def expense(db,user,r,title,total,category,payment):
    d=r['data'];day=payment.get('payment_date') or today().isoformat()
    if date.fromisoformat(str(day))>today():raise ValueError('Payment date cannot be in the future.')
    method=payment.get('method','Cash')
    if method not in ('Cash','Bank transfer','Mobile wallet'):raise ValueError('Choose a supported expense payment method.')
    return db.execute('''INSERT INTO expenses(customer_id,title,category,payee,amount,expense_date,status,method,payment_date,reference,notes)
        VALUES (NULL,%s,%s,%s,%s,%s,'Paid',%s,%s,%s,%s) RETURNING id''',(title,category,d.get('vendor_name') or d.get('employee_name') or 'Operations payment',total,day,method,day,'OPS-'+str(r['id']),'Posted by '+user['name'])).fetchone()['id']


def apply_customer_change(db,user,r):
    d=r['data'];c=db.execute('SELECT * FROM customers WHERE id=%s FOR UPDATE',(d['customer'],)).fetchone()
    if not c:raise ValueError('Customer no longer exists.')
    if c['status']=='Terminated':raise ValueError('Use the customer recovery/reactivation workflow for terminated accounts.')
    action=d.get('action') or d.get('type')
    if action=='Package change':
        p=db.execute("SELECT * FROM packages WHERE id=%s AND status='Active'",(d.get('package'),)).fetchone()
        if not p:raise ValueError('Select an active package.')
        db.execute('UPDATE customers SET package_id=%s,package=%s,monthly_fee=%s WHERE id=%s',(p['id'],p['name'],p['monthly_price'],c['id']))
    elif action=='Status change':
        status=d.get('requested_status')
        if status not in ('Active','Suspended','Disconnected'):raise ValueError('Choose an allowed status.')
        db.execute('UPDATE customers SET status=%s WHERE id=%s',(status,c['id']))
    else:raise ValueError('Only package/status requests can be applied directly.')
    return set_state(db,r,user,'Applied')


def action(db,user,payload,validate_payment):
    name=payload.get('module');act=payload.get('action')
    if not permitted(user,name,True):raise PermissionError('Your role cannot perform this action.')
    if name=='Areas':lock_areas(db)
    r=record(db,payload.get('id'),name,True);d=r['data']
    if user['role']=='Technician':
        raise PermissionError('Technicians cannot post or approve operational actions.')
    if act=='delete':
        if user['role']!='Administrator':raise PermissionError('Only administrators can delete records.')
        return delete(db,user,r)
    if act=='archive':
        if name in IMMUTABLE or r['state'] not in ('Open','Pending'):raise ValueError('Posted records cannot be archived.')
        if name=='Reseller invoices' and db.execute("SELECT 1 FROM operations_records WHERE module='Reseller receipts' AND data->>'invoice'=%s",(str(r['id']),)).fetchone():raise ValueError('An invoice with receipts cannot be archived.')
        if name=='Areas' and db.execute('SELECT 1 FROM customers WHERE area=%s LIMIT 1',(d['name'],)).fetchone():raise ValueError('This area is used by customers. Mark it Inactive instead.')
        if name=='Companies' and db.execute("SELECT 1 FROM operations_records WHERE module IN ('Areas','Branches') AND state!='Archived' AND data->>'company'=%s LIMIT 1",(str(r['id']),)).fetchone():raise ValueError('This company has linked areas or branches. Mark it Inactive instead.')
        return set_state(db,r,user,'Archived')
    if act in ('approve','reject'):
        if name not in APPROVALS:raise ValueError('This module does not use approvals.')
        if name in ('Collection approvals','Discount requests') and user['role'] not in FINANCE:raise PermissionError('Finance approval is required.')
        if name=='Requisitions' and user['role'] not in ('Administrator','Manager'):raise PermissionError('Manager approval is required.')
        if r['state']!='Pending':return r
        if act=='reject':return set_state(db,r,user,'Rejected')
        if name=='Collection approvals':
            import crm_recharge
            fields=dict(customer_id=d['customer'],amount=d['amount'],payment_date=d['payment_date'],billing_month=d['billing_month'],method=d['method'],reference=d.get('reference',''),revenue_type='MRC',otc_type='Other')
            result=crm_recharge.save_payment(db,dict(fields=fields,request_key=str(uuid.uuid5(uuid.NAMESPACE_URL,'ops-collection:'+str(r['id'])))),user,validate_payment)
            return set_state(db,r,user,'Posted',dict(payment_id=result['id'],receipt_number=result.get('receipt_number')))
        return set_state(db,r,user,'Approved')
    if act=='receive' and name=='Purchase bills':
        if d.get('received_at'):return r
        if r['state']=='Archived':raise ValueError('Archived purchase cannot be received.')
        item=db.execute('SELECT * FROM inventory WHERE id=%s FOR UPDATE',(d['item'],)).fetchone()
        if not item:raise ValueError('Inventory item no longer exists.')
        db.execute('UPDATE inventory SET quantity=quantity+%s WHERE id=%s',(d['quantity'],d['item']))
        return set_state(db,r,user,'Paid' if d.get('expense_id') else 'Received',dict(received_at=today().isoformat()))
    if act=='pay' and name in ('Payroll','Purchase bills','Bandwidth bills'):
        if user['role'] not in FINANCE:raise PermissionError('Finance permission is required to pay.')
        if d.get('expense_id'):return r
        if r['state']=='Archived':raise ValueError('Archived records cannot be paid.')
        total=payroll_total(d) if name=='Payroll' else Decimal(d['unit_cost'])*d['quantity'] if name=='Purchase bills' else Decimal(d['amount'])
        amount(total,positive=True)
        if name=='Payroll':
            staff=db.execute('SELECT name FROM staff WHERE id=%s',(d['employee'],)).fetchone();d=dict(d,employee_name=staff['name']);r=dict(r,data=d)
        if name=='Purchase bills':d=dict(d,vendor_name=record(db,d['vendor'],'Vendors')['data']['name']);r=dict(r,data=d)
        eid=expense(db,user,r,name+' OPS-'+str(r['id']),total,'Staff salaries' if name=='Payroll' else 'Equipment purchase' if name=='Purchase bills' else 'Bandwidth / Upstream',payload)
        return set_state(db,r,user,'Paid',dict(expense_id=eid,paid_at=today().isoformat()))
    if act=='deliver' and name=='Message queue':
        if r['state']=='Delivered':return r
        if d['channel']!='In-app':raise ValueError('This channel is not configured. No external message was sent.')
        import crm_customer_portal
        crm_customer_portal.notify(db,d['customer'],d['subject'],d['body'],'ops-message:'+str(r['id']))
        return set_state(db,r,user,'Delivered')
    if act=='apply' and name in ('Client schedules','Customer requests'):
        if r['state']=='Applied':return r
        if r['state'] not in ('Open','Pending','Approved'):raise ValueError('This request cannot be applied.')
        if name=='Client schedules' and date.fromisoformat(d['effective_date'])>today():raise ValueError('Schedule is not due yet.')
        return apply_customer_change(db,user,r)
    if act=='ticket' and name=='Customer requests':
        if d.get('ticket_id'):return r
        if d['type']!='Support':raise ValueError('Only support requests create tickets.')
        if r['state'] not in ('Pending','Approved'):raise ValueError('This request is not pending.')
        from crm_tat import default_hours
        from datetime import timedelta
        hours=default_hours(db,'Other','Normal');due=datetime.now(ZoneInfo('Asia/Karachi'))+timedelta(hours=hours)
        tid=db.execute('''INSERT INTO tickets(subject,customer_id,assigned_to,type,priority,status,due_date,description,resolution_notes,tat_hours,due_at)
            VALUES (%s,%s,NULL,'Other','Normal','Open',%s,%s,'',%s,%s) RETURNING id''',(d['subject'],d['customer'],due.date(),d['details'],hours,due)).fetchone()['id']
        db.execute('INSERT INTO ticket_events(ticket_id,message) VALUES (%s,%s)',(tid,user['name']+': Created from customer portal request.'))
        return set_state(db,r,user,'Converted',dict(ticket_id=tid))
    raise ValueError('This action is not available for this module.')


def deletable(r):
    return r['module'] not in IMMUTABLE and r['state'] in ('Open','Pending','Archived','Rejected','Queued','Not configured')


def delete(db,user,r):
    name=r['module'];d=r['data']
    if user['role'] not in ('Administrator','Manager'):raise PermissionError('Only an administrator or manager can delete records.')
    if not deletable(r):raise ValueError('Posted, paid or completed records cannot be deleted; they are kept for your accounts and history.')
    users=[]
    for module,definition in MODULES.items():
        for f in definition['fields']:
            if f['kind']=='ref:'+name:
                users+=[f"{module} OPS-{x['id']}" for x in db.execute('SELECT id FROM operations_records WHERE module=%s AND data->>%s=%s ORDER BY id LIMIT 5',(module,key(f['name']),str(r['id'])))]
    if users:raise ValueError('This record is still used by '+', '.join(users)+'. Delete or change those first.')
    if name=='Areas' and db.execute('SELECT 1 FROM customers WHERE area=%s LIMIT 1',(d.get('name'),)).fetchone():raise ValueError('Customers are in this area. Move them to another area first.')
    if name=='Cities' and (db.execute("SELECT 1 FROM operations_records WHERE module IN ('Areas','Companies') AND lower(data->>'city')=lower(%s) LIMIT 1",(d.get('name'),)).fetchone() or db.execute('SELECT 1 FROM customers WHERE lower(city)=lower(%s) LIMIT 1',(d.get('name'),)).fetchone()):raise ValueError('Areas, companies or customers use this city. Move them to another city first, or mark the city Inactive.')
    if name=='Warehouses' and db.execute('SELECT 1 FROM inventory WHERE location=%s LIMIT 1',(d.get('name'),)).fetchone():raise ValueError('Inventory batches are recorded in this warehouse. Transfer the stock out, or mark the warehouse Inactive instead.')
    return_stock(db,user,d.get('stock_issue_id'))
    if name=='Assets':
        import crm_attachments
        db.execute("DELETE FROM record_invoices WHERE section='Assets' AND record_id=%s",(r['id'],))
        crm_attachments.prune(db)
    db.execute('DELETE FROM operations_events WHERE record_id=%s',(r['id'],))
    db.execute('DELETE FROM operations_records WHERE id=%s',(r['id'],))
    label=d.get('name') or d.get('title') or d.get('invoice_number') or d.get('subject') or ''
    db.execute('INSERT INTO operations_events(record_id,actor,action) VALUES (NULL,%s,%s)',(user['name'],f'Deleted {name} OPS-{r["id"]} {label}'.strip()))
    return dict(r,state='Deleted')


def state(db,user):
    modules={k:dict(v,write=permitted(user,k,True)) for k,v in MODULES.items() if permitted(user,k)}
    rows=list(db.execute('SELECT * FROM operations_records WHERE module=ANY(%s) ORDER BY id DESC',(list(modules),)))
    if user['role'] not in FINANCE:rows=[r for r in rows if r['module']!='Collection approvals' or r['created_by']==user['id']]
    if user['role']=='Technician':rows=[r for r in rows if r['module']=='Collection approvals' and r['created_by']==user['id'] or r['module']=='Tasks' and r['data'].get('employee')==user['staff_id']]
    events=list(db.execute('SELECT * FROM operations_events WHERE record_id=ANY(%s) ORDER BY id DESC',([r['id'] for r in rows],))) if rows else []
    if 'Assets' in modules:
        invoices={x['record_id']:x['n'] for x in db.execute("SELECT record_id,count(*) AS n FROM record_invoices WHERE section='Assets' GROUP BY record_id")}
        for r in rows:
            if r['module']=='Assets':r['invoice_count']=invoices.get(r['id'],0)
    lookups={}
    for kind,table,label in [('customer','customers','name'),('staff','staff','name'),('package','packages','name')]:
        lookups[kind]=list(db.execute(f'SELECT id,{label} AS name FROM {table} ORDER BY {label}'))
    # Stock pickers group batches by warehouse so devices and cables deduct from the right store.
    lookups['city']=[dict(id=c,name=c) for c in city_names(db)]
    lookups['inventory']=list(db.execute("SELECT id,item AS name,batch,location AS warehouse,quantity FROM inventory ORDER BY location,item,batch"))
    performance=[]
    if user['role'] in ('Administrator','Manager'):
        performance=list(db.execute("SELECT s.id,s.name,COUNT(t.id) AS assigned,COUNT(t.id) FILTER(WHERE t.status IN ('Resolved','Closed')) AS resolved,COUNT(t.id) FILTER(WHERE t.resolved_at IS NOT NULL AND t.resolved_at<=t.due_at) AS within_target FROM staff s LEFT JOIN tickets t ON t.assigned_to=s.id GROUP BY s.id,s.name ORDER BY resolved DESC"))
    return dict(modules=modules,records=rows,events=events,lookups=lookups,performance=performance,integrations=[dict(name=n,status='Not configured') for n in ['MikroTik / RADIUS','1LINK / Easypaisa / JazzCash checkout','SMS gateway','Transactional email delivery','OTT provider','Native Android app','Reseller portal authentication']],currency='PKR')


def generate_payroll(db,user,month):
    if user['role'] not in FINANCE:raise PermissionError('Finance permission is required.')
    date.fromisoformat(str(month)+'-01')
    db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('payroll-generation:'+month,))
    count=0
    for staff in db.execute('SELECT * FROM staff ORDER BY id').fetchall():
        exists=db.execute("SELECT 1 FROM operations_records WHERE module='Payroll' AND data->>'employee'=%s AND data->>'month'=%s",(str(staff['id']),month)).fetchone()
        if exists:continue
        fields=dict(employee=staff['id'],month=month,basic_salary=str(staff['monthly_salary']),allowances=str(staff['allowances']),deductions=str(staff['deductions']),bonus='0',overtime_amount='0',incentive='0',notes='Generated from employee salary agreement.')
        save(db,user,dict(module='Payroll',fields=fields,request_key=str(uuid.uuid4())));count+=1
    return dict(ok=True,generated=count)


def customer_state(db,cid):
    return dict(messages=list(db.execute("SELECT id,data,created_at FROM operations_records WHERE module='Customer messages' AND data->>'customer'=%s ORDER BY id DESC LIMIT 100",(str(cid),))),requests=list(db.execute("SELECT id,data,state,created_at FROM operations_records WHERE module='Customer requests' AND data->>'customer'=%s ORDER BY id DESC",(str(cid),))),notices=list(db.execute("SELECT id,data,created_at FROM operations_records WHERE module='Notices' AND data->>'published'='Yes' AND data->>'audience' IN ('Customers','Everyone') ORDER BY id DESC")),links=list(db.execute("SELECT id,data FROM operations_records WHERE module='Customer links' AND data->>'status'='Active' ORDER BY id DESC")),packages=list(db.execute("SELECT id,name,monthly_price FROM packages WHERE status='Active' ORDER BY name")))


def customer_request(db,cid,payload):
    user=dict(id=None,name='Customer '+str(cid),role='Support')
    fields=dict(payload.get('fields') or {},customer=cid)
    # A customer request cannot change an account until an authorized staff review.
    r=save(db,user,dict(module='Customer requests',fields=fields,request_key=payload.get('request_key')))
    return dict(ok=True,id=r['id'])


def customer_message(db,cid,payload):
    user=dict(id=None,name='Customer '+str(cid),role='Support')
    r=save(db,user,dict(module='Customer messages',fields=dict(customer=cid,message=payload.get('message')),request_key=payload.get('request_key')))
    return dict(ok=True,id=r['id'])


def area_options(db):
    return [r['name'] for r in db.execute("SELECT data->>'name' AS name FROM operations_records WHERE module='Areas' AND state!='Archived' AND data->>'status'='Active' ORDER BY lower(data->>'name')")]


def lock_areas(db):
    db.execute('SELECT pg_advisory_xact_lock(649214081)')


def area_cities(db):
    return {r['name']:r['city'] for r in db.execute("SELECT trim(data->>'name') AS name, coalesce(trim(data->>'city'),'') AS city FROM operations_records WHERE module='Areas' AND state!='Archived'")}


def customer_city(db,value,area):
    """A customer's city: from the Cities list, matching the area's city. Required once cities exist."""
    area_city=area_cities(db).get(area,'') if area else ''
    value=str(value or '').strip()
    if value:
        value=city_name(db,value)
        if area_city and area_city.casefold()!=value.casefold():raise ValueError(f'Area {area} is in {area_city}. Choose an area of {value}, or change the city.')
        return value
    if area_city:return city_name(db,area_city)
    if city_names(db):raise ValueError("Select the customer's city.")
    return ''


def validate_customer_area(db,value,existing=None):
    lock_areas(db)
    value=str(value or '').strip()
    if len(value)>300:raise ValueError('Area must be 300 characters or fewer.')
    if value and (not existing or value!=existing.get('area','')) and value not in area_options(db):raise ValueError('Choose an active area from Operations > Areas first.')
    return value


def run_due_schedules(db):
    system=dict(id=None,name='System schedule',role='Administrator')
    rows=db.execute("SELECT * FROM operations_records WHERE module='Client schedules' AND state='Open' AND data->>'effective_date'<=%s ORDER BY id FOR UPDATE SKIP LOCKED",(today().isoformat(),)).fetchall()
    for r in rows:
        # Validation is completed before the customer UPDATE, so a rejected
        # schedule can be recorded without an aborted SQL transaction.
        try:apply_customer_change(db,system,r)
        except ValueError as exc:set_state(db,r,system,'Blocked',dict(error=str(exc)))


def generate_mac_tariffs(db):
    system=dict(id=None,name='System daily tariff',role='Administrator')
    for r in db.execute("SELECT * FROM operations_records WHERE module='Resellers' AND state!='Archived' AND data->>'type'='MAC' AND data->>'status'='Active' ORDER BY id FOR UPDATE SKIP LOCKED").fetchall():
        tariff=Decimal(r['data'].get('daily_tariff') or '0')
        if tariff<=0:continue
        day=str(today());request=str(uuid.uuid5(uuid.NAMESPACE_URL,'mac-tariff:'+str(r['id'])+':'+day))
        # The saved day's tariff is a financial snapshot, even if the catalog
        # tariff is edited later. Never replay or rewrite a prior daily charge.
        if db.execute('SELECT 1 FROM operations_records WHERE request_key=%s',(request,)).fetchone():continue
        save(db,system,dict(module='Reseller invoices',request_key=request,fields=dict(reseller=r['id'],month=day[:7],description='Daily MAC tariff '+day,amount=str(tariff),due_date=day)))


def import_customers(db,user,rows,validate_core):
    import crm_auth
    import crm_data
    from datetime import timedelta
    if not crm_auth.allowed(user,'Customers','write'):raise PermissionError('Customer write permission is required.')
    if not isinstance(rows,list) or not 1<=len(rows)<=200:raise ValueError('Import between 1 and 200 customer rows at a time.')
    saved=[]
    for index,raw in enumerate(rows,1):
        if not isinstance(raw,dict):raise ValueError('Invalid CSV row '+str(index)+'.')
        fields={key(str(k).strip()):v for k,v in raw.items()}
        joined=fields.get('joined') or fields.get('creation_date') or str(today())
        if fields.get('status','Active') not in ('Active','Suspended','Disconnected'):raise ValueError('Row '+str(index)+': new accounts cannot be Terminated.')
        package=fields.get('package_id') or fields.get('package')
        p=db.execute("SELECT * FROM packages WHERE status='Active' AND (id::text=%s OR name=%s) ORDER BY id LIMIT 1",(str(package),str(package))).fetchone()
        if not p:raise ValueError('Row '+str(index)+': select an existing active package by exact name or ID.')
        fields.update(package=p['name'],monthly_fee=p['monthly_price'],installation_charge=fields.get('installation_charge') or p['installation_fee'],joined=joined,expiry_date=fields.get('expiry_date') or str(date.fromisoformat(joined)+timedelta(days=30)),status=fields.get('status') or 'Active')
        if fields.get('latitude') in (None,'') or fields.get('longitude') in (None,''):raise ValueError('Row '+str(index)+': installation latitude and longitude are required.')
        fields['area']=validate_customer_area(db,fields.get('area'))
        values=validate_core('Customers',fields)
        columns=[crm_data.column_name(label) for label,kind in crm_data.record_fields('Customers')]+['package_id']
        placeholders=','.join('%s' for _ in columns)
        cid=db.execute('INSERT INTO customers('+','.join(columns)+') VALUES ('+placeholders+') RETURNING id',values+[p['id']]).fetchone()['id']
        saved.append(cid)
    return dict(ok=True,imported=len(saved),ids=saved)


def bulk_status(db,user,ids,status):
    import crm_auth
    if not crm_auth.allowed(user,'Customers','write'):raise PermissionError('Customer write permission is required.')
    if status not in ('Active','Suspended','Disconnected'):raise ValueError('Use an ordinary status; termination requires the recovery workflow.')
    if not isinstance(ids,list) or not 1<=len(ids)<=200 or any(type(i) is not int or i<=0 for i in ids):raise ValueError('Select between 1 and 200 valid customer IDs.')
    ids=sorted(set(ids));customers=db.execute('SELECT * FROM customers WHERE id=ANY(%s) ORDER BY id FOR UPDATE',(ids,)).fetchall()
    if len(customers)!=len(ids):raise ValueError('One or more customers no longer exist.')
    if any(c['status']=='Terminated' for c in customers):raise ValueError('Terminated accounts require separate recovery/reactivation; no accounts were changed.')
    db.execute('UPDATE customers SET status=%s WHERE id=ANY(%s)',(status,ids))
    for c in customers:
        # Keep an auditable operational event for every bulk account change.
        r=save(db,user,dict(module='Customer requests',request_key=str(uuid.uuid4()),fields=dict(customer=c['id'],type='Status change',subject='Bulk status change',details=c['status']+' → '+status,requested_status=status)))
        set_state(db,r,user,'Applied')
    return dict(ok=True,updated=len(ids))
