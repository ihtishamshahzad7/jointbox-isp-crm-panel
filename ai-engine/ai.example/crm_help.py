"""How-to help for the CRM assistant: where to find things and how to do them, step by step.

Each topic has keywords (English and Roman Urdu) and the steps. A question asking how/where/kaise/kahan
gets the best-matching topic. Keep these in step with the screens when menus change.
"""
import re

INTENT = ('how', 'where', 'what is', 'what are', 'which', 'can i', 'can we', 'add', 'change', 'edit', 'update', 'delete',
          'remove', 'find', 'open', 'enter', 'set', 'create', 'make', 'record', 'upload', 'download', 'use', 'steps', 'guide',
          'help', 'print', 'move', 'transfer', 'assign', 'import', 'export', 'kaise', 'kese', 'kaisay', 'kesay',
          'kahan', 'kahaan', 'kidhar', 'kya', 'kia', 'kaha', 'karna', 'karen', 'karun', 'banana', 'banayen', 'dekhna', 'dekhen', 'lagana')

# Questions asking for figures go to the data lookup instead ("how much was collected", "kitne customers").
FIGURES = ('how much', 'how many', 'kitna', 'kitne', 'kitni', 'total', 'count', 'number of', 'balance of', 'today', 'this month', 'last month')

TOPICS = [
 ('Sign in, password and signing out', ('sign in', 'login', 'log in', 'password', 'sign out', 'logout', 'forgot'),
  'Sign in with your username and password. Change your own password with Password in the top bar; Sign out ends your session. Forgot password: use the link on the sign-in page; it emails a 20-minute link to the employee email linked to your login (email sending must be set up).'),
 ('City picker (show one city)', ('city picker', 'select city', 'choose city', 'one city', 'all cities', 'filter city', 'shehar'),
  'Top bar → City. Choose a city to show only that city\'s customers and their bills, payments, tickets and stock issues across the whole CRM; choose All cities to see everything. The picker turns orange while a city is selected, and is remembered on that browser.'),
 ('Add or change a city', ('add city', 'new city', 'cities', 'city list', 'rename city', 'province'),
  '1. Operations → Company → Cities.\n2. + Add cities: name, province, status Active → Save record.\n3. To rename, click Edit on the city; its areas, companies and customers follow.\nA city cannot be deleted while areas, companies or customers use it; mark it Inactive instead.'),
 ('Add an area', ('area', 'areas', 'new area', 'add area', 'ilaqa'),
  '1. Operations → Company → Areas → + Add areas.\n2. Enter the name, choose the City (from the Cities list), company and zone, status Active → Save record.\nOnly active areas appear in the customer form, and only the areas of the customer\'s chosen city.'),
 ('Add a new customer', ('add customer', 'new customer', 'register customer', 'new connection', 'customer add', 'naya customer', 'new client'),
  '1. Customers → + Add customer (or + New customer on the Dashboard).\n2. Enter name, phone, username, address, City, then Area, package and creation date. Email, CNIC, passport and NTN are optional.\n3. Set the map location (latitude and longitude).\n4. Save. Expiry is creation date + 30 days unless you enter it. The 9-digit customer (payment) ID is created automatically.'),
 ('Edit a customer, change package or expiry', ('edit customer', 'change package', 'package change', 'change expiry', 'customer details', 'update customer', 'upgrade', 'downgrade'),
  'Open the customer (click the name in Customers) → Edit customer to change details, city or area. On the Subscriptions tab use Change package / expiry. An existing agreed monthly fee stays unless the package changes.'),
 ('Customer page tabs', ('customer profile', 'customer page', 'customer account', 'ledger', 'payment history', 'activation cost', 'subscriptions tab'),
  'Click a customer\'s name. Tabs: Subscriptions (package, status, expiry), Documents, Finance (bills and balance), Ledger (every charge and payment with running balance), Payment history, Activation costs, Tickets. Buttons above: Edit customer, + Log ticket, Print invoice, Customer app access, Send app notification, Issue stock, Terminate account, Recharge customer.'),
 ('Upload customer documents', ('document', 'documents', 'cnic copy', 'upload cnic', 'agreement'),
  'Open the customer → Documents tab → choose the file (PDF, JPG, PNG or WebP, up to 5 MB each) and its type → upload. Documents are stored in the CRM database.'),
 ('Recharge / record a payment', ('recharge', 'payment', 'receive payment', 'collect', 'record payment', 'pay bill', 'paisay', 'raqam', 'wasooli'),
  '1. Open the customer → Recharge customer (or Payments → + Add).\n2. Choose the customer (search by 9-digit ID); the amount due fills in.\n3. Choose payment date, billing month, method (Cash, Card, Bank transfer, Mobile wallet) and MRC (monthly bill) or OTC (one-time charge).\n4. Save. A permanent receipt is created. A full current-month payment activates the account and extends expiry by 30 days once per month.'),
 ('Partial payment and partial activation', ('partial', 'half payment', 'less payment', 'carry forward', 'remaining balance', 'baqaya'),
  'Enter the smaller amount when recharging. It is saved but does not activate the account unless an Administrator, Manager or Accountant ticks "Activate now and carry unpaid amount to next bill". The unpaid part is added to next month\'s bill.'),
 ('Print an invoice or receipt', ('print invoice', 'invoice', 'receipt', 'print receipt', 'bill print', 'pdf'),
  'Invoice: open the customer → Print invoice, or Finance → Monthly invoices → View / Print. Receipt: Payments → the payment row → Receipt, or the customer\'s Payment history. Use the browser\'s Print / Save as PDF.'),
 ('Receipt and bill paper size', ('paper size', 'print size', 'receipt size', 'thermal', 'receipt printer', '80mm', '58mm', 'a5', 'a4', 'printing'),
  'Open the receipt or bill → Paper size (next to Print / Save PDF): A4, A5, 80 mm receipt printer or 58 mm receipt printer → Print / Save PDF. Each computer remembers its choice separately for receipts and bills. For receipt printers, also choose the printer\'s roll size in the print window.'),
 ('Receipt and bill design: logo and notes', ('logo', 'logo receipt', 'logo bill', 'note receipt', 'note bill', 'receipt design', 'bill design', 'edit receipt', 'change receipt', 'receipt format', 'customise receipt', 'customize receipt', 'company name on receipt', 'notes on receipt', 'bank details', 'footer'),
  '1. Open any receipt or bill → Customise design (Administrators and Managers).\n2. Upload the logo (PNG, JPG or WebP, up to 1 MB); enter company name, tagline, address, phone, email/website.\n3. Add a receipt note and footer, and a bill note (e.g. bank details) and footer; optionally hide the CRM\'s explanatory notes.\n4. Save design. The preview updates as you type; the design applies to every receipt and bill.'),
 ('Monthly invoices (bills)', ('monthly invoice', 'monthly bill', 'billing', 'bills', 'generate bill', 'invoices'),
  'Finance → Monthly invoices. The CRM creates one bill per active customer each month automatically, showing the month\'s charge, previous unpaid balance and total. Stock charged to a customer is added as an equipment charge in that month.'),
 ('Expiry dates and expired customers', ('expiry', 'expire', 'expired', 'expiry date', 'due date', 'renewal'),
  'Customers list → Expiry date column shows each customer\'s expiry with days left (red when expired, amber within 7 days). The Dashboard shows expired accounts; Reports → Expiry Report lists them for any dates. Recharging extends expiry by 30 days.'),
 ('Terminate a customer', ('terminate', 'termination', 'disconnect permanently', 'close account', 'band karna', 'reason'),
  'Open the customer → Terminate account → choose the reason from the list (shifted to another ISP, relocated, non-payment, slow speed, frequent disconnections, price too high, no longer needs internet, complaint not resolved, duplicate/test, other) and add details → confirm. If CRM equipment is still with the customer, a recovery task is created.'),
 ('Device recovery', ('device recovery', 'equipment recovery', 'recover router', 'recovery'),
  'Inventory → Device recovery lists terminated (or long-expired) customers who still hold equipment. Return the devices to stock to complete the recovery; recovery tickets close automatically when everything required is returned or the customer recharges.'),
 ('Tickets (complaints and jobs)', ('ticket', 'complaint', 'fault', 'job', 'assign ticket', 'shikayat', 'log ticket'),
  '1. Tickets → + New ticket (or + Log ticket on the customer page).\n2. Subject, customer, type, priority, assigned staff → Save.\n3. Move it Open → In progress → Awaiting customer → Resolved → Closed. Assign someone before In progress; Resolved/Closed need resolution notes.\nTechnicians see only their tickets.'),
 ('TAT (target time) for tickets', ('tat', 'turnaround', 'target time', 'overdue', 'deadline'),
  'Settings → TAT settings: hours allowed for each ticket type and priority. New tickets get their due time from it; late tickets show as Overdue on Tickets and the Dashboard.'),
 ('Add stock (new batch) and prices', ('add stock', 'add inventory', 'new batch', 'batch', 'purchase stock', 'selling price', 'unit cost', 'maal'),
  '1. Inventory → + Add (or New batch on an item row).\n2. Item, category, Warehouse, quantity, minimum stock, unit cost (what you paid) and selling price. The batch number (e.g. B-2610-003) fills in automatically.\n3. Attach the supplier invoice → Save. Each batch keeps its own cost and selling price.'),
 ('Supplier and expense invoices (files)', ('invoice upload', 'upload invoice', 'attach invoice', 'bill photo', 'supplier invoice'),
  'Attach in the Inventory or Expense form when adding it, or later with the Invoices button on the row (shows the count, e.g. Invoices (2)). PDF or photo, up to 5 MB each.'),
 ('Add a warehouse', ('warehouse', 'add warehouse', 'store', 'godown', 'wh'),
  '1. Operations → Inventory → Warehouses → + Add warehouses.\n2. Name, code, branch, address, keeper, status Active → Save record.\nEvery inventory batch belongs to one warehouse; Main Store holds the original stock.'),
 ('Move stock between warehouses', ('transfer', 'move stock', 'shift stock', 'stock transfer', 'another warehouse'),
  'Inventory → the item\'s row → Transfer → choose the destination warehouse and quantity → Transfer stock. The batch keeps its cost and price at the new warehouse; QR-tracked devices move with it. A warehouse with stock cannot be deleted.'),
 ('Issue stock to a customer or the network', ('issue stock', 'stock issue', 'give router', 'issue router', 'router', 'ont', 'give stock', 'stock movement', 'deduct stock', 'waive', 'discount'),
  '1. Inventory → Stock movements → + Add, or Issue stock on the customer page.\n2. Choose Warehouse → Item → Batch (or scan the QR label).\n3. Issued against Customer, System or Network; customer or destination; employee (optional); quantity.\n4. For customers choose pricing: Charge (batch selling price), Discount (percent off) or Waived (free) → Save. Stock is deducted from that warehouse; charges go to the customer\'s ledger.'),
 ('Read a device label from a photo', ('photo', 'device photo', 'label', 'mac', 'serial', 'scan label', 'picture'),
  'In the stock issue form, take or upload a photo of the router/ONT label. The CRM reads make, model, MAC and serial number on the computer (no internet needed) and fills them in; check and correct them. If nothing is found, type them. Press Ctrl+F5 if the page says it is out of date.'),
 ('Return or delete a stock issue', ('return stock', 'return', 'delete stock issue', 'undo issue', 'wapas'),
  'Inventory → Stock movements → Return stock on the row puts the full quantity back to its warehouse once and keeps the record. Only an Administrator can Delete a stock issue entered by mistake.'),
 ('QR labels for devices', ('qr', 'qr code', 'qr label', 'stocktake'),
  'Inventory → QR tools: register devices with serial numbers, print QR labels and scan them when issuing or returning. Stocktake compares expected and scanned devices without silently changing quantities.'),
 ('Add an expense', ('expense', 'add expense', 'kharcha', 'spend', 'bill paid', 'salary paid', 'electricity'),
  '1. Expenses → + Add.\n2. Title, category, payee, amount, status (Paid with date and method, Pending or Cancelled), reference.\n3. Tick "Charge this cost to a specific customer (activation cost)" only for a customer\'s connection cost.\n4. Attach the bill → Save. Only Paid expenses count in profit.'),
 ('Packages, service provider and cost', ('package', 'packages', 'service provider', 'provider', 'monthly cost', 'package price', 'speed', 'active customers'),
  'Settings → Packages: name, service provider (Transworld Panel, Nayatel bandwidth, Transworld Bandwidth), speed, monthly price, monthly cost, installation fee, status. The list shows Active customers per package. Transworld Panel uses the package\'s own Monthly cost; bandwidth providers get their cost from the monthly peak.'),
 ('Change bandwidth peak and price per Mbps', ('peak', 'price per mbps', 'per mbps', 'bandwidth peak', 'nayatel', 'transworld bandwidth', 'bandwidth cost', 'month end'),
  '1. Operations → Bandwidth → Bandwidth peaks.\n2. Edit the provider\'s month to change Peak Mbps or Price per Mbps, or + Add bandwidth peaks for a new month → Save record.\nCost per bill = peak × (package speed ÷ total speed billed on that provider) × price per Mbps. From the last 3 days of each month an orange Dashboard reminder (Enter now) asks for missing peaks.'),
 ('Profit and loss / business health', ('profit', 'loss', 'p&l', 'net profit', 'business health', 'margin', 'munafa', 'nuqsan'),
  'Reports → Business Health (Net Profit) or Profit & Loss Statement, choose From/To dates. Also on the Dashboard (Profit & loss panel, pick a month). Revenue = money collected; costs = package cost of bills raised + Paid expenses. Stock issued is shown separately and not deducted.'),
 ('Reports and exporting', ('report', 'reports', 'export', 'csv', 'excel', 'collection report', 'daily sales'),
  'Reports → choose the report, set From and To dates, search within it, then Export CSV (opens in Excel) or Print. Reports include collections, staff collection, accounts, daily sales, transactions, recharges, packages, expiry, promises and inventory reconciliation.'),
 ('Dashboard', ('dashboard', 'customize dashboard', 'home page', 'overview'),
  'Dashboard is the first page. Customize Dashboard hides or shows panels (Save layout); Refresh reloads the numbers. It shows collections, network overview, profit & loss, tickets, stock watch and recent receipts.'),
 ('Add staff and reporting hierarchy', ('staff', 'employee', 'add staff', 'add employee', 'hierarchy', 'reports to', 'designation', 'salary'),
  'Staff → + Add: identity, contact, role, area, designation, department, joining date, salary and bank details → Save. The employee code is automatic. Choose Reports to for the hierarchy. Settings → Designations manages the designation list.'),
 ('Users, roles and permissions', ('user', 'users', 'role', 'roles', 'permission', 'rights', 'access', 'new login'),
  'Settings → Users (Administrator only): + Add with name, username, designation, role and linked employee; set Inactive to block sign-in. Roles: Administrator (everything), Manager (all business pages), Accountant (payments, expenses), Support (customers, tickets), Technician (own tickets and stock issues), Storekeeper (inventory, stock issues), Viewer (read only).'),
 ('Network map', ('network map', 'map', 'satellite', 'full screen', 'fullscreen', 'zoom'),
  'Operations → Network → Network map. Zoom with + and −; switch Streets/Satellite at the top right and tick layers. ⛶ Full screen enlarges the map (also inside cable and POP forms); Esc returns. Click anything on the map to open it.'),
 ('Add a POP, DC, FAT or other device on the map', ('pop', 'dc', 'fat', 'fdt', 'olt', 'splitter', 'joint', 'pin', 'add pop', 'add fat', 'device'),
  '1. Network map → + POP, + DC, + FAT, + FDT, + OLT or + Device.\n2. Click its exact place on the map.\n3. Fill in the name and details; choose a Stock item to deduct 1 unit from that warehouse → Save. Every entry gets an ID such as POP-001 or FAT-012.'),
 ('Draw a fiber cable', ('fiber', 'fibre', 'cable', 'route', 'draw cable', 'lay cable', 'core'),
  '1. Network map → + Fiber cable.\n2. Click along the cable path (Undo last point / Clear route to fix); length is calculated.\n3. Cable type, core count, status, start/end devices, Cable stock item (choose the warehouse batch) → Save. Non-Planned cables deduct their length from stock; deleting or setting back to Planned returns it.'),
 ('Upload or download KMZ', ('kmz', 'kml', 'google earth', 'upload kmz', 'download kmz', 'import map'),
  'Download: Network map → Download KMZ (opens in Google Earth). Upload: Network map → Upload KMZ → choose the .kmz/.kml → check what each pin and line is (POP, FAT, cable, Skip), choose the zone and cable details → Add items to the map. Items already on the map are skipped; nothing is taken from stock.'),
 ('Zones, sub zones and branches', ('zone', 'zones', 'branch', 'branches', 'company', 'companies', 'office'),
  'Operations → Company → Companies / Branches (offices), and Operations → Network → Zones / Sub zones. Zones group POPs and can belong to a branch; areas can link to a zone.'),
 ('Payroll', ('payroll', 'salary sheet', 'pay salary', 'tankhwa'),
  'Operations → People → Payroll → Generate month creates salary records from staff salaries; review, then Pay / post expense records the paid salary as an expense (no bank transfer is made).'),
 ('Purchasing: vendors, requisitions and purchase bills', ('vendor', 'supplier', 'requisition', 'purchase bill', 'purchase', 'buy'),
  'Operations → Purchasing: Vendors (suppliers), Requisitions (stock requests a manager approves), Purchase bills (Receive stock adds to inventory; Pay / post expense records the payment).'),
 ('Field collections and approvals', ('collection approval', 'field collection', 'collector', 'approve payment'),
  'Operations → Finance → Collection approvals: collectors submit money collected; finance Approves to post the payment and receipt (and recharge if due).'),
 ('Customer portal access', ('customer portal', 'customer app', 'app access', 'customer login', 'notification'),
  'Open the customer → Customer app access to create their login (9-digit ID and password). Customers use the /customer/ page to see bills, receipts, expiry and tickets and send requests. Send app notification posts a message to their portal.'),
 ('Import customers from CSV or change many statuses', ('csv', 'import customers', 'bulk', 'bulk status', 'many customers'),
  'Operations → Customer tools → Import customers CSV (up to 200 rows: name, phone, username, package, latitude, longitude; all rows save together or none) or Bulk customer status (Active, Suspended, Disconnected).'),
 ('Themes and layout', ('theme', 'dark', 'light', 'glossy', 'layout', 'colour', 'color'),
  'Top bar → Theme: Light, Dark or Glossy (colours only). Layout switches between Standard and Studio. Both are remembered on that browser.'),
 ('Where data is stored and backups', ('backup', 'data stored', 'database', 'where is data', 'save data', 'restore'),
  'All data is in the PostgreSQL database "ispcrm" on the CRM computer, including uploaded files. Backups are .dump files in the CRM folder\'s backups folder; keep a copy off the computer (USB or cloud).'),
 ('CRM assistant', ('assistant', 'chatbot', 'ask'),
  'Ask how or where to do something (e.g. "where do I add a warehouse?") for steps, or ask for figures (e.g. "collections this month", a customer\'s name or ID). The assistant only reads; it cannot change anything.'),
]


def words(text):
    return ' ' + re.sub(r'[^a-z0-9&+]+', ' ', text.lower()) + ' '


def tokens(text):
    # Whole words, with simple plurals folded ("customers" -> "customer").
    return {w[:-1] if len(w) > 3 and w.endswith('s') and not w.endswith('ss') else w for w in words(text).split()}


def best_topic(question):
    q = tokens(question)
    scored = []
    for title, keys, answer in TOPICS:
        # A keyword counts when all its words are in the question, in any order ("customer kaise add" = "add customer").
        score = sum(len(k.split()) * 2 for k in keys if tokens(k) <= q)
        if score:
            scored.append((score, -len(scored), title, answer))
    return max(scored)[2:] if scored else None


def help_answer(question):
    """Steps for a how/where question, or None when it is not a how-to question or nothing matches."""
    q = words(question)
    if not any(words(w) in q for w in INTENT) or any(words(w) in q for w in FIGURES):
        return None
    topic = best_topic(question)
    return f'{topic[0]}\n{topic[1]}' if topic else None
