import unittest

import crm_city


SCOPE = dict(city='Topi', areas={'Main Bazar', 'Botaka'}, other_areas={'Saddar'}, customers={1, 2})


class CityFilterTests(unittest.TestCase):
    def test_all_cities_leaves_records_unchanged(self):
        records = {'Customers': [{'id': 1}, {'id': 9}]}
        self.assertEqual(crm_city.filter_records(records, None), {'Customers': [{'id': 1}, {'id': 9}]})

    def test_customer_linked_records_follow_the_city(self):
        records = {
            'Customers': [{'id': 1}, {'id': 2}, {'id': 9}],
            'Payments': [{'id': 10, 'customer_id': 1}, {'id': 11, 'customer_id': 9}],
            'Expenses': [{'id': 20, 'customer_id': None}, {'id': 21, 'customer_id': 9}, {'id': 22, 'customer_id': 2}],
            'Staff': [{'id': 30, 'area': 'Main Bazar'}, {'id': 31, 'area': 'Saddar'}, {'id': 32, 'area': ''}],
            'Inventory': [{'id': 40, 'item': 'ONT'}],
            'Tickets': [],
        }
        result = crm_city.filter_records(records, SCOPE)
        self.assertEqual([r['id'] for r in result['Customers']], [1, 2])
        self.assertEqual([r['id'] for r in result['Payments']], [10])
        self.assertEqual([r['id'] for r in result['Expenses']], [20, 22])
        self.assertEqual([r['id'] for r in result['Staff']], [30, 32])
        self.assertEqual([r['id'] for r in result['Inventory']], [40])

    def test_operations_keep_city_areas_and_customers(self):
        result = dict(records=[
            dict(id=1, module='Areas', data={'name': 'Main Bazar'}),
            dict(id=2, module='Areas', data={'name': 'Saddar'}),
            dict(id=3, module='Customer requests', data={'customer': 2}),
            dict(id=4, module='Customer requests', data={'customer': '9'}),
            dict(id=5, module='POPs', data={'name': 'Core POP'}),
        ], events=[dict(record_id=3), dict(record_id=4)], lookups={'customer': [{'id': 2}, {'id': 9}]})
        result = crm_city.filter_operations(result, SCOPE)
        self.assertEqual([r['id'] for r in result['records']], [1, 3, 5])
        self.assertEqual(result['events'], [dict(record_id=3)])
        self.assertEqual(result['lookups']['customer'], [{'id': 2}])


if __name__ == '__main__':
    unittest.main()
