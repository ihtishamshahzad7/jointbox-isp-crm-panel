'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { loadCurrencyFromApi, money } from './currency';
import StaticIpBanner from './static-ip-banner';
import CommandPalette from './command-palette';
import { NovaStyles } from './ui';
import { usePathname, useRouter } from 'next/navigation';
import { silent } from './silent';
import { Icons } from './icons';
import API_BASE from "./api";
import NotificationBell from './notification-bell';
import { CrownBadge } from './crown';
import { ThemeToggle } from './theme';
import BottomNav from './bottom-nav';
import Avatar from './avatar';
import { BRAND } from '../../lib/brand';
import { LANGS, useI18n } from '../../lib/i18n';
import { LicenceProvider, LicenceBanner } from './licence';
import { ensureMediaToken, hasFreshMediaToken, clearMediaToken } from './image-upload';
import { PLATFORM_HOME, isPlatformPath, isPlatformOnlyPath } from './platform';

const API = API_BASE;

interface UserProfile {
  id: string;
  name: string;
  email: string;
  role?: string;
  balance?: number;
  parentId?: number | null;
  photoUrl?: string | null;
}

const navIcons = {
  Dashboard:   () => <Icons.Dashboard width={18} height={18} />,
  Subscribers: () => <Icons.Subscribers width={18} height={18} />,
  Payments:    () => <Icons.Payments width={18} height={18} />,
  Invoices:    () => <Icons.Invoices width={18} height={18} />,
  Packages:    () => <Icons.Packages width={18} height={18} />,
  Pool:        () => <Icons.Pool width={18} height={18} />,
  Vouchers:    () => <Icons.Vouchers width={18} height={18} />,
  NAS:         () => <Icons.NAS width={18} height={18} />,
  Areas:       () => <Icons.Areas width={18} height={18} />,
  Complaints:  () => <Icons.Complaints width={18} height={18} />,
  Reports:     () => <Icons.Reports width={18} height={18} />,
  Users:       () => <Icons.Users width={18} height={18} />,
  Logs:        () => <Icons.Logs width={18} height={18} />,
  Settings:    () => <Icons.Settings width={18} height={18} />,
  ChevronLeft: () => <Icons.ChevronLeft width={16} height={16} />,
  Menu:        () => <Icons.Menu width={18} height={18} />,
  Logout:      () => <Icons.Logout width={16} height={16} />,
  Search:      () => <Icons.Search width={18} height={18} />,
  Support:     () => <Icons.Support width={18} height={18} />,
  Network:     () => <Icons.Network width={18} height={18} />,
};

