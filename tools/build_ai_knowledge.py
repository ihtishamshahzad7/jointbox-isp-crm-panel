#!/usr/bin/env python3
"""
build_ai_knowledge.py — teach the panel's assistant about itself.

WHY THIS EXISTS
The assistant answers from a hand-written knowledge base. Hand-written means it
goes stale the moment someone ships a feature and forgets to add an entry — which
is exactly what happened: the KB knew nothing about My Work, Quick Connect,
Renewals, alerts or NAS monitoring weeks after they shipped.

This script reads the SOURCE OF TRUTH — the code itself — and generates knowledge
entries from it:

  • every screen the user can open      (frontend/app/**/page.tsx  ->  route)
  • every action the backend exposes    (backend/src/**/*.controller.ts)
  • the "why" the developers wrote      (the /** ... */ block above each file)

Run it after adding features and the assistant learns them. Nothing is invented:
if the code doesn't say it, it doesn't end up in the answer.

USAGE
    python tools/build_ai_knowledge.py            # write the JSON
    python tools/build_ai_knowledge.py --print    # preview without writing
"""

from __future__ import annotations
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend" / "app"
BACKEND = ROOT / "backend" / "src"
OUT = ROOT / "backend" / "src" / "ai" / "knowledge.generated.json"

# Routes that are internal plumbing, not places a user "goes".
SKIP_ROUTES = {"", "login", "portal"}

# Where each top-level route lives in the menu, so answers can say "go to X".
MENU = {
    "dashboard": "Daily Work → Dashboard",
    "my-work": "Daily Work → My Work",
    "my-business": "Daily Work → My Work → My Business",
    "quick-connect": "Daily Work → My Work → Quick Connect",
    "renewals": "Daily Work → My Work → Renewals",
    "subscribers": "Daily Work → Subscribers",
    "support-center": "Daily Work → Support",
    "trace": "Daily Work → Trace Search",
    "network-center": "Operations → Network",
    "operations": "Operations → Network → Operations",
    "noc": "Operations → Network → NOC / Uptime",
    "nas": "Operations → Network → NAS / Routers",
    "fiber": "Operations → Network → FTTH / Fiber",
    "ip-pools": "Operations → Network → IP Pools",
    "static-ips": "Operations → Network → Static IPs",
    "outages": "Operations → Network → Outages & Power",
    "service-catalog": "Operations → Plans & Stock",
    "packages": "Operations → Plans & Stock → Packages",
    "areas": "Operations → Plans & Stock → Areas",
    "inventory": "Operations → Plans & Stock → Inventory",
    "billing-center": "Business → Billing & Accounting",
    "accounting": "Business → Billing & Accounting → Accounting",
    "earnings": "Business → Billing & Accounting → Collections",
    "invoices": "Business → Billing & Accounting → Invoices",
    "payments": "Business → Billing & Accounting → Payments",
    "vouchers": "Business → Billing & Accounting → Vouchers",
    "pricing": "Business → Billing & Accounting → Reseller Pricing",
    "reversals": "Business → Billing & Accounting → Disputes & Reversals",
    "insights": "Business → Insights",
    "segments": "Business → Insights → Segments",
    "compliance": "Business → KYC & Data Usage",
    "admin-center": "System → Administration",
    "users": "System → Administration → Users",
    "organization": "System → Administration → Organization",
    "security": "System → Administration → Security",
    "settings": "System → Administration → Settings",
    "jobs": "System → Background Jobs",
    "setup": "System → Setup Checklist",
    "console": "System → Server Console (ISP owner only)",
    "radius-admin": "System → FreeRADIUS & Database (ISP owner only)",
    "logs": "Business → Insights → Logs",
    "docs": "System → Documentation",
    "communication": "Daily Work → Support → Communication",
    "complaints": "Daily Work → Support → Complaints",
    "field-jobs": "Daily Work → Support → Field Jobs",
}

# HTTP verb -> what it means to a person.
VERB = {
    "Get": "view", "Post": "create/run", "Put": "replace",
    "Patch": "update", "Delete": "remove",
}


def first_doc_comment(text: str) -> str:
    """Return the first /** ... */ block, cleaned into a sentence or two."""
    m = re.search(r"/\*\*(.*?)\*/", text, re.S)
    if not m:
        return ""
    body = m.group(1)
    lines = []
    for ln in body.splitlines():
        ln = ln.strip().lstrip("*").strip()
        if not ln or ln.startswith("@"):
            continue
        lines.append(ln)
    doc = " ".join(lines)
    doc = re.sub(r"\s+", " ", doc).strip()
    # Keep it to the first two sentences — the assistant answers concisely.
    parts = re.split(r"(?<=[.!?]) ", doc)
    return " ".join(parts[:2]).strip()


