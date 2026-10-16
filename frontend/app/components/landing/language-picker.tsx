"use client";

import { useEffect, useRef, useState } from "react";
import s from "./landing.module.css";
import { LANGS, useI18n } from "../../../lib/i18n";

/** The language menu shared by the landing and login pages. Escape or a click outside closes it. */
export function LanguagePicker() {
  const { lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const current = LANGS.find((l) => l.code === lang)?.native ?? "English";
  return (
    <div className={s.langWrap} ref={ref}>
      <button type="button" className={s.lang} aria-expanded={open} aria-haspopup="true" aria-label={`Language: ${current}`} onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3z" />
        </svg>
        <span>{current}</span>
      </button>
      {open && (
        <div className={s.langMenu}>
          {LANGS.map((l) => (
            <button
              key={l.code}
              type="button"
              className={s.langItem}
              aria-current={lang === l.code}
              onClick={() => { setLang(l.code); setOpen(false); }}
            >
              <span>{l.native}</span>
              {lang === l.code && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
