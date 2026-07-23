'use client';

import { useEffect, useMemo, useState } from 'react';
import { loadCurrencyFromApi, money } from './currency';
import StaticIpBanner from './static-ip-banner';
import { NovaStyles } from './ui';
import { usePathname, useRouter } from 'next/navigation';

const API = process.env.NEXT_PUBLIC_BACKEND_URL || (typeof window!=="undefined"?`http://${window.location.hostname}:3001`:'http://localhost:3001');

interface UserProfile {
  id: string;
  name: string;
  email: string;
  role?: string;
  balance?: number;
  parentId?: number | null;
}

const Icons = {
  Dashboard:   () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  Subscribers: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  Payments:    () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>,
  Invoices:    () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
  Packages:    () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  Pool:        () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>,
  Vouchers:    () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h14"/><line x1="12" y1="4" x2="12" y2="20"/><path d="M20 15h2M20 19h2"/></svg>,
  NAS:         () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>,
  Areas:       () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>,
  Complaints:  () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  Reports:     () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  Users:       () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  Logs:        () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
  Settings:    () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  ChevronLeft: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>,
  Menu:        () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>,
  Logout:      () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  // FIXED: Added missing icons
  Search:      () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  Support:     () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  Network:     () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="6" height="6" rx="1"/><rect x="16" y="2" width="6" height="6" rx="1"/><rect x="9" y="16" width="6" height="6" rx="1"/><path d="M5 8v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><line x1="12" y1="12" x2="12" y2="16"/></svg>,
};

// Grouped, workflow-ordered menu: most-used on top, setup steps in order,
// and all money features tucked under "Accounting & Billing".
const menuGroups = [
  // Ten entries instead of twenty-nine. Screens used on the same job now live
  // together as tabs inside a hub, so related work is one click away rather
  // than a hunt down a long list. The old routes all still work — deep links
  // and bookmarks are unaffected.
  { label: 'Daily Work', items: [
    { id: 'dashboard', label: 'Dashboard', href: '/dashboard', Icon: Icons.Dashboard },
    { id: 'subscribers', label: 'Subscribers', href: '/subscribers', Icon: Icons.Subscribers },
    { id: 'support', label: 'Support', href: '/support-center', Icon: Icons.Support },
    { id: 'trace', label: 'Trace Search', href: '/trace', Icon: Icons.Search },
  ]},
  { label: 'Operations', items: [
    { id: 'network', label: 'Network', href: '/network-center', Icon: Icons.Network },
    { id: 'catalog', label: 'Plans & Stock', href: '/service-catalog', Icon: Icons.Packages },
  ]},
  { label: 'Business', items: [
    { id: 'billing', label: 'Billing', href: '/billing-center', Icon: Icons.Payments },
    { id: 'insights', label: 'Insights', href: '/insights', Icon: Icons.Reports },
    { id: 'compliance', label: 'KYC & Data Usage', href: '/compliance', Icon: Icons.Users },
  ]},
  { label: 'System', items: [
    { id: 'admin', label: 'Administration', href: '/admin-center', Icon: Icons.Settings },
    // Sits above Help deliberately: it answers "what do I do next", which is
    // the question people actually arrive with, and it checks itself.
    { id: 'setup', label: 'Setup Checklist', href: '/setup', Icon: Icons.Dashboard },
    // ISP owner only — root server console (logs + terminal). Hidden for
    // everyone else, and the backend refuses the routes for non-owners anyway.
    { id: 'console', label: 'Server Console', href: '/console', Icon: Icons.NAS, ispOnly: true },
    { id: 'help', label: 'Help & Guide', href: '/help', Icon: Icons.Support },
  ]},
];
// Flat list kept for title lookup / active-menu detection.
const menuItems = menuGroups.flatMap((g) => g.items);

function getInitials(name = ''): string {
  if (!name) return 'U';
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'U';
}

/**
 * Which sidebar entry to light up.
 *
 * The old standalone routes still exist and are still linked from inside the
 * app, so they map onto the hub that now contains them. Landing on /invoices
 * from an email link should still highlight Billing rather than nothing.
 */
