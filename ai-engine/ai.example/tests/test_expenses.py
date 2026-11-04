"""Run: python -m unittest discover -s tests -p test_expenses.py"""
import json
import threading
import unittest
import urllib.error
import urllib.request
import uuid

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

import crm_data
import ispcrm
from auth_client import administrator_client


class ExpensesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings = crm_data.database_settings()
        cls.schema = 'crm_expense_test_' + uuid.uuid4().hex
        cls.original_data = crm_data.connect_database
        cls.original_server = ispcrm.connect_database
        with psycopg.connect(**cls.settings, autocommit=True) as db:
            db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(cls.schema)))
        def isolated():
            return psycopg.connect(**cls.settings, row_factory=dict_row, options='-c search_path=' + cls.schema)
        cls.connect = staticmethod(isolated)
        crm_data.connect_database = ispcrm.connect_database = isolated
        try:
            crm_data.initialize_database()
            cls.server = ispcrm.ThreadingHTTPServer(('127.0.0.1', 0), ispcrm.Handler)
            cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
            cls.thread.start()
            cls.base = 'http://127.0.0.1:' + str(cls.server.server_port)
            cls.opener, cls.token = administrator_client(cls.base)
        except BaseException:
            cls.cleanup()
            raise

    @classmethod
    def cleanup(cls):
        if hasattr(cls, 'server'):
            cls.server.shutdown()
            cls.server.server_close()
            cls.thread.join()
        crm_data.connect_database = cls.original_data
        ispcrm.connect_database = cls.original_server
        with psycopg.connect(**cls.settings, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(cls.schema)))

    @classmethod
    def tearDownClass(cls):
        cls.cleanup()

    def post(self, fields=None, rid=None, action=None, expected=200):
        request = urllib.request.Request(self.base + '/api/record',
            data=json.dumps(dict(section='Expenses', fields=fields, id=rid, action=action)).encode(),
            headers={'X-CRM-Token': self.token, 'Content-Type': 'application/json'})
        try:
            response = self.opener.open(request)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            self.assertEqual(response.status, expected, json.load(response))

    def rows(self):
        with self.opener.open(self.base + '/api/state') as response:
            return json.load(response)['records']['Expenses']

    def fields(self):
        return dict(title='Expense ' + uuid.uuid4().hex, category='Bandwidth / Upstream',
                    payee='Test supplier', amount='12500.25', expense_date='2026-09-30',
                    status='Pending', method='Bank transfer', payment_date='', reference='', notes='')

    def test_pending_paid_cancelled_and_delete(self):
        fields = self.fields()
        self.post(fields)
        row = next(r for r in self.rows() if r['title'] == fields['title'])
        rid = row['id']
        self.assertIsNone(row['payment_date'])
        self.assertEqual(row['expense_date'], '2026-09-30')
        fields.update(status='Paid', payment_date='2026-10-02')
        self.post(fields, rid)
        self.assertEqual(self.rows()[0]['payment_date'], '2026-10-02')
        fields.update(amount='13500.75', notes='Corrected supplier invoice.')
        self.post(fields, rid)
        with self.connect() as db:
            persisted = db.execute('SELECT * FROM expenses WHERE id=%s', (rid,)).fetchone()
            self.assertEqual(str(persisted['amount']), '13500.75')
            self.assertGreaterEqual(persisted['updated_at'], persisted['created_at'])
        fields['status'] = 'Cancelled'
        self.post(fields, rid)
        self.assertIsNone(self.rows()[0]['payment_date'])
        crm_data.initialize_database()
        self.assertEqual(self.rows()[0]['status'], 'Cancelled')
        self.post(rid=rid, action='delete')
        self.assertFalse(any(r['id'] == rid for r in self.rows()))

    def test_validation_and_atomic_failure(self):
        original = self.fields()
        for changes in [dict(amount='0'), dict(amount='-1'), dict(amount='NaN'),
                        dict(amount='0.001'), dict(category='Unknown'), dict(payee=''),
                        dict(status='Paid', payment_date=''), dict(status='Paid', payment_date='not-a-date'),
                        dict(expense_date='2026-02-30'), dict(status='Invalid')]:
            with self.subTest(changes=changes):
                self.post(dict(original, **changes), expected=400)
        self.assertFalse(any(r['title'] == original['title'] for r in self.rows()))
        self.post(original)
        rid = next(r['id'] for r in self.rows() if r['title'] == original['title'])
        self.post(dict(original, amount='-50'), rid, expected=400)
        self.assertEqual(next(r['amount'] for r in self.rows() if r['id'] == rid), 12500.25)
        self.post(rid=rid, action='delete')


if __name__ == '__main__':
    unittest.main()
