"""Read-only lookup filters and permission boundaries, without external AI calls."""
import unittest
from datetime import date,datetime
from decimal import Decimal
from zoneinfo import ZoneInfo
from unittest.mock import patch
from crm_assistant_queries import lookup,period

class AssistantQueriesTest(unittest.TestCase):
    def test_assistant_answers_only_with_summary(self):
        from crm_assistant import guide_answer
        result=dict(section='Payments',matching_records=50,shown=20,period=('2026-10-20','2026-10-20'),totals={'recorded_amount':Decimal(5000)},records=[{'reference':'PRIVATE ROW DETAIL','amount':'200'}],language='en')
        answer=guide_answer('show all payments',{'lookup':result})
        self.assertIn('5,000',answer)
        self.assertNotIn('PRIVATE ROW DETAIL',answer)
        self.assertLessEqual(len(answer.splitlines()),4)
        result['language']='roman'
        answer=guide_answer('aaj kitni wasooli hui',{'lookup':result})
        self.assertIn('Kul raqam',answer)
        self.assertNotIn('PRIVATE ROW DETAIL',answer)

    def setUp(self):
        self.user={'role':'Administrator'}
        self.snapshot={'date_pkt':'2026-10-20','matched_customers':[]}
        self.records={'Payments':[dict(id=1,customer_id=8,amount=Decimal(2000),payment_date=date(2026,10,20),revenue_type='MRC',method='Cash'),dict(id=2,customer_id=9,amount=Decimal(500),payment_date=date(2026,10,19),revenue_type='OTC',method='Card')],'Customers':[dict(id=8,name='Hassan')],'Staff':[],'Inventory':[]}
    def test_payment_dates_customer_and_totals(self):
        result=lookup(None,self.user,'Show collections today',self.records,self.snapshot)
        self.assertEqual(result['matching_records'],1)
        self.assertEqual(result['totals']['recorded_amount'],2000)
        self.snapshot['matched_customers']=[{'id':9,'payment_id':'123456789'}]
        result=lookup(None,self.user,'Show payments for 123456789',self.records,self.snapshot)
        self.assertEqual(result['matching_records'],1)
        self.assertEqual(result['records'][0]['id'],'2')
    def test_restrictions_and_unknown_customer(self):
        result=lookup(None,{'role':'Support'},'show payments',self.records,self.snapshot)
        self.assertIn('does not have access',result['error'])
        result=lookup(None,self.user,'Show payments for customer 987654321',self.records,self.snapshot)
        self.assertIn('No matching customer',result['error'])
        self.assertIn('does not retrieve',lookup(None,self.user,'show employee salaries',self.records,self.snapshot)['error'])
    def test_period_and_no_guide_interception(self):
        self.assertEqual(period('last 7 days','2026-10-20'),('2026-10-14','2026-10-20'))
        self.assertEqual(period('2028-02','2026-10-20'),('2028-02-01','2028-02-29'))
        self.assertIsNone(lookup(None,self.user,'How do monthly invoices work?',self.records,self.snapshot))
    def test_invoice_filter_is_billing_month(self):
        with patch('crm_assistant_queries.billing.monthly_invoices',return_value=[dict(id=1,customer_id=8,billing_month='2026-09',issue_date=date(2026,10,1),amount=Decimal(100),service_amount=Decimal(50))]):
            result=lookup(None,self.user,'Show invoices 2026-09',self.records,self.snapshot)
            self.assertEqual(result['matching_records'],1)
            self.assertEqual(result['totals']['current_charges'],150)
    def test_results_capped_but_totals_complete(self):
        self.records['Payments']=[dict(id=i,customer_id=8,amount=Decimal(10),payment_date=date(2026,10,20),revenue_type='MRC',method='Cash') for i in range(25)]
        result=lookup(None,self.user,'show payments',self.records,self.snapshot)
        self.assertEqual(result['matching_records'],25)
        self.assertEqual(result['shown'],20)
        self.assertEqual(result['totals']['recorded_amount'],250)

    def test_roman_urdu_sales_and_urdu_collection(self):
        from unittest.mock import MagicMock
        from crm_assistant_language import language,localize
        db=MagicMock();db.execute.return_value=[dict(customer_id=8,activated_at=datetime(2026,10,20,1,tzinfo=ZoneInfo('Asia/Karachi')))]
        with patch('crm_assistant_queries.billing.monthly_invoices',return_value=[dict(issue_date=date(2026,10,20),amount=Decimal(3000))]):
            result=lookup(db,self.user,'kitni sali hoi ha ajj',self.records,self.snapshot)
        self.assertEqual(result['totals']['sales'],3000)
        self.assertEqual(result['totals']['activated_connections'],1)
        self.assertEqual(result['period'],('2026-10-20','2026-10-20'))
        result['language']=language('kitni sali hoi ha ajj')
        self.assertIn('PKR 3,000',localize(result))
        result=lookup(db,self.user,'آج کتنی وصولی ہوئی ہے',self.records,self.snapshot)
        result['language']=language('آج کتنی وصولی ہوئی ہے')
        self.assertEqual(result['totals']['recorded_amount'],2000)
        self.assertIn('کل رقم',localize(result))
        restricted=lookup(db,{'role':'Support'},'kitni sali hoi ha ajj',self.records,self.snapshot)
        self.assertIn('does not have access',restricted['error'])
