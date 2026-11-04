"""Run a disposable sample-data CRM on port 3001 for review links."""
import os
import secrets
import uuid
import threading

import json
from pathlib import Path
CONFIG=Path(__file__).with_name('.demo-share.local.json')
if CONFIG.exists():
    demo=json.loads(CONFIG.read_text(encoding='utf-8'))
else:
    demo={'database':'ispcrm_share_demo_'+uuid.uuid4().hex[:12],'password':secrets.token_urlsafe(15)}
    CONFIG.write_text(json.dumps(demo,indent=2),encoding='utf-8')
if not demo['database'].startswith('ispcrm_share_demo_'):
    raise SystemExit('Refusing to use a non-demo database.')
os.environ['PGDATABASE']=demo['database']
import crm_data
import crm_auth
import ispcrm
import seed_demo
import seed_billing_demo

if __name__=='__main__':
    crm_data.initialize_database()
    with crm_data.connect_database() as db:
        prepared=db.execute("SELECT to_regclass('demo_presentation_state') AS table_name").fetchone()['table_name'] is not None
    if not prepared:
        seed_demo.seed()
        seed_billing_demo.seed()
        crm_data.initialize_database()
        password=demo['password']
        with crm_data.connect_database() as db:
            db.execute("INSERT INTO app_users(name,username,designation,role,status,password_hash) VALUES ('Demo Reviewer','demo-reviewer','Demo manager','Manager','Active',%s) ON CONFLICT (lower(username)) DO UPDATE SET password_hash=EXCLUDED.password_hash,status='Active',role='Manager'",(crm_auth.hash_password(password),))
        # Populate the latest billing and inventory features with synthetic examples.
        import crm_billing,crm_inventory_qr,crm_customer_ledger
        from datetime import datetime
        from zoneinfo import ZoneInfo
        from uuid import uuid5,NAMESPACE_URL
        day=datetime.now(ZoneInfo('Asia/Karachi')).date()
        with crm_data.connect_database() as db:
            customers=list(db.execute("SELECT * FROM customers WHERE username LIKE 'demo.user%' ORDER BY id LIMIT 10"))
            for customer in customers:
                crm_billing.ensure_invoice(db,customer,day.strftime('%Y-%m'),day)
            if customers:
                crm_customer_ledger.add_charge(db,dict(customer_id=customers[0]['id'],description='[DEMO] Wi-Fi setup service',service_date=day.replace(day=1).isoformat(),amount=500,request_key=str(uuid5(NAMESPACE_URL,'share-demo-service-'+day.strftime('%Y-%m')))),{'name':'Demo system'})
            db.execute("UPDATE staff SET monthly_salary=35000,allowances=5000,designation='Demo field technician',department='Operations' WHERE name LIKE '[DEMO]%' AND monthly_salary=0")
            item=db.execute("SELECT id FROM inventory WHERE category='ONT' AND item LIKE '[DEMO]%' ORDER BY id LIMIT 1").fetchone()
            if item:
                for number in range(1,4):
                    crm_inventory_qr.register(db,dict(inventory_id=item['id'],serial_number='DEMO-ONT-'+str(number),receive_new=False,request_key='share-demo-qr-'+str(number)),{'name':'Demo system'})
    from demo_presentation import apply
    with crm_data.connect_database() as db:apply(db)
    password=demo['password']
    server=ispcrm.ThreadingHTTPServer(('127.0.0.1',3001),ispcrm.Handler)
    stop=threading.Event()
    worker=threading.Thread(target=ispcrm.expiry_recovery_worker,args=(stop,),daemon=True)
    worker.start()
    print('DEMO READY: http://localhost:3001',flush=True)
    print('Demo username: demo-reviewer',flush=True)
    print('Demo password: '+password,flush=True)
    print('Only generated sample records are in this disposable database.',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:
        stop.set();server.server_close()
