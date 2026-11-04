"""CRM assistant how-to help: how/where questions get steps; figure questions still go to the data lookup."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest
import crm_help


class HelpTest(unittest.TestCase):
    def title(self, question):
        answer = crm_help.help_answer(question)
        return answer.splitlines()[0] if answer else None

    def test_how_and_where_questions_find_the_right_steps(self):
        cases = {
            'where can i change the peak and price?': 'Change bandwidth peak and price per Mbps',
            'how do I add a warehouse': 'Add a warehouse',
            'how to move stock to another warehouse': 'Move stock between warehouses',
            'how can I upload KMZ': 'Upload or download KMZ',
            'how do I give a router to customer': 'Issue stock to a customer or the network',
            'how to change customer package': 'Edit a customer, change package or expiry',
            'customer kaise add karen': 'Add a new customer',
            'warehouse kahan banana hai': 'Add a warehouse',
            'where can i assign rights to roles': 'Users, roles and permissions',
            'where is the city picker': 'City picker (show one city)',
        }
        for question, title in cases.items():
            self.assertEqual(self.title(question), title, question)

    def test_figure_and_name_questions_are_left_to_the_data_lookup(self):
        for question in ('how much collected this month', 'how many customers', 'collections today', 'Ali khan', 'kitne customers expired hain'):
            self.assertIsNone(crm_help.help_answer(question), question)

    def test_every_topic_has_keywords_and_steps(self):
        titles = [t for t, _, _ in crm_help.TOPICS]
        self.assertEqual(len(titles), len(set(titles)))
        for title, keys, steps in crm_help.TOPICS:
            self.assertTrue(keys and len(steps) > 60, title)


if __name__ == '__main__':
    unittest.main()
