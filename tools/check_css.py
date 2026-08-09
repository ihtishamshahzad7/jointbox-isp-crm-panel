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

    # 4. A declaration without a colon is almost always a truncated edit.
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
