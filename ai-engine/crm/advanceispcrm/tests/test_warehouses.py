"""Warehouses: default store, warehouse checks on batches, and stock transfers (with QR-tracked units)."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest
import uuid
import psycopg
from psycopg import sql
from psycopg.rows import dict_row
import crm_data
import crm_operations as ops
import crm_warehouses as wh


class WarehouseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings = crm_data.database_settings(); cls.schema = 'wh_test_' + uuid.uuid4().hex
        with psycopg.connect(**cls.settings, autocommit=True) as db:
            db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(cls.schema)))
        cls.original = crm_data.connect_database
        cls.connect = staticmethod(lambda: psycopg.connect(**cls.settings, row_factory=dict_row, options='-c search_path=' + cls.schema))
        crm_data.connect_database = cls.connect
        crm_data.initialize_database()

    @classmethod
    def tearDownClass(cls):
        crm_data.connect_database = cls.original
        with psycopg.connect(**cls.settings, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(cls.schema)))

    def setUp(self):
        self.db = self.connect(); self.addCleanup(self.db.close)
        self.user = dict(id=None, name='Test administrator', role='Administrator', staff_id=None)
        self.db.execute("INSERT INTO categories(name,status) VALUES ('Fiber','Active') ON CONFLICT DO NOTHING")
        self.swabi = ops.save(self.db, self.user, dict(module='Warehouses', fields=dict(name='Swabi Store ' + uuid.uuid4().hex[:6], status='Active'), request_key=str(uuid.uuid4())))['data']['name']
        self.row = self.db.execute("INSERT INTO inventory(item,category,batch,quantity,minimum_stock,unit_cost,location,selling_price) VALUES ('12 core fiber','Fiber','B-1',1000,0,50,%s,80) RETURNING *", (wh.DEFAULT,)).fetchone()

    def move(self, quantity, to=None, key=None):
        return wh.transfer(self.db, self.user, dict(inventory_id=self.row['id'], quantity=quantity, to_warehouse=to or self.swabi, request_key=key or str(uuid.uuid4())))

    def qty(self, rid):
        return self.db.execute('SELECT quantity FROM inventory WHERE id=%s', (rid,)).fetchone()['quantity']

    def test_default_warehouse_exists(self):
        self.assertIn(wh.DEFAULT, wh.names(self.db))

    def test_transfer_moves_stock_into_same_batch_at_target(self):
        first = self.move(300)
        self.assertEqual(self.qty(self.row['id']), 700); self.assertEqual(self.qty(first['to_inventory_id']), 300)
        target = self.db.execute('SELECT * FROM inventory WHERE id=%s', (first['to_inventory_id'],)).fetchone()
        self.assertEqual((target['location'], target['batch'], target['unit_cost'], target['selling_price']), (self.swabi, 'B-1', self.row['unit_cost'], self.row['selling_price']))
        second = self.move(200)
        self.assertEqual(second['to_inventory_id'], first['to_inventory_id']); self.assertEqual(self.qty(first['to_inventory_id']), 500)

    def test_transfer_is_validated_and_not_repeated(self):
        with self.assertRaises(ValueError): self.move(1001)
        with self.assertRaises(ValueError): self.move(0)
        with self.assertRaises(ValueError): self.move(5, to=wh.DEFAULT)
        with self.assertRaises(ValueError): self.move(5, to='No such store')
        key = str(uuid.uuid4())
        self.assertEqual(self.move(10, key=key)['id'], self.move(10, key=key)['id'])
        self.assertEqual(self.qty(self.row['id']), 990)
        with self.assertRaises(PermissionError):
            wh.transfer(self.db, dict(self.user, role='Technician'), dict(inventory_id=self.row['id'], quantity=1, to_warehouse=self.swabi, request_key=str(uuid.uuid4())))

    def test_transfer_moves_only_needed_qr_units(self):
        for n in range(3):
            self.db.execute("INSERT INTO inventory_units(inventory_id,qr_code,serial_number,state,request_key) VALUES (%s,%s,%s,'Available',%s)", (self.row['id'], 'QR-' + uuid.uuid4().hex, 'SN' + str(n), str(uuid.uuid4())))
        result = self.move(998)  # 2 left behind, so 1 of the 3 tracked units must move
        self.assertEqual(result['units_moved'], 1)
        self.assertEqual(self.db.execute("SELECT count(*) AS n FROM inventory_units WHERE inventory_id=%s AND state='Available'", (self.row['id'],)).fetchone()['n'], 2)

    def test_batch_warehouse_rules(self):
        self.assertEqual(wh.check_inventory_warehouse(self.db, self.swabi), self.swabi)
        with self.assertRaises(ValueError): wh.check_inventory_warehouse(self.db, '')
        with self.assertRaises(ValueError): wh.check_inventory_warehouse(self.db, self.swabi, self.row)  # still has stock in Main Store
        self.assertEqual(wh.check_inventory_warehouse(self.db, wh.DEFAULT, self.row), wh.DEFAULT)

    def test_transfer_records_value_date_and_movement_number(self):
        line = self.move(40)
        self.assertEqual((line['unit_cost'], line['quantity']), (self.row['unit_cost'], 40))
        self.assertRegex(line['movement_no'], r'^TRF-\d{4}-\d{3}$')
        self.assertEqual(line['transfer_date'], wh.transfer_day(None))
        record = next(h for h in wh.history(self.db) if h['id'] == line['id'])
        self.assertEqual(record['value'], 40 * self.row['unit_cost'])
        self.assertEqual((record['item'], record['batch']), ('12 core fiber', 'B-1'))
        with self.assertRaises(ValueError):
            wh.transfer(self.db, self.user, dict(inventory_id=self.row['id'], quantity=1, to_warehouse=self.swabi, request_key=str(uuid.uuid4()), transfer_date='2999-01-01'))

    def test_move_several_batches_at_once(self):
        other = self.db.execute("INSERT INTO inventory(item,category,batch,quantity,minimum_stock,unit_cost,location,selling_price) VALUES ('ONU','Fiber','B-2',20,0,3500,%s,4500) RETURNING *", (wh.DEFAULT,)).fetchone()
        key = str(uuid.uuid4())
        payload = dict(from_warehouse=wh.DEFAULT, to_warehouse=self.swabi, transfer_date='2026-10-15', notes='Swabi expansion', request_key=key,
                       lines=[dict(inventory_id=self.row['id'], quantity=100), dict(inventory_id=other['id'], quantity=5)])
        result = wh.move(self.db, self.user, payload)
        self.assertEqual(len(result['lines']), 2)
        self.assertEqual({l['movement_no'] for l in result['lines']}, {result['movement_no']})
        self.assertTrue(result['movement_no'].startswith('TRF-2610-'))
        self.assertEqual({str(l['transfer_date']) for l in result['lines']}, {'2026-10-15'})
        self.assertEqual((self.qty(self.row['id']), self.qty(other['id'])), (900, 15))
        self.assertEqual(sum(l['quantity'] * l['unit_cost'] for l in result['lines']), 100 * 50 + 5 * 3500)
        # Submitting the same movement again does not move stock twice.
        wh.move(self.db, self.user, payload)
        self.assertEqual(self.qty(self.row['id']), 900)
        # One bad line (more than in stock) cancels the whole movement.
        self.db.commit()
        bad = dict(payload, request_key=str(uuid.uuid4()), lines=[dict(inventory_id=self.row['id'], quantity=1), dict(inventory_id=other['id'], quantity=999)])
        with self.assertRaisesRegex(ValueError, 'Line 2'):
            wh.move(self.db, self.user, bad)
        self.db.rollback()
        self.assertEqual((self.qty(self.row['id']), self.qty(other['id'])), (900, 15))
        with self.assertRaises(ValueError):
            wh.move(self.db, self.user, dict(payload, request_key=str(uuid.uuid4()), from_warehouse=self.swabi))  # those batches are not in Swabi
        with self.assertRaises(ValueError):
            wh.move(self.db, self.user, dict(payload, request_key=str(uuid.uuid4()), to_warehouse=wh.DEFAULT))

    def test_rename_and_delete_follow_inventory(self):
        record = self.db.execute("SELECT * FROM operations_records WHERE module='Warehouses' AND data->>'name'=%s", (self.swabi,)).fetchone()
        self.move(5)
        renamed = self.swabi + ' New'
        ops.save(self.db, self.user, dict(module='Warehouses', id=record['id'], version=record['version'], fields=dict(name=renamed, status='Active'), request_key=str(uuid.uuid4())))
        self.assertTrue(self.db.execute('SELECT 1 FROM inventory WHERE location=%s', (renamed,)).fetchone())
        with self.assertRaises(ValueError): ops.delete(self.db, self.user, ops.record(self.db, record['id']))


if __name__ == '__main__':
    unittest.main()
