"""Upload KMZ: reading pins/lines, guessing types, safety checks, importing once and spotting duplicates."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import io
import unittest
import uuid
import zipfile
import psycopg
from psycopg import sql
from psycopg.rows import dict_row
import crm_data
import crm_operations as ops
import crm_kmz_import as kmz

KML = '''<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Topi network</name>
<Folder><name>Core</name>
 <Placemark><name>POP Topi Bazar</name><Point><coordinates>72.6284254,34.0685036,0</coordinates></Point></Placemark>
 <Placemark><name>FAT-12</name><description>Street 4</description><Point><coordinates>72.6301,34.0701</coordinates></Point></Placemark>
</Folder>
<Folder><name>Customers</name><Placemark><name>Ali house</name><Point><coordinates>72.63,34.07</coordinates></Point></Placemark></Folder>
<Folder><name>Cables</name>
 <Placemark><name>12 core feeder A</name><styleUrl>#fiber-active</styleUrl><LineString><coordinates>72.6284,34.0685,0 72.6290,34.0690,0 72.6301,34.0701,0</coordinates></LineString></Placemark>
 <Placemark><name>Coverage</name><Polygon><outerBoundaryIs><LinearRing><coordinates>72.62,34.06 72.63,34.06 72.63,34.07 72.62,34.06</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Folder></Document></kml>'''


def kmz_bytes(text):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('doc.kml', text)
    return buffer.getvalue()


class KmzImportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings = crm_data.database_settings(); cls.schema = 'kmz_test_' + uuid.uuid4().hex
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
        self.zone = ops.save(self.db, self.user, dict(module='Zones', fields=dict(name='Zone ' + uuid.uuid4().hex[:6]), request_key=str(uuid.uuid4())))

    def test_preview_reads_and_guesses(self):
        result = kmz.preview(self.db, self.user, kmz_bytes(KML))
        by = {i['name']: i for i in result['items']}
        self.assertEqual(by['POP Topi Bazar']['type'], 'POP'); self.assertEqual(by['POP Topi Bazar']['latitude'], 34.0685036)
        self.assertEqual(by['FAT-12']['type'], 'FAT'); self.assertEqual(by['Ali house']['type'], 'Skip')
        line = by['12 core feeder A']
        self.assertEqual((line['kind'], line['status'], line['cores'], len(line['points'])), ('line', 'Active', 12, 3))
        self.assertEqual(line['points'][0], [34.0685, 72.6284] if isinstance(line['points'][0], list) else (34.0685, 72.6284))
        self.assertEqual(result['polygons_skipped'], 1)
        self.assertEqual(kmz.preview(self.db, self.user, KML.encode())['items'][0]['name'], 'POP Topi Bazar')  # plain KML works too

    def test_unsafe_or_bad_files_are_refused(self):
        for bad in (b'not a map', b'PK\x03\x04broken', ('<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY a "x">]>' + KML[38:]).encode()):
            with self.assertRaises(ValueError): kmz.preview(self.db, self.user, bad)
        with self.assertRaises(PermissionError): kmz.preview(self.db, dict(self.user, role='Support'), kmz_bytes(KML))

    def test_import_once_and_duplicates_are_skipped_next_time(self):
        items = [dict(i, type=i['type'], cable_type='Feeder', status='Active', cores=12, points=[list(p) for p in i.get('points', [])])
                 for i in kmz.preview(self.db, self.user, kmz_bytes(KML))['items'] if i['type'] != 'Skip']
        payload = dict(items=items, zone=self.zone['id'], request_key=str(uuid.uuid4()))
        self.assertEqual(kmz.import_items(self.db, self.user, payload), dict(POPs=1, devices=1, cables=1))
        kmz.import_items(self.db, self.user, payload)  # same request again adds nothing
        self.assertEqual(self.db.execute("SELECT count(*) AS n FROM operations_records WHERE module IN ('POPs','Network devices','Fiber segments') AND data->>'name' IN ('POP Topi Bazar','FAT-12','12 core feeder A')").fetchone()['n'], 3)
        cable = self.db.execute("SELECT data FROM operations_records WHERE module='Fiber segments' AND data->>'name'='12 core feeder A'").fetchone()['data']
        self.assertTrue(cable['code'].startswith('FBR-')); self.assertGreater(float(cable['length_m']), 100)
        again = {i['name']: i for i in kmz.preview(self.db, self.user, kmz_bytes(KML))['items']}
        self.assertTrue(all(again[n]['duplicate'] and again[n]['type'] == 'Skip' for n in ('POP Topi Bazar', 'FAT-12', '12 core feeder A')))

    def test_import_needs_zone_and_cable_details(self):
        with self.assertRaises(ValueError):
            kmz.import_items(self.db, self.user, dict(items=[dict(type='POP', name='P', latitude=34, longitude=72)], zone=None, request_key=str(uuid.uuid4())))
        with self.assertRaises(ValueError):
            kmz.import_items(self.db, self.user, dict(items=[dict(type='Fiber cable', name='C', points=[[34, 72], [34.1, 72.1]], cable_type='Feeder', status='Active', cores=None)], request_key=str(uuid.uuid4())))

    def test_new_zone_is_created_for_pops(self):
        name = 'KMZ zone ' + uuid.uuid4().hex[:6]
        made = kmz.import_items(self.db, self.user, dict(items=[dict(type='POP', name='POP new zone', latitude=34.2, longitude=72.2)], zone=None, new_zone=name, request_key=str(uuid.uuid4())))
        self.assertEqual(made['POPs'], 1)
        zone = self.db.execute("SELECT id FROM operations_records WHERE module='Zones' AND data->>'name'=%s", (name,)).fetchone()
        self.assertEqual(self.db.execute("SELECT data->>'zone' AS z FROM operations_records WHERE module='POPs' AND data->>'name'='POP new zone'").fetchone()['z'], str(zone['id']))

    def test_own_export_round_trips(self):
        ops.save(self.db, self.user, dict(module='Network devices', fields=dict(name='Export OLT', type='OLT', latitude='34.1', longitude='72.5'), request_key=str(uuid.uuid4())))
        exported = kmz.preview(self.db, self.user, ops.kmz(self.db, self.user))['items']
        olt = next(i for i in exported if 'Export OLT' in i['name'])
        self.assertTrue(olt['duplicate'] or olt['type'] == 'OLT')

    def test_long_lines_are_thinned(self):
        points, simplified = kmz.thin([(34 + i / 1e5, 72.0) for i in range(2500)])
        self.assertTrue(simplified); self.assertEqual(len(points), kmz.MAX_ROUTE_POINTS)
        self.assertEqual((points[0], points[-1]), ((34.0, 72.0), (34 + 2499 / 1e5, 72.0)))


if __name__ == '__main__':
    unittest.main()
