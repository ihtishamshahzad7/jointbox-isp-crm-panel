"""Run python ispcrm.py and open http://localhost:3000."""
import json
import secrets
import threading
import logging
import psycopg
import hashlib
import re
import crm_auth as auth
import crm_documents as documents
import crm_recharge as recharge
import crm_gateway as gateway
import crm_billing as billing
import crm_customer_ledger as customer_ledger
import crm_customer_portal as customer_portal
import crm_inventory_qr as inventory_qr
import crm_tat
import crm_costs
import crm_termination as termination
import crm_operations as operations
import crm_device_scan as device_scan
import crm_attachments as attachments
import crm_city as city_filter
import crm_warehouses as warehouses
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from decimal import Decimal, InvalidOperation
from uuid import UUID
from http.server import BaseHTTPRequestHandler
import http.server


OCR_FILES = {'tesseract.min.js': 'text/javascript', 'worker.min.js': 'text/javascript', 'zxing.min.js': 'text/javascript',
             'tesseract-core-simd-lstm.wasm.js': 'text/javascript', 'tesseract-core-lstm.wasm.js': 'text/javascript',
             'eng.traineddata.gz': 'application/gzip'}


class ThreadingHTTPServer(http.server.ThreadingHTTPServer):
    # The page loads ~25 files at once; the default backlog of 5 makes Windows refuse some of them.
    request_queue_size = 128
from pathlib import Path
from urllib.parse import urlparse, quote, parse_qs, unquote
from crm_data import STAFF_DETAILS, STAFF_PRIVATE, SCHEMAS, column_name, connect_database, initialize_database, table_name, record_fields

TOKEN = secrets.token_urlsafe(32)
ROOT = Path(__file__).parent


def next_batch_number(db):
    """Next automatic batch number for this month, e.g. B-2610-003."""
    prefix = 'B-' + recharge.local_today().strftime('%y%m') + '-'
    used = [int(r['batch'][len(prefix):]) for r in db.execute('SELECT batch FROM inventory WHERE batch LIKE %s', (prefix + '%',)) if r['batch'][len(prefix):].isdigit()]
    return prefix + f'{max(used, default=0) + 1:03d}'


def validate(section, fields):
    if section == 'Inventory':
        fields = dict(fields)
        fields['batch'] = str(fields.get('batch') or '').strip()
        if len(fields['batch']) > 100:
            raise ValueError('Batch must be 100 characters or fewer.')
    if section=='Staff':
        fields=dict(fields)
        for label,kind in STAFF_DETAILS:
            if kind=='generated':continue
            fields.setdefault(column_name(label),0 if kind=='money' else 'Not specified' if label=='Gender' else 'Permanent' if label=='Employment type' else '')
        try:
            salaries=[Decimal(str(fields[k])) for k in ('monthly_salary','allowances','deductions')]
            if not all(v.is_finite() for v in salaries):raise ValueError('Enter valid salary amounts.')
            if salaries[2]>salaries[0]+salaries[1]:raise ValueError('Deductions cannot exceed monthly salary plus allowances.')
        except InvalidOperation:
            raise ValueError('Enter valid salary amounts.')
        if fields.get('date_of_birth') and fields.get('joining_date') and str(fields['date_of_birth'])>=str(fields['joining_date']):
            raise ValueError('Date of birth must be before the joining date.')
    if section == 'Payments':
        fields = dict(fields)
        fields.setdefault('revenue_type', 'MRC')
        fields.setdefault('otc_type','Other')
        if fields['revenue_type']=='MRC' and fields['otc_type']!='Other':
            raise ValueError('Installation and other one-time charges must use OTC.')
    if section == 'Customers':
        fields = dict(fields)
        fields.setdefault('customer_type', 'Residential')
        if not fields.get('expiry_date'):
            fields['expiry_date'] = (date.fromisoformat(str(fields.get('joined', ''))) + timedelta(days=30)).isoformat()
    if section == 'Stock issues':
        fields = dict(fields)
        fields.setdefault('recovery_required','Yes')
        fields['status'] = 'Issued'
        if fields.get('issued_against') != 'Customer':
            fields['customer_id'] = ''
    if section == 'Expenses':
        fields = dict(fields)
        if fields.get('status') != 'Paid':
            fields['payment_date'] = ''
    values = []
    for label, kind in record_fields(section):
        value = str(fields.get(column_name(label), '')).strip()
        if kind in ('latitude','longitude'):
            raw=fields.get(column_name(label))
            if raw is None or str(raw).strip()=='':
                values.append(None)
                continue
            try:
                number=Decimal(str(raw).strip())
            except InvalidOperation:
                raise ValueError(f'{label} must be a decimal coordinate.')
            limit=90 if kind=='latitude' else 180
            if not number.is_finite() or not -limit<=number<=limit:
                raise ValueError(f'{label} must be between -{limit} and {limit}.')
            values.append(number.quantize(Decimal('0.0000001')))
            continue
        if kind in ('assignee', 'optionalcustomer', 'optionalstaff') and fields.get(column_name(label)) is None:
            value = ''
        if kind in ('assignee', 'optionalcustomer', 'optionalstaff') and not value:
            values.append(None)
            continue
        if kind == 'optionaldate' and (not value or fields.get(column_name(label)) is None):
            values.append(None)
            continue
        if not value and kind != 'optionaltext' and label not in ('Notes', 'Reference', 'Address', 'Location', 'Area', 'Resolution notes', 'Destination'):
            raise ValueError(f'{label} is required.')
        if isinstance(kind, list):
            if value not in kind:
                raise ValueError(f'Invalid {label}.')
        elif kind in ('money', 'integer', 'customer', 'staff', 'assignee', 'inventory', 'optionalcustomer', 'optionalstaff'):
            try:
                number = Decimal(value)
            except InvalidOperation:
                raise ValueError(f'{label} must be numeric.')
            if not number.is_finite() or not 0 <= number <= 1_000_000_000_000:
                raise ValueError(f'{label} is outside the supported range.')
            if kind != 'money' and number != number.to_integral_value():
                raise ValueError(f'{label} must be a whole number.')
            value = number.quantize(Decimal('0.01')) if kind == 'money' else int(number)
        elif kind in ('date', 'optionaldate'):
            if date.fromisoformat(value).isoformat() != value:
                raise ValueError('Use YYYY-MM-DD dates.')
        elif kind == 'month':
            if date.fromisoformat(value + '-01').strftime('%Y-%m') != value:
                raise ValueError('Use YYYY-MM for billing month.')
        values.append(value)
    if section == 'Tickets':
        ticket = dict(zip((column_name(label) for label, _ in SCHEMAS[section]), values))
        if ticket['status'] in ('In progress', 'Resolved', 'Closed') and ticket['assigned_to'] is None:
            raise ValueError('Assign a staff member before starting or resolving a ticket.')
        if ticket['status'] in ('Resolved', 'Closed') and not ticket['resolution_notes']:
            raise ValueError('Add resolution notes before marking a ticket resolved or closed.')
    if section == 'Expenses':
        expense = dict(zip((column_name(label) for label, _ in SCHEMAS[section]), values))
        if expense['amount'] <= 0:
            raise ValueError('Expense amount must be greater than zero.')
        if expense['status'] == 'Paid' and expense['payment_date'] is None:
            raise ValueError('Enter the payment date for a paid expense.')
    if section == 'Stock issues':
        issue = dict(zip((column_name(label) for label, _ in SCHEMAS[section]), values))
        if issue['quantity'] <= 0:
            raise ValueError('Issue quantity must be a positive whole number.')
        if issue['issued_against'] == 'Customer' and issue['customer_id'] is None:
            raise ValueError('Select the customer receiving this inventory.')
        if issue['issued_against'] != 'Customer' and not issue['destination']:
            raise ValueError('Enter the system name or network location in Destination.')
    if section == 'Payments' and fields.get('revenue_type') == 'OTC' and not str(fields.get('reference','')).strip():
        raise ValueError('Describe the one-time charge in Reference.')
    if section == 'Customers':
        customer = dict(zip((column_name(label) for label, _ in record_fields(section)), values))
        if (customer['latitude'] is None)!=(customer['longitude'] is None):
            raise ValueError('Enter both latitude and longitude for the deployment pin.')
        if customer['expiry_date'] < customer['joined']:
            raise ValueError('Expiry date cannot be before the customer creation date.')
        if customer['email'] and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', customer['email']):
            raise ValueError('Enter a valid email address or leave it blank.')
        if customer['cnic'] and not re.fullmatch(r'(?:[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9])', customer['cnic']):
            raise ValueError('CNIC must contain 13 digits, optionally in 12345-1234567-1 format.')
    return values