def route_of(page: Path) -> str:
    """frontend/app/nas/page.tsx -> 'nas'."""
    rel = page.relative_to(FRONTEND).parent.as_posix()
    return "" if rel == "." else rel


def scan_screens() -> list[dict]:
    """Every page the user can open, with its menu path and purpose."""
    out = []
    for page in sorted(FRONTEND.rglob("page.tsx")):
        route = route_of(page)
        top = route.split("/")[0]
        # Skip dynamic segments ([id]) — they're detail views of a parent screen.
        if "[" in route or top in SKIP_ROUTES:
            continue
        text = page.read_text(encoding="utf-8", errors="ignore")
        doc = first_doc_comment(text)
        where = MENU.get(route) or MENU.get(top) or f"/{route}"
        title = route.replace("-", " ").replace("/", " → ").title()
        answer = f"{where}."
        if doc:
            answer += f" {doc}"
        out.append({
            "t": f"Screen: {title}",
            "k": f"{route} {route.replace('-', ' ')} page screen where find open go to {title.lower()}",
            "a": answer,
            "src": "screens",
        })
    return out


def scan_actions() -> list[dict]:
    """Every backend capability, grouped per module, described in plain terms."""
    out = []
    for ctrl in sorted(BACKEND.rglob("*.controller.ts")):
        text = ctrl.read_text(encoding="utf-8", errors="ignore")
        base = re.search(r"@Controller\(['\"]([^'\"]*)['\"]\)", text)
        if not base:
            continue
        base_path = base.group(1)
        routes = re.findall(r"@(Get|Post|Put|Patch|Delete)\(\s*['\"]?([^'\")]*)['\"]?\s*\)", text)
        if not routes:
            continue
        verbs = []
        for verb, path in routes:
            p = f"/{base_path}/{path}".replace("//", "/").rstrip("/")
            verbs.append(f"{VERB.get(verb, verb)} {p}")
        module = ctrl.stem.replace(".controller", "")
        doc = first_doc_comment(text)
        answer = (doc + " ") if doc else ""
        answer += f"Available actions: {'; '.join(sorted(set(verbs))[:14])}."
        out.append({
            "t": f"What the panel can do: {module.replace('-', ' ')}",
            "k": f"{module} {module.replace('-', ' ')} api action endpoint capability can i",
            "a": answer.strip(),
            "src": "actions",
        })
    return out


