# Fair Usage Policy (FUP) - Quota Setup Guide

This guide explains how to configure the 1400GB monthly quota system for 4MB subscribers with automatic service blocking when limits are exceeded.

---

## Quick Summary of Fixes

### ✅ Issue 1: Admin/ISP Unable to Delete Users or Packages - FIXED
- **Root Cause:** Package deletion endpoint was missing authorization check
- **Fix:** Added `SecurityService.assertCan(actor, 'packages.delete')` permission check
- **Result:** Only admin/ISP users with `packages.delete` permission can now delete packages
- **Subscriber deletion:** Already had proper authorization - only ISP/admin can delete, not the owning dealer

### ✅ Issue 2: Subscriber Quota System - Ready to Configure
- **Status:** All code is ready, just needs configuration
- **Current Setup:** System defaults to THROTTLE mode (reduces speed when over quota)
- **Needed Change:** Enable BLOCK mode to cut internet entirely when limit exceeded

---

## Configuration Steps

### Step 1: Enable BLOCK Mode (Cut Internet When Over Quota)

In your `.env` or environment variables, set:

```bash
FUP_MODE=BLOCK
FUP_ENABLED=true
FUP_DEFAULT_QUOTA_GB=1400
```

**What this does:**
- `FUP_MODE=BLOCK`: When subscriber exceeds quota, internet is completely stopped (not throttled)
- `FUP_ENABLED=true`: Activates the hourly FUP enforcement sweep
- `FUP_DEFAULT_QUOTA_GB=1400`: Default 1400GB cap for any subscriber without a specific override

**How to apply:**
1. SSH into your Ubuntu server (or edit locally if testing)
2. Edit `/opt/jointbox/backend/.env` (or your deployment path)
3. Add/update the lines above
4. Restart the backend: `pm2 restart backend` or `docker-compose restart backend`

### Step 2: Configure Package Quotas

For each 4MB package that should have the 1400GB monthly limit:

**Via Admin Panel:**
1. Go to **Packages** section
2. Click on the 4MB package to edit it
3. Scroll to **FUP Settings** section
4. Set:
   - **Data Quota (GB):** `1400`
   - **FUP Download Speed (Mbps):** `1` (optional throttle speed if in THROTTLE mode)
   - **FUP Upload Speed (Mbps):** `1` (optional throttle speed if in THROTTLE mode)
5. Save

**Alternative (Direct API):**
```bash
curl -X PUT "http://localhost:3001/packages/{packageId}" \
  -H "Authorization: Bearer {JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "dataQuotaGb": 1400,
    "fupDownloadSpeed": 1,
    "fupUploadSpeed": 1
  }'
```

### Step 3: Restart the Backend

After configuration changes:

```bash
# If using PM2
pm2 restart backend

# If using Docker
docker-compose restart backend

# Check logs
pm2 logs backend  # or docker-compose logs backend
```

---

## How the Quota System Works

### Real-Time Tracking
- **Source:** RADIUS accounting data (radacct table)
- **Frequency:** Checked every hour (runs at `:15` past each hour)
- **Accuracy:** Reflects actual network usage, not estimated

### When Subscriber Exceeds 1400GB

In **BLOCK mode** (what you configured):

1. **Immediate Actions:**
   - Subscriber is removed from RADIUS
   - Live PPPoE session is disconnected
   - `fupApplied` flag is set to `true` on the subscriber
   - SMS notification sent: _"Dear customer, you have used your 1400 GB data limit and your internet is now stopped. Please top up your data or renew to continue."_

2. **Service is Completely Stopped**
   - Customer cannot authenticate
   - No internet access at all
   - Remains blocked until quota is extended or renewed

3. **How to Restore Service:**
   - **Option A - Quota Extension (Top-up):** Admin extends their quota by X GB
   - **Option B - Renewal:** Customer renews their subscription (starts a new billing cycle)

---

## Managing Quotas - Admin Operations

### Check a Subscriber's Current Usage

**API Endpoint:**
```bash
GET /compliance/fup/{subscriberId}
```

**Example Response:**
```json
{
  "subscriberId": 42,
  "username": "john_4mb",
  "cycleStart": "2026-06-24T00:00:00Z",
  "usedGb": 1450.5,
  "quotaGb": 1400,
  "bonusGb": 50,
  "remainingGb": 0,
  "percentUsed": 103.6,
  "mode": "BLOCK",
  "fupApplied": true,
  "state": "BLOCKED",
  "throttledTo": null
}
```

### Extend Quota (Top-up Customer)

When a customer wants to buy more data within their current billing cycle:

**API Endpoint:**
```bash
POST /compliance/fup/{subscriberId}/extend
Content-Type: application/json

{
  "gb": 500
}
```

