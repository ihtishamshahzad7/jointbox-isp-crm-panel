"""PostgreSQL storage and shared record definitions for ISP CRM."""
import json
import os
from pathlib import Path
import psycopg
from psycopg import sql
from psycopg.rows import dict_row


CONFIG = Path(__file__).with_name('database.local.json')
INVENTORY_CATEGORIES = [
    'ONT', 'ONU', 'OLT', 'Router', 'Switch', 'SFP / SFP+ Module',
    'Fiber - 2 Core', 'Fiber - 4 Core', 'Fiber - 6 Core',
    'Fiber - 8 Core', 'Fiber - 12 Core', 'Fiber - 24 Core',
    'Fiber - 48 Core', 'Fiber - 96 Core', 'Fiber Drop Cable',
    'Splitter - 1:2', 'Splitter - 1:4', 'Splitter - 1:8',
    'Splitter - 1:16', 'Splitter - 1:32', 'Splitter - 1:64',
    'Fiber Joint Closure', 'Joint Box', 'Splice Tray', 'Splice Protection Sleeve',
    'Fiber Distribution Box (FDB)', 'Optical Distribution Frame (ODF)',
    'Fiber Patch Cord', 'Fiber Pigtail', 'Fast Connector', 'Fiber Adapter / Coupler',
    'Ethernet Cable - Cat5e', 'Ethernet Cable - Cat6', 'RJ45 Connector',
    'Media Converter', 'PoE Injector', 'Power Adapter', 'UPS', 'Battery',
    'Network Rack', 'Patch Panel', 'Cable Clamp', 'Cable Tie',
    'Splicing Machine', 'Fiber Cleaver', 'Optical Power Meter', 'VFL', 'OTDR',
    'Tools', 'Other',
    # Keep the original values so existing records can still be edited.
    'ONU / ONT', 'Cable',
]
SCHEMAS = {
    'Customers': [('Name', 'text'), ('Customer type', ['Residential', 'Business', 'Corporate']),
                  ('Email', 'optionaltext'), ('CNIC', 'optionaltext'), ('Phone', 'text'),
                  ('Telephone', 'optionaltext'), ('Passport', 'optionaltext'), ('NTN', 'optionaltext'), ('Address', 'text'), ('City', 'optionaltext'), ('Area', 'optionaltext'), ('Latitude', 'latitude'), ('Longitude', 'longitude'),
                  ('Username', 'text'), ('Recovery status', 'generated'), ('Payment ID', 'generated'), ('Package', 'package'), ('Monthly fee', 'money'), ('Installation charge', 'money'),
                  ('Status', ['Active', 'Suspended', 'Disconnected', 'Terminated']), ('Joined', 'date'), ('Expiry date', 'date'), ('Promise date', 'optionaldate')],
    'Inventory': [('Item', 'text'), ('Category', 'category'), ('Batch', 'optionaltext'),
                  ('Quantity', 'integer'), ('Minimum stock', 'integer'), ('Unit cost', 'money'),
                  ('Location', 'text'), ('Selling price','money')],
    'Staff': [('Name', 'text'), ('Phone', 'text'),
              ('Role', ['Technician', 'Support', 'Collector', 'Manager', 'Other']),
              ('Area', 'text'), ('Status', ['Available', 'On duty', 'On leave'])],
    'Jobs': [('Title', 'text'), ('Customer ID', 'customer'), ('Staff ID', 'staff'),
             ('Type', ['Installation', 'Complaint', 'Maintenance', 'Collection']),
             ('Status', ['Open', 'In progress', 'Completed']), ('Due date', 'date'), ('Notes', 'text')],
    'Tickets': [('Subject', 'text'), ('Customer ID', 'customer'),
                ('Assigned to', 'assignee'),
                ('Type', ['Network outage', 'Slow speed', 'Billing', 'Installation', 'Complaint', 'Maintenance', 'Collection', 'Equipment recovery', 'Equipment', 'Other']),
                ('Priority', ['Normal', 'Low', 'High', 'Urgent']),
                ('Status', ['Open', 'In progress', 'Awaiting customer', 'Resolved', 'Closed']),
                ('Due date', 'date'), ('Description', 'longtext'), ('Resolution notes', 'longtext')],
    'Payments': [('Revenue type', ['MRC', 'OTC']), ('OTC type', ['Other', 'Installation', 'Equipment', 'Service']), ('Customer ID', 'customer'), ('Amount', 'money'), ('Payment date', 'date'),
                 ('Billing month', 'month'), ('Method', ['Cash', 'Card', 'Bank transfer', 'Mobile wallet', '1LINK', 'Easypaisa', 'JazzCash']),
                 ('Reference', 'text')],
    'Expenses': [('Customer ID', 'optionalcustomer'), ('Title', 'text'),
                 ('Category', ['Bandwidth / Upstream', 'Fiber lease / Backhaul',
                               'Tower / Pole rent', 'POP / Site rent', 'Data center / Colocation',
                               'Staff salaries', 'Overtime / Bonuses', 'Employee benefits',
                               'Training / Recruitment', 'Office rent', 'Electricity',
                               'Generator fuel', 'Generator maintenance', 'Fuel / Transport',
                               'Vehicle maintenance', 'Equipment purchase', 'Fiber / Cable',
                               'Installation labor', 'Civil works / Trenching',
                               'Tools / Safety equipment', 'Repairs / Maintenance',
                               'Software / Licenses', 'Cloud / Hosting', 'SMS / Communications',
                               'Marketing', 'Office supplies / Printing', 'Bank / Payment charges',
                               'Professional services', 'Insurance', 'Taxes / Regulatory fees',
                               'Other']),
                 ('Payee', 'text'), ('Amount', 'money'), ('Expense date', 'date'),
                 ('Status', ['Paid', 'Pending', 'Cancelled']),
                 ('Method', ['Cash', 'Bank transfer', 'Mobile wallet']),
                 ('Payment date', 'optionaldate'), ('Reference', 'text'), ('Notes', 'longtext')],
    'Packages': [('Name', 'text'), ('Service provider', ['Transworld Panel', 'Nayatel bandwidth', 'Transworld Bandwidth']), ('Speed Mbps', 'integer'),
                 ('Monthly price', 'money'), ('Monthly cost', 'money'), ('Installation fee', 'money'),
                 ('Status', ['Active', 'Inactive'])],
    'Categories': [('Name', 'text'), ('Status', ['Active', 'Inactive'])],
    'Equipment recovery': [('Customer ID', 'customer'), ('Terminated on', 'date'), ('Monthly revenue loss', 'money'),
                           ('Status', ['Equipment recovery pending', 'Recovered', 'No equipment to recover']),
                           ('Employee ID', 'optionalstaff'), ('Reason', 'longtext')],
    'Stock issues': [('Inventory ID', 'inventory'), ('Issued against', ['Customer', 'System', 'Network']),
                     ('Customer ID', 'optionalcustomer'), ('Destination', 'text'),
                     ('Employee ID', 'optionalstaff'), ('Quantity', 'integer'),
                     ('Recovery required', ['Yes', 'No']), ('Issue date', 'date'), ('Status', ['Issued', 'Returned']), ('Notes', 'longtext')],
}