# ── Plain-language safety notes ──────────────────────────────────────────────
# Auto-extraction can tell us a button EXISTS; it cannot know what happens after
# you press it. These are written by hand, keyed by words that appear in button
# labels, so every risky control comes with "what happens" and "can I undo it".
# Matching is longest-key-first so "bulk delete" wins over "delete".
RISK = {
    "delete": ("Removes the record for good.",
               "Invoices and payments already raised are KEPT — they detach instead of being destroyed. The record itself does not come back.",
               "high"),
    "delete forever": ("Destroys the record permanently.",
                       "This is the confirmed step — there is no recycle bin behind it.",
                       "high"),
    "mass delete": ("Removes EVERY customer you ticked, all at once.",
                    "Count the ticked rows before confirming. There is no single Undo for a mass delete.",
                    "high"),
    "sync all": ("Rewrites EVERY customer's login into FreeRADIUS.",
                 "Safe, but on a big base it runs for several minutes and loads the server. Use the per-customer Force Sync if only one person is broken.",
                 "medium"),
    "bulk delete": ("Removes EVERY row you ticked, all at once.",
                    "Count the ticked rows first. There is no single Undo for a bulk delete.",
                    "high"),
    "remove": ("Takes this item out of the list.",
               "Check you are on the right row — the row you are hovering is the one that goes.",
               "high"),
    "suspend": ("Cuts this customer's internet now.",
                "They drop offline within a minute. Un-suspending is one click, but they stay off until you do it.",
                "high"),
    "disconnect": ("Kicks the customer off their current session.",
                   "Their router normally dials back in within seconds. Use it to force a fresh IP or apply a new speed.",
                   "medium"),
    "reverse": ("Cancels a payment or commission that was already recorded.",
                "It writes a matching opposite entry — the original stays visible in the audit trail. Balances change immediately.",
                "high"),
    "refund": ("Gives money back and reduces the balance.",
               "Money movements are logged against your account. Confirm the amount before pressing.",
               "high"),
    "activate": ("Starts the customer's service and their billing period.",
                 "This charges the package price and generates an invoice. Billing runs from TODAY, so activating late does not lose you days.",
                 "medium"),
    "renew": ("Extends the customer for another period and charges for it.",
              "A preview shows the price and the new expiry date BEFORE anything is charged. Read it.",
              "medium"),
    "force sync": ("Rewrites this customer's login into FreeRADIUS from scratch.",
                   "Safe to press any time. It fixes 'renewed but still cannot connect'. It does not change their password.",
                   "low"),
    "import": ("Adds many records at once from a file.",
               "Nothing is saved until you press Import on the preview screen. Fix anything shown in red first.",
               "medium"),
    "export": ("Downloads what you are looking at as a file.",
               "Read-only — it changes nothing.",
               "low"),
    # NOTE: keyed on the FULL label, not the word "update" — a bare "update"
    # key matched "Update Package" and warned people that editing a plan would
    # log the whole company out. Panel upgrades have their own exact labels.
    "update now": ("Upgrades the whole panel to the newest version.",
                   "The panel restarts and everyone is logged out for 1-2 minutes. Do it outside busy hours.",
                   "high"),
    "update panel": ("Upgrades the whole panel to the newest version.",
                     "The panel restarts and everyone is logged out for 1-2 minutes. Do it outside busy hours.",
                     "high"),
    "activation": ("Opens the activate/renew screen for this customer.",
                   "The next screen previews the price and the new expiry before charging anything.",
                   "medium"),
    "grace": ("Gives the customer extra days without paying yet.",
              "Their expiry moves forward and auto-suspend skips them until it passes.",
              "medium"),
    "message": ("Sends a real SMS or notification to real customers.",
                "It cannot be unsent. Check exactly who is selected first.",
                "high"),
    "move": ("Hands this customer over to a different dealer or account.",
             "Pricing is recalculated for the new owner and settled pro-rata. Ownership really changes.",
             "high"),
    # The subscriber-list rows end with four two-letter buttons. "Off" and
    # "Del" sit next to each other and one is reversible while the other is
    # not — the single most dangerous pair of buttons in the panel.
    "off": ("Disables this customer so they cannot connect.",
            "Reversible — press it again to switch them back on. This is the safe one; Del next to it is not.",
            "high"),
    "del": ("Deletes this customer permanently.",
            "This is NOT the same as Off beside it. Invoices and payments are kept, but the customer record does not come back. If you only want to stop their internet, press Off instead.",
            "high"),
    "disable": ("Switches this record off so it stops being used.",
                "Anyone relying on it loses access until you enable it again.",
                "high"),
    "mass service": ("Applies one setting to EVERY customer you ticked.",
                     "Check the ticked count before confirming — it changes all of them together.",
                     "high"),
    "restart": ("Restarts a server service.",
                "Customers already online stay online, but new logins fail for a few seconds.",
                "high"),
    "save": ("Writes your changes.",
             "Nothing you typed takes effect until you press this.",
             "low"),
    "refresh": ("Re-reads the latest data.",
                "Read-only — it changes nothing.",
                "low"),
    "ping": ("Tests whether the router answers.",
             "Read-only. A failed ping means a network/firewall problem, not a Jointbox problem.",
             "low"),
    "notify": ("Sends a message to real customers.",
               "They receive it immediately and it cannot be unsent. Check who is selected.",
               "high"),
    "send": ("Sends a real message to real people.",
             "It cannot be unsent. Check the recipient list first.",
             "high"),
    "add": ("Opens a form to create a new record.",
            "Nothing is created until you fill the form and press Save.",
            "low"),
    "edit": ("Opens this record so you can change it.",
             "Your changes apply only after you press Save.",
             "low"),
}

# Labels that are decoration, not actions — never worth an entry.
BUTTON_NOISE = re.compile(r"^(\s*|[×✕✖✓↻⟳⛶⋯…•·›»‹«←→↑↓+\-–—?]+|\d+)$")

# `<button ...>` attributes contain arrow functions, and `[^>]*` stops at the
# `>` in `=>` — which leaked labels like `setShowTaxModal(false)}>Cancel`.
# Any leftover code punctuation means we captured source, not a label.
CODE_LEAK = re.compile(r"[(){}=<>;]")


