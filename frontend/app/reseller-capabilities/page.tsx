"use client";

import { useEffect, useMemo, useState } from "react";

const API = process.env.NEXT_PUBLIC_BACKEND_URL || (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

type ChecklistStatus = "yes" | "partial" | "no" | "unassessed";

type Question = {
  id: string;
  text: string;
  status: ChecklistStatus;
};

type Section = {
  id: string;
  title: string;
  questions: Question[];
};

type ActivityLog = {
  id: number;
  action: string;
  entity: string;
  entityId: number | null;
  details: string | null;
  createdAt: string;
  user?: {
    id: number;
    name: string;
    email: string;
  } | null;
};

const statusLabel: Record<ChecklistStatus, string> = {
  yes: "✅ Yes",
  partial: "⚠️ Partial",
  no: "❌ No",
  unassessed: "— Unassessed",
};

const statusOrder: ChecklistStatus[] = ["yes", "partial", "no", "unassessed"];

export default function ResellerCapabilitiesPage() {
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [subscriberId, setSubscriberId] = useState("42");
  const [reverseReason, setReverseReason] = useState("Duplicate activation reversal");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);

  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    const headers: HeadersInit = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    Promise.all([
      fetch(`${API}/features/reseller-capability-checklist`, { headers }),
      fetch(`${API}/logs/activity?limit=8`, { headers }),
    ])
      .then(async ([checklistRes, logsRes]) => {
        if (!checklistRes.ok) {
          const data = await checklistRes.json().catch(() => ({}));
          throw new Error(data.message || `Checklist request failed with ${checklistRes.status}`);
        }
        if (!logsRes.ok) {
          const data = await logsRes.json().catch(() => ({}));
          throw new Error(data.message || `Logs request failed with ${logsRes.status}`);
        }

        const checklistData = await checklistRes.json();
        const logsData = await logsRes.json();
        setSections(checklistData.sections || []);
        setActivityLogs((logsData.logs || []).slice(0, 8));
      })
      .catch((e) => setError(e.message || "Unable to load capability checklist."))
      .finally(() => setLoading(false));
  }, []);

  const totalQuestions = useMemo(() => sections.reduce((sum, section) => sum + section.questions.length, 0), [sections]);
  const yesCount = useMemo(
    () => sections.reduce((sum, section) => sum + section.questions.filter((q) => q.status === "yes").length, 0),
    [sections],
  );

  const updateStatus = async (questionId: string, status: ChecklistStatus) => {
    setSaving(true);
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    const headers: HeadersInit = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const res = await fetch(`${API}/features/reseller-capability-checklist`, {
        method: "POST",
        headers,
        body: JSON.stringify({ questionId, status }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Unable to save ${questionId}`);
      }

      setSections((current) =>
        current.map((section) => ({
          ...section,
          questions: section.questions.map((question) =>
            question.id === questionId ? { ...question, status } : question,
          ),
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save status.");
    } finally {
      setSaving(false);
    }
  };

  const callProtectedAction = async (path: "settle" | "reverse") => {
    setActionBusy(true);
    setActionMessage(null);

    const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    const headers: HeadersInit = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const res = await fetch(`${API}/organization/pricing/${path}/${subscriberId}`, {
        method: "POST",
        headers,
        body: path === "reverse"
          ? JSON.stringify({ reason: reverseReason || "Duplicate activation reversal" })
          : JSON.stringify({ event: "capability-check" }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || `Unable to ${path} subscriber ${subscriberId}`);
      }

      setActionMessage(`${path === "settle" ? "Settlement" : "Reversal"} succeeded: ${JSON.stringify(data)}`);
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : `Unable to ${path} subscriber.`);
    } finally {
      setActionBusy(false);
    }
  };

  if (loading) return <div style={{ padding: 24 }}>Loading reseller capability checklist…</div>;
  if (error) return <div style={{ padding: 24, color: "#fca5a5" }}>{error}</div>;

  return (
    <div style={{ padding: 24, display: "grid", gap: 18 }}>
      <div style={{ display: "grid", gap: 6 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Reseller / Franchise Capability Checklist</h1>
        <p style={{ margin: 0, color: "#94a3b8" }}>
          A practical assessment surface for the hierarchy, wallet, reversal, and audit requirements in the ISP reseller model.
        </p>

        <div
          style={{
            border: "1px solid rgba(96,165,250,0.4)",
            borderRadius: 14,
            padding: 14,
            background: "rgba(15,23,42,0.7)",
            display: "grid",
            gap: 10,
          }}
        >
          <div style={{ fontWeight: 700, color: "#bfdbfe" }}>Live money-integrity controls</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ color: "#cbd5e1" }}>
              Subscriber ID
              <input
                value={subscriberId}
                onChange={(e) => setSubscriberId(e.target.value)}
                style={{ display: "block", marginTop: 4, padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(148,163,184,0.4)", background: "#0f172a", color: "#e2e8f0" }}
              />
            </label>
            <label style={{ color: "#cbd5e1" }}>
              Reversal reason
              <input
                value={reverseReason}
                onChange={(e) => setReverseReason(e.target.value)}
                style={{ display: "block", marginTop: 4, width: 320, padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(148,163,184,0.4)", background: "#0f172a", color: "#e2e8f0" }}
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={() => callProtectedAction("settle")}
              disabled={actionBusy}
              style={{ borderRadius: 10, padding: "8px 12px", border: "1px solid rgba(52,211,153,0.5)", background: "rgba(20,83,45,0.4)", color: "#d1fae5", cursor: "pointer" }}
            >
              {actionBusy ? "Working…" : "Re-run settlement"}
            </button>
            <button
              onClick={() => callProtectedAction("reverse")}
              disabled={actionBusy}
              style={{ borderRadius: 10, padding: "8px 12px", border: "1px solid rgba(251,191,36,0.5)", background: "rgba(133,77,14,0.4)", color: "#fef3c7", cursor: "pointer" }}
            >
              Reverse activation
            </button>
          </div>
          {actionMessage && (
            <div style={{ color: "#f8fafc", fontSize: 13, background: "rgba(30,41,59,0.65)", borderRadius: 10, padding: 10 }}>
              {actionMessage}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <span style={{ padding: "6px 10px", borderRadius: 999, background: "rgba(96,165,250,0.18)", color: "#bfdbfe" }}>
            {totalQuestions} total checks
          </span>
          <span style={{ padding: "6px 10px", borderRadius: 999, background: "rgba(52,211,153,0.18)", color: "#a7f3d0" }}>
            {yesCount} marked yes
          </span>
          <span style={{ padding: "6px 10px", borderRadius: 999, background: "rgba(251,191,36,0.18)", color: "#fde68a" }}>
            {saving ? "Saving…" : "Ready"}
          </span>
        </div>
      </div>

      {sections.map((section) => (
        <section
          key={section.id}
          style={{
            border: "1px solid rgba(148,163,184,0.25)",
            borderRadius: 16,
            padding: 18,
            background: "rgba(15,23,42,0.5)",
            display: "grid",
            gap: 12,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 20 }}>{section.id}. {section.title}</h2>

          <div style={{ display: "grid", gap: 10 }}>
            {section.questions.map((question) => (
              <div
                key={question.id}
                style={{
                  border: "1px solid rgba(148,163,184,0.2)",
                  borderRadius: 12,
                  padding: 12,
                  background: "rgba(30,41,59,0.5)",
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ color: "#e2e8f0", fontSize: 14 }}>{question.text}</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {statusOrder.map((status) => (
                    <button
                      key={status}
                      onClick={() => updateStatus(question.id, status)}
                      style={{
                        border: question.status === status ? "1px solid #60a5fa" : "1px solid rgba(148,163,184,0.3)",
                        borderRadius: 999,
                        padding: "6px 10px",
                        background: question.status === status ? "rgba(96,165,250,0.18)" : "transparent",
                        color: "#e2e8f0",
                        cursor: "pointer",
                      }}
                    >
                      {statusLabel[status]}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section
        style={{
          border: "1px solid rgba(148,163,184,0.25)",
          borderRadius: 16,
          padding: 18,
          background: "rgba(15,23,42,0.5)",
          display: "grid",
          gap: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 20 }}>Recent reversal / audit trail</h2>
        <div style={{ display: "grid", gap: 8 }}>
          {activityLogs.length === 0 ? (
            <div style={{ color: "#94a3b8" }}>No recent activity logs were returned for this scope yet.</div>
          ) : (
            activityLogs.map((log) => (
              <div
                key={log.id}
                style={{
                  border: "1px solid rgba(148,163,184,0.2)",
                  borderRadius: 12,
                  padding: 10,
                  background: "rgba(30,41,59,0.45)",
                }}
              >
                <div style={{ color: "#bfdbfe", fontWeight: 700 }}>{log.action}</div>
                <div style={{ color: "#cbd5e1", fontSize: 13, marginTop: 4 }}>
                  {log.details || "No details provided"}
                </div>
                <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}>
                  {new Date(log.createdAt).toLocaleString()} · {log.user?.name || "System"}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