**What happens:**
- 500 GB is added to their current cycle bonus
- If they're blocked and now back under quota → **automatically restored to full speed**
- SMS confirmation sent to customer
- Service restored immediately

### Release Blocked/Throttled Customer

To manually restore full speed (e.g., as a goodwill gesture or billing dispute resolution):

**API Endpoint:**
```bash
PATCH /compliance/fup/{subscriberId}/release
```

**What happens:**
- Customer is restored to RADIUS with full speed
- Live session is not reconnected automatically (they'll reconnect normally)
- Quota penalty is NOT removed (still counts towards usage)

### Get Heavy Users Report

To see which customers are approaching or exceeding quota:

**API Endpoint:**
```bash
GET /compliance/fup/report
```

**Use this to:**
- Identify customers who should be contacted about data usage
- Proactively offer quota extensions
- Plan capacity upgrades

---

## Subscriber Quota Override (Per-Customer Customization)

For a specific subscriber, you can override the package quota without changing the entire package:

1. Go to Subscriber details → **Service Settings**
2. Set custom **Quota (GB):** field with their personal limit
3. Save

**Priority:**
- Subscriber override → Package quota → System default (1400 GB)

The system uses the first value it finds, starting from the subscriber level.

---

## Troubleshooting

### Customers Not Being Blocked When Over Quota

**Check 1: Is FUP enabled?**
```bash
# Check environment variable
echo $FUP_MODE
# Should output: BLOCK

# Check logs for FUP messages
pm2 logs backend | grep -i fup
```

**Check 2: Do packages have quota set?**
- Go to **Packages** → check the package's Data Quota field
- Should be > 0 (e.g., 1400)

**Check 3: Is the quota enforcement job running?**
- Look for logs like: `FUP: blocked 3 subscriber(s) over quota`
- If nothing appears, check if the scheduler is running: `pm2 status backend`

### Service Not Restored After Extending Quota

**Automatic restoration only works if:**
- `FUP_MODE=BLOCK` is set
- Quota was extended with `POST /compliance/fup/{id}/extend`
- After extension, `usedGb < quotaGb` (still uses less than the new quota)

**Manual restoration:**
```bash
PATCH /compliance/fup/{subscriberId}/release
```

### RADIUS Not Removing Customer

- Check RADIUS database connectivity
- Verify `radcheck` and `radreply` tables are being updated
- Check if FreeRADIUS service is running

---

## Configuration Examples

### Example 1: Standard ISP Setup (1400GB for All)
```bash
FUP_MODE=BLOCK
FUP_ENABLED=true
FUP_DEFAULT_QUOTA_GB=1400
```

### Example 2: Tiered Plans
- **Budget Plan Package:** `dataQuotaGb: 500`
- **Standard Plan Package:** `dataQuotaGb: 1400`
- **Premium Plan Package:** `dataQuotaGb: 5000`
- **Unlimited Plan Package:** `dataQuotaGb: null` (no limit)

### Example 3: Throttle Instead of Block
```bash
FUP_MODE=THROTTLE
# Package needs fupDownloadSpeed and fupUploadSpeed set
# e.g., fupDownloadSpeed: 2 Mbps, fupUploadSpeed: 1 Mbps
```

---

## API Quick Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/compliance/fup/{id}` | GET | Check usage & quota status |
| `/compliance/fup/{id}/extend` | POST | Add GB to current cycle |
| `/compliance/fup/{id}/release` | PATCH | Restore full speed |
| `/compliance/fup/report` | GET | List heavy users |

---

## Database Queries (Advanced)

### Manual Check: Find All Blocked Subscribers
```sql
SELECT id, username, status, fupApplied, fupAppliedAt 
FROM "Subscriber" 
WHERE fupApplied = true 
ORDER BY fupAppliedAt DESC;
```

### Manual Check: Monthly Usage for One Subscriber
```sql
SELECT 
  username,
  COALESCE(SUM(acctinputoctets), 0) as input_octets,
  COALESCE(SUM(acctoutputoctets), 0) as output_octets,
  (COALESCE(SUM(acctinputoctets), 0) + COALESCE(SUM(acctoutputoctets), 0)) / 1024.0 / 1024.0 / 1024.0 as total_gb,
  MIN(acctstarttime) as period_start,
  MAX(acctstarttime) as period_end
FROM radacct
WHERE username = 'john_4mb'
  AND acctstarttime >= DATE_TRUNC('month', NOW())
GROUP BY username;
```

---

## Next Steps

1. **Update `.env`** with the FUP configuration above
2. **Restart backend** for changes to take effect
3. **Set package quotas** to 1400 GB for 4MB plans
4. **Test:** Create a test subscriber and simulate usage
5. **Monitor:** Check logs for FUP enforcement messages

The system will automatically enforce quotas and notify customers. No additional setup needed!
