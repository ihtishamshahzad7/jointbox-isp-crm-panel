#!/usr/bin/env python3
"""
check_css.py — catch the CSS mistakes that a brace count cannot.

WHY THIS EXISTS
A stylesheet edit was verified with "braces balance to zero" and shipped. The
braces did balance. The file was still invalid: a search-and-replace had left
three rules with an EMPTY selector (`{ --bg: ... }`), which Turbopack rejects
outright, so the whole frontend build failed after the code was already pushed.

Balanced braces prove nothing about whether each rule has a selector, whether
@import rules still precede everything else, or whether a declaration block is
missing its colon. This checks those directly.

    python tools/check_css.py frontend/app/globals.css
"""

from __future__ import annotations
import re
import sys
from pathlib import Path


def mask_comments(css: str) -> str:
    """Blank out comments so scanning can't be confused by braces inside prose."""
    out = list(css)
    i = 0
    while i < len(css):
        if css.startswith("/*", i):
            j = css.find("*/", i + 2)
            j = len(css) if j < 0 else j + 2
            for k in range(i, j):
                if out[k] != "\n":
                    out[k] = " "
            i = j
        else:
            i += 1
    return "".join(out)


def line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def split_selector_list(sel: str) -> list[str]:
    """
    Split a selector list on top-level commas only.

    `[style*="rgb(129, 140, 248)"]` contains commas of its own. Splitting on
    every comma is exactly the bug this file exists to catch, so the checker
    must not commit it while looking for it.
    """
    parts: list[str] = []
    buf = ""
    depth = 0
    quote: str | None = None
    for ch in sel:
        if quote:
            buf += ch
            if ch == quote:
                quote = None
            continue
        if ch in "\"'":
            quote = ch
            buf += ch
            continue
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(buf.strip())
            buf = ""
        else:
            buf += ch
    if buf.strip():
        parts.append(buf.strip())
    return parts


def check(path: Path) -> list[str]:
    css = path.read_text(encoding="utf-8")
    masked = mask_comments(css)
    problems: list[str] = []

    # 1. Braces must balance.
    depth = masked.count("{") - masked.count("}")
    if depth:
        problems.append(f"unbalanced braces: {depth:+d}")

    # 2. Every rule needs a selector. THIS is the one that bit us.
    i = 0
    while True:
        b = masked.find("{", i)
        if b < 0:
            break
        prev = masked.rfind("}", 0, b)
        prev = max(prev, masked.rfind("{", 0, b))
        sel = masked[prev + 1:b].strip()
        if not sel:
            problems.append(f"line {line_of(css, b)}: empty selector before '{{'")
        i = b + 1

    # 3. @import must precede every rule, or browsers silently drop it.
    first_rule = re.search(r"^[^@\s/][^{]*\{", masked, re.M)
    if first_rule:
        for m in re.finditer(r"@import[^;]*;", masked):
            if m.start() > first_rule.start():
                problems.append(
                    f"line {line_of(css, m.start())}: @import appears after a rule — it will be ignored"
                )

    # 4. Every selector part must actually look like a selector.
    #
    # A scripted edit that splits selector lists on "," will happily split
    # INSIDE rgb(129, 140, 248), producing fragments like `html 140` and
    # `248)"]`. Braces still balance and no selector is empty, so the earlier
    # checks pass while the stylesheet is nonsense.
    #
    # Brackets are counted with QUOTED text removed first: a perfectly legal
    # selector such as button[style*="linear-gradient(135deg,#6C3CE1"] has an
    # unclosed paren inside its attribute value, and flagging that would bury
    # the real problems under false alarms.
    for m in re.finditer(r"(^|\})([^{}]*)\{", masked):
        sel = m.group(2)
        if sel.lstrip().startswith("@"):
            continue
        for p in split_selector_list(sel):
            bare = re.sub(r"\"[^\"]*\"|'[^']*'", "", p)
            for token in bare.split():
                if re.fullmatch(r"[\d.]+[,)\]]*", token):
                    problems.append(
                        f"line {line_of(css, m.start(2))}: selector contains a bare number "
                        f"({token!r}) — a selector list was probably split inside rgb(...): {p[:44]!r}"
                    )
                    break
            if bare.count("(") != bare.count(")") or bare.count("[") != bare.count("]"):
                problems.append(
                    f"line {line_of(css, m.start(2))}: unbalanced brackets in selector: {p[:44]!r}"
                )

    # 5. A dark text colour applied to .db-root will black out the sidebar.
    #
    # `.db-root` is the whole shell — it contains BOTH the white page and the
    # dark navigation rail. A page-wide rule like
    #     .db-root span { color: #1C2434 }
    # therefore paints the menu labels the same colour as the rail they sit on,
    # and the navigation disappears. This has happened twice. Page text rules
    # must target `.main`.
    for m in re.finditer(r"(^|\})([^{}]*)\{([^{}]*)\}", masked):
        sel, body = m.group(2), m.group(3)
        if ".db-root" not in sel or ".sidebar" in sel:
            continue
        cm = re.search(r"(?:^|;)\s*color\s*:\s*#([0-9A-Fa-f]{6})", body)
        if not cm:
            continue
        r_, g_, b_ = (int(cm.group(1)[i:i+2], 16) for i in (0, 2, 4))
        if r_ + g_ + b_ < 300:                     # a dark colour
            problems.append(
                f"line {line_of(css, m.start(2))}: dark colour #{cm.group(1)} applied to "
                f"a .db-root selector — this also hits the sidebar and hides the menu. "
                f"Use .main instead: {sel.strip()[:44]!r}"
            )

    # 6. A declaration without a colon is almost always a truncated edit.
    for m in re.finditer(r"\{([^{}]*)\}", masked):
        for decl in m.group(1).split(";"):
            d = decl.strip()
            if d and ":" not in d:
                problems.append(
                    f"line {line_of(css, m.start())}: declaration without a colon: {d[:40]!r}"
                )
    return problems


def main() -> int:
    targets = sys.argv[1:] or ["frontend/app/globals.css"]
    failed = False
    for t in targets:
        p = Path(t)
        if not p.exists():
            print(f"✗ {t}: not found")
            failed = True
            continue
        issues = check(p)
        if issues:
            failed = True
            print(f"✗ {t}: {len(issues)} problem(s)")
            for i in issues[:20]:
                print(f"    {i}")
        else:
            print(f"✓ {t}: valid ({len(p.read_text(encoding='utf-8').splitlines())} lines)")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