STAFF_DETAILS=[('Employee code','optionaltext'),('Father name','optionaltext'),('CNIC','optionaltext'),('Date of birth','optionaldate'),('Gender',['Not specified','Male','Female','Other']),('Email','optionaltext'),('Alternate phone','optionaltext'),('Address','optionaltext'),('Emergency contact name','optionaltext'),('Emergency contact phone','optionaltext'),('Emergency relationship','optionaltext'),('Designation','optionaltext'),('Department','optionaltext'),('Employment type',['Permanent','Contract','Part time','Intern']),('Joining date','optionaldate'),('Monthly salary','money'),('Allowances','money'),('Deductions','money'),('Net salary','generated'),('Bank name','optionaltext'),('Account title','optionaltext'),('Account number','optionaltext'),('IBAN','optionaltext'),('Notes','optionaltext')]
SCHEMAS['Designations']=[('Name','text'),('Status',['Active','Inactive'])]
SCHEMAS['Staff']+=STAFF_DETAILS+[('Reports to','optionalstaff')]
STAFF_PRIVATE={label.lower().replace(' ','_') for label,_ in STAFF_DETAILS if label not in ('Designation','Department','Employment type')}

SCHEMAS['TAT settings']=[('Ticket type',dict(SCHEMAS['Tickets'])['Type']),('Priority',dict(SCHEMAS['Tickets'])['Priority']),('Hours','integer')]

