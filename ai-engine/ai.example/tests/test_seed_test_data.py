"""Seed and remove [TEST] data in an isolated schema, keeping real records intact."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import unittest
import uuid
import psycopg
from psycopg import sql
from psycopg.rows import dict_row
import crm_data
import remove_test_data
import seed_test_data


class SeedTestDataTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings=crm_data.database_settings();cls.schema='seed_test_'+uuid.uuid4().hex
        with psycopg.connect(**cls.settings,autocommit=True) as db:db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(cls.schema)))
        cls.original=crm_data.connect_database
        cls.connect=staticmethod(lambda:psycopg.connect(**cls.settings,row_factory=dict_row,options='-c search_path='+cls.schema))
        crm_data.connect_database=cls.connect
        crm_data.initialize_database()

    @classmethod
    def tearDownClass(cls):
        crm_data.connect_database=cls.original
        with psycopg.connect(**cls.settings,autocommit=True) as db:db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(cls.schema)))

    def counts(self,db):
        return {t:db.execute(sql.SQL('SELECT count(*) AS n FROM {}').format(sql.Identifier(t))).fetchone()['n'] for t in ('customers','staff','packages','inventory','tickets','payments','payment_receipts','invoices','expenses','operations_records','operations_events','app_users','designations','customer_portal_accounts')}

    def test_seed_then_remove_restores_real_records(self):
        with self.connect() as db:
            admin=db.execute("INSERT INTO app_users(name,username,designation,role,status,password_hash) VALUES ('Owner','owner','Owner','Administrator','Active','x') RETURNING id").fetchone()['id']
            real_package=db.execute("INSERT INTO packages(name,speed_mbps,monthly_price,monthly_cost,installation_fee,status) VALUES ('Real 20',20,2000,1000,0,'Active') RETURNING *").fetchone()
            db.execute("INSERT INTO customers(name,phone,address,username,package,package_id,monthly_fee,status,joined,expiry_date) VALUES ('Real customer','0','Real address','real.customer',%s,%s,2000,'Active',CURRENT_DATE,CURRENT_DATE)",(real_package['name'],real_package['id']))
            before=self.counts(db)
        summary,portal=seed_test_data.seed()
        self.assertEqual(len(portal),2)
        with self.connect() as db:
            loaded=self.counts(db)
            self.assertEqual(loaded['customers'],before['customers']+24)
            self.assertGreater(loaded['payment_receipts'],0);self.assertGreater(loaded['invoices'],0);self.assertGreater(loaded['tickets'],0)
            self.assertEqual(db.execute("SELECT count(*) AS n FROM operations_records WHERE module='Fiber segments'").fetchone()['n'],6)
            # Real records that point at test records while testing.
            test_staff=db.execute("SELECT id FROM staff WHERE name LIKE '[TEST]%' ORDER BY id LIMIT 1").fetchone()['id']
            test_package=db.execute("SELECT * FROM packages WHERE name LIKE '[TEST]%' ORDER BY id LIMIT 1").fetchone()
            real_staff=db.execute("INSERT INTO staff(name,phone,role,area,status,reports_to) VALUES ('Real employee','0','Support','Office','Available',%s) RETURNING id",(test_staff,)).fetchone()['id']
            db.execute("UPDATE customers SET package_id=%s,package=%s WHERE username='real.customer'",(test_package['id'],test_package['name']))
            unlinked=db.execute("SELECT s.id FROM staff s WHERE s.name LIKE '[TEST]%' AND NOT EXISTS (SELECT 1 FROM app_users u WHERE u.staff_id=s.id) ORDER BY s.id LIMIT 1").fetchone()['id']
            db.execute("INSERT INTO app_users(name,username,designation,role,status,password_hash,staff_id) VALUES ('Real support','real.support','Support','Support','Active','x',%s)",(unlinked,))
        with self.assertRaises(SystemExit):seed_test_data.seed()
        remove_test_data.remove()
        with self.connect() as db:
            after=self.counts(db)
            self.assertEqual(after['customers'],before['customers']);self.assertEqual(after['packages'],before['packages'])
            self.assertEqual(after['staff'],before['staff']+1);self.assertEqual(after['app_users'],before['app_users']+1)
            for table in ('tickets','payments','payment_receipts','invoices','expenses','operations_records','operations_events','designations','customer_portal_accounts'):
                self.assertEqual(after[table],before[table],table)
            self.assertIsNone(db.execute('SELECT reports_to FROM staff WHERE id=%s',(real_staff,)).fetchone()['reports_to'])
            self.assertIsNone(db.execute("SELECT package_id FROM customers WHERE username='real.customer'").fetchone()['package_id'])
            self.assertIsNone(db.execute("SELECT staff_id FROM app_users WHERE username='real.support'").fetchone()['staff_id'])
            self.assertTrue(db.execute('SELECT 1 FROM app_users WHERE id=%s',(admin,)).fetchone())
            self.assertIsNone(db.execute("SELECT to_regclass('test_data_records') AS t").fetchone()['t'])


if __name__=='__main__':unittest.main()
