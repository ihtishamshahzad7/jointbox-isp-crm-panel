import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '../../common/cache.service';
import type { CrmAnswer } from './ai-crm-query.service';

/**
 * OPTIONAL AI-MODEL WORDING FOR CRM ANSWERS.
 *
 * Ported in behaviour from the reference assistant's "AI mode"
 * (AI_ASSISTANT.md). The numbers are ALWAYS computed by the database
 * (AiCrmQueryService) and shown as tiles; the model only phrases the answer.
 * If anything about the model is off, the deterministic answer is returned
 * unchanged — the assistant never depends on it.
 *
 * Off unless the operator turns it on, because it sends company data to a
 * third party:
 *   AI_BASE_URL / AI_API_KEY / AI_MODEL   the same OpenAI-compatible model the help chat uses
 *   AI_CRM_DATA_TO_MODEL=true              explicit consent to send CRM figures to it
 *
 * What is sent: the question, the section and period, the server-built
 * figures and at most 20 already-redacted rows (customer rows are identity
 * and status only — the query service never selects phone, address, CNIC,
 * documents, passwords or bank details). Refusals and errors are never sent.
 * `store: false` is requested (it is a request — retention is the provider's
 * policy). No conversation history is kept.
 *
 * Limit: 10 model calls per user per 15 minutes (cluster-wide with Redis);
 * beyond that the plain answer is returned.
 */
const WINDOW_S = 15 * 60;
const MAX_CALLS = 10;
const MAX_ROWS = 20;

@Injectable()
export class AiNarratorService {
  private readonly logger = new Logger(AiNarratorService.name);
  private readonly local = new Map<string, { n: number; until: number }>();

  constructor(private readonly cache: CacheService) {}

  private get baseUrl() { return (process.env.AI_BASE_URL || '').replace(/\/$/, ''); }
  private get apiKey() { return process.env.AI_API_KEY || ''; }
  private get model() { return process.env.AI_MODEL || 'llama3.2:1b'; }

  /** Model configured AND the operator consented to sending CRM figures to it. */
  get enabled(): boolean {
    const configured = !!this.baseUrl && (!!this.apiKey || this.baseUrl.includes('11434'));
    return configured && process.env.AI_CRM_DATA_TO_MODEL === 'true';
  }

  /** True while this user is within their model allowance (and counts this call). */
  async allow(userId: number): Promise<boolean> {
    const bucket = Math.floor(Date.now() / (WINDOW_S * 1000));
    const key = `ai:narrate:${userId}:${bucket}`;
    const n = await this.cache.incr(key, WINDOW_S * 2).catch(() => null);
    if (n !== null && n !== undefined) return n <= MAX_CALLS;
    // No Redis: per-process count (looser across instances, never unlimited).
    const now = Date.now();
    const e = this.local.get(key);
    if (!e || e.until < now) {
      this.local.set(key, { n: 1, until: now + WINDOW_S * 1000 });
      return true;
    }
    e.n += 1;
    return e.n <= MAX_CALLS;
  }

  /** What leaves the server: figures and redacted rows only. */
  payload(question: string, a: CrmAnswer) {
    return {
      question: String(question).slice(0, 500),
      section: a.section,
      period: a.period,
      matchingRecords: a.matching,
      figures: a.tiles.map((t) => ({ label: t.label, value: t.value, ...(t.currency ? { currency: t.currency } : {}) })),
      rows: a.records.slice(0, MAX_ROWS),
    };
  }

  /**
   * Word the answer with the model, or return null to keep the plain one.
   * Never throws.
   */
  async narrate(question: string, a: CrmAnswer, userId: number | null): Promise<string | null> {
    if (!this.enabled || !a.ok || a.error || !userId) return null;
    if (!(await this.allow(userId))) return null;
    const lang = a.language === 'ur' ? 'Urdu (Urdu script)' : a.language === 'roman' ? 'Roman Urdu' : 'English';
    const system = [
      'You are the CRM assistant inside Uplinko, an ISP management panel.',
      `Answer in ${lang}, in at most 6 short sentences or bullet points.`,
      'Use ONLY the figures and rows in the JSON you are given. Never invent, estimate or recalculate numbers;',
      'copy them exactly, with their currency. If the data does not answer the question, say so.',
      'Do not ask for or mention passwords, ID numbers, phone numbers, addresses or bank details.',
    ].join(' ');
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20_000);
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey || 'ollama'}` },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          max_tokens: 400,
          store: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(this.payload(question, a)) },
          ],
        }),
        // The endpoint is the operator's own setting (often a local model, so the
        // public-only outbound guard does not apply) — but never follow a redirect.
        redirect: 'error',
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) return null;
      const data: any = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      return typeof text === 'string' && text.trim() ? text.trim().slice(0, 4000) : null;
    } catch (e: any) {
      this.logger.warn(`Model unavailable, using the plain answer: ${e?.message ?? e}`);
      return null;
    }
  }
}