// Grouped, workflow-ordered menu: most-used on top, setup steps in order,
// and all money features tucked under "Accounting & Billing".
const menuGroups = [
  // Ten entries instead of twenty-nine. Screens used on the same job now live
  // together as tabs inside a hub, so related work is one click away rather
  // than a hunt down a long list. The old routes all still work — deep links
  // and bookmarks are unaffected.
  { label: 'Daily Work', items: [
    { id: 'dashboard', label: 'Dashboard', href: '/dashboard', Icon: navIcons.Dashboard },
    // My Business + Quick Connect + Renewals — the daily loop, one page, tabs.
    { id: 'my-work', label: 'My Work', href: '/my-work', Icon: navIcons.Reports },
    { id: 'subscribers', label: 'Subscribers', href: '/subscribers', Icon: navIcons.Subscribers },
    { id: 'support', label: 'Support', href: '/support-center', Icon: navIcons.Support },
    { id: 'trace', label: 'Trace Search', href: '/trace', Icon: navIcons.Search },
  ]},
  { label: 'Operations', items: [
    // Operations + NOC + Live + NAS + Fiber + Pools + Static + Outages as tabs.
    { id: 'network', label: 'Network', href: '/network-center', Icon: navIcons.Network },
    { id: 'monitoring', label: 'Monitoring', href: '/monitoring', Icon: navIcons.Network },
    { id: 'catalog', label: 'Plans & Stock', href: '/service-catalog', Icon: navIcons.Packages },
  ]},
  { label: 'Business', items: [
    // Accounting + Collections + Invoices + Payments + Gateways + Vouchers +
    // Pricing + Reversals all live here as tabs — one "money" entry.
    { id: 'billing', label: 'Billing & Accounting', href: '/billing-center', Icon: navIcons.Payments },
    { id: 'insights', label: 'Insights', href: '/insights', Icon: navIcons.Reports },
    { id: 'compliance', label: 'KYC & Data Usage', href: '/compliance', Icon: navIcons.Users },
  ]},
  { label: 'System', items: [
    { id: 'admin', label: 'Administration', href: '/admin-center', Icon: navIcons.Settings },
    // ISP owner only — licence state, plan caps and activation. It had a page
    // and a command-palette entry but no menu row, so the only way to reach it
    // was to already know the URL. Anyone who needs it is by definition someone
    // whose panel is warning them about it.
    { id: 'licence', label: 'Licence', href: '/licence', Icon: navIcons.Settings, ispOnly: true },
    // ISP owner only — background job queue (bulk work + integrity reconcile).
    { id: 'jobs', label: 'Background Jobs', href: '/jobs', Icon: navIcons.Reports, ispOnly: true },
    // Sits above Help deliberately: it answers "what do I do next", which is
    // the question people actually arrive with, and it checks itself.
    { id: 'setup', label: 'Setup Checklist', href: '/setup', Icon: navIcons.Dashboard },
    // ISP owner only — root server console (logs + terminal). Hidden for
    // everyone else, and the backend refuses the routes for non-owners anyway.
    { id: 'console', label: 'Server Console', href: '/console', Icon: navIcons.NAS, ispOnly: true },
    // ISP owner only — FreeRADIUS module toggles, config-file editor and DB details.
    { id: 'radius-admin', label: 'FreeRADIUS & Database', href: '/radius-admin', Icon: navIcons.NAS, ispOnly: true },
    // Ask (conversation) and Documentation (browse) answer from the same
    // knowledge base — some people ask, some prefer to read.
    { id: 'docs', label: 'Documentation', href: '/docs', Icon: navIcons.Support },
  ]},
];
// Flat list kept for title lookup / active-menu detection.
// The platform account's whole menu: its companies, the defaults every
// company starts from, and the server. No business screen appears here — the
// backend refuses them to this account anyway (platform-boundary).
const platformMenuGroups = [
  { label: 'Platform', items: [
    { id: 'companies', label: 'Companies', href: '/companies', Icon: navIcons.Users },
    { id: 'licence', label: 'Licence', href: '/licence', Icon: navIcons.Settings },
  ]},
  { label: 'Company Defaults', items: [
    { id: 'p-templates', label: 'Message Templates', href: '/communication', Icon: navIcons.Support },
    { id: 'p-taxes', label: 'Taxes & Fees', href: '/packages/taxes', Icon: navIcons.Payments },
    { id: 'p-policies', label: 'RADIUS Policies', href: '/packages/policies', Icon: navIcons.NAS },
    { id: 'p-allocations', label: 'Allocations', href: '/packages/allocations', Icon: navIcons.Pool },
  ]},
  { label: 'Server', items: [
    { id: 'p-settings', label: 'Settings & Backups', href: '/settings', Icon: navIcons.Settings },
    { id: 'p-security', label: 'Roles & Security', href: '/security', Icon: navIcons.Users },
    { id: 'jobs', label: 'Background Jobs', href: '/jobs', Icon: navIcons.Reports },
    { id: 'console', label: 'Server Console', href: '/console', Icon: navIcons.NAS },
    { id: 'radius-admin', label: 'FreeRADIUS & Database', href: '/radius-admin', Icon: navIcons.NAS },
    { id: 'docs', label: 'Documentation', href: '/docs', Icon: navIcons.Support },
  ]},
];
const PLATFORM_ROUTE_TO_MENU: Array<[string, string]> = [
  ['/companies', 'companies'], ['/licence', 'licence'], ['/communication', 'p-templates'],
  ['/packages/taxes', 'p-taxes'], ['/packages/policies', 'p-policies'], ['/packages/allocations', 'p-allocations'],
  ['/settings', 'p-settings'], ['/security', 'p-security'], ['/jobs', 'jobs'], ['/console', 'console'],
  ['/radius-admin', 'radius-admin'], ['/docs', 'docs'],
];
// Flat list kept for title lookup (business menu first, then the platform's).
const menuItems = [...menuGroups, ...platformMenuGroups].flatMap((g) => g.items);


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
  ['/jobs', 'jobs'],
  ['/support-center', 'support'],
  ['/admin-center', 'admin'],
  ['/insights', 'insights'],

  ['/trace', 'trace'],
  ['/subscribers', 'subscribers'],
  ['/compliance', 'compliance'],

  // Network hub
  ['/network', 'network'],
  ['/nas', 'network'],
  ['/fiber', 'network'],
  ['/ip-pools', 'network'],
  ['/static-ips', 'network'],
  ['/prefixes', 'network'],
  ['/outages', 'network'],

  // Plans & stock
  ['/packages', 'catalog'],
  ['/areas', 'catalog'],
  ['/inventory', 'catalog'],
  ['/franchise-groups', 'catalog'],

  // Billing & Accounting (all tabs of /billing-center)
  ['/accounting', 'billing'],
  ['/invoices', 'billing'],
  ['/payments', 'billing'],
  ['/gateways', 'billing'],
  ['/vouchers', 'billing'],
  ['/pricing', 'billing'],
  ['/earnings', 'billing'],
  ['/reversals', 'billing'],

  // My Work (tabs of /my-work)
  ['/my-business', 'my-work'],
  ['/quick-connect', 'my-work'],
  ['/renewals', 'my-work'],

  // Network (tabs of /network-center)
  ['/operations', 'network'],
  ['/noc', 'network'],

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
  ['/licence', 'licence'],
  ['/my-profile', 'admin'],
];

