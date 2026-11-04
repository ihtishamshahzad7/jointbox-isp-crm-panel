"""Confirmed CRM receipts and atomic, once-per-billing-month customer renewal."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from uuid import UUID
from crm_receipts import save_receipt, record_deletion
from crm_billing import previous_balance, ensure_invoice
from crm_data import record_fields, column_name


def local_today():
    return datetime.now(ZoneInfo('Asia/Karachi')).date()


def apply_recharge(db, customer, billing_month, payment_id, user_id, activate_partial=False):
    today = local_today()
    if customer['status']=='Terminated':
        return {'activated': False, 'message': 'Payment saved. This account is terminated; equipment recovery and authorized reactivation must be completed separately.'}
    if billing_month != today.strftime('%Y-%m'):
        return {'activated': False, 'message': 'Payment saved. Only the current billing month qualifies for automatic recharge.'}
    if db.execute('SELECT 1 FROM customer_recharges WHERE customer_id=%s AND billing_month=%s', (customer['id'], billing_month)).fetchone():
        return {'activated': False, 'message': 'Payment saved. This billing month was already recharged; no extra renewal was applied.'}
    invoice = ensure_invoice(db,customer,billing_month,today)
    fee = invoice['amount']
    due = fee + previous_balance(db,customer['id'],billing_month)
    if fee <= 0:
        return {'activated': False, 'message': 'Payment saved. Set a positive monthly fee before automatic recharge.'}
    received = db.execute("SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE revenue_type='MRC' AND customer_id=%s AND billing_month=%s", (customer['id'],billing_month)).fetchone()['total']
    outstanding = max(0,due-received)
    if outstanding and not activate_partial:
        return {'activated': False, 'message': f'Payment saved. Another Rs {outstanding:,.2f} is required to activate this billing month.'}
    expiry = max(today, customer['expiry_date']) + timedelta(days=30)
    db.execute('''INSERT INTO customer_recharges(customer_id,billing_month,monthly_fee,received_amount,previous_expiry,expiry_date,payment_record_id,activated_by,partial_activation,outstanding_amount)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''', (customer['id'],billing_month,fee,received,customer['expiry_date'],expiry,payment_id,user_id,bool(outstanding),outstanding))
    db.execute("UPDATE customers SET status='Active',expiry_date=%s WHERE id=%s", (expiry,customer['id']))
    from crm_termination import resolve_expiry_recovery
    resolve_expiry_recovery(db,customer['id'],'Customer recharged: connection activated and expiry renewed.')
    return {'activated': True, 'partial_activation': bool(outstanding), 'outstanding_amount': outstanding, 'expiry_date': expiry.isoformat(), 'message': f'Customer activated in CRM. Expiry renewed to {expiry.isoformat()}.' + (f' Unpaid Rs {outstanding:,.2f} will carry forward to the next bill.' if outstanding else '')}


def save_payment(db, payload, user, validate, trusted_gateway=False):
    activate_partial = payload.get('activate_partial', False)
    if type(activate_partial) is not bool:
        raise ValueError('Invalid partial activation choice.')
    if activate_partial and (trusted_gateway or user.get('role') not in ('Administrator','Manager','Accountant')):
        raise PermissionError('Only authorized finance staff can approve partial activation.')
    rid = payload.get('id')
    existing = db.execute('SELECT * FROM payments WHERE id=%s', (rid,)).fetchone() if rid else None
    if rid and not existing:
        raise ValueError('Payment no longer exists. Reload the page.')
    deleting = payload.get('action') == 'delete'
    online_methods = ('1LINK','Easypaisa','JazzCash')
    if existing and existing['method'] in online_methods:
        raise PermissionError('Online receipts are immutable. Preserve the provider transaction record.')
    if deleting and not existing:
        raise ValueError('Select an existing payment.')
    fields = payload.get('fields', {})
    if not isinstance(fields, dict):
        raise ValueError('Invalid payment fields.')
    columns = [column_name(label) for label, _ in record_fields('Payments')]
    values = validate('Payments', fields) if not deleting else None
    payment = dict(zip(columns, values)) if values is not None else existing
    if not deleting:
        if payment['method'] in online_methods and not trusted_gateway:
            raise PermissionError('Online receipts must arrive through a verified provider integration. Choose Cash or Card for manual payments.')
        if payment['amount'] <= 0:
            raise ValueError('Payment amount must be greater than zero.')
        if payment['payment_date'] > local_today().isoformat():
            raise ValueError('Only confirmed payments may be recorded. Payment date cannot be in the future.')
    ids = sorted({payment['customer_id']} | ({existing['customer_id']} if existing else set()))
    customers = {row['id']: row for row in db.execute('SELECT * FROM customers WHERE id=ANY(%s) ORDER BY id FOR UPDATE', (ids,))}
    if payment['customer_id'] not in customers:
        raise ValueError('Customer does not exist.')
    if existing:
        # Lock again after the customer locks, so concurrent edits cannot use a stale receipt.
        latest = db.execute('SELECT * FROM payments WHERE id=%s FOR UPDATE', (rid,)).fetchone()
        if latest != existing:
            raise ValueError('Payment changed. Reload it before saving.')
        if db.execute('SELECT 1 FROM payment_receipts WHERE payment_record_id=%s', (rid,)).fetchone():
            raise ValueError('A permanent receipt is saved for this payment. It cannot be edited or deleted.')
        if db.execute('SELECT 1 FROM customer_recharges WHERE customer_id=%s AND billing_month=%s', (existing['customer_id'],existing['billing_month'])).fetchone():
            raise ValueError('This payment belongs to a completed recharge. It cannot be edited or deleted; preserve the confirmed receipt.')
    if deleting:
        record_deletion(db, existing, user)
        db.execute('DELETE FROM payments WHERE id=%s', (rid,))
        return {'ok': True, 'id': rid}
    request_key = payload.get('request_key') if not rid else None
    if request_key:
        try:
            request_key = str(UUID(str(request_key)))
        except (ValueError, TypeError, AttributeError):
            raise ValueError('Invalid payment request key.')
        prior = db.execute('SELECT * FROM payments WHERE request_key=%s', (request_key,)).fetchone()
        if prior:
            if str(prior['service_charge_id'] or '')!=str(fields.get('service_charge_id') or ''):raise ValueError('Request key already used for a different service payment.')
            if any(str(prior[c]) != str(payment[c]) for c in columns):
                raise ValueError('This request key was already used for a different payment.')
            return {'ok': True, 'id': prior['id'], **save_receipt(db,prior['id'],user['id']), 'recharge': {'activated': False, 'message': 'This payment was already saved. No duplicate receipt or renewal was created.'}}
    if payment['revenue_type']=='MRC':
        from crm_customer_ledger import charges as customer_services
        if any(s['due']>0 for s in customer_services(db,payment['customer_id'])):
            invoice=db.execute('SELECT amount FROM invoices WHERE customer_id=%s AND billing_month=%s',(payment['customer_id'],payment['billing_month'])).fetchone()
            monthly=invoice['amount'] if invoice else customers[payment['customer_id']]['monthly_fee']
            collected=db.execute("SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE customer_id=%s AND billing_month=%s AND revenue_type='MRC'",(payment['customer_id'],payment['billing_month'])).fetchone()['n']
            mrc_due=max(0,monthly+previous_balance(db,payment['customer_id'],payment['billing_month'])-collected)
            if payment['amount']>mrc_due:raise ValueError('This customer has extra service charges. Record only the subscription amount as MRC; collect each extra service using its Record payment button in customer Finance.')
    service_id=fields.get('service_charge_id')
    if service_id not in (None,''):
        try:service_id=int(service_id)
        except (ValueError,TypeError):raise ValueError('Select a valid service charge.')
        service=db.execute('SELECT * FROM customer_service_charges WHERE id=%s FOR UPDATE',(service_id,)).fetchone()
        if not service or service['customer_id']!=payment['customer_id'] or payment['revenue_type']!='OTC' or payment['otc_type']!=service['charge_type'] or payment['billing_month']!=service['service_date'].strftime('%Y-%m'):
            raise ValueError('Charge payment must match the customer, charge month and OTC category.')
        paid=db.execute('SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE service_charge_id=%s',(service_id,)).fetchone()['n']
        if payment['amount']>service['amount']-paid:raise ValueError('Service payment exceeds the remaining service charge.')
    if payment['revenue_type']=='OTC' and payment['otc_type']=='Installation':
        received=db.execute("SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE customer_id=%s AND revenue_type='OTC' AND otc_type='Installation'",(payment['customer_id'],)).fetchone()['paid']
        if payment['amount']>customers[payment['customer_id']]['installation_charge']-received:
            raise ValueError('Installation payment exceeds the remaining installation charge. Check the customer charge first.')
    if rid:
        db.execute('UPDATE payments SET '+', '.join(c+'=%s' for c in columns)+' WHERE id=%s', values+[rid])
    else:
        rid = db.execute('INSERT INTO payments ('+', '.join(columns)+', request_key) VALUES ('+', '.join(['%s']*(len(values)+1))+') RETURNING id',values+[request_key]).fetchone()['id']
    if service_id not in (None,''):db.execute('UPDATE payments SET service_charge_id=%s WHERE id=%s',(service_id,rid))
    if payment['revenue_type']=='OTC' and activate_partial:
        raise ValueError('OTC payments cannot activate subscriptions.')
    result = apply_recharge(db,customers[payment['customer_id']],payment['billing_month'],rid,user['id'],activate_partial=activate_partial) if payment['revenue_type']=='MRC' else {'activated': False, 'message': 'OTC payment saved separately. Subscription balance and activation are unchanged.'}
    return {'ok': True, 'id': rid, **save_receipt(db,rid,user['id'],result['activated'],result.get('outstanding_amount',0),result.get('partial_activation',False)), 'recharge': result}
