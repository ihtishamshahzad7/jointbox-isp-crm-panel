"""Signed receipt bridge contract; provider-native API adapters are configured separately."""
import hashlib
import hmac
import json
import os
import re
import time
from datetime import datetime
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo
import crm_recharge

PROVIDERS = {'1LINK': 'CRM_1LINK_BRIDGE_SECRET', 'Easypaisa': 'CRM_EASYPAISA_BRIDGE_SECRET', 'JazzCash': 'CRM_JAZZCASH_BRIDGE_SECRET'}


def confirmed_receipt(headers, raw):
    provider = headers.get('X-CRM-Payment-Provider', '')
    if provider not in PROVIDERS:
        raise ValueError('Unsupported payment provider.')
    secret = os.environ.get(PROVIDERS[provider], '')
    if len(secret) < 32:
        raise RuntimeError('This payment provider bridge is not configured.')
    stamp = headers.get('X-CRM-Payment-Timestamp', '')
    if not re.fullmatch(r'[0-9]{10}', stamp):
        raise PermissionError('Invalid payment timestamp.')
    age = time.time()-int(stamp)
    signature = headers.get('X-CRM-Payment-Signature', '')
    expected = hmac.new(secret.encode(), stamp.encode()+b'.'+provider.encode()+b'.'+raw, hashlib.sha256).hexdigest()
    if age > 300 or age < -30 or not hmac.compare_digest(signature, expected):
        raise PermissionError('Invalid or expired payment signature.')
    payload = json.loads(raw)
    if not isinstance(payload, dict) or payload.get('status') != 'paid':
        raise ValueError('Only verified paid receipts can be posted.')
    payment_id = str(payload.get('payment_id', ''))
    if not re.fullmatch(r'[0-9]{9}', payment_id):
        raise ValueError('Provide the customer nine-digit payment ID.')
    transaction = payload.get('transaction_id')
    if not isinstance(transaction, str) or not transaction.strip() or len(transaction) > 160:
        raise ValueError('Provide a valid provider transaction ID.')
    paid_at = datetime.fromisoformat(str(payload.get('paid_at', '')).replace('Z','+00:00'))
    if paid_at.tzinfo is None or paid_at.timestamp() > time.time()+30:
        raise ValueError('Provide a confirmed payment time with timezone.')
    paid_day = paid_at.astimezone(ZoneInfo('Asia/Karachi')).date()
    return provider, payment_id, dict(
        amount=payload.get('amount'), payment_date=paid_day.isoformat(),
        billing_month=paid_day.strftime('%Y-%m'), method=provider, reference=transaction.strip())


def post_receipt(db, provider, payment_id, fields, validate):
    customer = db.execute('SELECT id FROM customers WHERE payment_id=%s', (payment_id,)).fetchone()
    if not customer:
        raise ValueError('No customer matches this payment ID.')
    fields['customer_id'] = customer['id']
    # Stable across delivery retries, even if they arrive days later.
    request_key = str(uuid5(NAMESPACE_URL,'ispcrm-payment:'+provider+':'+fields['reference']))
    return crm_recharge.save_payment(db,dict(fields=fields,request_key=request_key),{'id':None},validate,trusted_gateway=True)