def clean_label(raw: str) -> str:
    """Strip JSX noise from a captured button label."""
    s = re.sub(r"\{[^{}]*\}", " ", raw)          # {expr}
    s = re.sub(r"&amp;", "&", s)
    s = re.sub(r"&nbsp;", " ", s)
    s = re.sub(r"<[^>]+>", " ", s)               # nested tags
    s = re.sub(r"\s+", " ", s).strip()
    return s


def risk_for(label: str):
    """Longest matching hand-written safety note for a button label, or None."""
    low = label.lower().strip()
    if low in RISK:                       # exact label always wins
        return RISK[low]
    # Whole-word matching only: substring matching made "Create Allocation"
    # inherit the "add" note and would have made any label containing "update"
    # claim it restarts the server.
    hits = [k for k in RISK if re.search(rf"(?<![a-z]){re.escape(k)}(?![a-z])", low)]
    if not hits:
        return None
    return RISK[max(hits, key=len)]      # "mass delete" beats "delete"


def scan_buttons() -> tuple[list[dict], dict]:
    """
    Every clickable control the user can actually see, per screen.

    WHY: the commonest support question is not "where is X" but "what happens if
    I press this". We read the real labels out of the JSX so the assistant can
    never describe a button that does not exist, and attach the hand-written
    consequence from RISK so the answer says what the click DOES.
    """
    entries: list[dict] = []
    index: dict[str, list] = {}
    for page in sorted(FRONTEND.rglob("page.tsx")):
        route = route_of(page)
        top = route.split("/")[0]
        if "[" in route or top in SKIP_ROUTES:
            continue
        text = page.read_text(encoding="utf-8", errors="ignore")

        labels: list[str] = []
        # <button ...>Label</button>  (literal text only)
        labels += re.findall(r"<button\b[^>]*>([^<]{2,48}?)</button>", text)
        # aria-label / title on a button — the accessible name IS the label
        labels += re.findall(r"<button\b[^>]*?(?:aria-label|title)=\"([^\"]{2,48})\"", text)
        # Toolbar/tab arrays declared as objects:
        #   { label: "Add", icon: "＋", onClick: ... }     ← toolbar button
        #   { id: "noc", label: "NOC / Uptime", ... }      ← tab
        #
        # A bare `label:` is NOT enough — form fields and table columns use the
        # same key ({ key:"nasIp", label:"NAS IP" }), and the first version of
        # this scan cheerfully told users "RADIUS secret" was a button. So a
        # label only counts when the object around it also proves it is
        # clickable: an `onClick` after it, or an `id`/`icon` beside it.
        for m in re.finditer(r"label:\s*\"([^\"]{2,48})\"", text):
            near_before = text[max(0, m.start() - 70):m.start()]
            near_after = text[m.end():m.end() + 220]
            clickable = ("onClick" in near_after or "icon:" in near_after
                         or re.search(r"id:\s*\"[a-z0-9_-]+\"\s*,\s*$", near_before, re.I))
            if clickable:
                labels.append(m.group(1))

        seen, keep = set(), []
        for raw in labels:
            lab = clean_label(raw)
            if not lab or BUTTON_NOISE.match(lab) or len(lab) < 2 or CODE_LEAK.search(lab):
                continue
            key = lab.lower()
            if key in seen:
                continue
            seen.add(key)
            keep.append(lab)

        if not keep:
            continue
        where = MENU.get(route) or MENU.get(top) or f"/{route}"
        index[route] = [
            {"label": l, "does": (risk_for(l) or ("", "", "low"))[0],
             "careful": (risk_for(l) or ("", "", "low"))[1],
             "risk": (risk_for(l) or ("", "", "low"))[2]}
            for l in keep[:40]
        ]

        # One entry per screen listing its controls...
        entries.append({
            "t": f"Buttons on {route.replace('-', ' ').title()}",
            "k": f"{route} buttons button options controls what can i click press tap here {route.replace('-', ' ')}",
            "a": f"{where}. The controls on this screen are: " + ", ".join(keep[:24]) + ".",
            "src": "buttons",
        })
        # ...plus a dedicated entry per RISKY control, because those are the
        # clicks that cost money or cut someone's internet.
        for lab in keep:
            r = risk_for(lab)
            if not r or r[2] == "low":
                continue
            does, careful, level = r
            entries.append({
                "t": f'The "{lab}" button ({route.replace("-", " ").title()})',
                "k": f'{lab.lower()} {route} button what happens if i press click {lab.lower()} safe undo',
                "a": f"{where} → {lab}. What it does: {does} Before you press: {careful}",
                "src": "buttons",
            })
    return entries, index


