# Package Share Modal - Complete Implementation Guide

## Overview

You now have an **enhanced Package Share Modal** that combines group sharing and franchisee pricing in one intuitive interface. When you click the "Share" button on any package, a modern popup opens with search functionality and the ability to set different prices for different franchisees.

---

## What Changed

### Before
- Two separate modals for sharing packages
- Share Modal: Only showed groups
- Franchise Pricing Modal: Required a separate button click
- No search functionality
- Limited visibility of all franchisees

### After ✅
- **One unified modal** for all sharing needs
- Shows all franchisees (resellers, dealers, retailers)
- Search functionality to find specific franchisees
- Expandable pricing interface for each franchisee
- Real-time margin calculations
- Modern, card-based UI design

---

## How It Works

### Opening the Share Modal

1. Go to **Packages** page
2. Find your package in the table (e.g., "E2E-pkg-497770")
3. Click the **Share** button in the action column
4. The new modal opens with all franchisees listed

### Features

#### 1. **Search Functionality** 🔍
- Search by:
  - Franchisee name
  - Email address
  - User role (RESELLER, FRANCHISE, DEALER, RETAILER)
- Real-time filtering as you type
- Shows filtered results matching any criteria

#### 2. **Franchisee List** 👥
Each franchisee card displays:
- **Name** with color-coded indicator
- **Email** address
- **Role** badge (FRANCHISE, RESELLER, DEALER, RETAILER)
- **Subscriber count** (if applicable)
- **Share/Unshare button**
- **Price button** (if already shared)

#### 3. **Pricing Interface** 💰
Once you share a package with a franchisee:
- Click **"Price"** button to expand pricing details
- Shows:
  - **Your Base Price**: The original package price (e.g., Rs 1,000)
  - **Resale Price**: What you sold it to this franchisee for (editable input)
  - **Your Margin**: Calculated automatically (base - resale = your profit)

### Example Workflow

Let's say you have a package at **Rs 1,000** (base price):

1. Open the Share Modal
2. Search for "F2" franchisee
3. Click **Share** button on F2 row
   - Modal says "Package shared successfully"
4. Click **▼ Price (Rs 1000)** button to expand pricing
5. Change "Resale Price" to **Rs 800** 
   - (you want F2 to sell it at 800, so your margin is 200)
6. Press Enter or click away
   - Modal saves automatically
   - Shows your margin: **20% (Rs 200)**

Now F2 sees this package at Rs 800 in their panel and can sell it at their own markup.

---

## Key Features

### Intelligent Sharing

- **Share**: Click to add package to franchisee's catalog
- **Unshare**: Click to remove package and pricing
- **Status**: Card changes color when package is shared (green tint)

### Margin Calculation

Your margin is automatically calculated:
```
Margin % = (Your Base Price - Your Resale Price) / Your Base Price * 100
Margin Amount = Your Base Price - Your Resale Price
```

Example:
- Base: Rs 1,000
- Resale to F2: Rs 800
- **Margin: 20% (Rs 200)**

- Base: Rs 1,000
- Resale to F1: Rs 500
- **Margin: 50% (Rs 500)**

Each franchisee can have a **different price**, so you maximize margins with larger franchisees while offering competitive rates to smaller ones.

---

## Screen Elements

### Header Section
```
📦 Share Package — [Package Name]
20/10 Mbps package with 4000 GB quota
```

### Search Bar
```
🔍 Search franchisees by name, email, or role...
```

### Franchisee Card (Not Shared)
```
🟢 Franchisee Name | FRANCHISE
  user@email.com
  
  [Share] button
```

### Franchisee Card (Shared)
```
🟢 Franchisee Name | FRANCHISE
  user@email.com (4 subs)
  
  [▼ Price (Rs 800)]  [Unshare]
  
  (expanded)
  Your Base Price:  Rs 1,000
  Resale Price:     [800]
  Your Margin:      20% (Rs 200)
```

---

## Technical Details

### API Endpoints Used

The modal communicates with these backend endpoints:

1. **GET** `/users?type=reseller` - Fetch all franchisees
2. **GET** `/organization/franchise-pricing/:packageId` - Get current pricing
3. **PUT** `/organization/franchise-pricing` - Set/update price for franchisee
   ```json
   {
     "userId": 123,
     "packageId": 456,
     "price": 800
   }
   ```
4. **DELETE** `/organization/franchise-pricing/:userId/:packageId` - Remove pricing