/** Most rows the Act-as dropdown will ever render at once. */
const SWITCH_LIMIT = 50;

function getActiveMenu(pathname: string, platform = false): string {
  const hit = (platform ? PLATFORM_ROUTE_TO_MENU : ROUTE_TO_MENU).find(([prefix]) => pathname.startsWith(prefix));
  return hit ? hit[1] : platform ? 'companies' : 'dashboard';
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t, setLang, lang, locale } = useI18n();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [time, setTime] = useState('');
  const [date, setDate] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  /**
   * Uploaded files need a media token (see image-upload.tsx). Fetched once and
   * renewed every half hour while it has under an hour left. If there was no
   * valid one when the shell opened (first load after sign-in, or after a long
   * idle), the page is re-mounted ONCE when it arrives so its photos load —
   * renewals never re-mount anything.
   */
  const [mediaKey, setMediaKey] = useState(0);
  useEffect(() => {
    let alive = true;
    const hadOne = hasFreshMediaToken(0);
    ensureMediaToken().then(() => {
      if (alive && !hadOne && hasFreshMediaToken(0)) setMediaKey((k) => k + 1);
    });
    const t = setInterval(() => { void ensureMediaToken(); }, 30 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  /**
   * Smart-sidebar state:
   *  - `peeking`  — while collapsed, hovering the rail temporarily expands it
   *                 (auto-open on hover, auto-close when the mouse leaves).
   *  - `width`    — the expanded width, adjustable by dragging the edge handle
   *                 and remembered between sessions.
   *  - `dragW`    — live width while a drag is in progress (null when idle).
   *  - `dragging` — true during a drag, so transitions are disabled and the
   *                 release position decides the final state.
   */
  const [peeking, setPeeking] = useState(false);
  const [width, setWidth] = useState(224);
  const [dragW, setDragW] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Short grace period so the cursor can travel between the rail and the
      drag handle without the sidebar flickering shut mid-move. */
  const peekTimer = useRef<number>(0);

  const RAIL_W = 60;    // collapsed rail width — matches .sidebar.collapsed
  const MIN_W = 200;    // narrowest the expanded sidebar may be dragged to
  const MAX_W = 320;    // widest
  const EXPAND_AT = 150; // drag release above this = keep open, below = close

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const isMobileView = () => typeof window !== 'undefined' && window.innerWidth <= 768;

  const startPeek = () => {
    window.clearTimeout(peekTimer.current);
    if (!collapsed || dragging || isMobileView()) return;
    setPeeking(true);
  };
  const deferUnpeek = () => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setPeeking(false), 220);
  };

  /** True when the sidebar is showing icons only (labels hidden). Never on
      phones — the drawer always shows labels even if `collapsed` was saved
      on desktop. */
  const rail = !isMobileView() && collapsed && !peeking && (dragW === null || dragW < EXPAND_AT);
  /** Width the sidebar should render at right now (mobile CSS wins via !important). */
  const sidebarW = isMobileView() ? undefined : (dragW ?? (collapsed && !peeking ? RAIL_W : width));

  /**
   * Drag-to-slide the sidebar. Starting from the rail, dragging right expands
   * it live; from the expanded state, dragging left shrinks it. On release the
   * pointer decides the outcome — past the threshold it stays open at that
   * width (or collapses below it), so letting go of the mouse is the control.
   */
  const beginDrag = (e: React.PointerEvent) => {
    if (isMobileView()) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = collapsed && !peeking ? RAIL_W : width;
    setDragging(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    const onMove = (ev: PointerEvent) => setDragW(clamp(startW + (ev.clientX - startX), RAIL_W, MAX_W));
    const finish = (finalW: number) => {
      if (finalW <= EXPAND_AT) setCollapsed(true);
      else { setCollapsed(false); setWidth(clamp(finalW, MIN_W, MAX_W)); }
      setPeeking(false);
      setDragW(null);
      setDragging(false);
    };
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      finish(clamp(startW + (ev.clientX - startX), RAIL_W, MAX_W));
    };
    const onCancel = () => {
      // Pointer lost mid-drag (edge gesture, palm, etc.) — settle back to the
      // state we started from rather than leave a half-dragged sidebar.
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      finish(startW);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  };

  // One button, two behaviours: on phones it opens/closes the off-canvas drawer;
  // on desktop it collapses/expands the sidebar.
  const toggleSidebar = () => {
    if (isMobileView()) setMobileOpen((o) => !o);
    else { setCollapsed((p) => !p); setPeeking(false); }
  };
  const [switchList, setSwitchList] = useState<any[]>([]);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [imp, setImp] = useState<any>(null); // { by, byName, byRole } when acting as someone
  const [myRole, setMyRole] = useState<string | null>(null);
  // Children render once the role is known, so the platform account never
  // mounts (and fires requests from) a business page before being redirected.
  const [roleReady, setRoleReady] = useState(false);
  const roleRefreshStarted = useRef(false);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [switchQuery, setSwitchQuery] = useState('');
  const [switchView, setSwitchView] = useState<'list' | 'tree'>('tree');
  const [updateInfo, setUpdateInfo] = useState<any>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [switchExpanded, setSwitchExpanded] = useState<Record<number, boolean>>({});
  const [latestNotice, setLatestNotice] = useState<any | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);

  const activeMenu = useMemo(
    () => getActiveMenu(pathname || '/dashboard', myRole === 'SUPER_ADMIN'),
    [pathname, myRole],
  );
  // The platform account never lands on a business screen: anything outside
  // its own pages goes to Companies (the backend would refuse it anyway).
  const platformBlocked =
    (myRole === 'SUPER_ADMIN' && !!pathname && !isPlatformPath(pathname)) ||
    // …and a company account never lands on a platform-only screen.
    (!!myRole && myRole !== 'SUPER_ADMIN' && !!pathname && isPlatformOnlyPath(pathname));
  useEffect(() => {
    if (platformBlocked) router.replace(myRole === 'SUPER_ADMIN' ? PLATFORM_HOME : '/dashboard');
  }, [platformBlocked, router, myRole]);

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
    setMyRole(decodeToken()?.role ?? null);
    setRoleReady(true);
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : '';
    if (!token) return;
    // Pull the operator's display currency once per session so every screen
    // renders amounts in their own currency instead of a hard-coded symbol.
    loadCurrencyFromApi(API, token);
    const payload = decodeToken();
    setImp(payload?.imp ?? null);
    setMyRole(payload?.role ?? null);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    // Approval badge: how many refunds/expenses are waiting on the ISP owner.
    // Approvals live inside a company; the platform account has none.
    if (payload?.role === 'ADMIN') {
      const loadApprovals = () => fetch(`${API}/accounting/pending-approvals`, { headers })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setPendingApprovals(d.total || 0); })
        .catch(() => {});
      loadApprovals();
      const t = setInterval(loadApprovals, 60000);
      // best-effort cleanup if the component unmounts
      if (typeof window !== 'undefined') (window as any).__jbApprovalTimer && clearInterval((window as any).__jbApprovalTimer);
      if (typeof window !== 'undefined') (window as any).__jbApprovalTimer = t;
    }
    fetch(`${API}/users`, { headers })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        const me = payload?.sub;
        setSwitchList((Array.isArray(rows) ? rows : []).filter((u: any) => u.id !== me));
      })
      .catch(silent("usersListFetch"));
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
    const savedW = window.localStorage.getItem('app_shell_width');
    if (savedW) {
      const n = parseInt(savedW, 10);
      if (!Number.isNaN(n) && n >= MIN_W && n <= MAX_W) setWidth(n);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('app_shell_collapsed', collapsed ? '1' : '0');
  }, [collapsed]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('app_shell_width', String(width));
  }, [width]);

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
      if (!btn || (btn as HTMLButtonElement).disabled || btn.hasAttribute('data-no-ripple')) return;
      const now = Date.now();
      if (now - last < 80) return;
      last = now;

      // Clip only while the ripple runs, then give the button back its own
      // overflow — leaving it hidden for good cut off anything drawn outside
      // the button afterwards (badges, the super admin's crown).
      const cs = getComputedStyle(btn);
      if (cs.position === 'static') btn.style.position = 'relative';
      const running = Number(btn.dataset.ripples || 0);
      if (!running) btn.dataset.prevOverflow = btn.style.overflow || '';
      btn.dataset.ripples = String(running + 1);
      if (cs.overflow !== 'hidden') btn.style.overflow = 'hidden';

      const rect = btn.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const r = document.createElement('span');
      r.className = 'nova-ripple';
      r.style.width = r.style.height = `${size}px`;
      r.style.left = `${e.clientX - rect.left - size / 2}px`;
      r.style.top = `${e.clientY - rect.top - size / 2}px`;
      btn.appendChild(r);
      setTimeout(() => {
        r.remove();
        const left = Number(btn.dataset.ripples || 1) - 1;
        if (left > 0) { btn.dataset.ripples = String(left); return; }
        btn.style.overflow = btn.dataset.prevOverflow || '';
        delete btn.dataset.ripples;
        delete btn.dataset.prevOverflow;
      }, 600);
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
    const loadProfile = () =>
      fetch(`${API}/auth/profile`, { headers })
        .then((res) => {
          // Only a rejected session signs the operator out. A busy server (429),
          // a restart (502) or a dropped connection must not — this check runs
          // every 45 seconds and on every focus.
          if (res.status === 401 || res.status === 403) throw new Error('signed-out');
          if (!res.ok) return null;
          return res.json();
        })
        .then((data) => {
          if (!data) return;
          const u = data?.user ?? data;
          // Belt and braces with the login redirect: a session that reaches the
          // shell while a forced change is pending is sent back to it.
          if (u?.mustChangePassword) { router.replace('/change-password'); return; }
          // The role in the token is the one it was issued with. If the account
          // has since changed (e.g. moved out of the platform account into its
          // company), swap the token for a fresh one so the menu matches.
          const tp = decodeToken();
          if (u?.role && tp?.role && !tp.imp && tp.role !== u.role && !roleRefreshStarted.current) {
            roleRefreshStarted.current = true;
            fetch(`${API}/auth/refresh`, { method: 'POST', headers, body: JSON.stringify({ token }) })
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => {
                if (!d?.token) return;
                localStorage.setItem('token', d.token);
                window.location.assign(u.role === 'SUPER_ADMIN' ? PLATFORM_HOME : '/dashboard');
              })
              .catch(() => {});
          }
          setUser(u);
        })
        .catch((e) => { if (String(e?.message) === 'signed-out') router.replace('/login'); });
    loadProfile();

    // The My Profile page fires this after saving a new picture, so the header
    // avatar updates immediately without a full reload.
    const onPhoto = () => loadProfile();
    window.addEventListener('profile-photo-changed', onPhoto);
    // Keep the header wallet balance fresh — it used to be fetched only once, so
    // after an activation or top-up it showed a stale figure. Refresh on a timer
    // and whenever the tab regains focus.
    const balanceTimer = window.setInterval(loadProfile, 45000);
    const onFocus = () => loadProfile();
    window.addEventListener('focus', onFocus);
    // Any code that moves money can dispatch this to refresh the header at once.
    const onBalance = () => loadProfile();
    window.addEventListener('wallet-changed', onBalance);

    fetch(`${API}/communication/latest`, { headers })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setLatestNotice(data || null))
      .catch(() => setLatestNotice(null));

    return () => {
      window.removeEventListener('profile-photo-changed', onPhoto);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('wallet-changed', onBalance);
      window.clearInterval(balanceTimer);
    };
  }, []);

  useEffect(() => {
    const fmt = new Intl.DateTimeFormat(locale === "en" ? "en-US" : locale, {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const fmtD = new Intl.DateTimeFormat(locale === "en" ? "en-US" : locale, {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
    const tick = () => {
      const now = new Date();
      setTime(fmt.format(now));
      setDate(fmtD.format(now));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [locale]);

  const handleLogout = () => {
    localStorage.removeItem('token');
    clearMediaToken();
    router.replace('/login');
  };

  // Session inactivity auto-logout. After N minutes with no mouse/keyboard/touch
  // activity, the panel logs the operator out — so an unattended terminal can't
  // be used by someone else. Default 30 min; override with
  // NEXT_PUBLIC_IDLE_LOGOUT_MIN. Any real activity resets the timer.
  useEffect(() => {
    const mins = Number(process.env.NEXT_PUBLIC_IDLE_LOGOUT_MIN) || 30;
    if (mins <= 0) return;
    let timer: number;
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (localStorage.getItem('token')) { localStorage.removeItem('token'); router.replace('/login?reason=idle'); }
      }, mins * 60_000);
    };
    const evs = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    evs.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => { window.clearTimeout(timer); evs.forEach((e) => window.removeEventListener(e, reset)); };
  }, [router]);

  const checkUpdate = async () => {
    if (typeof window === 'undefined') return;
    const token = localStorage.getItem('token');
    if (!token || myRole !== 'SUPER_ADMIN') return;
    setCheckingUpdate(true);
    try {
      const res = await fetch(`${API}/update/check`, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok) {
        setUpdateInfo(data);
      } else {
        setUpdateInfo({ error: data?.message || 'Failed to check for updates' });
      }
    } catch (error) {
      setUpdateInfo({ error: String(error) });
    } finally {
      setCheckingUpdate(false);
    }
  };

  const pullUpdate = async () => {
    if (!window.confirm('Pull the latest update from git and restart the backend if available?')) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    setUpdating(true);
    try {
      // force: the operator explicitly asked to update, so run the deploy script
      // even if we can't prove we're behind (a failed `git fetch` used to make
      // this silently report "already up to date" and do nothing).
      const res = await fetch(`${API}/update/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(`Update failed: ${data?.message || 'Unknown error'}`);
        setUpdateInfo({ error: data?.message || 'Update failed' });
      } else {
        alert(data?.message || 'Update completed. Restarting backend.');
        setUpdateInfo(data);
      }
    } catch (error) {
      alert(`Update failed: ${String(error)}`);
      setUpdateInfo({ error: String(error) });
    } finally {
      setUpdating(false);
    }
  };

  useEffect(() => {
    if (myRole === 'SUPER_ADMIN') {
      checkUpdate();
    }
  }, [myRole]);

  const title = t(menuItems.find((item) => item.id === activeMenu)?.label || 'Dashboard');


  return (
    <div className="db-root">
      {/* Nova UI kit stylesheet — mounted once here so every page can compose
          the shared primitives without importing styles of its own. */}
      <NovaStyles />
      {/* Backdrop behind the mobile drawer — tap to close (shown on phones only). */}
      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />}
      <aside
        className={`sidebar ${rail ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''} ${peeking ? 'peeking' : ''} ${dragging ? 'dragging' : ''}`}
        style={{ width: sidebarW }}
        onPointerEnter={startPeek}
        onPointerLeave={deferUnpeek}
        onPointerDown={(e) => {
          // Drag anywhere on the rail opens it; text selection would otherwise
          // fight the gesture. Only on desktop, and only when collapsed.
          if (collapsed && !peeking && !dragging && !isMobileView() && (e.target as HTMLElement).closest('button') === null) {
            beginDrag(e);
          }
        }}
      >
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden="true">
            {/* Linked-boxes glyph, matching the favicon/logo mark. */}
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
              <rect x="4" y="5" width="12" height="12" rx="3.6" fill="none" stroke="#fff" strokeWidth="2.2" opacity="0.85" />
              <rect x="9" y="8" width="12" height="12" rx="3.6" fill="none" stroke="#fff" strokeWidth="2.2" />
            </svg>
          </div>
          {!rail && (
            <div className="brand-meta">
              <div className="brand-title">{BRAND.name}</div>
              <div className="brand-subtitle">{BRAND.subtitle}</div>
            </div>
          )}
        </div>

        <nav className="nav-section">
          {(myRole === 'SUPER_ADMIN' ? platformMenuGroups : menuGroups).map((group) => {
            // ISP-only items (Server Console) are hidden for everyone else.
            const items = group.items.filter((it: any) => !it.ispOnly || myRole === 'SUPER_ADMIN');
            if (items.length === 0) return null;
            return (
            <div key={group.label}>
              {!rail && <div className="nav-label">{t(group.label)}</div>}
              {items.map((item) => {
                const isActive = item.id === activeMenu;
                const Icon = item.Icon;
                return (
                  <button
                    key={item.href}
                    type="button"
                    className={`nav-item ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      setMobileOpen(false); // close the drawer after navigating on mobile
                      if (item.href === '#assistant') window.dispatchEvent(new Event('open-assistant'));
                      else router.push(item.href);
                    }}
                    title={rail ? item.label : ''}
                  >
                    <span className="nav-icon"><Icon /></span>
                    {!rail && <span>{t(item.label)}</span>}
                    {item.id === 'billing' && pendingApprovals > 0 && (
                      <span title={`${pendingApprovals} awaiting your approval`}
                        style={{ marginLeft: 'auto', background: '#ef4444', color: '#fff', borderRadius: 999, fontSize: 10, fontWeight: 700, minWidth: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' }}>
                        {pendingApprovals}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            );
          })}
        </nav>

        {/* Smart-sidebar footer: pin keeps the hover-expanded rail open, or
            collapses the expanded sidebar back to the rail. */}
        <div className="sidebar-actions">
          <button
            type="button"
            className={`sb-pin ${collapsed ? '' : 'pinned'}`}
            onClick={() => { setCollapsed((c) => !c); setPeeking(false); }}
            title={collapsed ? 'Pin sidebar open' : 'Collapse to rail'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17v5" />
              <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
            </svg>
            {!rail && <span>{collapsed ? 'Pin open' : 'Collapse'}</span>}
          </button>
        </div>

        {/* The account card and log-out button used to live here. They moved to
            the avatar menu in the top-right — occasional actions shouldn't hold
            permanent space in the navigation. */}
      </aside>

      {/* Drag-to-slide handle on the sidebar's right edge. Fixed so it never
          scrolls with the nav; left is kept in step with the live width.
          Double-click toggles rail/expanded. */}
      <div
        className="sb-handle"
        style={{ left: Math.max(dragW ?? (collapsed && !peeking ? RAIL_W : width) - 6, 0) }}
        onPointerDown={beginDrag}
        onPointerEnter={startPeek}
        onPointerLeave={deferUnpeek}
        onDoubleClick={toggleSidebar}
        title="Drag to resize · double-click to collapse"
      />

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="topbar-sidebar-toggle"
              onClick={toggleSidebar}
              aria-label="Menu"
              title="Menu"
            >
              {/* Hamburger on mobile (clearly a menu); chevron reflects the visible state on desktop: hamburger while railed, chevron once open (incl. peek). */}
              <span className="hamburger-mobile"><Icons.Menu /></span>
              <span className="chevron-desktop">{rail ? <Icons.Menu /> : <Icons.ChevronLeft />}</span>
            </button>
            <div>
            <div className="topbar-title">{title}</div>
            <div className="topbar-sub">{date || t('Unified control panel')}</div>
            </div>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event('open-command-palette'))}
              title="Find any feature or action"
              style={{ marginLeft: 14, display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: 10, padding: '7px 12px', fontSize: 12.5, cursor: 'pointer' }}
            >
              <span>🔎 {t('Find features')}</span>
              <kbd style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, padding: '1px 6px', fontSize: 11 }}>Ctrl K</kbd>
            </button>
          </div>

          {/* Header search removed — "Find features" (Ctrl K) and Trace Search
              cover finding things; the wide bar was redundant chrome. */}

          <div className="topbar-right">
            {/* Wallet balance, always visible.
                This is the number that decides whether the next activation
                goes through. A reseller discovering they are empty only when
                a customer is standing in front of them is a wasted visit, so
                it lives permanently in the chrome rather than behind a page. */}
            {/* Owners (the platform, an ISP company) are where money starts — no wallet to show. */}
            {user?.balance !== undefined && myRole !== 'SUPER_ADMIN' && myRole !== 'ADMIN' && (
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

            {/* The bell stays in the bar; everything else that used to crowd the
                header (language, theme, clock, online status, Act as, updates,
                the latest notice) lives in the account menu below. */}
            <NotificationBell />

            <div className="nv-menu-wrap" style={{ position: 'relative' }}>
              <button
                type="button"
                className={`acct-trigger ${accountOpen ? 'open' : ''}`}
                data-no-ripple
                onClick={() => { setAccountOpen((p) => !p); setSwitchOpen(false); setNoticeOpen(false); }}
                aria-haspopup="menu"
                aria-expanded={accountOpen}
                title={user?.name || 'Account'}
              >
                <span className="acct-av">
                  {user?.photoUrl
                    ? <Avatar name={user?.name} photoUrl={user.photoUrl} size={30} />
                    : getInitials(user?.name)}
                  <span className="acct-dot" aria-hidden />
                  {user?.role === 'SUPER_ADMIN' && <CrownBadge size={32} />}
                </span>
                <span className="acct-meta">
                  <b>{user?.name || t('Account')}</b>
                  <em>{time}</em>
                </span>
                {(updateInfo?.behind || latestNotice) && <span className="acct-alert" aria-label={updateInfo?.behind ? 'Update available' : 'New notice'} />}
                <svg className="chev" width="11" height="11" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {accountOpen && (
                <>
                  <div className="nv-menu-catch" onClick={() => setAccountOpen(false)} />
                  <div className="nv-menu acct-menu" role="menu">
                    <div className="acct-head">
                      <span className="acct-av lg">
                        {user?.photoUrl
                          ? <Avatar name={user?.name} photoUrl={user.photoUrl} size={38} />
                          : getInitials(user?.name)}
                        {user?.role === 'SUPER_ADMIN' && <CrownBadge size={42} />}
                      </span>
                      <span className="acct-id">
                        <b>{user?.name || 'Loading…'}</b>
                        <em>{[user?.role, user?.email].filter(Boolean).join(' · ')}</em>
                        <span className="acct-live"><span className="acct-dot inline" aria-hidden />{t('Online')} · {time}</span>
                      </span>
                    </div>

                    {switchList.length > 0 && (
                      <button type="button" role="menuitem" className="acct-row"
                        onClick={() => { setAccountOpen(false); setSwitchOpen(true); }}>
                        <Icons.Users />
                        <span>Act as another account</span>
                        <em>{switchList.length}</em>
                      </button>
                    )}

                    <div className="acct-row static">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <circle cx="12" cy="12" r="9" />
                        <path d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
                      </svg>
                      <label htmlFor="acct-lang">Language</label>
                      <select id="acct-lang" className="acct-select" value={lang} onChange={(e) => setLang(e.target.value as any)}>
                        {LANGS.map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}
                      </select>
                    </div>

                    <div className="acct-row static">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                      </svg>
                      <span>Theme</span>
                      <ThemeToggle compact />
                    </div>

                    {latestNotice && (
                      <button type="button" role="menuitem" className="acct-row"
                        onClick={() => { setAccountOpen(false); setNoticeOpen(true); }}>
                        <Icons.Bell />
                        <span className="acct-clip">{latestNotice.title || t('Latest notification')}</span>
                        <em className="new">new</em>
                      </button>
                    )}

                    {user?.role === 'SUPER_ADMIN' && (
                      <button type="button" role="menuitem" className="acct-row" disabled={updating}
                        onClick={updating ? undefined : () => { void pullUpdate(); }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <polyline points="23 4 23 10 17 10" /><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10" />
                        </svg>
                        <span>{checkingUpdate ? 'Checking for updates…' : updating ? 'Updating…' : updateInfo?.behind ? 'Install update' : 'Check for updates'}</span>
                        {updateInfo?.behind && !updating && <em className="new">available</em>}
                      </button>
                    )}

                    <div className="acct-sep" />
                    <button type="button" role="menuitem" className="acct-row"
                      onClick={() => { setAccountOpen(false); router.push('/my-profile'); }}>
                      <Icons.Users /><span>{t('My Profile')}</span>
                    </button>
                    <button type="button" role="menuitem" className="acct-row"
                      onClick={() => { setAccountOpen(false); router.push(myRole === 'SUPER_ADMIN' ? '/settings' : '/admin-center?tab=settings'); }}>
                      <Icons.Settings /><span>{t('Settings')}</span>
                    </button>
                    <div className="acct-sep" />
                    <button type="button" role="menuitem" className="acct-row danger"
                      onClick={() => { setAccountOpen(false); handleLogout(); }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
                      </svg>
                      <span>{t('Log out')}</span>
                    </button>
                  </div>
                </>
              )}

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

                {noticeOpen && (
                  <div style={{
                    position: 'absolute', right: 0, top: 46, width: 320, zIndex: 40,
                    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14,
                    boxShadow: '0 20px 60px rgba(0,0,0,.18)', overflow: 'hidden',
                  }}>
                    <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700 }}>{t('Latest notification')}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{new Date(latestNotice.createdAt).toLocaleString(locale === 'en' ? 'en-US' : locale)}</div>
                      </div>
                      <button type="button" onClick={() => setNoticeOpen(false)} style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', padding: 0, fontSize: 14 }}>
                        ×
                      </button>
                    </div>
                    <div style={{ padding: '14px 16px' }}>
                      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>{latestNotice.title || t('Untitled notice')}</div>
                      <div style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{latestNotice.body || t('No details available.')}</div>
                    </div>
                    <div style={{ borderTop: '1px solid var(--border)', padding: '10px 16px', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <button type="button" onClick={() => { setNoticeOpen(false); router.push('/communication'); }} style={{ border: '1px solid var(--border)', borderRadius: 9, background: 'transparent', color: 'var(--text)', fontSize: 12, padding: '8px 12px', cursor: 'pointer' }}>
                        {t('View all')}
                      </button>
                    </div>
                  </div>
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

        {/* The skip link's target. tabIndex -1 makes it programmatically
            focusable so focus actually MOVES here — without it the browser
            scrolls but leaves focus behind, and the next Tab returns to the
            navigation the user just skipped. */}
        <main id="main" tabIndex={-1} className="app-shell-page-content">
          <div className="app-shell-page-inner">
            {/* Renders nothing unless there are static IP charges to chase. */}
            {roleReady && myRole !== 'SUPER_ADMIN' && <StaticIpBanner />}
            {/* Renders nothing on an ACTIVE licence, which is the normal case. */}
            <LicenceBanner />
            <div key={mediaKey} style={{ display: 'contents' }}>{roleReady && !platformBlocked ? children : null}</div>
          </div>
        </main>

        {/* Global feature finder — Ctrl/⌘+K on any screen. */}
        <CommandPalette />

        {/* Mobile bottom navigation. Hidden on desktop by CSS; "More" opens the
            same drawer the hamburger does. */}
        {myRole !== 'SUPER_ADMIN' && <BottomNav onMore={() => setMobileOpen(true)} />}

        {/* Footer removed. It said nothing that changes, and it cost a strip
            of vertical space on every screen — the version number belongs in
            Help, not in the way of the table you are reading. */}
      </div>
    </div>
  );
}

export function AppShellGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // /change-password renders without the shell: a forced change happens before
  // the account may load anything else, and the shell fetches a dozen
  // endpoints that would each answer 403 until the password is changed.
  const publicPaths = ['/login', '/', '/change-password'];

  // Subscriber portal has its own lightweight UI — never wrap it in the admin shell
  if (publicPaths.includes(pathname || '/') || (pathname || '').startsWith('/portal')) {
    return <>{children}</>;
  }

  // The provider goes here, not around the portal or login: it polls an
  // authenticated endpoint, and it installs the 402 interceptor that the
  // operator screens need. The subscriber portal has neither concern.
  return (
    <LicenceProvider>
      <AppShell>{children}</AppShell>
    </LicenceProvider>
  );
}