def table_name(section):
    return section.lower().replace(' ', '_')


def column_name(label):
    return label.lower().replace(' ', '_')


def record_fields(section):
    return [(label, kind) for label, kind in SCHEMAS[section] if kind != 'generated']


def database_settings():
    settings = {'host': 'localhost', 'port': 5432, 'user': 'postgres', 'dbname': 'ispcrm'}
    if CONFIG.exists():
        settings.update(json.loads(CONFIG.read_text(encoding='utf-8')))
    for field, env in [('host', 'PGHOST'), ('port', 'PGPORT'), ('user', 'PGUSER'),
                       ('password', 'PGPASSWORD'), ('dbname', 'PGDATABASE')]:
        if env in os.environ:
            settings[field] = os.environ[env]
    settings['connect_timeout'] = 5
    return settings


def connect_database():
    return psycopg.connect(**database_settings(), row_factory=dict_row)


def initialize_database():
    """Create the configured database if absent, then prepare the CRM tables."""
    settings = database_settings()
    target = settings['dbname']
    admin = dict(settings, dbname='postgres')
    with psycopg.connect(**admin, autocommit=True) as connection:
        if not connection.execute('SELECT 1 FROM pg_database WHERE datname=%s', (target,)).fetchone():
            try:
                connection.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(target)))
            except psycopg.errors.DuplicateDatabase:
                pass
    with connect_database() as connection:
        first_categories = connection.execute("SELECT to_regclass('categories') AS existing").fetchone()['existing'] is None
        first_designations = connection.execute("SELECT to_regclass('designations') AS existing").fetchone()['existing'] is None
        first_tat_settings = connection.execute("SELECT to_regclass('tat_settings') AS existing").fetchone()['existing'] is None
        for section in SCHEMAS:
            fields = record_fields(section)
            columns = ['id BIGSERIAL PRIMARY KEY']
            for label, kind in fields:
                column = column_name(label)
                sql_type = ('BIGINT' if kind in ('integer', 'customer', 'staff', 'assignee', 'inventory', 'optionalcustomer', 'optionalstaff') else
                            'NUMERIC(10,7)' if kind in ('latitude','longitude') else
                            'NUMERIC(15,2)' if kind == 'money' else
                            'DATE' if kind in ('date', 'optionaldate') else 'TEXT')
                definition = f'{column} {sql_type}' + ('' if kind in ('assignee', 'optionaldate', 'optionalcustomer', 'optionalstaff', 'latitude', 'longitude') else ' NOT NULL')
                if kind in ('integer', 'money'):
                    definition += f' CHECK ({column} >= 0)'
                if kind in ('customer', 'staff', 'assignee', 'inventory', 'optionalcustomer', 'optionalstaff'):
                    target_table = 'customers' if kind in ('customer', 'optionalcustomer') else 'inventory' if kind == 'inventory' else 'staff'
                    definition += f' REFERENCES {target_table}(id) ON DELETE RESTRICT'
                columns.append(definition)
            connection.execute(f'CREATE TABLE IF NOT EXISTS {table_name(section)} ({", ".join(columns)})')
        # Upstream provider each package is bought from; existing packages start blank until edited.
        connection.execute("ALTER TABLE packages ADD COLUMN IF NOT EXISTS service_provider TEXT NOT NULL DEFAULT ''")
        connection.execute("ALTER TABLE packages ALTER COLUMN service_provider SET DEFAULT ''")
        connection.execute("ALTER TABLE inventory ADD COLUMN IF NOT EXISTS batch TEXT NOT NULL DEFAULT ''")
        connection.execute("ALTER TABLE inventory ALTER COLUMN batch SET DEFAULT ''")
        connection.execute("ALTER TABLE customers ADD COLUMN IF NOT EXISTS area TEXT NOT NULL DEFAULT ''")
        connection.execute("ALTER TABLE customers ALTER COLUMN area SET DEFAULT ''")
        connection.execute("ALTER TABLE customers ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT ''")
        connection.execute("ALTER TABLE customers ALTER COLUMN city SET DEFAULT ''")
        for label,kind in STAFF_DETAILS:
            if kind=='generated':
                continue
            column=column_name(label)
            definition="NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK ("+column+">=0)" if kind=='money' else 'DATE' if kind=='optionaldate' else "TEXT NOT NULL DEFAULT ''"
            connection.execute(f'ALTER TABLE staff ADD COLUMN IF NOT EXISTS {column} {definition}')
            if kind=='money':
                connection.execute(f'ALTER TABLE staff ALTER COLUMN {column} SET DEFAULT 0')
            elif kind!='optionaldate':
                default='Not specified' if label=='Gender' else 'Permanent' if label=='Employment type' else ''
                connection.execute(sql.SQL('ALTER TABLE staff ALTER COLUMN {} SET DEFAULT {}').format(sql.Identifier(column),sql.Literal(default)))
        connection.execute("UPDATE staff SET gender='Not specified' WHERE gender=''")
        connection.execute("UPDATE staff SET employment_type='Permanent' WHERE employment_type=''")
        connection.execute('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP')
        connection.execute('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP')
        connection.execute('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ')
        connection.execute('CREATE INDEX IF NOT EXISTS tickets_queue ON tickets(status, assigned_to, due_date)')
        connection.execute('''CREATE TABLE IF NOT EXISTS ticket_events (
            id BIGSERIAL PRIMARY KEY,
            ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
            message TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )''')
        connection.execute('CREATE INDEX IF NOT EXISTS ticket_events_ticket ON ticket_events(ticket_id, id)')
        connection.execute('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP')
        connection.execute('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES customers(id) ON DELETE RESTRICT')
        connection.execute('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP')
        connection.execute('CREATE INDEX IF NOT EXISTS expenses_date_status ON expenses(expense_date, status)')
        connection.execute('ALTER TABLE inventory ADD COLUMN IF NOT EXISTS selling_price NUMERIC(15,2)')
        connection.execute('UPDATE inventory SET selling_price=unit_cost WHERE selling_price IS NULL')
        connection.execute('ALTER TABLE inventory ALTER COLUMN selling_price SET DEFAULT 0')
        connection.execute('ALTER TABLE inventory ALTER COLUMN selling_price SET NOT NULL')
        connection.execute('ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS unit_selling_price NUMERIC(15,2)')
        connection.execute('ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP')
        connection.execute('ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ')
        connection.execute('ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS request_key TEXT UNIQUE')
        connection.execute('ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS unit_cost_at_issue NUMERIC(15,2)')
        connection.execute('ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS cost_estimated BOOLEAN NOT NULL DEFAULT FALSE')
        connection.execute('UPDATE stock_issues s SET unit_cost_at_issue=i.unit_cost,cost_estimated=TRUE FROM inventory i WHERE i.id=s.inventory_id AND s.unit_cost_at_issue IS NULL')
        connection.execute('CREATE INDEX IF NOT EXISTS stock_issues_inventory ON stock_issues(inventory_id, id)')
        # Customer pricing: the price charged is unit_selling_price; these keep how it was reached.
        connection.execute('ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS list_price NUMERIC(15,2)')
        connection.execute('ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0')
        connection.execute('ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS waived BOOLEAN NOT NULL DEFAULT FALSE')
        # Device details read from (or typed for) the label; the photo itself lives in its own table.
        for column in ('device_make', 'device_model', 'device_mac', 'device_serial'):
            connection.execute(f"ALTER TABLE stock_issues ADD COLUMN IF NOT EXISTS {column} TEXT NOT NULL DEFAULT ''")
        connection.execute('CREATE TABLE IF NOT EXISTS stock_issue_photos(issue_id BIGINT PRIMARY KEY REFERENCES stock_issues(id) ON DELETE CASCADE, photo BYTEA NOT NULL, media_type TEXT NOT NULL)')
        # The issuing employee is optional.
        connection.execute('ALTER TABLE stock_issues ALTER COLUMN employee_id DROP NOT NULL')
        connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS unique_customer_username ON customers(username)')
        connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS unique_package_name ON packages(name)')
        connection.execute('ALTER TABLE packages ADD COLUMN IF NOT EXISTS monthly_cost NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (monthly_cost >= 0)')
        connection.execute("ALTER TABLE customers ADD COLUMN IF NOT EXISTS promise_date DATE")
        connection.execute('ALTER TABLE customers ADD COLUMN IF NOT EXISTS installation_charge NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK(installation_charge>=0)')
        connection.execute('ALTER TABLE customers ALTER COLUMN installation_charge SET DEFAULT 0')
        connection.execute('ALTER TABLE customers ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,7)')
        connection.execute('ALTER TABLE customers ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7)')
        for coordinate,limit in (('latitude',90),('longitude',180)):
            constraint='customer_'+coordinate+'_range'
            if not connection.execute("SELECT 1 FROM pg_constraint WHERE conname=%s AND conrelid='customers'::regclass",(constraint,)).fetchone():
                connection.execute(f'ALTER TABLE customers ADD CONSTRAINT {constraint} CHECK ({coordinate} BETWEEN -{limit} AND {limit})')
        if not connection.execute("SELECT 1 FROM pg_constraint WHERE conname='customer_coordinate_pair' AND conrelid='customers'::regclass").fetchone():
            connection.execute('ALTER TABLE customers ADD CONSTRAINT customer_coordinate_pair CHECK ((latitude IS NULL)=(longitude IS NULL))')
        connection.execute('ALTER TABLE customers ADD COLUMN IF NOT EXISTS package_id BIGINT REFERENCES packages(id) ON DELETE RESTRICT')
        connection.execute("ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_type TEXT NOT NULL DEFAULT 'Residential'")
        connection.execute("ALTER TABLE customers ALTER COLUMN customer_type SET DEFAULT 'Residential'")
        for extra in ('email', 'cnic', 'telephone', 'passport', 'ntn'):
            connection.execute(f"ALTER TABLE customers ADD COLUMN IF NOT EXISTS {extra} TEXT NOT NULL DEFAULT ''")
            connection.execute(f"ALTER TABLE customers ALTER COLUMN {extra} SET DEFAULT ''")
        connection.execute('CREATE SEQUENCE IF NOT EXISTS customer_payment_id_seq MINVALUE 100000000 MAXVALUE 999999999 START 100000000 NO CYCLE')
        connection.execute('ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_id TEXT')
        connection.execute("UPDATE customers SET payment_id=nextval('customer_payment_id_seq')::text WHERE payment_id IS NULL")
        connection.execute("ALTER TABLE customers ALTER COLUMN payment_id SET DEFAULT nextval('customer_payment_id_seq')::text")
        connection.execute('ALTER TABLE customers ALTER COLUMN payment_id SET NOT NULL')
        connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS customers_payment_id_unique ON customers(payment_id)')
        if not connection.execute("SELECT 1 FROM pg_constraint WHERE conname='customer_payment_id_format' AND conrelid='customers'::regclass").fetchone():
            connection.execute("ALTER TABLE customers ADD CONSTRAINT customer_payment_id_format CHECK(payment_id ~ '^[0-9]{9}$')")
        connection.execute('''CREATE OR REPLACE FUNCTION protect_customer_payment_id() RETURNS trigger AS $$
            BEGIN IF NEW.payment_id IS DISTINCT FROM OLD.payment_id THEN
                RAISE EXCEPTION 'Customer payment IDs cannot be changed' USING ERRCODE='23514';
            END IF; RETURN NEW; END; $$ LANGUAGE plpgsql''')
        if not connection.execute("SELECT 1 FROM pg_trigger WHERE tgname='customer_payment_id_immutable' AND tgrelid='customers'::regclass").fetchone():
            connection.execute('CREATE TRIGGER customer_payment_id_immutable BEFORE UPDATE OF payment_id ON customers FOR EACH ROW EXECUTE FUNCTION protect_customer_payment_id()')
        connection.execute('ALTER TABLE customers ADD COLUMN IF NOT EXISTS expiry_date DATE')
        connection.execute('UPDATE customers SET expiry_date=joined+30 WHERE expiry_date IS NULL')
        connection.execute('ALTER TABLE customers ALTER COLUMN expiry_date SET NOT NULL')
        connection.execute('''CREATE OR REPLACE FUNCTION default_customer_expiry() RETURNS trigger AS $$
            BEGIN IF NEW.expiry_date IS NULL THEN NEW.expiry_date := NEW.joined + 30; END IF; RETURN NEW; END;
            $$ LANGUAGE plpgsql''')
        if not connection.execute("SELECT 1 FROM pg_trigger WHERE tgname='customer_expiry_default' AND tgrelid='customers'::regclass").fetchone():
            connection.execute('CREATE TRIGGER customer_expiry_default BEFORE INSERT ON customers FOR EACH ROW EXECUTE FUNCTION default_customer_expiry()')
        if not connection.execute("SELECT 1 FROM pg_constraint WHERE conname='customer_expiry_valid' AND conrelid='customers'::regclass").fetchone():
            connection.execute('ALTER TABLE customers ADD CONSTRAINT customer_expiry_valid CHECK (expiry_date>=joined)')
        connection.execute('''CREATE TABLE IF NOT EXISTS invoices (
            id BIGSERIAL PRIMARY KEY, customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
            billing_month TEXT NOT NULL, invoice_number TEXT NOT NULL UNIQUE,
            customer_name TEXT NOT NULL, username TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
            package_name TEXT NOT NULL, amount NUMERIC(15,2) NOT NULL CHECK (amount>=0),
            issue_date DATE NOT NULL, due_date DATE NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(customer_id,billing_month)
        )''')
        connection.execute('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS previous_balance NUMERIC(15,2) NOT NULL DEFAULT 0')
        connection.execute('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_id TEXT')
        connection.execute('UPDATE invoices i SET payment_id=c.payment_id FROM customers c WHERE i.customer_id=c.id AND i.payment_id IS NULL')
        connection.execute('ALTER TABLE invoices ALTER COLUMN payment_id SET NOT NULL')
        connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS unique_category_name ON categories(name)')
        if first_categories:
            for name in INVENTORY_CATEGORIES:
                connection.execute("INSERT INTO categories (name, status) VALUES (%s, 'Active') ON CONFLICT (name) DO NOTHING", (name,))
        connection.execute("INSERT INTO categories (name, status) SELECT DISTINCT category, 'Active' FROM inventory ON CONFLICT (name) DO NOTHING")
        if not connection.execute("SELECT 1 FROM pg_constraint WHERE conname='inventory_category_fkey' AND conrelid='inventory'::regclass").fetchone():
            connection.execute('ALTER TABLE inventory ADD CONSTRAINT inventory_category_fkey FOREIGN KEY (category) REFERENCES categories(name) ON UPDATE CASCADE ON DELETE RESTRICT')
        connection.execute('ALTER TABLE staff ADD COLUMN IF NOT EXISTS reports_to BIGINT REFERENCES staff(id) ON DELETE RESTRICT')
        connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS designations_name ON designations(lower(name))')
        connection.execute("INSERT INTO designations(name,status) SELECT DISTINCT trim(designation),'Active' FROM staff WHERE trim(designation)!='' ON CONFLICT DO NOTHING")
        if first_designations:
            for designation in ('General Manager','Operations Manager','Network Engineer','Field Technician','Customer Support','Accountant','Storekeeper'):
                connection.execute("INSERT INTO designations(name,status) VALUES (%s,'Active') ON CONFLICT DO NOTHING",(designation,))
        import crm_employee_codes
        crm_employee_codes.initialize(connection)
        import crm_attachments
        crm_attachments.initialize(connection)
        from crm_auth import initialize_auth
        initialize_auth(connection)
        connection.execute('''CREATE TABLE IF NOT EXISTS customer_documents (
            id BIGSERIAL PRIMARY KEY, customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
            document_type TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT NOT NULL,
            byte_size INTEGER NOT NULL CHECK(byte_size>0 AND byte_size<=5242880), content BYTEA NOT NULL,
            uploaded_by BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
            uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )''')
        connection.execute('CREATE INDEX IF NOT EXISTS customer_documents_customer ON customer_documents(customer_id,id)')
        connection.execute("ALTER TABLE payments ADD COLUMN IF NOT EXISTS otc_type TEXT NOT NULL DEFAULT 'Other'")
        connection.execute("ALTER TABLE payments ALTER COLUMN otc_type SET DEFAULT 'Other'")
        connection.execute("ALTER TABLE payments ADD COLUMN IF NOT EXISTS revenue_type TEXT NOT NULL DEFAULT 'MRC'")
        connection.execute("ALTER TABLE payments ALTER COLUMN revenue_type SET DEFAULT 'MRC'")
        connection.execute('ALTER TABLE payments ADD COLUMN IF NOT EXISTS request_key TEXT')
        connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS payment_request_unique ON payments(request_key)')
        connection.execute('''CREATE TABLE IF NOT EXISTS customer_recharges (
            id BIGSERIAL PRIMARY KEY, customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
            billing_month TEXT NOT NULL, monthly_fee NUMERIC(15,2) NOT NULL,
            received_amount NUMERIC(15,2) NOT NULL, previous_expiry DATE NOT NULL, expiry_date DATE NOT NULL,
            payment_record_id BIGINT NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
            activated_by BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
            activated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(customer_id,billing_month)
        )''')
        connection.execute('ALTER TABLE customer_recharges ADD COLUMN IF NOT EXISTS partial_activation BOOLEAN NOT NULL DEFAULT FALSE')
        connection.execute('ALTER TABLE customer_recharges ADD COLUMN IF NOT EXISTS outstanding_amount NUMERIC(15,2) NOT NULL DEFAULT 0')
        from crm_receipts import initialize_receipts
        initialize_receipts(connection)
        from crm_jobs_migration import migrate_jobs
        migrate_jobs(connection)
        connection.execute('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tat_hours INTEGER NOT NULL DEFAULT 24 CHECK(tat_hours BETWEEN 1 AND 720)')
        connection.execute('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ')
        connection.execute("UPDATE tickets SET due_at=(due_date+TIME '23:59:59') AT TIME ZONE 'Asia/Karachi' WHERE due_at IS NULL")
        connection.execute('''CREATE OR REPLACE FUNCTION default_ticket_deadline() RETURNS trigger AS $$
            BEGIN IF NEW.due_at IS NULL THEN NEW.due_at := (NEW.due_date+TIME '23:59:59') AT TIME ZONE 'Asia/Karachi'; END IF; RETURN NEW; END;
            $$ LANGUAGE plpgsql''')
        if not connection.execute("SELECT 1 FROM pg_trigger WHERE tgname='ticket_deadline_default' AND tgrelid='tickets'::regclass").fetchone():
            connection.execute('CREATE TRIGGER ticket_deadline_default BEFORE INSERT ON tickets FOR EACH ROW EXECUTE FUNCTION default_ticket_deadline()')
        connection.execute('CREATE INDEX IF NOT EXISTS ticket_due_at ON tickets(due_at)')
        from crm_termination import initialize as initialize_terminations
        initialize_terminations(connection)
        from crm_inventory_qr import initialize as initialize_inventory_qr
        initialize_inventory_qr(connection)
        from crm_customer_portal import initialize as initialize_customer_portal
        initialize_customer_portal(connection)
        from crm_customer_ledger import initialize as initialize_customer_ledger
        initialize_customer_ledger(connection)
        from crm_operations import initialize as initialize_operations
        initialize_operations(connection)
        from crm_warehouses import initialize as initialize_warehouses
        initialize_warehouses(connection)
        from crm_print_settings import initialize as initialize_print_settings
        initialize_print_settings(connection)
        connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS tat_settings_type_priority ON tat_settings(ticket_type,priority)')
        from crm_tat import DEFAULT_HOURS
        if first_tat_settings:
            for ticket_type in dict(SCHEMAS['Tickets'])['Type']:
                for priority,hours in DEFAULT_HOURS.items():
                    connection.execute('INSERT INTO tat_settings(ticket_type,priority,hours) VALUES (%s,%s,%s) ON CONFLICT (ticket_type,priority) DO NOTHING',(ticket_type,priority,hours))