### Component Structure

- **File**: `frontend/app/packages/package-share-modal.tsx`
- **Type**: React functional component
- **Props**:
  - `isOpen`: Boolean to show/hide modal
  - `onClose`: Callback to close modal
  - `package`: PackageRow object with pricing details
  - `token`: Authentication token for API calls
  - `onSuccess`: Optional callback after successful operation

---

## Usage Tips

### Best Practices

1. **Different prices for different tiers**:
   - Large franchisees: Lower resale price (e.g., 750)
   - Medium franchisees: Medium price (e.g., 850)
   - Small dealers: Higher price (e.g., 950)

2. **Monitor margins**: Green color indicates profit. Make sure each franchisee's price leaves you with acceptable margin.

3. **Bulk operations**: Use search to quickly find and price packages for similar franchisees.

4. **Hide from view**: Unsharing a package removes it from that franchisee's available packages.

### Search Tips

- Search for "F" to find all franchises starting with F
- Search for "dealer" to find all dealer role users
- Search for email domain like "@gmail" to find specific provider users
- Leave search empty to see all franchisees

---

## What Each Franchisee Sees

When a franchisee logs into their panel:

1. They see packages shared with them at YOUR resale price
2. They can set their own retail price for their customers
3. They cannot see YOUR base price or margin
4. They only see what you've shared with them

### Example from Franchisee Perspective

**ISP Admin** (You):
- Base price: Rs 1,000
- Sold to F2 at: Rs 800
- Your margin: Rs 200

**F2's Panel** (What they see):
- Package available at: Rs 800
- They can set retail price: Rs 1,200
- Their margin: Rs 400
- Their customers pay: Rs 1,200

---

## Troubleshooting

### Modal Not Opening
- Ensure you have active franchisee users
- Check browser console for errors (F12)
- Verify authentication token is valid

### Prices Not Saving
- Check internet connection
- Verify backend is running (`pm2 status`)
- Look for API errors in browser Network tab

### Search Not Working
- Clear search box (it's real-time, no submit button)
- Check that franchisees have names/emails

### No Franchisees Showing
- Create franchisee/reseller users in Organization > Users
- Ensure they have RESELLER or FRANCHISE role
- Refresh the page

---

## File Changes Summary

### Files Modified
1. **frontend/app/packages/package-share-modal.tsx** (NEW)
   - Complete new component for enhanced sharing
   - ~450 lines of React code
   - Handles all franchisee pricing logic

2. **frontend/app/packages/page.tsx**
   - Added import for PackageShareModal
   - Simplified openPackageShare() function
   - Removed old modal JSX
   - Removed unused franchise pricing functions
   - Integrated new component

### No Backend Changes Required
The backend API endpoints already support this feature. No server-side code changes needed.

---

## Next Steps for You

1. ✅ **Code is ready**: No compilation errors
2. 📝 **Test locally**: npm run dev (if testing locally first)
3. 🚀 **Deploy**: Push to GitHub then pull on Ubuntu server
4. 🔍 **Verify**: Click Share button on a package and test
5. 📊 **Monitor**: Check that prices are saving correctly

---

## Commands to Deploy

### On Your Ubuntu Server

```bash
# Navigate to Jointbox
cd /path/to/Jointbox/panel

# Pull latest frontend changes
git pull origin main

# Reinstall dependencies (if needed)
npm install

# Build
npm run build

# Restart frontend
pm2 restart frontend
pm2 logs frontend  # Monitor for errors

# Verify it's running
pm2 status
```

Or if using Docker:
```bash
docker-compose up -d frontend
docker-compose logs -f frontend
```

---

## Feature Benefits

✅ **One unified interface** instead of two separate modals
✅ **Search functionality** to quickly find franchisees
✅ **Real-time margin calculations** for pricing decisions
✅ **Flexible pricing** - each franchisee gets their own rate
✅ **Better UX** - expandable cards save space
✅ **Color-coded** - easily see shared vs unshared packages
✅ **Responsive** - works on mobile and desktop
✅ **No backend changes** - uses existing APIs

---

## Support

If you encounter any issues:

1. Check browser console (F12) for JavaScript errors
2. Check backend logs: `pm2 logs backend`
3. Verify API endpoints are responding: Check Network tab in DevTools
4. Verify authentication: Ensure token is valid
5. Test with curl: `curl http://localhost:3001/organization/franchise-pricing/1`

---

Enjoy your improved package sharing system! 🎉