const ROUTE_TO_MENU: Array<[string, string]> = [
  // Hubs first — a hub path must not be captured by a prefix rule below it.
  ['/network-center', 'network'],
  ['/billing-center', 'billing'],
  ['/service-catalog', 'catalog'],
  ['/support-center', 'support'],
  ['/admin-center', 'admin'],
  ['/insights', 'insights'],

  ['/trace', 'trace'],
  ['/subscribers', 'subscribers'],
  ['/compliance', 'compliance'],
  ['/help', 'help'],

  // Network hub
  ['/network', 'network'],
  ['/nas', 'network'],
  ['/ip-pools', 'network'],
  ['/static-ips', 'network'],
  ['/outages', 'network'],

  // Plans & stock
  ['/packages', 'catalog'],
  ['/areas', 'catalog'],
  ['/inventory', 'catalog'],

  // Billing
  ['/accounting', 'billing'],
  ['/invoices', 'billing'],
  ['/payments', 'billing'],
  ['/vouchers', 'billing'],
  ['/pricing', 'billing'],

  // Support
  ['/complaints', 'support'],
  ['/field-jobs', 'support'],
  ['/communication', 'support'],

  // Insights
  ['/segments', 'insights'],
  ['/analytics', 'insights'],
  ['/reports', 'insights'],
  ['/logs', 'insights'],

  // Administration
  ['/organization', 'admin'],
  ['/hierarchy', 'admin'],
  ['/users', 'admin'],
  ['/security', 'admin'],
  ['/settings', 'admin'],
  ['/my-profile', 'admin'],
];

/** Most rows the Act-as dropdown will ever render at once. */
const SWITCH_LIMIT = 50;