def json_value(value):
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, date):
        return value.isoformat()
    raise TypeError(f'Unsupported JSON value: {type(value).__name__}')


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, mime='application/json; charset=utf-8', headers=None):
        data = json.dumps(body, default=json_value).encode() if mime.startswith('application/json') else body
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        if 'Cache-Control' not in (headers or {}):
            self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org https://server.arcgisonline.com; connect-src 'self' https://server.arcgisonline.com; frame-ancestors 'none'; base-uri 'none'")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/operations':
            try:
                user=auth.current_session(self.headers)
                if not user:return self.send(401,{'error':'Sign in to use operations.'})
                with connect_database() as db:
                    scope=city_filter.scope(db,parse_qs(urlparse(self.path).query).get('city',[''])[0])
                    result=city_filter.filter_operations(operations.state(db,user),scope)
                return self.send(200,result)
            except psycopg.Error:return self.send(503,{'error':'Operations data is unavailable.'})
        if path in ('/api/print-settings','/api/print-logo'):
            try:
                import crm_print_settings
                user=auth.current_session(self.headers)
                if not user:return self.send(401,{'error':'Sign in to the CRM to print.'})
                with connect_database() as db:
                    if path=='/api/print-settings':return self.send(200,crm_print_settings.get(db,user))
                    content,mime=crm_print_settings.logo(db)
                if not content:return self.send(404,{'error':'No logo uploaded.'})
                return self.send(200,content,mime,{'Cache-Control':'private, max-age=86400'})
            except psycopg.Error:return self.send(503,{'error':'Print settings are unavailable.'})
        if path.startswith('/ocr/') and path[5:] in OCR_FILES:
            # Offline label-reading engine and data (~11 MB); cache it so it downloads once.
            return self.send(200,(ROOT/'web'/'ocr'/path[5:]).read_bytes(),OCR_FILES[path[5:]],{'Cache-Control':'public, max-age=2592000'})
        if path.startswith('/api/attachments/') or path.startswith('/api/attachment-files/'):
            try:
                user=auth.current_session(self.headers)
                if not user:return self.send(401,{'error':'Sign in to view invoices.'})
                parts=path.strip('/').split('/')
                with connect_database() as db:
                    if parts[1]=='attachments' and len(parts)==4:
                        return self.send(200,{'invoices':attachments.listing(db,user,unquote(parts[2]),int(parts[3]))})
                    if parts[1]=='attachment-files' and len(parts)==3:
                        row=db.execute('SELECT * FROM record_invoices WHERE id=%s',(int(parts[2]),)).fetchone()
                        if not row:return self.send(404,{'error':'Invoice does not exist.'})
                        attachments.check(user,row['section'])
                        disposition="inline; filename=invoice; filename*=UTF-8''"+quote(row['original_name'],safe='')
                        return self.send(200,bytes(row['content']),row['mime_type'],{'Content-Disposition':disposition})
                return self.send(404,{'error':'Not found'})
            except PermissionError as exc:return self.send(403,{'error':str(exc)})
            except (ValueError,TypeError) as exc:return self.send(400,{'error':str(exc)})
            except psycopg.Error:return self.send(503,{'error':'Invoices are unavailable.'})
        if path.startswith('/api/stock-issues/') and path.endswith('/photo'):
            try:
                user=auth.current_session(self.headers)
                if not user or not auth.allowed(user,'Stock issues'):return self.send(403,{'error':'You cannot view stock issue photos.'})
                rid=int(path.split('/')[3])
                with connect_database() as db:
                    row=db.execute('SELECT p.photo,p.media_type,s.employee_id FROM stock_issue_photos p JOIN stock_issues s ON s.id=p.issue_id WHERE p.issue_id=%s',(rid,)).fetchone()
                if not row or (user['role']=='Technician' and row['employee_id']!=user['staff_id']):return self.send(404,{'error':'Photo not found.'})
                return self.send(200,bytes(row['photo']),row['media_type'])
            except ValueError:return self.send(404,{'error':'Photo not found.'})
            except psycopg.Error:return self.send(503,{'error':'Photo is unavailable.'})
        if path == '/api/operations/kmz':
            try:
                user=auth.current_session(self.headers)
                if not user:return self.send(401,{'error':'Sign in to download the network map.'})
                with connect_database() as db:data=operations.kmz(db,user)
                return self.send(200,data,'application/vnd.google-earth.kmz',{'Content-Disposition':'attachment; filename="isp-network-map.kmz"'})
            except PermissionError as exc:return self.send(403,{'error':str(exc)})
            except psycopg.Error:return self.send(503,{'error':'Network map data is unavailable.'})
        assets ={'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
        assets.update({'/dashboard.js': ('dashboard.js', 'text/javascript'), '/dashboard.css': ('dashboard.css', 'text/css')})
        assets.update({'/theme.js': ('theme.js', 'text/javascript'), '/theme.css': ('theme.css', 'text/css')})
        assets['/section-summary.js'] = ('section-summary.js', 'text/javascript')
        assets['/ticket-tat.js'] = ('ticket-tat.js', 'text/javascript')
        assets['/business-dashboard.js'] = ('business-dashboard.js', 'text/javascript')
        assets.update({'/reports.js': ('reports.js', 'text/javascript'), '/reports.css': ('reports.css', 'text/css')})
        assets['/business-dashboard.css'] = ('business-dashboard.css', 'text/css')
        for route,name,mime in [('','customer-portal.html','text/html'),('/','customer-portal.html','text/html'),('/portal.js','customer-portal.js','text/javascript'),('/portal.css','customer-portal.css','text/css'),('/manifest.json','customer-manifest.json','application/manifest+json'),('/sw.js','customer-sw.js','text/javascript'),('/icon.svg','customer-icon.svg','image/svg+xml')]:
            assets['/customer'+route]=(name,mime)
        assets['/modern.css'] = ('modern.css', 'text/css')
        assets['/inventory-qr.js'] = ('inventory-qr.js', 'text/javascript')
        assets['/termination.js'] = ('termination.js', 'text/javascript')
        assets['/customer-location.js'] = ('customer-location.js', 'text/javascript')
        assets['/assistant.js'] = ('assistant.js', 'text/javascript')
        assets['/operations.js'] = ('operations.js', 'text/javascript')
        assets.update({'/attachments.js': ('attachments.js', 'text/javascript'), '/count-up.js': ('count-up.js', 'text/javascript'), '/device-label.js': ('device-label.js', 'text/javascript'), '/network-map.js': ('network-map.js', 'text/javascript'), '/leaflet.js': ('leaflet.js', 'text/javascript'), '/leaflet.css': ('leaflet.css', 'text/css')})
        assets['/digital-theme.css'] = ('digital-theme.css', 'text/css')
        assets['/city-filter.js'] = ('city-filter.js', 'text/javascript')
        assets['/warehouses.js'] = ('warehouses.js', 'text/javascript')
        assets['/network-kmz-import.js'] = ('network-kmz-import.js', 'text/javascript')
        assets['/bandwidth-reminder.js'] = ('bandwidth-reminder.js', 'text/javascript')
        assets.update({'/paper-size.js': ('paper-size.js', 'text/javascript'), '/paper-size.css': ('paper-size.css', 'text/css')})
        assets.update({'/print-design.js': ('print-design.js', 'text/javascript'), '/print-design.css': ('print-design.css', 'text/css')})
        assets.update({'/print-design.js': ('print-design.js', 'text/javascript'), '/print-design.css': ('print-design.css', 'text/css')})
        assets['/auth.js'] = ('auth.js', 'text/javascript')
        assets['/customer.js'] = ('customer.js', 'text/javascript')
        assets['/select-search.js'] = ('select-search.js', 'text/javascript')
        assets['/documents.js'] = ('documents.js', 'text/javascript')
        assets.update({'/customer-profile.js': ('customer-profile.js', 'text/javascript'), '/customer-profile.css': ('customer-profile.css', 'text/css')})
        assets.update({'/invoice': ('invoice.html', 'text/html'), '/invoice.js': ('invoice.js', 'text/javascript'), '/invoice.css': ('invoice.css', 'text/css')})
        assets.update({'/receipt': ('receipt.html', 'text/html'), '/receipt.js': ('receipt.js', 'text/javascript'), '/receipt.css': ('receipt.css', 'text/css')})
        if path in assets:
            filename, mime = assets[path]
            return self.send(200, (ROOT / 'web' / filename).read_bytes(), mime + '; charset=utf-8')
        if path == '/api/auth/status':
            try:
                user = auth.current_session(self.headers)
                with connect_database() as db:
                    setup = not db.execute('SELECT 1 FROM app_users LIMIT 1').fetchone()
                return self.send(200, {'setup_required': setup, 'user': auth.public_user(user) if user else None, 'token': user['csrf'] if user else TOKEN})
            except psycopg.Error:
                return self.send(503, {'error': 'PostgreSQL is unavailable.'})
        if path.startswith('/api/customer-app/'):
            return self.customer_app_get(path)
        if path == '/api/inventory-qr':
            return self.inventory_qr_get()
        if path == '/api/state':
            try:
                user = auth.current_session(self.headers)
                if not user:
                    return self.send(401, {'error': 'Sign in to use the CRM.'})
                with connect_database() as db:
                    termination.generate_expiry_recovery(db)
                    billing.generate_monthly_invoices(db)
                    records = auth.read_records(db, user)
                    if auth.allowed(user,'Payments'):
                        balances=customer_ledger.account_balances(db)
                        for customer in records['Customers']:customer['account_balance']=balances.get(customer['id'],0)
                    records['Inventory units']=list(db.execute('SELECT id,inventory_id,state,condition FROM inventory_units')) if auth.allowed(user,'Inventory') else []
                    records['Invoices'] = billing.monthly_invoices(db) if auth.allowed(user,'Payments') else []
                    if auth.allowed(user,'Payments'):
                        collectors={r['payment_record_id']:r['recorded_by'] for r in db.execute('SELECT payment_record_id,recorded_by FROM payment_receipts')}
                        for payment in records['Payments']:
                            payment['recorded_by']=collectors.get(payment['id'],'Unknown')
                    records['Recharges'] = list(db.execute('SELECT id,customer_id,billing_month,activated_at,partial_activation FROM customer_recharges ORDER BY id DESC')) if auth.allowed(user,'Payments') else []
                    # Speed billed per provider and month across all cities, so a city view gets only its share of the peak.
                    sold={(r['month'],r['provider']):r['mbps'] for r in db.execute('''SELECT i.billing_month AS month,p.service_provider AS provider,sum(p.speed_mbps) AS mbps FROM invoices i
                        JOIN customers c ON c.id=i.customer_id JOIN packages p ON p.id=COALESCE((SELECT x.id FROM packages x WHERE x.name=i.package_name ORDER BY x.id LIMIT 1),c.package_id) GROUP BY 1,2''')}
                    records['Bandwidth peaks']=[dict(id=r['id'],provider=r['data'].get('provider'),month=r['data'].get('month'),peak_mbps=r['data'].get('peak_mbps'),price_per_mbps=r['data'].get('price_per_mbps'),
                        sold_mbps=sold.get((r['data'].get('month'),r['data'].get('provider')))) for r in db.execute("SELECT id,data FROM operations_records WHERE module='Bandwidth peaks' AND state!='Archived' ORDER BY data->>'month' DESC")] if auth.allowed(user,'Payments') else []
                    city_options=city_filter.cities(db)
                    scope=city_filter.scope(db,parse_qs(urlparse(self.path).query).get('city',[''])[0])
                    records=city_filter.filter_records(records,scope)
                    if records.get('Equipment recovery'):
                        for recovery in records['Equipment recovery']:
                            recovery['pending_items']=[{key:item[key] for key in ('id','inventory_id','item','quantity','employee_id','issue_date')} for item in termination.pending_items(db,recovery['customer_id'])] if recovery['status']=='Equipment recovery pending' else []
                    tat_settings=list(db.execute('SELECT ticket_type,priority,hours FROM tat_settings')) if auth.allowed(user,'Tickets') else []
                    ticket_ids = [t['id'] for t in records['Tickets']]
                    area_options=operations.area_options(db) if auth.allowed(user,'Customers') else []
                    if scope:area_options=[a for a in area_options if a in scope['areas']]
                    city_list=operations.city_names(db) if auth.allowed(user,'Customers') else []
                    if scope:city_list=[c for c in city_list if c.casefold()==scope['city'].casefold()]
                    area_city_map={a:c for a,c in operations.area_cities(db).items() if a in area_options}
                    stock_access=auth.allowed(user,'Inventory') or auth.allowed(user,'Stock issues')
                    warehouse_options=warehouses.names(db) if stock_access else []
                    transfers=warehouses.history(db) if auth.allowed(user,'Inventory') else []
                    activity = list(db.execute('SELECT * FROM ticket_events WHERE ticket_id=ANY(%s) ORDER BY id DESC', (ticket_ids,))) if ticket_ids else []
                schemas = {s: fields for s, fields in SCHEMAS.items() if s != 'Jobs' and auth.allowed(user, s)}
                if user['role'] not in ('Administrator','Manager') and 'Staff' in schemas:
                    schemas['Staff']=[(label,kind) for label,kind in schemas['Staff'] if column_name(label) not in STAFF_PRIVATE]
                if auth.allowed(user, 'Users'):
                    schemas['Users'] = auth.USER_SCHEMA
                return self.send(200, {'schemas': schemas, 'records': records, 'ticket_activity': activity, 'tat_settings':tat_settings, 'area_options':area_options,
                                      'cities':city_options, 'city':scope['city'] if scope else '',
                                      'warehouses':warehouse_options, 'transfers':transfers,
                                      'city_list':city_list, 'area_cities':area_city_map,
                                      'token': user['csrf'], 'user': auth.public_user(user),
                                      'permissions': auth.ROLES[user['role']], 'roles': auth.ROLES})
            except psycopg.Error:
                return self.send(503, {'error': 'PostgreSQL is unavailable. Check that its service is running.'})
        if path.startswith('/api/receipts/'):
            return self.receipt_get(path)
        if path.startswith('/api/invoices/'):
            return self.invoice_get(path)
        if path.startswith('/api/customers/') and path.endswith('/billing'):
            return self.billing_quote_get(path)
        if path.startswith('/api/customers/') and path.endswith('/profile'):
            return self.customer_profile_get(path)
        if path.startswith('/api/customer-documents/') or (path.startswith('/api/customers/') and path.endswith('/documents')):
            return self.documents_get(path)
        self.send(404, {'error': 'Not found'})

    def do_POST(self):
        path = urlparse(self.path).path
        if path.startswith('/api/customer-app/'):
            return self.customer_app_post(path)
        if path == '/api/payments/incoming':
            return self.incoming_payment_post()
        if path.startswith('/api/auth/'):
            return self.auth_post(path)
        try:
            user = auth.current_session(self.headers)
        except psycopg.Error:
            return self.send(503, {'error': 'PostgreSQL is unavailable.'})
        if not user:
            return self.send(401, {'error': 'Your session expired. Sign in again.'})
        if self.headers.get('X-CRM-Token') != user['csrf']:
            return self.send(403, {'error': 'Reload the page before saving.'})
        if path=='/api/attachments':
            try:
                payload=self.read_json(documents.MAX_REQUEST)
                with connect_database() as db:
                    if payload.get('action')=='delete':attachments.remove(db,user,payload.get('id'));return self.send(200,{'ok':True})
                    count=attachments.upload(db,user,payload.get('section'),payload.get('record_id'),payload.get('files'))
                return self.send(200,{'ok':True,'uploaded':count})
            except PermissionError as exc:return self.send(403,{'error':str(exc)})
            except (ValueError,TypeError) as exc:return self.send(400,{'error':str(exc)})
            except psycopg.Error:return self.send(503,{'error':'Could not save the invoice.'})
        if path=='/api/print-settings':
            try:
                import crm_print_settings
                payload=self.read_json(limit=2*1024*1024)
                with connect_database() as db:result=crm_print_settings.save(db,user,payload)
                return self.send(200,result)
            except PermissionError as exc:return self.send(403,{'error':str(exc)})
            except (ValueError,TypeError) as exc:return self.send(400,{'error':str(exc)})
            except psycopg.Error:return self.send(503,{'error':'The design could not be saved.'})
        if path=='/api/network-kmz':
            try:
                import base64,binascii
                import crm_kmz_import
                payload=self.read_json(limit=21*1024*1024)
                with connect_database() as db:
                    if payload.get('action')=='preview':
                        try:data=base64.b64decode(str(payload.get('file') or ''),validate=True)
                        except binascii.Error:raise ValueError('The file could not be read. Choose it again.')
                        result=crm_kmz_import.preview(db,user,data)
                    elif payload.get('action')=='import':result={'ok':True,'created':crm_kmz_import.import_items(db,user,payload)}
                    else:raise ValueError('Invalid KMZ request.')
                return self.send(200,result)
            except PermissionError as exc:return self.send(403,{'error':str(exc)})
            except (ValueError,TypeError,KeyError) as exc:return self.send(400,{'error':str(exc)})
            except psycopg.Error:
                logging.exception('KMZ import failed')
                return self.send(503,{'error':'Import failed. Nothing was added to the map.'})
        if path=='/api/inventory-transfer':
            try:
                payload=self.read_json(limit=10000)
                if not isinstance(payload,dict):raise ValueError('Invalid transfer request.')
                with connect_database() as db:result=warehouses.transfer(db,user,payload)
                return self.send(200,{'ok':True,'transfer':result})
            except PermissionError as exc:return self.send(403,{'error':str(exc)})
            except (ValueError,TypeError) as exc:return self.send(400,{'error':str(exc)})
            except psycopg.Error:
                logging.exception('Inventory transfer failed')
                return self.send(503,{'error':'Transfer failed. No stock was moved.'})
        if path=='/api/device-scan':
            # Labels are now read in the browser; only a page loaded before that change still calls this.
            return self.send(410,{'error':'This page is out of date. Press Ctrl+F5 to reload it, then add the photo again.'})
        if path=='/api/operations':
            try:
                payload=self.read_json(limit=200000)
                if not isinstance(payload,dict):raise ValueError('Invalid operations request.')
                with connect_database() as db:
                    if payload.get('action')=='generate_payroll':result=operations.generate_payroll(db,user,payload.get('month'))
                    elif payload.get('action')=='import_customers':result=operations.import_customers(db,user,payload.get('rows'),validate)
                    elif payload.get('action')=='bulk_status':result=operations.bulk_status(db,user,payload.get('ids'),payload.get('status'))
                    elif payload.get('action') in (None,'save'):result={'ok':True,'record':operations.save(db,user,payload)}
                    else:result={'ok':True,'record':operations.action(db,user,payload,validate)}
                return self.send(200,result)
            except PermissionError as exc:return self.send(403,{'error':str(exc)})
            except (ValueError,TypeError,KeyError) as exc:return self.send(400,{'error':str(exc)})
            except psycopg.IntegrityError:return self.send(400,{'error':'A linked record or unique value conflicts with this operation.'})
            except psycopg.Error:
                logging.exception('Operations transaction failed')
                return self.send(503,{'error':'Operation failed. No changes were committed.'})
        if path=='/api/assistant':
            try:
                origin=self.headers.get('Origin')
                if origin and urlparse(origin).netloc!=self.headers.get('Host'):return self.send(403,{'error':'Use the CRM assistant from this page.'})
                payload=self.read_json(limit=10000)
                if not isinstance(payload,dict):raise ValueError('Invalid assistant request.')
                import crm_assistant
                with connect_database() as db:
                    if payload.get('action')=='status':result={'ai_available':crm_assistant.config()['enabled']}
                    else:result=crm_assistant.ask(db,user,payload)
                return self.send(200,result)
            except (ValueError,TypeError) as exc:return self.send(400,{'error':str(exc)})
            except psycopg.Error:return self.send(503,{'error':'CRM data is temporarily unavailable.'})
        if path=='/api/customer-services':
            return self.customer_services_post(user)
        if path in ('/api/customer-portal/access','/api/customer-portal/notify'):
            return self.customer_portal_staff_post(path,user)
        if path == '/api/inventory-qr':
            return self.inventory_qr_post(user)
        if path == '/api/customers/terminate':
            return self.terminate_post(user)
        if path == '/api/users':
            return self.users_post(user)
        if path == '/api/invoices':
            return self.invoice_post(user)
        if path == '/api/customer-documents':
            return self.documents_post(user)
        if path != '/api/record':
            return self.send(404, {'error': 'Not found'})
        db = None
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= documents.MAX_REQUEST:
                raise ValueError('Invalid request size.')
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict) or payload.get('section') not in SCHEMAS:
                raise ValueError('Invalid section.')
            section, rid = payload['section'], payload.get('id')
            action = payload.get('action')
            if action not in (None, 'save', 'delete', 'return'):
                raise ValueError('Unknown action.')
            if not auth.allowed(user, section, 'delete' if action == 'delete' else 'write'):
                raise PermissionError('Your role does not permit this action.')
            if action == 'return' and section != 'Stock issues':
                raise ValueError('Returns apply only to stock issues.')
            if rid is not None and (type(rid) is not int or rid <= 0):
                raise ValueError('Invalid record ID.')
            db = connect_database()
            with db:
                uploads = payload.get('documents', [])
                if uploads and (section != 'Customers' or not documents.permitted(user)):
                    raise PermissionError('Your role cannot upload customer documents.')
                validated_documents = documents.validate_uploads(uploads)
                if section == 'Payments':
                    payment_result = recharge.save_payment(db, payload, user, validate)
                    db.commit()
                    return self.send(200, payment_result)
                if section == 'Stock issues':
                    self.save_stock_issue(db, payload, rid, user)
                    # Commit stock and issue together before acknowledging the request.
                    db.commit()
                    return self.send(200, {'ok': True})
                if section=='TAT settings':
                    if payload.get('action')=='delete' or not rid:
                        raise ValueError('Edit an existing TAT rule to change its hours.')
                    rule=db.execute('SELECT * FROM tat_settings WHERE id=%s FOR UPDATE',(rid,)).fetchone()
                    proposed=payload.get('fields',{})
                    if not rule or proposed.get('ticket_type')!=rule['ticket_type'] or proposed.get('priority')!=rule['priority']:
                        raise ValueError('Select the existing rule for this ticket type and priority.')
                if payload.get('action') == 'delete':
                    if section=='Designations':
                        designation=db.execute('SELECT name FROM designations WHERE id=%s FOR UPDATE',(rid,)).fetchone()
                        if designation and db.execute('SELECT 1 FROM staff WHERE designation=%s LIMIT 1',(designation['name'],)).fetchone():
                            raise ValueError('This designation is used by employees. Set it to Inactive instead.')
                    if section == 'Tickets':
                        raise ValueError('Close tickets instead of deleting them, to preserve their resolution history.')
                    if section == 'Packages':
                        package = db.execute('SELECT * FROM packages WHERE id=%s FOR UPDATE', (rid,)).fetchone()
                        if package and db.execute('SELECT 1 FROM customers WHERE package=%s LIMIT 1', (package['name'],)).fetchone():
                            raise ValueError('This package is used by customers. Set it to Inactive instead.')
                    result = db.execute(f'DELETE FROM {table_name(section)} WHERE id=%s', (rid,))
                    if section in attachments.SECTIONS and result.rowcount:
                        db.execute('DELETE FROM record_invoices WHERE section=%s AND record_id=%s', (section, rid))
                else:
                    fields = payload.get('fields', {})
                    if not isinstance(fields, dict):
                        raise ValueError('Invalid fields.')
                    if section == 'Tickets':
                        tat_hours, ticket_due_at, tat_previous = crm_tat.prepare_tat(db,rid,fields,user)
                    auth.check_scoped_write(db, user, section, rid, fields)
                    if section == 'Inventory':
                        category_name = str(fields.get('category', '')).strip()
                        category = db.execute('SELECT * FROM categories WHERE name=%s FOR SHARE', (category_name,)).fetchone()
                        if not category:
                            raise ValueError('Select a category from Admin → Categories first.')
                        existing_item = db.execute('SELECT * FROM inventory WHERE id=%s FOR UPDATE', (rid,)).fetchone() if rid else None
                        fields.setdefault('batch', existing_item['batch'] if existing_item else '')
                        if existing_item and int(fields.get('quantity',0))<inventory_qr.available(db,rid):
                            raise ValueError('Quantity cannot be less than available QR-registered devices. Use scan issue/return to move tracked stock.')
                        if existing_item and payload.get('original_quantity') is not None and payload['original_quantity'] != existing_item['quantity']:
                            raise ValueError('Stock changed while this form was open. Reload the record before saving.')
                        if category['status'] != 'Active' and (not existing_item or existing_item['category'] != category_name):
                            raise ValueError('Select an active category for new inventory assignments.')
                        fields['location'] = warehouses.check_inventory_warehouse(db, fields.get('location'), existing_item)
                    package_id = None
                    if section == 'Customers':
                        operations.lock_areas(db)
                        existing = db.execute('SELECT * FROM customers WHERE id=%s FOR UPDATE', (rid,)).fetchone() if rid else None
                        fields['area']=operations.validate_customer_area(db,fields.get('area',existing['area'] if existing else ''),existing)
                        fields['city']=operations.customer_city(db,fields.get('city',existing['city'] if existing else ''),fields['area'])
                        if not existing and fields.get('status')=='Terminated':
                            raise ValueError('Create the account first, then terminate it from its profile.')
                        if existing and existing['status']=='Terminated' and existing['recovery_status']=='Equipment recovery pending' and fields.get('status')!='Terminated':
                            raise ValueError('Recover all required equipment before reactivating this account.')
                        if existing:
                            for extra in ('promise_date','installation_charge','customer_type','email','cnic','telephone','passport','ntn','latitude','longitude'):
                                fields.setdefault(extra, existing[extra])
                        if existing and existing['latitude'] is not None and any(fields.get(c) is None or str(fields.get(c)).strip()=='' for c in ('latitude','longitude')):
                            raise ValueError('Both deployment coordinates are required; replace the pin rather than clearing it.')
                        if existing and not fields.get('expiry_date'):
                            fields['expiry_date'] = existing['expiry_date'].isoformat()
                        selection = str(fields.get('package', '')).strip()
                        if existing and existing['package_id'] is None and selection == existing['package']:
                            fields['monthly_fee'] = existing['monthly_fee']
                        else:
                            if not selection.isdecimal():
                                raise ValueError('Select a package from the Admin panel first.')
                            package = db.execute('SELECT * FROM packages WHERE id=%s FOR SHARE', (int(selection),)).fetchone()
                            if not package:
                                raise ValueError('Selected package no longer exists.')
                            same_package = existing and existing['package_id'] == package['id']
                            if package['status'] != 'Active' and not same_package:
                                raise ValueError('Select an active package.')
                            package_id = package['id']
                            fields['package'] = package['name']
                            fields['monthly_fee'] = existing['monthly_fee'] if same_package else package['monthly_price']
                        if not existing and (fields.get('installation_charge') is None or str(fields.get('installation_charge')).strip()==''):
                            fields['installation_charge']=package['installation_fee']
                        if existing:
                            installation_paid=db.execute("SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE customer_id=%s AND revenue_type='OTC' AND otc_type='Installation'",(rid,)).fetchone()['paid']
                            try:
                                proposed=Decimal(str(fields.get('installation_charge')))
                            except InvalidOperation:
                                raise ValueError('Enter a valid installation charge.')
                            if not proposed.is_finite() or proposed<installation_paid:
                                raise ValueError('Installation charge cannot be less than installation payments already received.')
                    if section == 'Packages' and rid:
                        existing_package = db.execute('SELECT * FROM packages WHERE id=%s FOR UPDATE', (rid,)).fetchone()
                        if existing_package and fields.get('name', '').strip() != existing_package['name']:
                            if db.execute('SELECT 1 FROM customers WHERE package_id=%s OR package=%s LIMIT 1', (rid, existing_package['name'])).fetchone():
                                raise ValueError('A package used by customers cannot be renamed. Create another package instead.')
                    if section=='Customers' and not rid and any(fields.get(c) is None or str(fields.get(c)).strip()=='' for c in ('latitude','longitude')):
                        raise ValueError('Latitude and longitude are required for a new customer connection.')
                    if section=='Staff':db.execute('SELECT pg_advisory_xact_lock(174392062)')
                    if section=='Staff' and rid:
                        previous_staff=db.execute('SELECT * FROM staff WHERE id=%s FOR UPDATE',(rid,)).fetchone()
                        if not previous_staff:raise ValueError('Employee no longer exists.')
                        for label,kind in STAFF_DETAILS:
                            if kind!='generated':fields.setdefault(column_name(label),previous_staff[column_name(label)])
                    if section=='Staff':
                        fields['employee_code']=previous_staff['employee_code'] if rid else ''
                        fields.setdefault('reports_to',previous_staff['reports_to'] if rid else None)
                        from crm_employee_hierarchy import validate_staff_hierarchy
                        validate_staff_hierarchy(db,fields,rid)
                    if section=='Designations':
                        from crm_employee_hierarchy import validate_designation
                        validate_designation(db,fields,rid)

                    if section=='Inventory' and not rid and not str(fields.get('batch') or '').strip():
                        fields['batch']=next_batch_number(db)
                    if section=='Inventory' and 'selling_price' not in fields:
                        fields['selling_price']=existing_item['selling_price'] if existing_item else fields.get('unit_cost',0)
                    if section=='Staff' and fields.get('email') and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',str(fields['email']).strip()):raise ValueError('Enter a valid employee email address.')
                    values = validate(section, fields)
                    if section=='TAT settings' and not 1<=int(fields['hours'])<=720:
                        raise ValueError('TAT must be between 1 and 720 whole hours.')
                    if section=='Customers' and existing and existing['status']!='Terminated' and fields.get('status')=='Terminated':
                        termination.terminate(db,existing['id'],user,fields.get('termination_reason') or 'Terminated from customer record.')
                    previous_ticket = None
                    if section == 'Tickets':
                        previous_ticket = db.execute('SELECT * FROM tickets WHERE id=%s FOR UPDATE', (rid,)).fetchone() if rid else None
                        if previous_ticket and previous_ticket['expiry_recovery_date'] and previous_ticket['status'] not in ('Resolved','Closed') and fields.get('status') in ('Resolved','Closed'):
                            raise ValueError('Expiry recovery tickets resolve automatically after successful recharge or return of all required equipment.')
                        if previous_ticket and (previous_ticket['recovery_id'] or previous_ticket['expiry_recovery_date']) and fields.get('status') in ('Resolved','Closed') and termination.pending_items(db,previous_ticket['customer_id']):
                            raise ValueError('Return all recovery-required equipment before resolving this ticket.')
                        if rid and not previous_ticket:
                            raise ValueError('Ticket no longer exists. Reload the page.')
                        ticket_values = dict(zip((column_name(label) for label, _ in SCHEMAS[section]), values))
                        if ticket_values['assigned_to'] is not None:
                            assignee = db.execute('SELECT * FROM staff WHERE id=%s FOR SHARE', (ticket_values['assigned_to'],)).fetchone()
                            if not assignee:
                                raise ValueError('Select an existing staff member for assignment.')
                            if assignee['status'] == 'On leave' and (not previous_ticket or previous_ticket['assigned_to'] != assignee['id']):
                                raise ValueError('This staff member is on leave. Select another person.')
                    if section == 'Packages' and fields.get('speed_mbps') is not None and int(fields['speed_mbps']) <= 0:
                        raise ValueError('Package speed must be greater than zero.')
                    columns = [column_name(label) for label, _ in record_fields(section)]
                    if section == 'Tickets':
                        columns.extend(['tat_hours','due_at'])
                        values.extend([tat_hours,ticket_due_at])
                    if section == 'Customers':
                        columns.append('package_id')
                        values.append(package_id)
                    if rid:
                        assignments = ', '.join(f'{c}=%s' for c in columns)
                        result = db.execute(f'UPDATE {table_name(section)} SET {assignments} WHERE id=%s', values + [rid])
                    else:
                        result = db.execute(f'INSERT INTO {table_name(section)} ({", ".join(columns)}) VALUES ({", ".join("%s" for _ in values)}) RETURNING id', values)
                if not result.rowcount:
                    raise ValueError('Record no longer exists. Reload the page.')
                saved_id = rid
                if not rid and payload.get('action') != 'delete':
                    saved_id = result.fetchone()['id']
                if section == 'Customers' and payload.get('action') != 'delete':
                    documents.store_documents(db, saved_id, user['id'], validated_documents)
                    if fields.get('status')=='Terminated':
                        termination.terminate(db,saved_id,user,fields.get('termination_reason') or 'Terminated from customer record.')
                if section == 'Tickets':
                    ticket_id = saved_id
                    db.execute('''UPDATE tickets SET updated_at=CURRENT_TIMESTAMP,
                        resolved_at=CASE WHEN status IN ('Resolved','Closed')
                        THEN COALESCE(resolved_at,CURRENT_TIMESTAMP) ELSE NULL END WHERE id=%s''', (ticket_id,))
                    changes = []
                    for label, _ in SCHEMAS['Tickets']:
                        key = column_name(label)
                        value = ticket_values[key]
                        if previous_ticket and str(previous_ticket[key]) == str(value):
                            continue
                        if key == 'assigned_to':
                            changes.append('Assigned to: ' + (assignee['name'] if value is not None else 'Unassigned'))
                        elif key in ('status', 'priority', 'type'):
                            changes.append(f'{label}: {value}')
                        else:
                            changes.append(f'{label} updated')
                    if not previous_ticket or previous_ticket['tat_hours'] != tat_hours:
                        changes.append(f'TAT: {tat_hours} hours; due {ticket_due_at.astimezone(ZoneInfo("Asia/Karachi")).strftime("%d %b %Y %H:%M")} PKT')
                    if changes or not rid:
                        message = ('Created. ' if not rid else '') + '; '.join(changes)
                        db.execute('INSERT INTO ticket_events (ticket_id,message) VALUES (%s,%s)', (ticket_id, user['name'] + ': ' + message))
                if section == 'Expenses' and rid:
                    db.execute('UPDATE expenses SET updated_at=CURRENT_TIMESTAMP WHERE id=%s', (rid,))
            self.send(200, {'ok': True, 'id': saved_id})
        except PermissionError as exc:
            self.send(403, {'error': str(exc)})
        except psycopg.IntegrityError:
            self.send(400, {'error': 'Usernames, package names, and category names must be unique. Linked records must exist; records in use cannot be deleted. Deactivate used categories instead.'})
        except (ValueError, TypeError) as exc:
            self.send(400, {'error': str(exc)})
        except psycopg.Error:
            self.send(500, {'error': 'Database operation failed. Please try again.'})
        finally:
            if db is not None:
                db.close()

    def read_json(self, limit=65536):
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= limit:
            raise ValueError('Invalid request size.')
        payload = json.loads(self.rfile.read(length))
        if not isinstance(payload, dict):
            raise ValueError('Invalid request.')
        return payload

    def documents_get(self, path):
        try:
            user = auth.current_session(self.headers)
            if not user:
                return self.send(401, {'error': 'Sign in to access customer documents.'})
            if not documents.permitted(user):
                return self.send(403, {'error': 'Only administrators, managers, and support can access customer documents.'})
            parts = path.strip('/').split('/')
            with connect_database() as db:
                if len(parts) == 4 and parts[1] == 'customers' and parts[3] == 'documents':
                    customer_id = int(parts[2])
                    if not db.execute('SELECT 1 FROM customers WHERE id=%s', (customer_id,)).fetchone():
                        return self.send(404, {'error': 'Customer does not exist.'})
                    rows = list(db.execute(f'SELECT {documents.METADATA} FROM customer_documents WHERE customer_id=%s ORDER BY id DESC', (customer_id,)))
                    return self.send(200, {'documents': rows})
                if len(parts) != 3 or parts[1] != 'customer-documents':
                    raise ValueError('Invalid document URL.')
                document_id = int(parts[2])
                document = db.execute('SELECT * FROM customer_documents WHERE id=%s', (document_id,)).fetchone()
                if not document:
                    return self.send(404, {'error': 'Document does not exist.'})
            disposition = "attachment; filename=customer-document; filename*=UTF-8''" + quote(document['original_name'], safe='')
            self.send(200, bytes(document['content']), 'application/octet-stream', headers={'Content-Disposition': disposition})
        except (ValueError, TypeError):
            self.send(400, {'error': 'Invalid document or customer ID.'})
        except psycopg.Error:
            self.send(503, {'error': 'Could not load customer documents.'})

    def terminate_post(self,user):
        if not auth.allowed(user,'Customers','write'):
            return self.send(403,{'error':'Your role cannot terminate customers.'})
        try:
            payload=self.read_json()
            if type(payload.get('customer_id')) is not int or payload['customer_id']<=0:
                raise ValueError('Select a valid customer.')
            with connect_database() as db:
                result=termination.terminate(db,payload['customer_id'],user,payload.get('reason'),payload.get('employee_id'))
            self.send(200,{'ok':True,'recovery':result})
        except PermissionError as exc:
            self.send(403,{'error':str(exc)})
        except (ValueError,TypeError) as exc:
            self.send(400,{'error':str(exc)})
        except psycopg.Error:
            self.send(503,{'error':'Could not terminate account. No changes were saved.'})

    def billing_quote_get(self, path):
        try:
            user = auth.current_session(self.headers)
            if not user:
                return self.send(401, {'error': 'Sign in to view billing.'})
            if not auth.allowed(user, 'Payments'):
                return self.send(403, {'error': 'Your role cannot view billing.'})
            customer_id = int(path.strip('/').split('/')[2])
            month = parse_qs(urlparse(self.path).query).get('month',[recharge.local_today().strftime('%Y-%m')])[0]
            if len(month)!=7 or date.fromisoformat(month+'-01').strftime('%Y-%m')!=month:
                raise ValueError('Invalid billing month.')
            with connect_database() as db:
                customer = db.execute('SELECT * FROM customers WHERE id=%s',(customer_id,)).fetchone()
                if not customer:
                    return self.send(404, {'error': 'Customer does not exist.'})
                invoice = db.execute('SELECT amount FROM invoices WHERE customer_id=%s AND billing_month=%s',(customer_id,month)).fetchone()
                charge = invoice['amount'] if invoice else 0 if customer['status']=='Terminated' else customer['monthly_fee']
                previous = billing.previous_balance(db,customer_id,month)
                paid = db.execute("SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE revenue_type='MRC' AND customer_id=%s AND billing_month=%s",(customer_id,month)).fetchone()['total']
                installation_paid=db.execute("SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE customer_id=%s AND revenue_type='OTC' AND otc_type='Installation'",(customer_id,)).fetchone()['paid']
                service_due=sum((s['due'] for s in customer_ledger.charges(db,customer_id) if s['service_date'].strftime('%Y-%m')<=month),Decimal(0))
            self.send(200, {'service_due':service_due,'installation_charge':customer['installation_charge'],'installation_paid':installation_paid,'installation_due':max(0,customer['installation_charge']-installation_paid),'charge': charge, 'previous_balance': previous, 'paid': paid, 'due': max(0,charge+previous-paid)})
        except (ValueError,TypeError,IndexError):
            self.send(400, {'error': 'Invalid billing request.'})
        except psycopg.Error:
            self.send(503, {'error': 'Could not load billing totals.'})

    def receipt_get(self, path):
        try:
            user = auth.current_session(self.headers)
            if not user:
                return self.send(401, {'error': 'Sign in to view payment receipts.'})
            if not auth.allowed(user, 'Payments'):
                return self.send(403, {'error': 'Your role cannot view financial receipts.'})
            parts = path.strip('/').split('/')
            if len(parts) != 3 or not parts[2].isdigit():
                raise ValueError('Invalid payment ID.')
            with connect_database() as db:
                receipt = db.execute('SELECT * FROM payment_receipts WHERE payment_record_id=%s', (int(parts[2]),)).fetchone()
            if not receipt:
                return self.send(404, {'error': 'Receipt does not exist.'})
            self.send(200, {'receipt': receipt})
        except (ValueError, TypeError):
            self.send(400, {'error': 'Invalid payment ID.'})
        except psycopg.Error:
            self.send(503, {'error': 'Could not load payment receipt.'})

    def incoming_payment_post(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 8192:
                raise ValueError('Invalid payment request size.')
            raw = self.rfile.read(length)
            provider, payment_id, fields = gateway.confirmed_receipt(self.headers, raw)
            with connect_database() as db:
                result = gateway.post_receipt(db, provider, payment_id, fields, validate)
            return self.send(200, result)
        except PermissionError as exc:
            return self.send(403, {'error': str(exc)})
        except RuntimeError as exc:
            return self.send(503, {'error': str(exc)})
        except (ValueError, TypeError, UnicodeError):
            return self.send(400, {'error': 'Invalid confirmed payment. Check customer ID, transaction ID, amount, paid status and payment time.'})
        except psycopg.Error:
            return self.send(503, {'error': 'Could not save payment. Retry with the same transaction ID.'})

    def customer_profile_get(self, path):
        try:
            user = auth.current_session(self.headers)
            if not user:
                return self.send(401, {'error': 'Sign in to view a customer profile.'})
            if not auth.allowed(user, 'Customers'):
                return self.send(403, {'error': 'Your role cannot view customer profiles.'})
            parts = path.strip('/').split('/')
            if len(parts) != 4:
                raise ValueError('Invalid customer URL.')
            customer_id = int(parts[2])
            with connect_database() as db:
                customer = db.execute('SELECT * FROM customers WHERE id=%s', (customer_id,)).fetchone()
                if not customer:
                    return self.send(404, {'error': 'Customer does not exist.'})
                records = auth.read_records(db, user)
                related = {section: [r for r in records[section] if r['customer_id'] == customer_id]
                           for section in ('Payments', 'Tickets', 'Jobs', 'Stock issues')}
                finance = auth.allowed(user, 'Payments')
                invoices = list(db.execute('''SELECT i.*,COALESCE(p.paid,0) AS paid FROM invoices i
                    LEFT JOIN (SELECT billing_month,SUM(amount) AS paid FROM payments WHERE revenue_type='MRC' AND customer_id=%s GROUP BY billing_month) p
                    ON p.billing_month=i.billing_month WHERE i.customer_id=%s ORDER BY i.billing_month DESC,i.id DESC''', (customer_id,customer_id))) if finance else []
                for invoice in invoices:
                    invoice['previous_balance'] = billing.previous_balance(db,customer_id,invoice['billing_month'])
                    services=customer_ledger.invoice_services(db,customer_id,invoice['billing_month'])
                    invoice['previous_balance']+=services['previous']
                    invoice['service_amount']=services['amount']
                    invoice['paid']+=services['paid']
                    invoice['total'] = invoice['amount'] + services['amount'] + invoice['previous_balance']
                document_rows = []
                if documents.permitted(user):
                    columns = ','.join('d.' + column for column in documents.METADATA.split(','))
                    document_rows = list(db.execute(f'''SELECT {columns},u.name AS uploaded_name FROM customer_documents d
                        LEFT JOIN app_users u ON u.id=d.uploaded_by WHERE d.customer_id=%s ORDER BY d.id DESC''', (customer_id,)))
                recharges = list(db.execute('SELECT * FROM customer_recharges WHERE customer_id=%s ORDER BY id DESC', (customer_id,))) if finance else []
                installation_paid=db.execute("SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE customer_id=%s AND revenue_type='OTC' AND otc_type='Installation'",(customer_id,)).fetchone()['paid'] if finance else None
                installation={'charge':customer['installation_charge'],'paid':installation_paid,'due':max(0,customer['installation_charge']-installation_paid)} if finance else None
                ledger=customer_ledger.ledger(db,customer) if finance else None
                services=customer_ledger.charges(db,customer_id) if finance else []
                costs = crm_costs.customer_costs(db,customer) if auth.allowed(user,'Expenses') else None
                ticket_ids = [t['id'] for t in related['Tickets']]
                events = list(db.execute('SELECT * FROM ticket_events WHERE ticket_id=ANY(%s) ORDER BY id DESC', (ticket_ids,))) if ticket_ids else []
            self.send(200, {'customer': customer, 'records': related, 'invoices': invoices, 'documents': document_rows,
                            'ledger':ledger,'services':services,'events': events, 'installation':installation, 'costs': costs, 'recharges': recharges, 'access': {'finance': finance, 'documents': documents.permitted(user),
                            'tickets': auth.allowed(user, 'Tickets'), 'hardware': auth.allowed(user, 'Stock issues'),
                            'costs': auth.allowed(user,'Expenses'), 'jobs': False}})
        except (ValueError, TypeError):
            self.send(400, {'error': 'Invalid customer ID.'})
        except psycopg.Error:
            self.send(503, {'error': 'Could not load customer profile.'})

    def documents_post(self, user):
        if not documents.permitted(user):
            return self.send(403, {'error': 'Your role cannot manage customer documents.'})
        try:
            payload = self.read_json(documents.MAX_REQUEST)
            with connect_database() as db:
                if payload.get('action') == 'delete':
                    document_id = payload.get('id')
                    if type(document_id) is not int or document_id <= 0:
                        raise ValueError('Invalid document ID.')
                    if not db.execute('DELETE FROM customer_documents WHERE id=%s', (document_id,)).rowcount:
                        return self.send(404, {'error': 'Document does not exist.'})
                else:
                    if payload.get('action') not in (None, 'upload'):
                        raise ValueError('Unknown document action.')
                    customer_id = payload.get('customer_id')
                    if type(customer_id) is not int or customer_id <= 0:
                        raise ValueError('Select a valid customer.')
                    uploads = documents.validate_uploads(payload.get('documents', []))
                    if not uploads:
                        raise ValueError('Choose at least one document.')
                    if not db.execute('SELECT 1 FROM customers WHERE id=%s FOR KEY SHARE', (customer_id,)).fetchone():
                        return self.send(404, {'error': 'Customer does not exist.'})
                    documents.store_documents(db, customer_id, user['id'], uploads)
            self.send(200, {'ok': True})
        except (ValueError, TypeError) as exc:
            self.send(400, {'error': str(exc)})
        except psycopg.Error:
            self.send(503, {'error': 'Could not save customer documents.'})

    def invoice_post(self, user):
        if user['role'] not in ('Administrator', 'Manager', 'Accountant', 'Support'):
            return self.send(403, {'error': 'Your role cannot create customer invoices.'})
        try:
            payload = self.read_json()
            customer_id, month = payload.get('customer_id'), str(payload.get('billing_month', ''))
            if type(customer_id) is not int or customer_id <= 0:
                raise ValueError('Select a valid customer.')
            if len(month) != 7 or date.fromisoformat(month + '-01').strftime('%Y-%m') != month:
                raise ValueError('Select a billing month in YYYY-MM format.')
            today = datetime.now(ZoneInfo('Asia/Karachi')).date()
            with connect_database() as db:
                customer = db.execute('SELECT * FROM customers WHERE id=%s FOR UPDATE', (customer_id,)).fetchone()
                if not customer:
                    return self.send(404, {'error': 'Customer does not exist.'})
                invoice = billing.ensure_invoice(db,customer,month,today)
            self.send(200, {'id': invoice['id']})
        except (ValueError, TypeError) as exc:
            self.send(400, {'error': str(exc)})
        except psycopg.Error:
            self.send(503, {'error': 'Could not save this invoice.'})

    def invoice_get(self, path):
        try:
            user = auth.current_session(self.headers)
            if not user:
                return self.send(401, {'error': 'Sign in to the CRM, then reopen this invoice.'})
            if not (auth.allowed(user, 'Customers') and auth.allowed(user, 'Payments')):
                # Support can generate invoices for the customers they manage.
                if user['role'] != 'Support':
                    return self.send(403, {'error': 'Your role cannot view invoices.'})
            invoice_id = int(path.rsplit('/', 1)[-1])
            with connect_database() as db:
                invoice = db.execute('SELECT * FROM invoices WHERE id=%s', (invoice_id,)).fetchone()
                if not invoice:
                    return self.send(404, {'error': 'Invoice does not exist.'})
                paid = db.execute("SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE revenue_type='MRC' AND customer_id=%s AND billing_month=%s",
                                  (invoice['customer_id'], invoice['billing_month'])).fetchone()['total']
                previous = billing.previous_balance(db,invoice['customer_id'],invoice['billing_month'])
                services=customer_ledger.invoice_services(db,invoice['customer_id'],invoice['billing_month'])
                previous+=services['previous']
                paid+=services['paid']
                total = invoice['amount'] + services['amount'] + previous
            self.send(200, {'invoice': invoice, 'services':services, 'previous_balance': previous, 'total': total, 'paid': paid, 'balance': max(Decimal(0), total - paid),
                            'credit': max(Decimal(0), paid - total)})
        except (ValueError, TypeError):
            self.send(400, {'error': 'Invalid invoice ID.'})
        except psycopg.Error:
            self.send(503, {'error': 'Could not load this invoice.'})

    def auth_post(self, path):
        try:
            origin = self.headers.get('Origin')
            if origin and urlparse(origin).netloc != self.headers.get('Host'):
                return self.send(403, {'error': 'Use this CRM page to sign in.'})
            user = auth.current_session(self.headers)
            expected = TOKEN if path in ('/api/auth/login', '/api/auth/setup', '/api/auth/forgot-password', '/api/auth/reset-password') else user['csrf'] if user else None
            if not expected or self.headers.get('X-CRM-Token') != expected:
                return self.send(403, {'error': 'Reload the page and try again.'})
            payload = self.read_json()
            if path in ('/api/auth/forgot-password','/api/auth/reset-password'):
                import crm_password_recovery as recovery
                with connect_database() as db:
                    if path.endswith('/forgot-password'):
                        message=recovery.request(db,payload.get('email',''),self.client_address[0])
                    else:
                        recovery.reset(db,payload.get('token',''),payload.get('password',''),self.client_address[0])
                        message='Password reset. Sign in with your new password.'
                return self.send(200,{'ok':True,'message':message})
            if path == '/api/auth/setup':
                with connect_database() as db:
                    created = auth.save_user(db, dict(payload, role='Administrator', status='Active', designation='Owner', staff_id=None), setup=True)
                    cookie, csrf = auth.new_session(db, created['id'])
                return self.send(200, {'ok': True, 'token': csrf}, headers={'Set-Cookie': cookie})
            if path == '/api/auth/login':
                _, cookie, csrf = auth.login(payload.get('username', ''), payload.get('password', ''), self.client_address[0])
                return self.send(200, {'ok': True, 'token': csrf}, headers={'Set-Cookie': cookie})
            if not user:
                return self.send(401, {'error': 'Sign in again.'})
            if path == '/api/auth/logout':
                with connect_database() as db:
                    db.execute('DELETE FROM app_sessions WHERE token_hash=%s', (hashlib.sha256(auth.cookie_token(self.headers).encode()).hexdigest(),))
                return self.send(200, {'ok': True}, headers={'Set-Cookie': f'{auth.COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'})
            if path == '/api/auth/password':
                if not auth.verify_password(payload.get('current_password', ''), user['password_hash']):
                    raise ValueError('Current password is incorrect.')
                password_hash = auth.hash_password(payload.get('new_password', ''))
                with connect_database() as db:
                    db.execute('UPDATE app_users SET password_hash=%s WHERE id=%s', (password_hash, user['id']))
                    db.execute('DELETE FROM app_sessions WHERE user_id=%s', (user['id'],))
                    db.execute('DELETE FROM password_resets WHERE user_id=%s', (user['id'],))
                return self.send(200, {'ok': True}, headers={'Set-Cookie': f'{auth.COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'})
            self.send(404, {'error': 'Not found'})
        except psycopg.IntegrityError:
            self.send(400, {'error': 'Username or employee account already exists.'})
        except (ValueError, TypeError) as exc:
            self.send(400, {'error': str(exc)})
        except psycopg.Error:
            self.send(503, {'error': 'Database operation failed.'})

    def users_post(self, user):
        if not auth.allowed(user, 'Users', 'write'):
            return self.send(403, {'error': 'Only administrators can manage user accounts.'})
        try:
            payload = self.read_json()
            if payload.get('action') not in (None, 'save'):
                raise ValueError('Deactivate users instead of deleting their accounts.')
            fields, rid = payload.get('fields'), payload.get('id')
            if not isinstance(fields, dict) or (rid is not None and (type(rid) is not int or rid <= 0)):
                raise ValueError('Invalid account details.')
            with connect_database() as db:
                auth.save_user(db, fields, rid)
            self.send(200, {'ok': True})
        except psycopg.IntegrityError:
            self.send(400, {'error': 'This username or employee is already linked to an account.'})
        except (ValueError, TypeError) as exc:
            self.send(400, {'error': str(exc)})
        except psycopg.Error:
            self.send(503, {'error': 'Database operation failed.'})

    def customer_services_post(self,user):
        if not auth.allowed(user,'Payments','write'):return self.send(403,{'error':'Your role cannot add service charges.'})
        try:
            payload=self.read_json()
            if not isinstance(payload,dict):raise ValueError('Invalid service details.')
            with connect_database() as db:service=customer_ledger.add_charge(db,payload,user)
            self.send(200,{'ok':True,'service':service})
        except (ValueError,TypeError) as exc:self.send(400,{'error':str(exc)})
        except psycopg.Error:self.send(503,{'error':'Could not save service charge.'})

    def customer_app_get(self,path):
        try:
            with connect_database() as db:
                session=customer_portal.session(db,self.headers)
                if not session:return self.send(401,{'error':'Sign in to your customer account.'})
                if path!='/api/customer-app/state':return self.send(404,{'error':'Not found.'})
                data={} if session['must_change'] else customer_portal.dashboard(db,session['customer_id'])
                if not session['must_change']:data['operations']=operations.customer_state(db,session['customer_id'])
            self.send(200,dict(data,csrf=session['csrf'],must_change=session['must_change']))
        except psycopg.Error:
            logging.exception('Customer portal database failure')
            self.send(503,{'error':'Customer portal unavailable.'})

    def customer_app_post(self,path):
        try:
            origin=self.headers.get('Origin')
            if origin and urlparse(origin).netloc!=self.headers.get('Host'):
                return self.send(403,{'error':'Cross-site requests are not allowed.'})
            payload=self.read_json()
            if not isinstance(payload,dict):raise ValueError('Invalid request.')
            with connect_database() as db:
                if path=='/api/customer-app/login':
                    # Reuse the bounded, thread-safe login throttle, with a separate key prefix.
                    key='customer:'+self.client_address[0]
                    auth.check_attempts(key)
                    row=db.execute('SELECT a.*,c.payment_id FROM customer_portal_accounts a JOIN customers c ON c.id=a.customer_id WHERE c.payment_id=%s AND a.enabled',(str(payload.get('payment_id','')),)).fetchone()
                    if not row or not auth.verify_password(payload.get('password',''),row['password_hash']):
                        auth.failed_attempt(key)
                        return self.send(400,{'error':'Invalid customer ID or password.'})
                    token=secrets.token_urlsafe(32);csrf=secrets.token_urlsafe(32)
                    db.execute("INSERT INTO customer_portal_sessions(token_hash,customer_id,csrf,expires_at) VALUES (%s,%s,%s,CURRENT_TIMESTAMP+INTERVAL '8 hours')",(hashlib.sha256(token.encode()).hexdigest(),row['customer_id'],csrf))
                    db.commit()
                    return self.send(200,{'ok':True},headers={'Set-Cookie':customer_portal.cookie(token,secure=self.headers.get('X-Forwarded-Proto')=='https')})
                session=customer_portal.session(db,self.headers)
                if not session:return self.send(401,{'error':'Sign in again.'})
                if self.headers.get('X-Customer-Token')!=session['csrf']:return self.send(403,{'error':'Refresh before saving.'})
                cid=session['customer_id']
                if path=='/api/customer-app/logout':
                    db.execute('DELETE FROM customer_portal_sessions WHERE token_hash=%s',(session['token_hash'],))
                elif path=='/api/customer-app/password':
                    account=db.execute('SELECT * FROM customer_portal_accounts WHERE customer_id=%s FOR UPDATE',(cid,)).fetchone()
                    if not auth.verify_password(payload.get('current_password',''),account['password_hash']):raise ValueError('Current password is incorrect.')
                    db.execute('UPDATE customer_portal_accounts SET password_hash=%s,must_change=FALSE WHERE customer_id=%s',(auth.hash_password(payload.get('new_password','')),cid))
                    db.execute('DELETE FROM customer_portal_sessions WHERE customer_id=%s AND token_hash!=%s',(cid,session['token_hash']))
                elif session['must_change']:return self.send(403,{'error':'Change your temporary password first.'})
                elif path=='/api/customer-app/request':
                    result=operations.customer_request(db,cid,payload)
                    db.commit()
                    return self.send(200,result)
                elif path=='/api/customer-app/message':
                    result=operations.customer_message(db,cid,payload)
                    db.commit()
                    return self.send(200,result)
                elif path=='/api/customer-app/read':
                    db.execute('UPDATE customer_notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE id=%s AND customer_id=%s',(payload.get('id'),cid))
                else:return self.send(404,{'error':'Not found.'})
            self.send(200,{'ok':True},headers={'Set-Cookie':customer_portal.cookie('',True)} if path.endswith('/logout') else None)
        except (ValueError,TypeError) as exc:self.send(400,{'error':str(exc)})
        except psycopg.Error:self.send(503,{'error':'Could not update customer portal.'})

    def customer_portal_staff_post(self,path,user):
        if not auth.allowed(user,'Customers','write'):return self.send(403,{'error':'Your role cannot manage customer portal access.'})
        try:
            payload=self.read_json()
            if not isinstance(payload,dict):raise ValueError('Invalid customer portal request.')
            cid=payload.get('customer_id')
            with connect_database() as db:
                if path.endswith('/access'):
                    password=customer_portal.provision(db,cid)
                    result={'ok':True,'temporary_password':password}
                else:
                    title=str(payload.get('title','')).strip();body=str(payload.get('body','')).strip()
                    if not title or len(title)>150 or not body or len(body)>2000:raise ValueError('Enter a title (up to 150) and message (up to 2000 characters).')
                    if type(cid) is not int or not db.execute('SELECT 1 FROM customers WHERE id=%s',(cid,)).fetchone():raise ValueError('Customer not found.')
                    customer_portal.notify(db,cid,title,body,secrets.token_hex(16));result={'ok':True}
            self.send(200,result)
        except (ValueError,TypeError) as exc:self.send(400,{'error':str(exc)})
        except psycopg.Error:self.send(503,{'error':'Could not save customer portal settings.'})

    def inventory_qr_get(self):
        try:
            user=auth.current_session(self.headers)
            if not user:return self.send(401,{'error':'Sign in to scan inventory.'})
            if not auth.allowed(user,'Inventory'):return self.send(403,{'error':'Your role cannot view inventory QR records.'})
            params=parse_qs(urlparse(self.path).query)
            with connect_database() as db:
                if 'stocktake' in params:
                    return self.send(200,inventory_qr.stocktake_report(db,int(params['stocktake'][0]) if params['stocktake'][0] else None))
                if 'code' not in params:
                    return self.send(200,{'units':list(db.execute('SELECT u.*,i.item FROM inventory_units u JOIN inventory i ON i.id=u.inventory_id ORDER BY u.id DESC'))})
                data=inventory_qr.lookup(db,params.get('code',[''])[0])
            if params.get('label')==['1']:
                import qrcode
                import qrcode.image.svg
                qr=qrcode.make(data['unit']['qr_code'],image_factory=qrcode.image.svg.SvgPathImage)
                import io
                output=io.BytesIO();qr.save(output)
                raw=output.getvalue();self.send_response(200);self.send_header('Content-Type','image/svg+xml');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
                return
            self.send(200,data)
        except ValueError as exc:self.send(400,{'error':str(exc)})
        except psycopg.Error:self.send(503,{'error':'Could not load inventory QR.'})

    def inventory_qr_post(self,user):
        if not auth.allowed(user,'Inventory','write'):return self.send(403,{'error':'Your role cannot register stock.'})
        try:
            payload=self.read_json()
            if not isinstance(payload,dict):raise ValueError('Invalid QR registration details.')
            with connect_database() as db:
                if payload.get('action')=='condition':
                    inventory_qr.set_condition(db,payload,user)
                    db.commit()
                    return self.send(200,{'ok':True})
                if payload.get('action') in ('start_stocktake','scan_stocktake','close_stocktake'):
                    rid=inventory_qr.stocktake(db,payload,user)
                    db.commit()
                    return self.send(200,{'ok':True,'stocktake_id':rid})
                unit=inventory_qr.register(db,payload,user)
            self.send(200,{'ok':True,'unit':unit})
        except (ValueError,TypeError) as exc:self.send(400,{'error':str(exc)})
        except psycopg.IntegrityError:self.send(400,{'error':'This serial number is already registered for this inventory item.'})
        except psycopg.Error:self.send(503,{'error':'Could not register inventory QR.'})

    def delete_stock_issue(self, db, rid, user):
        """Administrators may remove an issue entry; stock still out is returned and its unpaid charge removed."""
        if not user or user['role'] != 'Administrator':
            raise PermissionError('Only an administrator can delete stock issue entries.')
        issue = db.execute('SELECT * FROM stock_issues WHERE id=%s FOR UPDATE', (rid,)).fetchone()
        if not issue:
            raise ValueError('Issue record does not exist.')
        charge = db.execute('SELECT * FROM customer_service_charges WHERE stock_issue_id=%s FOR UPDATE', (rid,)).fetchone()
        if charge and db.execute('SELECT 1 FROM payments WHERE service_charge_id=%s LIMIT 1', (charge['id'],)).fetchone():
            raise ValueError('The customer has already paid for this item. Keep the issue, or refund the payment first.')
        if issue['status'] == 'Issued':
            db.execute('UPDATE inventory SET quantity=quantity+%s WHERE id=%s', (issue['quantity'], issue['inventory_id']))
            inventory_qr.returned(db, rid, user)
        if charge:
            db.execute('DELETE FROM customer_service_charges WHERE id=%s', (charge['id'],))
        # Device history stays; it just no longer points at the deleted issue.
        db.execute('UPDATE inventory_movements SET issue_id=NULL WHERE issue_id=%s', (rid,))
        db.execute('UPDATE inventory_units SET issue_id=NULL WHERE issue_id=%s', (rid,))
        db.execute('DELETE FROM stock_issues WHERE id=%s', (rid,))
        if issue['customer_id']:
            termination.refresh_recovery(db, issue['customer_id'])

    def save_stock_issue(self, db, payload, rid, user=None):
        if payload.get('action') == 'return':
            original = db.execute('SELECT customer_id FROM stock_issues WHERE id=%s',(rid,)).fetchone()
            if original and original['customer_id']:
                db.execute('SELECT id FROM customers WHERE id=%s FOR UPDATE',(original['customer_id'],))
            issue = db.execute('SELECT * FROM stock_issues WHERE id=%s FOR UPDATE', (rid,)).fetchone()
            if not issue:
                raise ValueError('Issue record does not exist.')
            if issue['status'] == 'Returned':
                return
            db.execute('UPDATE inventory SET quantity=quantity+%s WHERE id=%s', (issue['quantity'], issue['inventory_id']))
            db.execute("UPDATE stock_issues SET status='Returned', returned_at=CURRENT_TIMESTAMP WHERE id=%s", (rid,))
            inventory_qr.returned(db,rid,user or {'name':'System'})
            if issue['customer_id']:
                termination.refresh_recovery(db,issue['customer_id'])
            return
        if payload.get('action') == 'delete':
            return self.delete_stock_issue(db, rid, user)
        if rid:
            raise ValueError('Issue records cannot be edited. Return the stock, then create a corrected issue.')
        fields = payload.get('fields', {})
        if not isinstance(fields, dict):
            raise ValueError('Invalid issue fields.')
        fields=dict(fields)
        if fields.get('qr_code'):fields['qr_code']=inventory_qr.code(fields['qr_code'])
        values = validate('Stock issues', fields)
        issue = dict(zip((column_name(label) for label, _ in SCHEMAS['Stock issues']), values))
        request_key = payload.get('request_key')
        if not isinstance(request_key, str) or not 1 <= len(request_key) <= 100:
            raise ValueError('Missing issue request key. Reload the form and try again.')
        # Serialize retries of the same request, including requests on different stock items.
        db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (request_key,))
        previous = db.execute('SELECT * FROM stock_issues WHERE request_key=%s', (request_key,)).fetchone()
        if previous:
            tracked=db.execute("SELECT u.qr_code FROM inventory_movements m JOIN inventory_units u ON u.id=m.unit_id WHERE m.issue_id=%s AND m.action='Issued'",(previous['id'],)).fetchone()
            if (tracked['qr_code'] if tracked else None)!=(fields.get('qr_code') or None):raise ValueError('This request was already used for a different QR device.')
            if previous['issued_against']=='Customer':
                stock=db.execute('SELECT * FROM inventory WHERE id=%s',(previous['inventory_id'],)).fetchone()
                if stock_issue_price(fields,stock)[0]!=previous['unit_selling_price']:raise ValueError('This issue request was already used with a different selling price.')
            if any(str(previous[key]) != str(value) for key, value in issue.items() if key != 'status'):
                raise ValueError('This issue request was already saved with different details. Open a new form.')
            return
        if issue['customer_id']:
            customer=db.execute('SELECT * FROM customers WHERE id=%s FOR UPDATE',(issue['customer_id'],)).fetchone()
            if customer and customer['status']=='Terminated':
                raise ValueError('Cannot issue new stock to a terminated account.')
        stock = db.execute('SELECT * FROM inventory WHERE id=%s FOR UPDATE', (issue['inventory_id'],)).fetchone()
        if not stock:
            raise ValueError('Select an existing inventory item.')
        qr=fields.get('qr_code')
        unit=inventory_qr.issue_unit(db,qr,issue['inventory_id']) if qr else None
        if unit and issue['quantity']!=1:raise ValueError('Each device QR can issue exactly one unit.')
        if not unit and issue['quantity']>stock['quantity']-inventory_qr.available(db,issue['inventory_id']):
            raise ValueError('This stock includes QR-registered devices. Scan their labels to issue them individually.')
        if issue['quantity'] > stock['quantity']:
            raise ValueError(f'Insufficient stock. Only {stock["quantity"]} available.')
        if issue['issued_against']=='Customer':
            issue['unit_selling_price'],issue['list_price'],issue['discount_percent'],issue['waived']=stock_issue_price(fields,stock)
        else:issue['unit_selling_price']=None
        issue['unit_cost_at_issue'] = stock['unit_cost']
        issue['cost_estimated'] = False
        issue.update(device_scan.device_fields(fields))
        photo = device_scan.decode_photo(fields['device_photo']) if fields.get('device_photo') else None
        columns = ', '.join(issue) + ', request_key'
        placeholders = ', '.join('%s' for _ in range(len(issue) + 1))
        saved_issue=db.execute(f'INSERT INTO stock_issues ({columns}) VALUES ({placeholders}) RETURNING id', list(issue.values()) + [request_key]).fetchone()['id']
        if photo:
            db.execute('INSERT INTO stock_issue_photos(issue_id,photo,media_type) VALUES (%s,%s,%s)', (saved_issue, photo[0], photo[1]))
        customer_ledger.bill_stock_issue(db,saved_issue,issue,stock,user or {'name':'System'},customer if issue['customer_id'] else None,recharge.local_today())
        if unit:inventory_qr.issued(db,unit,saved_issue,user or {'name':'System'})
        db.execute('UPDATE inventory SET quantity=quantity-%s WHERE id=%s', (issue['quantity'], issue['inventory_id']))


