"use client";

import React from "react";
import useSWR from "swr";
import API from "../components/api";

type Status = {
  active: boolean;
  roleEnabled: boolean;
  role: string;
  providerConfigured: boolean;
  plan: {
    name: string;
    monthlyPrice: number;
    currency: string;
    monthlyRequestLimit: number | null;
    monthlyTokenLimit: number | null;
  } | null;
  usage: {
    requests: number;
    tokens: number;
    estimatedRequests: number;
    providerCost: number | null;
    periodStart: string;
  };
};

type AiAgentVisual = {
  title: string;
  unit: string;
  series: Array<{
    label: string;
    points: Array<{ label: string; value: number }>;
  }>;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  visuals?: AiAgentVisual[];
};

function token() {
  try {
    return localStorage.getItem("token") || "";
  } catch {
    return "";
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token()}`,
      ...(init?.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = Array.isArray(body?.message)
      ? body.message.join(", ")
      : body?.message;
    throw new Error(String(message || `Request failed (${response.status})`));
  }
  return body as T;
}

export default function AiAgentPage() {
  const {
    data: status,
    error: statusError,
    isLoading: loading,
    mutate,
  } = useSWR<Status, Error>("/ai-agent/status", () =>
    api<Status>("/ai-agent/status"),
  );
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [question, setQuestion] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  async function send(text = question) {
    const content = text.trim();
    if (!content || busy || !status?.active || !status.roleEnabled) return;
    setMessages((current) => [...current, { role: "user", content }]);
    setQuestion("");
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        reply: string;
        visuals?: AiAgentVisual[];
        providerInsight?: string | null;
        providerStatus?: string;
      }>("/ai-agent/chat", {
        method: "POST",
        body: JSON.stringify({ question: content }),
      });
      const providerNote = result.providerInsight
        ? `\n\nAI interpretation (may be imperfect; metrics above are authoritative): ${result.providerInsight}`
        : result.providerStatus === "unavailable-local-results"
          ? "\n\nThe configured AI provider is unavailable; these deterministic local metrics are still authoritative."
          : "";
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: `${result.reply}${providerNote}`,
          visuals: result.visuals ?? [],
        },
      ]);
      await mutate();
    } catch (reason) {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content:
            "The request could not be completed. Review the error above and try again.",
        },
      ]);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading AI Agent…</p>
    );

  return (
    <main style={PAGE}>
      <header style={HEADER}>
        <div>
          <h1 style={TITLE}>UPLINKO AI AGENT</h1>
          <p style={SUBTITLE}>
            Read-only operational summaries from the records you are allowed to
            access.
          </p>
        </div>
        <button type="button" onClick={() => void mutate()} style={BUTTON}>
          Refresh
        </button>
      </header>

      {(error || statusError) && (
        <div role="alert" style={ERROR}>
          {error || statusError?.message}
        </div>
      )}

      {!status?.active || !status.roleEnabled ? (
        <section style={CARD}>
          <h2 style={SECTION_TITLE}>AI Agent is not available</h2>
          <p style={HELP}>
            {!status?.active
              ? "This company does not currently have an active AI Agent add-on. Contact your platform administrator."
              : "Your role has not been enabled by your company administrator."}
          </p>
        </section>
      ) : (
        <>
          <section style={STATS}>
            <Stat label="Plan" value={status.plan?.name ?? "Active"} />
            <Stat
              label="Requests this month"
              value={`${status.usage.requests}${status.plan?.monthlyRequestLimit == null ? "" : ` / ${status.plan.monthlyRequestLimit}`}`}
            />
            <Stat
              label="Tokens this month"
              value={`${status.usage.tokens.toLocaleString()}${status.plan?.monthlyTokenLimit == null ? "" : ` / ${status.plan.monthlyTokenLimit.toLocaleString()}`}`}
            />
            {status.usage.estimatedRequests > 0 && (
              <Stat
                label="Estimated provider usage"
                value={`${status.usage.estimatedRequests} requests`}
              />
            )}
            <Stat
              label="Provider"
              value={
                status.providerConfigured ? "Configured" : "Local summaries"
              }
            />
            <Stat
              label="Provider cost"
              value={
                status.usage.providerCost == null
                  ? "Not configured"
                  : `$${status.usage.providerCost.toFixed(6)}`
              }
            />
          </section>

          <section style={CARD}>
            <p style={HELP}>
              {status.providerConfigured
                ? "Only a permission-filtered aggregate summary is sent to the separately configured AI provider; your raw question is not forwarded. Uplinko does not store prompts, answers, or conversation history; provider retention policies may apply."
                : "No external AI provider is configured. The agent will return deterministic summaries from permitted aggregate data."}
            </p>
            <div style={CHAT}>
              {messages.length === 0 && (
                <div style={SUGGESTIONS}>
                  {[
                    "How many subscribers are active?",
                    "What are this month's collections?",
                    "Show receipts for the last 7 days",
                    "How many tickets are overdue?",
                    "How many routers can I see?",
                    "How many employees are active?",
                    "Compare attendance for the last 7 days",
                  ].map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => void send(item)}
                      style={SUGGESTION}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              )}
              {messages.map((message, index) => (
                <div
                  key={`${index}-${message.role}`}
                  style={{
                    ...BUBBLE,
                    alignSelf:
                      message.role === "user" ? "flex-end" : "flex-start",
                    background:
                      message.role === "user"
                        ? "var(--accent,#378ADD)"
                        : "var(--surface-2)",
                    color: message.role === "user" ? "#fff" : "var(--text)",
                  }}
                >
                  {message.content}
                  {message.visuals?.map((visual, visualIndex) => (
                    <Visual
                      key={`${visual.title}-${visualIndex}`}
                      visual={visual}
                    />
                  ))}
                </div>
              ))}
              {busy && (
                <div style={{ ...BUBBLE, color: "var(--muted)" }}>
                  Checking permitted data…
                </div>
              )}
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
              style={FORM}
            >
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                maxLength={2000}
                rows={2}
                placeholder="Ask a read-only question…"
                aria-label="Ask the AI Agent"
                style={INPUT}
              />
              <button
                type="submit"
                disabled={busy || !question.trim()}
                style={{
                  ...BUTTON,
                  opacity: busy || !question.trim() ? 0.6 : 1,
                }}
              >
                {busy ? "Working…" : "Ask"}
              </button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}

function Visual({ visual }: { visual: AiAgentVisual }) {
  const maximum = Math.max(
    1,
    ...visual.series.flatMap((series) =>
      series.points.map((point) => Math.abs(point.value)),
    ),
  );
  return (
    <section
      aria-label={`${visual.title}, measured in ${visual.unit}`}
      style={VISUAL}
    >
      <div style={VISUAL_TITLE}>
        {visual.title} <span style={VISUAL_UNIT}>({visual.unit})</span>
      </div>
      {visual.series.flatMap((series) =>
        series.points.map((point, index) => {
          const value = Number.isFinite(point.value) ? point.value : 0;
          return (
            <div
              key={`${series.label}-${point.label}-${index}`}
              style={VISUAL_ROW}
            >
              <div style={VISUAL_LABEL}>
                {point.label} · {series.label}
              </div>
              <div style={VISUAL_TRACK} aria-hidden="true">
                <div
                  style={{
                    ...VISUAL_BAR,
                    width: `${(Math.abs(value) / maximum) * 100}%`,
                  }}
                />
              </div>
              <div style={VISUAL_VALUE}>{value.toLocaleString()}</div>
            </div>
          );
        }),
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={STAT}>
      <div style={STAT_LABEL}>{label}</div>
      <div style={STAT_VALUE}>{value}</div>
    </div>
  );
}

const PAGE: React.CSSProperties = {
  maxWidth: 1050,
  margin: "0 auto",
  padding: 20,
  color: "var(--text)",
};
const HEADER: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  marginBottom: 16,
};
const TITLE: React.CSSProperties = { fontSize: 20, fontWeight: 900, margin: 0 };
const SUBTITLE: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 12.5,
  margin: "5px 0 0",
};
const CARD: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: 16,
  marginBottom: 14,
};
const SECTION_TITLE: React.CSSProperties = {
  fontSize: 14,
  margin: "0 0 8px",
  fontWeight: 800,
};
const HELP: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 12,
  lineHeight: 1.6,
  margin: "0 0 12px",
};
const STATS: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
  gap: 9,
  marginBottom: 14,
};
const STAT: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 13,
};
const STAT_LABEL: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 11,
  marginBottom: 5,
};
const STAT_VALUE: React.CSSProperties = { fontSize: 14, fontWeight: 800 };
const CHAT: React.CSSProperties = {
  minHeight: 260,
  maxHeight: "55vh",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 9,
  padding: "12px 0",
};
const BUBBLE: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  maxWidth: "min(100%, 74ch)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "10px 12px",
  fontSize: 13,
  lineHeight: 1.6,
};
const VISUAL: React.CSSProperties = {
  marginTop: 12,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: 9,
  background: "var(--surface)",
};
const VISUAL_TITLE: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  marginBottom: 8,
};
const VISUAL_UNIT: React.CSSProperties = {
  color: "var(--muted)",
  fontWeight: 500,
};
const VISUAL_ROW: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(55px,1fr) minmax(55px,2fr) auto",
  alignItems: "center",
  gap: 8,
  marginTop: 5,
};
const VISUAL_LABEL: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 10.5,
  overflowWrap: "anywhere",
};
const VISUAL_TRACK: React.CSSProperties = {
  height: 7,
  borderRadius: 999,
  overflow: "hidden",
  background: "var(--surface-2)",
};
const VISUAL_BAR: React.CSSProperties = {
  height: "100%",
  borderRadius: 999,
  background: "var(--accent,#378ADD)",
};
const VISUAL_VALUE: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
};
const SUGGESTIONS: React.CSSProperties = {
  display: "flex",
  gap: 7,
  flexWrap: "wrap",
  alignSelf: "flex-start",
};
const SUGGESTION: React.CSSProperties = {
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  color: "var(--text)",
  borderRadius: 999,
  padding: "7px 10px",
  fontSize: 11.5,
  cursor: "pointer",
  fontFamily: "inherit",
};
const FORM: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 8,
  borderTop: "1px solid var(--border)",
  paddingTop: 12,
};
const INPUT: React.CSSProperties = {
  flex: 1,
  resize: "vertical",
  minWidth: 0,
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 10,
  font: "inherit",
  color: "var(--text)",
  background: "var(--surface-2)",
};
const BUTTON: React.CSSProperties = {
  background: "var(--accent,#378ADD)",
  color: "#fff",
  border: 0,
  borderRadius: 9,
  padding: "9px 13px",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};
const ERROR: React.CSSProperties = {
  background: "#7f1d1d",
  color: "#fff",
  padding: 10,
  borderRadius: 9,
  fontSize: 12,
  marginBottom: 12,
};
