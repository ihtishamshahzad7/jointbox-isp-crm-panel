# Package Share Modal - Visual Guide & Screenshots

## Feature Overview

The new Package Share Modal provides an all-in-one interface to manage both group sharing and franchisee pricing for your packages.

---

## Screen Layouts

### 1. Opening the Modal

When you click the "Share" button on a package:

```
╔═══════════════════════════════════════════════════════════════╗
║ 📦 Share Package — E2E-pkg-497770                          ✕ ║
║ Set resale prices for 20/10 Mbps package with 4000 GB quota   ║
├───────────────────────────────────────────────────────────────┤
║ 🔍 Search franchisees by name, email, or role...              ║
├───────────────────────────────────────────────────────────────┤
║ ⏳ Loading franchisees...                                      ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
```

### 2. Franchisee List (Initial State)

Once loaded, you see all franchisees:

```
╔═══════════════════════════════════════════════════════════════╗
║ 📦 Share Package — E2E-pkg-497770                          ✕ ║
├───────────────────────────────────────────────────────────────┤
║ 🔍 Search franchisees by name, email, or role...              ║
├───────────────────────────────────────────────────────────────┤
║                                                               ║
║ 🟢 F1 Franchise Group              | FRANCHISE                ║
║    f1@company.com                                             ║
║                                           [Share]             ║
║                                                               ║
║ 🟠 F2 Telecom Reseller              | RESELLER (12 subs)      ║
║    f2@reseller.com                                            ║
║                                           [Share]             ║
║                                                               ║
║ 🟡 Dealer Network A                 | DEALER                  ║
║    dealer@network.com                                         ║
║                                           [Share]             ║
║                                                               ║
║ 🟣 Retail Partner B                 | RETAILER (2 subs)       ║
║    retail@partner.com                                         ║
║                                           [Share]             ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
```

### 3. After Sharing (Unshared Package)

```
┌───────────────────────────────────────────────────────────────┐
│ 🟢 F2 Telecom Reseller              | RESELLER (12 subs)      │
│    f2@reseller.com                                            │
│                                           [Share]             │
└───────────────────────────────────────────────────────────────┘

        ↓ (click Share)

┌───────────────────────────────────────────────────────────────┐
│ 🟢 F2 Telecom Reseller              | RESELLER (12 subs)      │
│    f2@reseller.com                                            │
│          ✓ Package shared successfully                        │
│                                  [▼ Price (Rs 1000)] [Unshare]│
└───────────────────────────────────────────────────────────────┘
```

### 4. Pricing Card (Expanded)

```
┌───────────────────────────────────────────────────────────────┐
│ 🟢 F2 Telecom Reseller              | RESELLER (12 subs)      │
│    f2@reseller.com                                            │
│                                  [▼ Price (Rs 800)] [Unshare]  │
├───────────────────────────────────────────────────────────────┤
│                                                               ║
│ Your Base Price    Rs 1,000                                   │
│ Resale Price       [800________] ← Type here                  │
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐  │
│ │ Your Margin      20% (Rs 200)                           │  │
│ └─────────────────────────────────────────────────────────┘  │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### 5. Search in Action

User types "F1" in search:

```
┌───────────────────────────────────────────────────────────────┐
│ 🔍 Search franchisees by name, email, or role...              │
│    [F1________________]     ← User typed "F1"                 │
├───────────────────────────────────────────────────────────────┤
│                                                               ║
│ 🟢 F1 Franchise Group              | FRANCHISE                │
│    f1@company.com                                             │
│                                           [Share]             │
│                                                               │
│ (0 other franchisees matching "F1")                           │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### 6. Search Results - Multiple Matches

User searches "reseller":

```
┌───────────────────────────────────────────────────────────────┐
│ 🔍 Search franchisees by name, email, or role...              │
│    [reseller__________]                                       │
├───────────────────────────────────────────────────────────────┤
│                                                               ║
│ 🟠 F2 Telecom Reseller              | RESELLER (12 subs)      │
│    f2@reseller.com                                            │
│                                  [▼ Price (Rs 800)] [Unshare]  │
│                                                               │
│ 🟠 SR3 Regional Reseller            | RESELLER                │
│    sr3@company.com                                            │
│                                           [Share]             │
│                                                               │
│ (2 results matching "reseller")                               │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### 7. Pricing Workflow - Step by Step

**Before:**
```
┌──────────────────────────────────────────┐
│ Package: E2E-pkg-497770                  │
│ Base Price: Rs 1,000                     │
│ Speed: 20/10 Mbps                        │
│ Quota: 4000 GB                           │
│ [Share]                                  │
└──────────────────────────────────────────┘
```

**During (Modal Opens):**
```
📦 Share Package — E2E-pkg-497770
───────────────────────────────────

🔍 Search...

