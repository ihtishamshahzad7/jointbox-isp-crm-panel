"use client";

import { useEffect, useMemo, useState } from "react";

const API = process.env.NEXT_PUBLIC_BACKEND_URL || (typeof window !== "undefined" ? `http://${window.location.hostname}:3001` : "http://localhost:3001");

type FeatureStatus = "planned" | "in-progress" | "research";

type Feature = {
  name: string;
  maturity: string;
  status: FeatureStatus;
  description: string;
};

type Category = {
  id: string;
  label: string;
  description: string;
  features: Feature[];
};

const statusTone: Record<FeatureStatus, { label: string; color: string }> = {
  planned: { label: "Planned", color: "#60a5fa" },
  "in-progress": { label: "In Progress", color: "#34d399" },
  research: { label: "Research", color: "#fbbf24" },
};

export default function AdvancedFeaturesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    const headers: HeadersInit = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    fetch(`${API}/features/advanced`, { headers })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message || `Request failed with ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        setCategories(data.categories || []);
      })
      .catch((e) => setError(e.message || "Unable to load advanced features."))
      .finally(() => setLoading(false));
  }, []);

  const totalFeatures = useMemo(() => categories.reduce((sum, category) => sum + category.features.length, 0), [categories]);

  if (loading) return <div style={{ padding: 24 }}>Loading advanced features…</div>;
  if (error) return <div style={{ padding: 24, color: "#fca5a5" }}>{error}</div>;

  return (
    <div style={{ padding: 24, display: "grid", gap: 20 }}>
      <div style={{ display: "grid", gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Advanced Features</h1>
        <p style={{ margin: 0, color: "#94a3b8" }}>
          Jointbox next-generation roadmap across AI, automation, security, visibility, and scale.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <span style={{ padding: "6px 10px", borderRadius: 999, background: "rgba(96,165,250,0.18)", color: "#bfdbfe" }}>
            {categories.length} categories
          </span>
          <span style={{ padding: "6px 10px", borderRadius: 999, background: "rgba(52,211,153,0.18)", color: "#a7f3d0" }}>
            {totalFeatures} features
          </span>
        </div>
      </div>

      {categories.map((category) => (
        <section
          key={category.id}
          style={{
            border: "1px solid rgba(148,163,184,0.25)",
            borderRadius: 16,
            padding: 18,
            background: "rgba(15,23,42,0.5)",
            display: "grid",
            gap: 14,
          }}
        >
          <div style={{ display: "grid", gap: 4 }}>
            <h2 style={{ margin: 0, fontSize: 20 }}>{category.label}</h2>
            <p style={{ margin: 0, color: "#94a3b8" }}>{category.description}</p>
          </div>

          <div style={{ display: "grid", gap: 12 }}>
            {category.features.map((feature) => (
              <div
                key={feature.name}
                style={{
                  border: "1px solid rgba(148,163,184,0.2)",
                  borderRadius: 12,
                  padding: 14,
                  display: "grid",
                  gap: 8,
                  background: "rgba(30,41,59,0.5)",
                }}
              >
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{feature.name}</strong>
                  <span
                    style={{
                      padding: "4px 8px",
                      borderRadius: 999,
                      fontSize: 12,
                      background: `${statusTone[feature.status].color}22`,
                      color: statusTone[feature.status].color,
                    }}
                  >
                    {statusTone[feature.status].label}
                  </span>
                  <span style={{ color: "#94a3b8", fontSize: 12 }}>{feature.maturity}</span>
                </div>
                <div style={{ color: "#cbd5e1", fontSize: 14 }}>{feature.description}</div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