def stock_issue_price(fields, stock):
    """Return (unit price charged, list price, discount %, waived) for stock issued to a customer."""
    mode = fields.get('charge_mode') or 'Charge'
    if mode not in ('Charge', 'Discount', 'Waived'):
        raise ValueError('Choose how to charge the customer.')
    raw = fields.get('unit_selling_price')
    try:
        base = Decimal(str(raw)) if raw not in (None, '') else (stock['selling_price'] or stock['unit_cost'] or Decimal(0))
    except InvalidOperation:
        raise ValueError('Enter a valid unit selling price.')
    if not base.is_finite() or not 0 <= base <= 1000000000 or base != base.quantize(Decimal('.01')):
        raise ValueError('Enter a valid unit selling price with at most two decimal places.')
    if mode == 'Waived':
        return Decimal('0.00'), base, Decimal(100), True
    discount = Decimal(0)
    if mode == 'Discount':
        try:
            discount = Decimal(str(fields.get('discount_percent') or 0))
        except InvalidOperation:
            raise ValueError('Enter a valid discount percentage.')
        if not discount.is_finite() or not 0 < discount < 100 or discount != discount.quantize(Decimal('.01')):
            raise ValueError('Discount must be more than 0% and less than 100%. Choose Waive off for a free item.')
    price = (base * (100 - discount) / 100).quantize(Decimal('.01'))
    if price <= 0:
        raise ValueError('This item has no selling price. Enter the price, or choose Waive off.')
    return price, base, discount, False


def expiry_recovery_worker(stop):
    while not stop.is_set():
        try:
            with connect_database() as db:
                operations.run_due_schedules(db)
                operations.generate_mac_tariffs(db)
                termination.generate_expiry_recovery(db)
                billing.generate_monthly_invoices(db)
        except Exception:
            logging.exception('Automatic expiry recovery check failed; retrying in one minute.')
        stop.wait(60)


if __name__ == '__main__':
    try:
        initialize_database()
    except (psycopg.Error, OSError, ValueError):
        raise SystemExit('Cannot initialize PostgreSQL. Check the service and database.local.json connection settings.')
    server = ThreadingHTTPServer(('127.0.0.1', 3000), Handler)
    print('ISP CRM: http://localhost:3000 — press Ctrl+C to stop.', flush=True)
    recovery_stop=threading.Event()
    recovery_worker=threading.Thread(target=expiry_recovery_worker,args=(recovery_stop,),daemon=True)
    recovery_worker.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        recovery_stop.set()
        recovery_worker.join(timeout=5)
        server.server_close()
