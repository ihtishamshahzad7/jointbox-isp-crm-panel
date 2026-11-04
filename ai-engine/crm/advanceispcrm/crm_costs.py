"""Customer activation costs from issued stock and explicitly allocated expenses."""
from decimal import Decimal

def customer_costs(db,customer):
    issues=list(db.execute('''SELECT s.id,s.quantity,s.status,s.issue_date,s.unit_cost_at_issue,s.cost_estimated,
        i.item,st.name AS employee_name FROM stock_issues s JOIN inventory i ON i.id=s.inventory_id
        LEFT JOIN staff st ON st.id=s.employee_id WHERE s.issued_against='Customer' AND s.customer_id=%s ORDER BY s.id DESC''',(customer['id'],)))
    for issue in issues:
        issue['cost']=issue['quantity']*(issue['unit_cost_at_issue'] or Decimal(0))
    expenses=list(db.execute("SELECT id,title,category,amount,status,expense_date FROM expenses WHERE customer_id=%s ORDER BY id DESC",(customer['id'],)))
    issued=sum((i['cost'] for i in issues if i['status']=='Issued'),Decimal(0))
    returned=sum((i['cost'] for i in issues if i['status']=='Returned'),Decimal(0))
    additional=sum((e['amount'] for e in expenses if e['status']!='Cancelled'),Decimal(0))
    package=db.execute('SELECT monthly_cost FROM packages WHERE id=%s',(customer['package_id'],)).fetchone() if customer['package_id'] else None
    return dict(issues=issues,expenses=expenses,inventory_cost=issued,returned_cost=returned,
        additional_cost=additional,total=issued+additional,estimated_issues=sum(i['cost_estimated'] for i in issues),
        unpriced_issues=sum(not i['unit_cost_at_issue'] for i in issues if i['status']=='Issued'),
        monthly_package_cost=package['monthly_cost'] if package else None)
