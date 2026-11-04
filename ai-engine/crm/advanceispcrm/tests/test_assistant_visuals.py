import unittest
from crm_assistant_visuals import graphical_summary

class AssistantVisualsTest(unittest.TestCase):
    def test_totals_only_and_units_are_separate(self):
        visual=graphical_summary({'lookup':dict(section='Sales',period=['2026-10-20','2026-10-20'],matching_records=3,totals={'sales':2000,'new_customers':2,'activated_connections':4},records=[{'password':'never expose','name':'private row'}])})
        self.assertEqual([m['unit'] for m in visual['metrics']],['PKR','count','count'])
        self.assertNotIn('records',visual)
        self.assertNotIn('private row',str(visual))
    def test_permission_errors_and_workflows_have_no_chart(self):
        self.assertIsNone(graphical_summary({'lookup':{'error':'No permission'}}))
        self.assertIsNone(graphical_summary({'lookup':None},'How do invoices work?'))
    def test_permitted_summary_only(self):
        visual=graphical_summary({'lookup':None,'date_pkt':'2026-10-20','tickets':{'open':5,'overdue':2}})
        self.assertEqual([m['value'] for m in visual['metrics']],[5,2])
        self.assertNotIn('PKR',str(visual['metrics']))
