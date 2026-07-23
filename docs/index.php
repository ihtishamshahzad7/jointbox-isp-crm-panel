<?php /* Jointbox Panel — User Documentation. Serve with any PHP/static host, or open the file directly in a browser. */ ?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Jointbox Panel — User Guide &amp; Documentation</title>
<style>
  :root{
    --bg:#0c1220; --card:#151f30; --border:#1e2d47; --row:#0f1a2e;
    --text:#e2e8f0; --muted:#64748b; --sub:#94a3b8;
    --accent:#0ea5e9; --green:#22c55e; --amber:#f59e0b; --red:#ef4444; --purple:#8b5cf6;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--text);font-family:'DM Sans','Segoe UI',system-ui,sans-serif;font-size:15px;line-height:1.65}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  code{background:#0a1424;border:1px solid var(--border);border-radius:5px;padding:1px 6px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:.86em;color:#7dd3fc}
  pre{background:#0a1424;border:1px solid var(--border);border-radius:10px;padding:14px 16px;overflow-x:auto;font-family:ui-monospace,monospace;font-size:.85em;color:#cbd5e1}
  h1,h2,h3{line-height:1.25}
  .layout{display:flex;min-height:100vh}

  /* Sidebar */
  .side{width:290px;flex-shrink:0;background:#0a101d;border-right:1px solid var(--border);position:sticky;top:0;height:100vh;overflow-y:auto;padding:20px 14px}
  .brand{display:flex;align-items:center;gap:10px;padding:6px 8px 16px}
  .brand .mark{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--accent),#2563eb);display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff}
  .brand b{font-size:16px}
  .brand small{display:block;color:var(--muted);font-size:11px;font-weight:600}
  .search{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:9px 12px;color:var(--text);font-size:13px;margin-bottom:12px}
  .nav-group{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700;margin:14px 8px 6px}
  .side a.nav{display:block;padding:7px 10px;border-radius:7px;color:var(--sub);font-size:13.5px;font-weight:500}
  .side a.nav:hover{background:var(--row);color:var(--text);text-decoration:none}

  /* Content */
  .main{flex:1;min-width:0}
  .wrap{max-width:900px;margin:0 auto;padding:40px 34px 90px}
  .hero{background:linear-gradient(135deg,#12233b,#0d1a2e);border:1px solid var(--border);border-radius:16px;padding:30px 32px;margin-bottom:34px}
  .hero h1{margin:0 0 8px;font-size:30px}
  .hero p{margin:0;color:var(--sub)}
  section{scroll-margin-top:20px;margin-bottom:40px;border-bottom:1px solid var(--border);padding-bottom:34px}
  section:last-child{border-bottom:none}
  section h2{font-size:23px;margin:0 0 4px;display:flex;align-items:center;gap:10px}
  .tag{font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px;background:rgba(14,165,233,.15);color:var(--accent);text-transform:uppercase;letter-spacing:.04em}
  section > p.lead{color:var(--sub);margin:0 0 16px}
  h3{font-size:16px;margin:22px 0 8px;color:#cbd5e1}
  ol,ul{padding-left:22px;margin:8px 0}
  li{margin:5px 0}
  .steps{counter-reset:s;list-style:none;padding-left:0}
  .steps>li{counter-increment:s;position:relative;padding:8px 0 8px 40px;border-bottom:1px dashed var(--border)}
  .steps>li:last-child{border-bottom:none}
  .steps>li::before{content:counter(s);position:absolute;left:0;top:8px;width:26px;height:26px;border-radius:50%;background:var(--accent);color:#fff;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center}
  .note{border-left:3px solid var(--accent);background:var(--card);border-radius:0 8px 8px 0;padding:11px 15px;margin:14px 0;font-size:14px;color:var(--sub)}
  .note.tip{border-color:var(--green)}
  .note.warn{border-color:var(--amber)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:14px 0}
  .mini{background:var(--card);border:1px solid var(--border);border-radius:11px;padding:14px 16px}
  .mini b{display:block;margin-bottom:3px}
  .mini span{font-size:13px;color:var(--muted)}
  table{width:100%;border-collapse:collapse;margin:14px 0;font-size:14px}
  th,td{text-align:left;padding:9px 11px;border-bottom:1px solid var(--border)}
  th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .pill{font-size:11px;padding:2px 8px;border-radius:20px;font-weight:700}
  .top{position:fixed;right:22px;bottom:22px;background:var(--accent);color:#fff;border:none;border-radius:50%;width:44px;height:44px;font-size:20px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.4);display:none}
  @media(max-width:820px){.side{display:none}.wrap{padding:24px 18px 80px}}
</style>
</head>
<body>
<div class="layout">
  <!-- SIDEBAR -->
  <aside class="side">
    <div class="brand">
      <div class="mark">J</div>
      <div><b>Jointbox</b><small>User Guide</small></div>
    </div>
    <input id="q" class="search" placeholder="Search the guide…" oninput="filterNav()" />

    <div class="nav-group">Getting started</div>
    <a class="nav" href="#intro">Introduction</a>
    <a class="nav" href="#login">Logging in &amp; 2FA</a>
    <a class="nav" href="#dashboard">Dashboard</a>

    <div class="nav-group">Customers &amp; service</div>
    <a class="nav" href="#subscribers">Subscribers</a>
    <a class="nav" href="#packages">Packages</a>
    <a class="nav" href="#ippools">IP Pools</a>
    <a class="nav" href="#areas">Areas</a>
    <a class="nav" href="#vouchers">Vouchers</a>

    <div class="nav-group">Network</div>
    <a class="nav" href="#nas">NAS / Routers</a>
    <a class="nav" href="#network">Live Network</a>
    <a class="nav" href="#trace">Trace Search</a>

    <div class="nav-group">Money</div>
    <a class="nav" href="#invoices">Invoices</a>
    <a class="nav" href="#payments">Payments</a>
    <a class="nav" href="#accounting">Accounting</a>

    <div class="nav-group">Resellers</div>
    <a class="nav" href="#organization">Organization &amp; hierarchy</a>
    <a class="nav" href="#pricing">Reseller Pricing</a>
    <a class="nav" href="#prepaid">Prepaid money &amp; profit</a>
    <a class="nav" href="#wallet">Wallet &amp; top-up</a>
    <a class="nav" href="#actas">Profile Switch (Act as)</a>

    <div class="nav-group">Operations</div>
    <a class="nav" href="#communication">Communication</a>
    <a class="nav" href="#complaints">Complaints / Tickets</a>
    <a class="nav" href="#reports">Reports</a>
    <a class="nav" href="#logs">Logs</a>
    <a class="nav" href="#security">Security &amp; Permissions</a>
    <a class="nav" href="#portal">Subscriber Portal</a>
    <a class="nav" href="#users">Staff Users</a>

    <div class="nav-group">Reference</div>
    <a class="nav" href="#glossary">Glossary</a>
    <a class="nav" href="#faq">FAQ</a>
  </aside>

  <!-- CONTENT -->
  <main class="main"><div class="wrap">

    <div class="hero">
      <h1>Jointbox Panel — Complete User Guide</h1>
      <p>Everything you need to run your ISP: manage customers, control the network, bill and collect money, and grow a reseller network. Each section below explains what a feature does and walks you through using it, step by step.</p>
    </div>

    <!-- INTRO -->
    <section id="intro">
      <h2>Introduction <span class="tag">Start here</span></h2>
      <p class="lead">Jointbox is an all-in-one control panel for Internet Service Providers. It ties together your customers, your routers (via FreeRADIUS/PPPoE), your billing, and your reseller chain in one place.</p>
      <div class="grid">
        <div class="mini"><b>Customers</b><span>Create, activate, suspend and track every subscriber.</span></div>
        <div class="mini"><b>Network</b><span>See who is online live, disconnect, and bind MAC addresses.</span></div>
        <div class="mini"><b>Billing</b><span>Invoices, payments, a full accounting ledger and automation.</span></div>
        <div class="mini"><b>Resellers</b><span>A tiered hierarchy where each level sets its own prices and profits.</span></div>
      </div>
      <div class="note tip">New here? Read <a href="#login">Logging in</a> → <a href="#dashboard">Dashboard</a> → <a href="#subscribers">Subscribers</a> first. That covers 80% of daily work.</div>
    </section>

    <!-- LOGIN -->
    <section id="login">
      <h2>Logging in &amp; Two-Factor</h2>
      <p class="lead">Open the panel in your browser and sign in with the email and password your administrator gave you.</p>
      <ol class="steps">
        <li>Go to the panel address (e.g. <code>http://your-server/</code>) and enter your <b>email</b> and <b>password</b>.</li>
        <li>If two-factor authentication (2FA) is enabled on your account, you will also be asked for a 6-digit code from your authenticator app.</li>
        <li>After login you land on the <a href="#dashboard">Dashboard</a>. The left sidebar is your menu; the top bar shows your name, the clock, and (for resellers) the <a href="#actas">Act as</a> switcher.</li>
      </ol>
      <div class="note">Forgot your password or locked out? Ask your ISP administrator to reset it from the <a href="#users">Users</a> page.</div>
    </section>

    <!-- DASHBOARD -->
    <section id="dashboard">
      <h2>Dashboard</h2>
      <p class="lead">Your home screen — a live snapshot of the business the moment you log in.</p>
      <h3>What you see</h3>
      <ul>
        <li><b>Subscriber totals</b> — total, active, expired, suspended, and how many are online right now.</li>
        <li><b>Money</b> — collected today/this month, and outstanding dues.</li>
        <li><b>Network</b> — online sessions and recent activity.</li>
      </ul>
      <div class="note tip">Every number on the dashboard is scoped to <b>you</b>. An ISP sees the whole business; a dealer sees only its own downline and their customers.</div>
    </section>

    <!-- SUBSCRIBERS -->
    <section id="subscribers">
      <h2>Subscribers</h2>
      <p class="lead">Your customers. This is where you add a new connection, change a plan, suspend for non-payment, or reconnect.</p>
      <h3>Add a new subscriber</h3>
      <ol class="steps">
        <li>Open <b>Subscribers</b> and click <b>+ Add Subscriber</b>.</li>
        <li>Fill in the name, phone, and a unique <b>username</b> and <b>password</b> (these are the PPPoE login the customer's router uses).</li>
        <li>Pick a <b>Package</b> (the speed plan) and, if used, an <b>Area</b> and <b>NAS/router</b>.</li>
        <li>Save. Jointbox automatically writes the login and speed limit into FreeRADIUS, so the customer can connect immediately.</li>
      </ol>
      <h3>Everyday actions</h3>
      <ul>
        <li><b>Edit</b> — change plan, password, or details (changes re-sync to the network automatically).</li>
        <li><b>Suspend / Activate</b> — cut off or restore service instantly.</li>
        <li><b>Search &amp; filter</b> — by status, package, area, salesperson, or date.</li>
        <li><b>Export</b> — download the list as a spreadsheet.</li>
      </ul>
      <div class="note warn">A subscriber can only exist on the network if it exists here first. Never edit RADIUS by hand — always use this page so billing and the network stay in sync.</div>
    </section>

    <!-- PACKAGES -->
    <section id="packages">
      <h2>Packages</h2>
      <p class="lead">Speed plans. A package defines download/upload speed, price, validity (days), and optional burst and IP-pool settings.</p>
      <ol class="steps">
        <li>Open <b>Packages</b> and click <b>+ Add Package</b>.</li>
        <li>Set a name, price, <b>download/upload speed</b> (in Mbps) and <b>duration</b> in days.</li>
        <li>Optionally set burst speeds and assign an <a href="#ippools">IP Pool</a>.</li>
        <li>Save. The package is now selectable when creating or editing subscribers.</li>
      </ol>
      <div class="note">The speed you set here becomes the <code>Mikrotik-Rate-Limit</code> pushed to the router — so changing a subscriber's package instantly changes their real speed.</div>
    </section>

    <!-- IP POOLS -->
    <section id="ippools">
      <h2>IP Pools</h2>
      <p class="lead">Ranges of IP addresses the router hands out to connected customers. Assign a pool to a package and every subscriber on that package draws an address from it.</p>
      <ol class="steps">
        <li>Open <b>IP Pools</b> → <b>+ Add Pool</b>.</li>
        <li>Give it a name and the address range (matching the pool name configured on your MikroTik).</li>
        <li>Attach the pool to a package on the <a href="#packages">Packages</a> page.</li>
      </ol>
    </section>

    <!-- AREAS -->
    <section id="areas">
      <h2>Areas</h2>
      <p class="lead">Coverage zones (neighbourhoods, towers, buildings). Tagging subscribers by area helps with reporting and field work.</p>
      <ol class="steps">
        <li>Open <b>Areas</b> → <b>+ Add Area</b>.</li>
        <li>Enter a name, city and optional description; save.</li>
        <li>Select the area when creating or editing a subscriber.</li>
      </ol>
    </section>

    <!-- VOUCHERS -->
    <section id="vouchers">
      <h2>Vouchers</h2>
      <p class="lead">Prepaid recharge cards. Generate a batch of code+PIN cards that customers redeem to top up or activate service.</p>
      <ol class="steps">
        <li>Open <b>Vouchers</b> → <b>+ Create Batch</b>.</li>
        <li>Choose how many cards, the value, and any package link; generate.</li>
        <li>Print/sell the cards. When a customer redeems a code, the value is applied automatically.</li>
      </ol>
    </section>

    <!-- NAS -->
    <section id="nas">
      <h2>NAS / Routers</h2>
      <p class="lead">Your MikroTik (or other) routers that terminate customer PPPoE sessions. Register each router here so FreeRADIUS trusts it and you can monitor it.</p>
      <ol class="steps">
        <li>Open <b>NAS / Routers</b> → <b>Add NAS</b>.</li>
        <li>Enter the router's <b>IP address</b>, a name, the <b>RADIUS secret</b> (must match the router), and the <b>API username/password</b> (lets Jointbox read CPU, uptime and live sessions).</li>
        <li>Save. The router is registered in RADIUS; click a router to see its live details and a reachability check.</li>
      </ol>
      <div class="note warn">The RADIUS secret and the router IP must match exactly on both sides, or the router's login requests will be ignored.</div>
    </section>

    <!-- LIVE NETWORK -->
    <section id="network">
      <h2>Live Network</h2>
      <p class="lead">A real-time view of everyone online right now — auto-refreshing every few seconds.</p>
      <ul>
        <li>See each online customer's IP, MAC, uptime, and live download/upload usage.</li>
        <li><b>Disconnect</b> a session with one click.</li>
        <li><b>Bind a MAC address</b> so a customer can only connect from their own device (or auto-learn it from the live session).</li>
      </ul>
    </section>

    <!-- TRACE -->
    <section id="trace">
      <h2>Trace Search</h2>
      <p class="lead">One search box across the whole system. Type a name, username, phone, IP or invoice number and jump straight to it — plus a full timeline of everything that happened to that subscriber.</p>
      <div class="note tip">Use this when a customer calls: search their number, open their timeline, and you instantly see logins, payments, plan changes and tickets in order.</div>
    </section>

    <!-- INVOICES -->
    <section id="invoices">
      <h2>Invoices</h2>
      <p class="lead">Billing documents for your customers. Create an invoice, then record payment against it.</p>
      <ol class="steps">
        <li>Open <b>Invoices</b> → <b>+ Create Invoice</b>.</li>
        <li>Pick the subscriber, add the amount, tax and any discount; save.</li>
        <li>When the customer pays, click the 💰 <b>Record payment</b> action on that invoice and enter the amount and method.</li>
      </ol>
      <div class="note">Recording a payment automatically updates the invoice's paid/due amounts and status, and (if enabled) renews the subscriber.</div>
    </section>

    <!-- PAYMENTS -->
    <section id="payments">
      <h2>Payments</h2>
      <p class="lead">Every payment collected, in one ledger. Payments are created against invoices (see above), then listed and totalled here.</p>
      <ul>
        <li>Filter by date, method (cash, bKash, card, etc.) or subscriber.</li>
        <li>See totals collected and drill into any single receipt.</li>
        <li>Online gateway payments (from the <a href="#portal">portal</a>) also land here automatically.</li>
      </ul>
    </section>

    <!-- ACCOUNTING -->
    <section id="accounting">
      <h2>Accounting</h2>
      <p class="lead">A real double-entry ledger — the financial backbone. Every payment, expense and reseller movement is recorded so your books always balance.</p>
      <ul>
        <li><b>Income &amp; expenses</b> — record business costs alongside revenue.</li>
        <li><b>Ledger</b> — a complete, auditable trail of every transaction.</li>
        <li><b>Billing automation</b> — scheduled jobs generate invoices and expiry actions on time, without manual work.</li>
      </ul>
    </section>

    <!-- ORGANIZATION -->
    <section id="organization">
      <h2>Organization &amp; Hierarchy</h2>
      <p class="lead">Your reseller network as a tree: <b>ISP → Franchise → Dealer → Sub-dealer → Retailer</b>. Each level can create the level below it and manage its own customers.</p>
      <h3>How the hierarchy works</h3>
      <ol class="steps">
        <li>The <b>ISP</b> (top) creates <b>Franchises</b>.</li>
        <li>Each Franchise creates its own <b>Dealers</b>; each Dealer creates <b>Sub-dealers</b>; and so on down to <b>Retailers</b>.</li>
        <li>Anyone you create becomes part of <b>your</b> branch — they attach directly beneath you.</li>
        <li>Each reseller has a <b>wallet</b> (prepaid balance) you can top up or withdraw from here.</li>
      </ol>
      <h3>Who can see what</h3>
      <div class="note tip">Everyone sees only <b>their own branch</b>. A franchise sees its dealers and everything beneath them — but never another franchise's tree. A dealer sees only its own sub-dealers and their customers. The ISP (and only the platform owner) sees everything.</div>
    </section>

    <!-- PRICING -->
    <section id="pricing">
      <h2>Reseller Pricing</h2>
      <p class="lead">The wholesale price ladder. Each tier sets the price it charges the tier directly below it — and keeps the difference as profit.</p>
      <h3>Set your prices</h3>
      <ol class="steps">
        <li>Open <b>Reseller Pricing</b>. You'll see every package with a <b>base price</b> and a <b>my price</b> column.</li>
        <li>Type the price you charge <b>your downline</b> for a package and click <b>Save</b>.</li>
        <li>Your downline does the same for the level beneath them.</li>
      </ol>
      <h3>How profit flows (example)</h3>
      <table>
        <tr><th>Tier</th><th>Buys at</th><th>Sells at</th><th>Profit</th></tr>
        <tr><td>ISP (base)</td><td>—</td><td>250</td><td>—</td></tr>
        <tr><td>Franchise</td><td>250</td><td>300</td><td><span class="pill" style="background:#14311f;color:#4ade80">+50</span></td></tr>
        <tr><td>Dealer</td><td>300</td><td>400</td><td><span class="pill" style="background:#14311f;color:#4ade80">+100</span></td></tr>
        <tr><td>Sub-dealer</td><td>400</td><td>500</td><td><span class="pill" style="background:#14311f;color:#4ade80">+100</span></td></tr>
        <tr><td>Retailer → Customer</td><td>500</td><td>retail</td><td>set by retailer</td></tr>
      </table>
      <p>When a subscriber is activated, the activator's wallet is charged its buy price, each tier above is credited its markup, and the ISP account is reduced by the base cost. Use the <b>Activation profit preview</b> box (enter a subscriber ID) to see the exact split before it happens.</p>
      <div class="note">Every movement is written to each reseller's wallet history, so profits are fully traceable per customer.</div>
      <div class="note tip">Any tier can also set its <b>own retail price</b> on a customer it serves directly — see "Prepaid money &amp; profit" below.</div>
    </section>

    <!-- PREPAID MONEY & PROFIT -->
    <section id="prepaid">
      <h2>Prepaid money &amp; profit <span class="tag">how you earn</span></h2>
      <p class="lead">Think of it like a chocolate shop chain. The factory sells cheap to a big shop, the big shop sells a little dearer to a small shop, and so on down to you. Everyone buys cheaper and sells dearer — the little extra each keeps is their profit. Jointbox writes down every step automatically.</p>

      <h3>The price ladder (example: Home 10&nbsp;Mbps)</h3>
      <div class="grid">
        <div class="mini"><b>ISP → Franchise</b><span>250</span></div>
        <div class="mini"><b>Franchise → Dealer</b><span>300</span></div>
        <div class="mini"><b>Dealer → Retailer</b><span>400</span></div>
        <div class="mini"><b>Retailer → Customer</b><span>500 (retail)</span></div>
      </div>

      <h3>What happens when a subscriber is activated</h3>
      <svg viewBox="0 0 720 470" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:640px;display:block;margin:10px 0" role="img" aria-label="Activation flow">
        <defs>
          <marker id="da" markerWidth="9" markerHeight="9" refX="5" refY="4.5" orient="auto"><path d="M1,1 L8,4.5 L1,8" fill="none" stroke="#64748b" stroke-width="1.6"/></marker>
          <marker id="dg" markerWidth="9" markerHeight="9" refX="5" refY="4.5" orient="auto"><path d="M1,1 L8,4.5 L1,8" fill="none" stroke="#22c55e" stroke-width="1.6"/></marker>
          <marker id="dr" markerWidth="9" markerHeight="9" refX="5" refY="4.5" orient="auto"><path d="M1,1 L8,4.5 L1,8" fill="none" stroke="#ef4444" stroke-width="1.6"/></marker>
        </defs>
        <rect x="200" y="10" width="320" height="42" rx="9" fill="#0b2942" stroke="#0ea5e9"/><text x="360" y="30" text-anchor="middle" font-size="13" font-weight="700" fill="#e2e8f0">Reseller adds subscriber</text><text x="360" y="45" text-anchor="middle" font-size="10" fill="#94a3b8">picks package + sets retail price</text>
        <line x1="360" y1="52" x2="360" y2="70" stroke="#64748b" stroke-width="1.5" marker-end="url(#da)"/>
        <rect x="200" y="72" width="320" height="42" rx="9" fill="#151f30" stroke="#1e2d47"/><text x="360" y="92" text-anchor="middle" font-size="12" font-weight="700" fill="#e2e8f0">Compute cost · sell · profit</text><text x="360" y="107" text-anchor="middle" font-size="10" fill="#94a3b8">profit = sell − cost</text>
        <line x1="360" y1="114" x2="360" y2="132" stroke="#64748b" stroke-width="1.5" marker-end="url(#da)"/>
        <polygon points="360,134 500,172 360,210 220,172" fill="#3a2a0a" stroke="#f59e0b"/><text x="360" y="170" text-anchor="middle" font-size="12" font-weight="700" fill="#e2e8f0">Wallet ≥ cost?</text><text x="360" y="185" text-anchor="middle" font-size="9" fill="#94a3b8">ISP is exempt</text>
        <line x1="500" y1="172" x2="590" y2="172" stroke="#ef4444" stroke-width="1.6" marker-end="url(#dr)"/><text x="525" y="165" font-size="10" fill="#ef4444" font-weight="700">NO</text>
        <rect x="590" y="150" width="120" height="44" rx="9" fill="#450a0a" stroke="#ef4444"/><text x="650" y="170" text-anchor="middle" font-size="11" font-weight="700" fill="#fca5a5">Blocked</text><text x="650" y="185" text-anchor="middle" font-size="9" fill="#fca5a5">top up needed</text>
        <text x="373" y="226" font-size="10" fill="#22c55e" font-weight="700">YES</text>
        <line x1="360" y1="210" x2="360" y2="236" stroke="#22c55e" stroke-width="1.6" marker-end="url(#dg)"/>
        <rect x="200" y="238" width="320" height="42" rx="9" fill="#151f30" stroke="#1e2d47"/><text x="360" y="258" text-anchor="middle" font-size="12" font-weight="700" fill="#e2e8f0">Online + auto-invoice at retail</text><text x="360" y="273" text-anchor="middle" font-size="10" fill="#94a3b8">router synced · customer billed</text>
        <line x1="360" y1="280" x2="360" y2="298" stroke="#64748b" stroke-width="1.5" marker-end="url(#da)"/>
        <rect x="180" y="300" width="360" height="52" rx="9" fill="#14311f" stroke="#22c55e"/><text x="360" y="322" text-anchor="middle" font-size="12" font-weight="700" fill="#e2e8f0">Wallets settle</text><text x="360" y="339" text-anchor="middle" font-size="10" fill="#86efac">activator −cost · each upline +margin · ISP −base</text>
        <line x1="360" y1="352" x2="360" y2="370" stroke="#64748b" stroke-width="1.5" marker-end="url(#da)"/>
        <rect x="200" y="372" width="320" height="42" rx="9" fill="#0b2942" stroke="#0ea5e9"/><text x="360" y="392" text-anchor="middle" font-size="12" font-weight="700" fill="#e2e8f0">Logged &amp; traceable</text><text x="360" y="407" text-anchor="middle" font-size="10" fill="#94a3b8">profit per subscriber &amp; per layer</text>
        <path d="M200,393 C90,393 90,93 200,93" fill="none" stroke="#8b5cf6" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#da)"/>
        <text x="70" y="250" font-size="10" fill="#8b5cf6" font-weight="700" transform="rotate(-90 70 250)">On expiry → renew → repeats</text>
      </svg>

      <h3>Real-life example — the Retailer signs up "Ali" (retail 500)</h3>
      <p>Wallets before: Franchise 2000, Dealer 1500, Retailer 1000.</p>
      <table>
        <tr><th>Account</th><th>Before</th><th>Change</th><th>After</th><th>Why</th></tr>
        <tr><td>Retailer</td><td>1000</td><td>−400</td><td><b>600</b></td><td>paid its buy price to the dealer</td></tr>
        <tr><td>Dealer</td><td>1500</td><td>+100</td><td><b>1600</b></td><td>margin 400 − 300</td></tr>
        <tr><td>Franchise</td><td>2000</td><td>+50</td><td><b>2050</b></td><td>margin 300 − 250</td></tr>
        <tr><td>ISP</td><td>pool</td><td>−250</td><td>—</td><td>base cost consumed</td></tr>
      </table>
      <p>Ali is billed <b>500</b>. The retailer collected 500 and spent 400, so its <b>profit = 100</b> (stamped on Ali). The dealer earned 100 and the franchise 50 on the same sale. It balances: 500 = retailer 100 + (dealer 100 + franchise 50 + ISP base 250).</p>

      <h3>The ISP can also sell direct at its own price</h3>
      <p>Even though the ISP wholesales to franchises at 250, if it serves a customer "Bob" itself it can bill its own retail — say <b>600</b>. Cost 250, so the ISP keeps <b>350</b>. Any tier can do this on customers it serves directly.</p>

      <h3>Renewals</h3>
      <div class="note tip">When a plan expires and renews, the exact same flow runs automatically — new invoice, wallet settle, fresh profit stamp — so every month is billed and accounted with no manual work.</div>
    </section>

    <!-- WALLET & TOP-UP -->
    <section id="wallet">
      <h2>Wallet &amp; top-up (prepaid)</h2>
      <p class="lead">Every reseller has one wallet — like mobile balance. It goes up when someone above tops it up, and down when they activate customers. Credit can only flow <b>downward</b>, so nobody can oversell.</p>
      <h3>Add balance to a downline</h3>
      <ol class="steps">
        <li>Open <b>Organization</b>, find the account, click <b>Wallet</b>.</li>
        <li>Enter an amount and top up. The giver's wallet is <b>debited</b> and the receiver's <b>credited</b> — a real transfer.</li>
      </ol>
      <table>
        <tr><th>Account</th><th>Before</th><th>Change</th><th>After</th></tr>
        <tr><td>Dealer (giver)</td><td>1600</td><td>−1000</td><td>600</td></tr>
        <tr><td>Retailer (receiver)</td><td>600</td><td>+1000</td><td>1600</td></tr>
      </table>
      <h3>Permission to add balance</h3>
      <div class="note warn">The ISP can always add balance. A reseller can only top up its downline if the ISP has ticked <b>"can add balance"</b> next to that account on the Organization page. Without it, the top-up is refused by the server — not just hidden.</div>
    </section>

    <!-- ACT AS -->
    <section id="actas">
      <h2>Profile Switch (“Act as”)</h2>
      <p class="lead">Step into any account beneath you to see exactly what they see — their customers, wallet and downline — then step back.</p>
      <ol class="steps">
        <li>Click <b>Act as ▾</b> in the top bar (visible when you have a downline).</li>
        <li>Pick a downstream account. The panel reloads showing <b>their</b> view; an amber banner reminds you who you're viewing as.</li>
        <li>Click <b>Return to my account</b> in the banner to switch back.</li>
      </ol>
      <div class="note warn">You can only switch into accounts inside your own branch. A dealer can act as its retailers, but never another dealer's — this is enforced by the server, not just hidden in the screen. Every switch is recorded in the audit log.</div>
    </section>

    <!-- COMMUNICATION -->
    <section id="communication">
      <h2>Communication</h2>
      <p class="lead">Send SMS/email to customers and automate reminders. Build reusable message templates and let the system send them on the right events.</p>
      <ul>
        <li><b>Templates</b> — welcome messages, expiry reminders, payment receipts.</li>
        <li><b>Automatic triggers</b> — e.g. an expiry reminder a few days before a plan ends.</li>
        <li><b>Broadcast</b> — send a notice to a group of subscribers.</li>
      </ul>
      <div class="note">Until you configure an SMS/email gateway, messages run in a safe <b>simulated</b> mode (logged, not actually sent) so you can test freely.</div>
    </section>

    <!-- COMPLAINTS -->
    <section id="complaints">
      <h2>Complaints / Tickets</h2>
      <p class="lead">Track customer issues from open to resolved.</p>
      <ol class="steps">
        <li>Open <b>Complaints</b> → create a ticket, link it to a subscriber, set priority.</li>
        <li>Assign it to a staff member and reply within the thread.</li>
        <li>Close it when resolved — the full history stays on the subscriber's timeline.</li>
      </ol>
    </section>

    <!-- REPORTS -->
    <section id="reports">
      <h2>Reports</h2>
      <p class="lead">Business insights — revenue, subscriber growth, and ticket trends — over the periods you choose.</p>
      <ul>
        <li>Revenue collected vs. outstanding over time.</li>
        <li>New vs. churned subscribers.</li>
        <li>Ticket volume and resolution.</li>
      </ul>
    </section>

    <!-- LOGS -->
    <section id="logs">
      <h2>Logs</h2>
      <p class="lead">A complete audit trail of what happened and who did it.</p>
      <ul>
        <li><b>Login log</b> — successful and failed logins, with IP.</li>
        <li><b>Activity log</b> — every create/edit/delete action.</li>
        <li><b>Session &amp; network logs</b> — RADIUS auth accepts/rejects and accounting.</li>
      </ul>
    </section>

    <!-- SECURITY -->
    <section id="security">
      <h2>Security &amp; Permissions</h2>
      <p class="lead">Control who can do what, and lock down accounts with two-factor authentication.</p>
      <h3>Permissions</h3>
      <ol class="steps">
        <li>Open <b>Security</b> → <b>Permissions</b>.</li>
        <li>Pick a role and tick <b>read</b>/<b>write</b> per feature. Write implies read; the platform owner always bypasses.</li>
        <li>Save — the rules apply immediately to everyone in that role.</li>
      </ol>
      <h3>Two-factor authentication (2FA)</h3>
      <ol class="steps">
        <li>Go to <b>Security → Two-Factor Auth</b> and click <b>Enroll</b>.</li>
        <li>Scan the QR code with an authenticator app (Google Authenticator, Authy…).</li>
        <li>Enter the 6-digit code to confirm. From now on login asks for the code.</li>
      </ol>
      <h3>Active sessions</h3>
      <p>See where your account is logged in and force-log-out any session.</p>
    </section>

    <!-- PORTAL -->
    <section id="portal">
      <h2>Subscriber Portal</h2>
      <p class="lead">A self-service page your customers use — separate from the admin panel — at <code>/portal</code>.</p>
      <ul>
        <li>Customers log in to see their <b>usage</b>, <b>invoices</b> and <b>plan</b>.</li>
        <li>They can <b>pay online</b> through your configured gateway (bKash, SSLCommerz, Stripe, or the sandbox for testing).</li>
        <li>They can raise and follow <b>support tickets</b>.</li>
      </ul>
    </section>

    <!-- USERS -->
    <section id="users">
      <h2>Staff Users</h2>
      <p class="lead">Your team accounts (as opposed to reseller accounts). Create staff, set their role, and enable/disable access.</p>
      <ol class="steps">
        <li>Open <b>Users</b> → <b>+ Add User</b>.</li>
        <li>Enter name, email, a strong password, and a <b>role</b> (which controls their permissions).</li>
        <li>Save. Use the toggle to activate/deactivate an account without deleting it.</li>
      </ol>
    </section>

    <!-- GLOSSARY -->
    <section id="glossary">
      <h2>Glossary</h2>
      <table>
        <tr><th>Term</th><th>Meaning</th></tr>
        <tr><td>NAS</td><td>Network Access Server — your router that terminates customer PPPoE sessions.</td></tr>
        <tr><td>RADIUS</td><td>The system that authenticates customer logins and records their usage.</td></tr>
        <tr><td>PPPoE</td><td>The dial-up-style login customers' routers use to connect.</td></tr>
        <tr><td>Rate-Limit</td><td>The speed cap sent to the router — set by the customer's package.</td></tr>
        <tr><td>Wallet</td><td>A reseller's prepaid balance, used to activate customers.</td></tr>
        <tr><td>Subtree</td><td>You plus everyone beneath you in the reseller tree — what you're allowed to see.</td></tr>
      </table>
    </section>

    <!-- FAQ -->
    <section id="faq">
      <h2>FAQ</h2>
      <h3>A new customer can't connect — what do I check?</h3>
      <ol>
        <li>Is the subscriber <b>Active</b> and on a package? (Subscribers page)</li>
        <li>Is their router registered and the RADIUS secret correct? (<a href="#nas">NAS</a>)</li>
        <li>Check the RADIUS auth log for an accept/reject (<a href="#logs">Logs</a>).</li>
      </ol>
      <h3>Why can't I see another branch's customers?</h3>
      <p>By design — you only see your own subtree. That isolation is enforced on the server for every page.</p>
      <h3>How do resellers make money?</h3>
      <p>Each tier sets its own <a href="#pricing">price</a> for the tier below and keeps the markup when a customer is activated. See the profit example in Reseller Pricing.</p>
    </section>

  </div></main>
</div>

<button class="top" id="top" onclick="window.scrollTo({top:0,behavior:'smooth'})">↑</button>

<script>
  // Sidebar search filter
  function filterNav(){
    var q = document.getElementById('q').value.toLowerCase();
    document.querySelectorAll('.side a.nav').forEach(function(a){
      a.style.display = a.textContent.toLowerCase().includes(q) ? 'block' : 'none';
    });
    document.querySelectorAll('.nav-group').forEach(function(g){
      var n = g.nextElementSibling, any = false;
      while(n && n.classList.contains('nav')){ if(n.style.display!=='none') any = true; n = n.nextElementSibling; }
      g.style.display = any ? 'block' : 'none';
    });
  }
  // Back-to-top button
  var topBtn = document.getElementById('top');
  window.addEventListener('scroll', function(){ topBtn.style.display = window.scrollY > 400 ? 'block' : 'none'; });
  // Highlight active section while scrolling
  var links = [].slice.call(document.querySelectorAll('.side a.nav'));
  var sections = links.map(function(l){ return document.querySelector(l.getAttribute('href')); });
  window.addEventListener('scroll', function(){
    var y = window.scrollY + 90, i = sections.length;
    while(--i >= 0){ if(sections[i] && sections[i].offsetTop <= y){
      links.forEach(function(l){ l.style.background=''; l.style.color=''; });
      links[i].style.background = 'var(--row)'; links[i].style.color = 'var(--text)'; break;
    }}
  });
</script>
</body>
</html>
