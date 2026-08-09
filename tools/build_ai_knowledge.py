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


def main() -> int:
    if not FRONTEND.exists() or not BACKEND.exists():
        print(f"error: run this from the repo root (looked in {ROOT})", file=sys.stderr)
        return 1

    screens = scan_screens()
    actions = scan_actions()
    entries = screens + actions

    payload = {
        "generated": True,
        "note": "Auto-generated from the codebase by tools/build_ai_knowledge.py. "
                "Do not edit by hand — re-run the script instead.",
        "counts": {"screens": len(screens), "actions": len(actions), "total": len(entries)},
        "entries": entries,
    }

    if "--print" in sys.argv:
        print(json.dumps(payload, indent=2)[:4000])
        print(f"\n… {len(entries)} entries (preview truncated)")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"✓ wrote {OUT.relative_to(ROOT)}")
    print(f"  screens: {len(screens)}   actions: {len(actions)}   total: {len(entries)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