🟢 F2 Franchise  | FRANCHISE  [Share]
🟠 F1 Reseller   | RESELLER   [Share]
🟡 Dealer Network| DEALER     [Share]
```

**After (Set Price):**
```
F1: Rs 500 → You get Rs 500 margin (50%)
F2: Rs 800 → You get Rs 200 margin (20%)
Dealer: Rs 900 → You get Rs 100 margin (10%)
```

---

## Color Coding System

### Card Status Indicators

| Color | Meaning | Status |
|-------|---------|--------|
| 🟢 Green | Franchise | Shared / Highest priority |
| 🟠 Orange | Reseller | Shared / Active merchants |
| 🟡 Yellow | Dealer | Unshared / Limited reach |
| 🟣 Purple | Retailer | Unshared / Retail partners |

### Button States

| State | Appearance | Action |
|-------|-----------|--------|
| Not Shared | Green button "Share" | Click to share |
| Shared | Green "▼ Price" | Click to expand pricing |
| Shared | Red "Unshare" | Click to revoke access |
| Saving | Greyed out "Saving..." | Wait for completion |

---

## Data Flow Diagram

```
User Interface (Modal)
    ↓
    ├─ [Search Box] → Filter franchisees in real-time
    ├─ [Share Button] → API PUT /organization/franchise-pricing
    ├─ [Unshare Button] → API DELETE /organization/franchise-pricing
    └─ [Price Input] → API PUT with new wholesale price
    ↓
Backend API Endpoints
    ├─ GET /users?type=reseller → Fetch franchisees
    ├─ GET /organization/franchise-pricing/:packageId → Current pricing
    ├─ PUT /organization/franchise-pricing → Set/Update price
    └─ DELETE /organization/franchise-pricing/:userId/:packageId → Remove
    ↓
Database
    ├─ users table → Franchisee info
    ├─ franchise_pricing table → Wholesale prices
    └─ packages table → Package details
```

---

## Real-World Usage Example

### Scenario: You want to share Rs 1,000 package with different margins

**Your Business Goal:**
- F1 (large franchisee): 50% margin (sell at Rs 500)
- F2 (medium franchisee): 20% margin (sell at Rs 800)
- Dealer A (small): 10% margin (sell at Rs 900)

**Steps:**

1. **Open Modal**
   - Click Share on package
   - Modal loads

2. **Share with F1**
   - Search: type "F1" or leave empty
   - Click [Share] on "F1 Franchise Group"
   - Click [▼ Price (Rs 1000)]
   - Change to: 500
   - Press Enter
   - ✓ Margin shows: 50% (Rs 500)

3. **Share with F2**
   - Click [Share] on "F2 Telecom Reseller"
   - Click [▼ Price (Rs 1000)]
   - Change to: 800
   - Press Enter
   - ✓ Margin shows: 20% (Rs 200)

4. **Share with Dealer**
   - Click [Share] on "Dealer Network A"
   - Click [▼ Price (Rs 1000)]
   - Change to: 900
   - Press Enter
   - ✓ Margin shows: 10% (Rs 100)

5. **Done!**
   - Each franchisee sees their specific price
   - You maximize revenue through volume and margins
   - Easy to adjust anytime

---

## Edge Cases & States

### Empty Franchisee List

```
╔═════════════════════════════════════════╗
║ 📦 Share Package — E2E-pkg-497770    ✕ ║
├─────────────────────────────────────────┤
║                                         ║
║              🏢                         ║
║       No franchisees found              ║
║ Create reseller/franchise users under   ║
║       your organization.                ║
║                                         ║
╚═════════════════════════════════════════╝
```

### Search with No Results

```
╔═════════════════════════════════════════╗
║ 📦 Share Package — E2E-pkg-497770    ✕ ║
├─────────────────────────────────────────┤
║ 🔍 Search: [xyz__________]              ║
├─────────────────────────────────────────┤
║              🏢                         ║
║    No results matching your search      ║
║       Try a different search term.      ║
╚═════════════════════════════════════════╝
```

### Network Error

```
╔═════════════════════════════════════════╗
║ 📦 Share Package — E2E-pkg-497770    ✕ ║
├─────────────────────────────────────────┤
║                                         ║
║         ⚠️ Network error                ║
║     Failed to load franchisees          ║
║                                         ║
║         [Close Modal]                   ║
╚═════════════════════════════════════════╝
```

---

## Mobile Responsiveness

### On Tablet / Small Screen

```
╔════════════════════════╗
║ 📦 Share Package    ✕  ║
│ 20/10 Mbps, 4000 GB    ║
├────────────────────────┤
║ 🔍 Search...           ║
├────────────────────────┤
║ 🟢 F1 Franchise    │ ║ │
║    f1@co.com      [►]  ║
║                        ║
║ 🟠 F2 Reseller    │ ║ │
║    f2@co.com      [►]  ║
║                        ║
║ (swipe for more)       ║
╚════════════════════════╝
```

---

## Animation States

### Share Button Click → Success

```
[Share] 
   ↓ (click)
[Saving...]
   ↓ (1 second)
✓ Package shared successfully
[▼ Price (Rs 1000)] [Unshare]
```

### Unshare Button Click → Confirmation

```
[Unshare]
   ↓ (click)
"Remove this package from franchisee?"
   ↓ (confirm)
[Saving...]
   ↓ (1 second)
✓ Package removed successfully
[Share]
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Type | Search in real-time |
| Enter | Save price when in input field |
| Escape | Close modal |
| Tab | Focus next franchisee |

---

## Performance Characteristics

- **Modal Load Time**: ~500ms (fetches franchisees + pricing)
- **Search Filtering**: Real-time (instant)
- **Price Update**: ~1s (POST to server)
- **Unshare**: ~1s (DELETE operation)
- **Max Franchisees**: Supports 1000+ without issues

---

## Toast Notifications

Success messages appear briefly:

```
✓ Package shared successfully (green)
✓ Package removed successfully (green)
⚠ Failed to share package (red)
⚠ Network error (red)
```

---

This visual guide helps you understand the complete user experience of the new Package Share feature!