def scan_tabs() -> tuple[list[dict], dict]:
    """
    The tabs inside each hub screen.

    WHY: hub pages share one route, so /network-center?tab=nas and ?tab=outages
    looked identical to the assistant and it answered about the wrong tab. The
    hubs already declare { id, label, hint } — that hint is a human-written
    one-liner, so we read it instead of guessing.
    """
    entries: list[dict] = []
    index: dict[str, list] = {}
    pat = re.compile(
        r"\{\s*id:\s*\"([a-z0-9_-]+)\"\s*,\s*label:\s*\"([^\"]+)\"\s*(?:,\s*hint:\s*\"([^\"]*)\")?",
        re.I,
    )
    for page in sorted(FRONTEND.rglob("page.tsx")):
        route = route_of(page)
        top = route.split("/")[0]
        if "[" in route or top in SKIP_ROUTES:
            continue
        text = page.read_text(encoding="utf-8", errors="ignore")
        found = [
            {"id": i, "label": l, "hint": (h or "").strip()}
            for i, l, h in pat.findall(text)
        ]
        # Only real tab strips: 2+ entries and at least one written hint.
        if len(found) < 2 or not any(f["hint"] for f in found):
            continue
        # Which real screen does each tab actually render?
        #
        # A hub tab is a thin wrapper: `render: () => <Nas />`, with `Nas`
        # imported from "../nas/page". Resolving that gives the tab the REAL
        # screen's route — and therefore its real buttons — instead of the
        # hub's. Without it, the button guide on /network-center?tab=nas listed
        # the hub's controls, which is to say almost none.
        imports = dict(
            (comp, re.sub(r"^\.\./|/page$", "", src).strip("./"))
            for comp, src in re.findall(
                r"import\s+(?:\{\s*)?([A-Z][A-Za-z0-9_]*)[^\n]*?from\s+\"([^\"]+/page)\"", text)
        )
        renders = dict(re.findall(r"id:\s*\"([a-z0-9_-]+)\"[^}]*?render:\s*\(\)\s*=>\s*<([A-Z][A-Za-z0-9_]*)", text, re.I))
        for f in found:
            target = imports.get(renders.get(f["id"], ""), "")
            if target:
                f["route"] = target

        index[route] = found
        where = MENU.get(route) or MENU.get(top) or f"/{route}"
        for f in found:
            if not f["hint"]:
                continue
            entries.append({
                "t": f'{f["label"]} tab',
                "k": f'{f["id"]} {f["label"].lower()} tab {route} {route.replace("-", " ")} what is this screen',
                "a": f'{where} → {f["label"]} tab. {f["hint"]}',
                "src": "tabs",
            })
    return entries, index


def main() -> int:
    if not FRONTEND.exists() or not BACKEND.exists():
        print(f"error: run this from the repo root (looked in {ROOT})", file=sys.stderr)
        return 1

    screens = scan_screens()
    actions = scan_actions()
    tabs, tab_index = scan_tabs()
    buttons, button_index = scan_buttons()
    entries = screens + actions + tabs + buttons

    payload = {
        "generated": True,
        "note": "Auto-generated from the codebase by tools/build_ai_knowledge.py. "
                "Do not edit by hand — re-run the script instead.",
        "counts": {
            "screens": len(screens), "actions": len(actions),
            "tabs": len(tabs), "buttons": len(buttons), "total": len(entries),
        },
        # Keyed by route so the backend can answer "what is this TAB" and
        # "what does this BUTTON do" without searching the whole KB.
        "tabs": tab_index,
        "buttons": button_index,
        "entries": entries,
    }

    if "--print" in sys.argv:
        print(json.dumps(payload, indent=2)[:4000])
        print(f"\n… {len(entries)} entries (preview truncated)")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"✓ wrote {OUT.relative_to(ROOT)}")
    print(f"  screens: {len(screens)}   actions: {len(actions)}   "
          f"tabs: {len(tabs)}   buttons: {len(buttons)}   total: {len(entries)}")
    print(f"  tab strips: {len(tab_index)} screens   button maps: {len(button_index)} screens")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