function getActiveMenu(pathname: string): string {
  const hit = ROUTE_TO_MENU.find(([prefix]) => pathname.startsWith(prefix));
  return hit ? hit[1] : 'dashboard';
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [time, setTime] = useState('');
  const [date, setDate] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [switchList, setSwitchList] = useState<any[]>([]);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [imp, setImp] = useState<any>(null); // { by, byName, byRole } when acting as someone
  const [myRole, setMyRole] = useState<string | null>(null);
  const [switchQuery, setSwitchQuery] = useState('');
  const [switchView, setSwitchView] = useState<'list' | 'tree'>('tree');
  const [switchExpanded, setSwitchExpanded] = useState<Record<number, boolean>>({});
  const [light, setLight] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const saved = localStorage.getItem('jb_theme') === 'light';
    setLight(saved);
    document.documentElement.setAttribute('data-theme', saved ? 'light' : 'dark');
  }, []);
  const toggleTheme = () => {
    const next = !light;
    setLight(next);
    localStorage.setItem('jb_theme', next ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', next ? 'light' : 'dark');
  };
  const activeMenu = useMemo(() => getActiveMenu(pathname || '/dashboard'), [pathname]);

  /**
   * Filtered, capped account list for the Act-as menu.
   *
   * An ISP with a thousand resellers was rendering a thousand buttons into a
   * dropdown on every page load — slow to open, and useless to scroll through
   * even once open. Search narrows it; the cap keeps the DOM small no matter
   * how large the tree gets.
   */
  const switchShown = useMemo(() => {
    const q = switchQuery.trim().toLowerCase();
    const matched = q
      ? switchList.filter((u: any) =>
          `${u.name ?? ''} ${u.email ?? ''} ${u.role ?? ''}`.toLowerCase().includes(q))
      : switchList;
    return matched.slice(0, SWITCH_LIMIT);
  }, [switchList, switchQuery]);

  const switchMore = useMemo(() => {
    const q = switchQuery.trim().toLowerCase();
    const total = q
      ? switchList.filter((u: any) =>
          `${u.name ?? ''} ${u.email ?? ''} ${u.role ?? ''}`.toLowerCase().includes(q)).length
      : switchList.length;
    return Math.max(0, total - SWITCH_LIMIT);
  }, [switchList, switchQuery]);

  /**
   * The account list as a hierarchy. A flat list of 100+ accounts is a wall of
   * equal rows you cannot navigate; the tree groups each reseller under its
   * parent so the shape of the business is visible and you drill to the one you
   * want. Roots are the accounts whose parent is not itself in the list (the top
   * of the caller's own downline).
   */
  const switchTree = useMemo(() => {
    const byId = new Map<number, any>(switchList.map((u: any) => [u.id, { ...u, children: [] as any[] }]));
    const roots: any[] = [];
    for (const node of byId.values()) {
      const parent = node.parentId != null ? byId.get(node.parentId) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const sortRec = (ns: any[]) => { ns.sort((a, b) => String(a.name).localeCompare(String(b.name))); ns.forEach((n) => sortRec(n.children)); };
    sortRec(roots);
    return roots;
  }, [switchList]);

  const expandAllSwitch = () => {
    const all: Record<number, boolean> = {};
    const walk = (ns: any[]) => ns.forEach((n) => { all[n.id] = true; walk(n.children); });
    walk(switchTree);
    setSwitchExpanded(all);
  };

  /** One flattened, depth-tagged list from the tree, honouring expand state. */
  const switchTreeRows = useMemo(() => {
    const out: { u: any; depth: number; hasKids: boolean }[] = [];
    const walk = (ns: any[], depth: number) => {
      for (const n of ns) {
        const hasKids = n.children.length > 0;
        out.push({ u: n, depth, hasKids });
        if (hasKids && switchExpanded[n.id]) walk(n.children, depth + 1);
      }
    };
    walk(switchTree, 0);
    return out;
  }, [switchTree, switchExpanded]);

  // Decode the JWT payload (no verify — just to read role/imp on the client).
  const decodeToken = () => {
    try {
      const t = localStorage.getItem('token');
      if (!t) return null;
      return JSON.parse(atob(t.split('.')[1]));
    } catch { return null; }
  };

  // Load the list of downstream users I can switch into + current imp state.
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : '';
    if (!token) return;
    // Pull the operator's display currency once per session so every screen
    // renders amounts in their own currency instead of a hard-coded symbol.
    loadCurrencyFromApi(API, token);
    const payload = decodeToken();
    setImp(payload?.imp ?? null);
    setMyRole(payload?.role ?? null);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    fetch(`${API}/users`, { headers })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        const me = payload?.sub;
        setSwitchList((Array.isArray(rows) ? rows : []).filter((u: any) => u.id !== me));
      })
      .catch(() => {});
    /**
     * Runs ONCE per session, not per navigation.
     *
     * This was keyed on `pathname`, so every click re-fetched the whole account
     * list — and that endpoint also runs aggregate counts per user. At a
     * thousand resellers it meant a full table scan plus five grouped queries
     * on every page change, for a dropdown most users never open.
     */
  }, []);

  async function actAs(userId: number) {
    const token = localStorage.getItem('token');
    const r = await fetch(`${API}/auth/impersonate/${userId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const data = await r.json();
      localStorage.setItem('token', data.token);
      setSwitchOpen(false);
      window.location.href = '/dashboard';
    }
  }

  async function stopActingAs() {
    const token = localStorage.getItem('token');
    const r = await fetch(`${API}/auth/impersonate-stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const data = await r.json();
      localStorage.setItem('token', data.token);
      window.location.href = '/dashboard';
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem('app_shell_collapsed');
    if (saved === '1') setCollapsed(true);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('app_shell_collapsed', collapsed ? '1' : '0');
  }, [collapsed]);

  // Nova design layer: ripple on every button in the shell.
  //
  // One delegated listener rather than wiring each of the hundreds of buttons
  // individually — pages get the effect for free, including ones written later.
  // Skips disabled buttons, respects reduced-motion, and rate-limits so a
  // held-down key can't flood the DOM with spans.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let last = 0;
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement)?.closest?.('button');
      if (!btn || (btn as HTMLButtonElement).disabled) return;
      const now = Date.now();
      if (now - last < 80) return;
      last = now;

      const cs = getComputedStyle(btn);
      if (cs.position === 'static') btn.style.position = 'relative';
      if (cs.overflow !== 'hidden') btn.style.overflow = 'hidden';

      const rect = btn.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const r = document.createElement('span');
      r.className = 'nova-ripple';
      r.style.width = r.style.height = `${size}px`;
      r.style.left = `${e.clientX - rect.left - size / 2}px`;
      r.style.top = `${e.clientY - rect.top - size / 2}px`;
      btn.appendChild(r);
      setTimeout(() => r.remove(), 600);
    };

    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : '';
    if (!token) {
      router.replace('/login');
      return;
    }

    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    fetch(`${API}/auth/profile`, { headers })
      .then((res) => {
        if (!res.ok) throw new Error('Profile fetch failed');
        return res.json();
      })
      .then((data) => setUser(data?.user ?? data))
      .catch(() => router.replace('/login'));
  }, [router]);

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setTime(now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
      setDate(now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('token');
    router.replace('/login');
  };

  const title = menuItems.find((item) => item.id === activeMenu)?.label || 'Dashboard';

  const acctItem: React.CSSProperties = {
    display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
    border: 'none', color: 'var(--text)', padding: '10px 12px', borderRadius: 10,
    fontSize: 12.5, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
    transition: 'background .16s, transform .16s',
  };

  return (
    <div className="db-root">
      {/* Nova UI kit stylesheet — mounted once here so every page can compose
          the shared primitives without importing styles of its own. */}
      <NovaStyles />
      <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden="true">
            {/* Linked-boxes glyph, matching the favicon/logo mark. */}
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
              <rect x="4" y="5" width="12" height="12" rx="3.6" fill="none" stroke="#fff" strokeWidth="2.2" opacity="0.85" />
              <rect x="9" y="8" width="12" height="12" rx="3.6" fill="none" stroke="#fff" strokeWidth="2.2" />
            </svg>
          </div>
          {!collapsed && (
            <div className="brand-meta">
              <div className="brand-title">Jointbox</div>
              <div className="brand-subtitle">ISP Management</div>
            </div>
          )}
        </div>

        <nav className="nav-section">
          {menuGroups.map((group) => {
            // ISP-only items (Server Console) are hidden for everyone else.
            const items = group.items.filter((it: any) => !it.ispOnly || myRole === 'SUPER_ADMIN');
            if (items.length === 0) return null;
            return (
            <div key={group.label}>
              {!collapsed && <div className="nav-label">{group.label}</div>}
              {items.map((item) => {
                const isActive = item.id === activeMenu;
                const Icon = item.Icon;
                return (
                  <button
                    key={item.href}
                    type="button"
                    className={`nav-item ${isActive ? 'active' : ''}`}
                    onClick={() => router.push(item.href)}
                    title={collapsed ? item.label : ''}
                  >
                    <span className="nav-icon"><Icon /></span>
                    {!collapsed && <span>{item.label}</span>}
                  </button>
                );
              })}
            </div>
            );
          })}
        </nav>

        {/* The account card and log-out button used to live here. They moved to
            the avatar menu in the top-right — occasional actions shouldn't hold
            permanent space in the navigation. */}
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="topbar-sidebar-toggle"
              onClick={() => setCollapsed((p) => !p)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? <Icons.Menu /> : <Icons.ChevronLeft />}
            </button>
            <div>
            <div className="topbar-title">{title}</div>
            <div className="topbar-sub">{date || 'Unified control panel'}</div>
            </div>
          </div>

          {/* Global search. Routes into Trace, which already searches across
              subscribers, sessions and invoices — so this is a shortcut to an
              existing capability rather than a new half-built one. */}
          <form
            className="nv-search"
            onSubmit={(e) => {
              e.preventDefault();
              const q = search.trim();
              if (q) router.push(`/trace?q=${encodeURIComponent(q)}`);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search subscribers, sessions, invoices…"
              aria-label="Search"
            />
            <kbd>↵</kbd>
          </form>

          <div className="topbar-right">
            {/* Wallet balance, always visible.
                This is the number that decides whether the next activation
                goes through. A reseller discovering they are empty only when
                a customer is standing in front of them is a wasted visit, so
                it lives permanently in the chrome rather than behind a page. */}
            {user?.balance !== undefined && (
              <div
                className={`nv-wallet ${
                  user.balance <= 0 ? 'empty' : user.balance < 1000 ? 'low' : ''
                }`}
                title={
                  user.balance <= 0
                    ? 'Wallet empty — activations will be refused'
                    : user.balance < 1000
                      ? 'Wallet running low'
                      : 'Wallet balance'
                }
                onClick={() => router.push('/billing-center?tab=accounting')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
                  <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
                  <path d="M18 12a2 2 0 0 0 0 4h4v-4z" />
                </svg>
                <span>{money(user.balance)}</span>
              </div>
            )}

            {switchList.length > 0 && (
              <div className="nv-menu-wrap">
                <button
                  type="button"
                  className={`nv-actas ${switchOpen ? 'open' : ''}`}
                  onClick={() => setSwitchOpen((p) => !p)}
                >
                  <Icons.Users />
                  <span>Act as</span>
                  <svg className="chev" width="11" height="11" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {switchOpen && (
                  <>
                    {/* Click-away layer. Sits below the menu but above the page
                        so a stray click anywhere closes it. */}
                    <div className="nv-menu-catch" onClick={() => setSwitchOpen(false)} />
                    <div className="nv-menu" role="menu">
                      <div className="nv-menu-head">
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <b>Switch account</b>
                          {/* Tree groups accounts under their parent so a big
                              downline is navigable; List is the flat, searchable
                              view. Searching always uses the flat list. */}
                          <div style={{ display: 'inline-flex', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 999, padding: 2 }}>
                            {(['tree', 'list'] as const).map((v) => (
                              <button key={v} onClick={() => setSwitchView(v)}
                                style={{ border: 'none', cursor: 'pointer', borderRadius: 999, padding: '3px 10px', fontSize: 10.5, fontWeight: 700, textTransform: 'capitalize', fontFamily: 'inherit', background: switchView === v ? 'var(--g-primary,#6C3CE1)' : 'transparent', color: switchView === v ? '#fff' : 'var(--muted)' }}>
                                {v}
                              </button>
                            ))}
                          </div>
                        </div>
                        <span>
                          {switchList.length > SWITCH_LIMIT
                            ? `${switchList.length} accounts — search, or drill the tree`
                            : 'View the panel as one of your downstream accounts'}
                        </span>
                      </div>

                      {switchList.length > 8 && (
                        <input
                          className="nv-menu-search"
                          autoFocus
                          placeholder="Search name, email or role…"
                          value={switchQuery}
                          onChange={(e) => setSwitchQuery(e.target.value)}
                        />
                      )}

                      {switchView === 'tree' && !switchQuery && switchTree.length > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '2px 10px 0' }}>
                          <button onClick={() => (Object.keys(switchExpanded).length ? setSwitchExpanded({}) : expandAllSwitch())}
                            style={{ border: 'none', background: 'transparent', color: 'var(--muted)', fontSize: 10.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                            {Object.keys(switchExpanded).length ? 'Collapse all' : 'Expand all'}
                          </button>
                        </div>
                      )}

                      <div className="nv-menu-list">
                        {/* Tree view — hierarchy with indent + expanders. Search
                            falls back to the flat list below. */}
                        {switchView === 'tree' && !switchQuery ? (
                          <>
                            {switchTreeRows.map(({ u, depth, hasKids }) => (
                              <div key={u.id} className="nv-menu-item" style={{ paddingLeft: 10 + depth * 16 }}>
                                {hasKids ? (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setSwitchExpanded((m) => ({ ...m, [u.id]: !m[u.id] })); }}
                                    aria-label={switchExpanded[u.id] ? 'Collapse' : 'Expand'}
                                    style={{ width: 18, height: 18, flexShrink: 0, border: '1px solid var(--border)', borderRadius: 5, background: 'var(--surface-2)', color: 'var(--muted)', cursor: 'pointer', fontSize: 11, lineHeight: 1, fontFamily: 'inherit' }}>
                                    {switchExpanded[u.id] ? '−' : '+'}
                                  </button>
                                ) : <span style={{ width: 18, flexShrink: 0 }} />}
                                <span className="nv-menu-av">{getInitials(u.name)}</span>
                                <button onClick={() => actAs(u.id)} role="menuitem"
                                  style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', padding: 0, minWidth: 0 }}>
                                  <span className="nv-menu-txt">
                                    <b>{u.name}{hasKids && <span style={{ color: 'var(--muted)', fontWeight: 500, fontSize: 10.5 }}> · {u.children.length}</span>}</b>
                                    <em>{u.role} · {u.email}</em>
                                  </span>
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="go">
                                    <polyline points="9 18 15 12 9 6" />
                                  </svg>
                                </button>
                              </div>
                            ))}
                            {switchTreeRows.length === 0 && (
                              <div className="nv-menu-empty">No downstream accounts to switch into.</div>
                            )}
                          </>
                        ) : (
                          <>
                            {switchShown.map((u) => (
                              <button key={u.id} className="nv-menu-item" onClick={() => actAs(u.id)} role="menuitem">
                                <span className="nv-menu-av">{getInitials(u.name)}</span>
                                <span className="nv-menu-txt">
                                  <b>{u.name}</b>
                                  <em>{u.role} · {u.email}</em>
                                </span>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="go">
                                  <polyline points="9 18 15 12 9 6" />
                                </svg>
                              </button>
                            ))}
                            {switchShown.length === 0 && (
                              <div className="nv-menu-empty">
                                {switchQuery ? `No account matches “${switchQuery}”.` : 'No downstream accounts to switch into.'}
                              </div>
                            )}
                            {switchMore > 0 && (
                              <div className="nv-menu-empty">{switchMore} more not shown — keep typing to narrow it down.</div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={toggleTheme}
              title={light ? 'Switch to dark' : 'Switch to light'}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '50%', fontSize: 14, cursor: 'pointer' }}
            >
              {light ? '🌙' : '☀️'}
            </button>
            <div className="status-pill">
              <span className="status-dot" />
              Online
            </div>
            <div className="topbar-clock">{time}</div>

            {/* Account menu. Moved out of the sidebar footer — signing out and
                switching accounts are things you do occasionally, so they
                belong in the corner rather than taking permanent space in the
                navigation. */}
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setAccountOpen((p) => !p)}
                title={user?.name || 'Account'}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 34, height: 34, borderRadius: '50%', cursor: 'pointer',
                  background: 'var(--g-primary)', color: '#fff',
                  border: '2px solid var(--border)', fontSize: 12, fontWeight: 700,
                  boxShadow: '0 4px 14px rgba(233,64,139,.3)',
                }}
              >
                {getInitials(user?.name)}
              </button>

              {accountOpen && (
                <>
                  {/* Click-away layer so the menu closes like every other menu. */}
                  <div className="nv-menu-catch" onClick={() => setAccountOpen(false)} />
                  <div className="nv-menu" style={{ width: 250, padding: 6 }}>
                    <div style={{
                      padding: '11px 12px', borderRadius: 11, marginBottom: 4,
                      background: 'linear-gradient(135deg, rgba(108,60,225,.16), rgba(233,64,139,.09))',
                    }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{user?.name || 'Loading…'}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{user?.role || user?.email || ''}</div>
                    </div>

                    <button
                      onClick={() => { setAccountOpen(false); router.push('/my-profile'); }}
                      style={acctItem}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      My Profile
                    </button>
                    <button
                      onClick={() => { setAccountOpen(false); router.push('/admin-center?tab=settings'); }}
                      style={acctItem}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      Settings
                    </button>

                    <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

                    <button
                      onClick={() => { setAccountOpen(false); handleLogout(); }}
                      style={{ ...acctItem, color: '#ef4444', fontWeight: 600 }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(239,68,68,.1)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      Log out
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {imp && (
          <div style={{ background: '#3a2a0a', borderBottom: '1px solid #f59e0b', color: '#fbbf24', padding: '8px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
            <span>👁 Viewing as <b>{user?.name}</b> ({user?.role}) — you are {imp.byName || 'the operator'}.</span>
            <button
              onClick={stopActingAs}
              style={{ background: '#f59e0b', color: '#1a1206', border: 'none', borderRadius: 8, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
            >
              Return to my account
            </button>
          </div>
        )}

        <main className="app-shell-page-content">
          <div className="app-shell-page-inner">
            {/* Renders nothing unless there are static IP charges to chase. */}
            <StaticIpBanner />
            {children}
          </div>
        </main>

        {/* Footer removed. It said nothing that changes, and it cost a strip
            of vertical space on every screen — the version number belongs in
            Help, not in the way of the table you are reading. */}
      </div>
    </div>
  );
}

export function AppShellGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const publicPaths = ['/login', '/'];

  // Subscriber portal has its own lightweight UI — never wrap it in the admin shell
  if (publicPaths.includes(pathname || '/') || (pathname || '').startsWith('/portal')) {
    return <>{children}</>;
  }

  return <AppShell>{children}</AppShell>;
}