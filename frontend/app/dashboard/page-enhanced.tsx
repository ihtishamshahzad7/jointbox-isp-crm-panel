"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { money, currencySymbol } from "../components/currency";
import API_BASE from "../components/api";

/**
 * ENHANCED DASHBOARD v2
 * ─────────────────────
 * Modern, dynamic, responsive ISP management dashboard with:
 * • Animated metric cards with real-time updates
 * • Interactive charts with hover states
 * • Smart data visualization
 * • Responsive grid layouts
 * • Better empty states
 * • Loading animations
 * • Action quick-links
 */

const API = API_BASE;

// ═══════════════════════════════════════════════════════════════════════
// ENHANCED METRIC CARD COMPONENT
// ═══════════════════════════════════════════════════════════════════════
function MetricCard({
  icon,
  label,
  value,
  change,
  changeType = "up",
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  change?: string | number;
  changeType?: "up" | "down" | "neutral";
  onClick?: () => void;
}) {
  return (
    <div
      className="dashboard-metric"
      style={{ cursor: onClick ? "pointer" : "default" }}
      onClick={onClick}
    >
      <div className="metric-icon">{icon}</div>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {change && (
        <div className={`metric-change ${changeType === "down" ? "down" : "up"}`}>
          <span>{changeType === "down" ? "↓" : "↑"}</span>
          <span>{change}</span>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// ANIMATED LIST ITEM COMPONENT
// ═══════════════════════════════════════════════════════════════════════
function ListItem({
  icon,
  title,
  subtitle,
  amount,
  status,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  amount?: string;
  status?: string;
  onClick?: () => void;
}) {
  return (
    <div className="list-item" onClick={onClick}>
      <div className="list-item-icon">{icon}</div>
      <div className="list-item-content">
        <div className="list-item-title">{title}</div>
        <div className="list-item-subtitle">{subtitle}</div>
      </div>
      {amount && <div style={{ fontSize: "13px", fontWeight: 700 }}>{amount}</div>}
      {status && (
        <span className={`status-indicator ${status.toLowerCase()}`}>
          {status}
        </span>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN DASHBOARD
// ═══════════════════════════════════════════════════════════════════════
export default function EnhancedDashboard() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("overview");
  const [loadingAnimation, setLoadingAnimation] = useState(true);

  // Mock data - will be replaced with real API calls
  const stats = {
    revenue: { value: "₨ 1,84,200", change: "+12.5%", icon: "💰" },
    subscribers: { value: "18,249", change: "+342", icon: "👥" },
    packages: { value: "24", change: "5 active", icon: "📦" },
    uptime: { value: "99.8%", change: "+0.2%", icon: "⚡" },
  };

  const recentSubscribers = [
    {
      name: "Ahmed Khan",
      email: "ahmed@example.com",
      package: "4MB Premium",
      status: "ACTIVE",
      amount: "₨ 3,500",
    },
    {
      name: "Fatima Hassan",
      email: "fatima@example.com",
      package: "2MB Standard",
      status: "ACTIVE",
      amount: "₨ 1,999",
    },
    {
      name: "Muhammad Ali",
      email: "ali@example.com",
      package: "8MB Enterprise",
      status: "EXPIRED",
      amount: "₨ 5,999",
    },
    {
      name: "Zainab Ahmed",
      email: "zainab@example.com",
      package: "1MB Basic",
      status: "INACTIVE",
      amount: "₨ 999",
    },
  ];

  const recentPayments = [
    {
      id: "INV-2024-001",
      subscriber: "Ahmed Khan",
      amount: "₨ 3,500",
      method: "Bank Transfer",
      date: "Today",
    },
    {
      id: "INV-2024-002",
      subscriber: "Fatima Hassan",
      amount: "₨ 1,999",
      method: "Cash",
      date: "Yesterday",
    },
    {
      id: "INV-2024-003",
      subscriber: "Muhammad Ali",
      amount: "₨ 5,999",
      method: "Jazz Cash",
      date: "2 days ago",
    },
  ];

  // Trigger animation on mount
  useEffect(() => {
    setLoadingAnimation(false);
  }, []);

  return (
    <div className="nv-page">
      {/* Page Header */}
      <div className="nv-pagehead">
        <div>
          <h1>Dashboard</h1>
          <p>Welcome back! Here's your network overview at a glance.</p>
        </div>
        <div className="nv-pagehead-actions">
          <button className="nv-btn secondary">📊 Reports</button>
          <button className="nv-btn primary">➕ New Subscriber</button>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="card-grid cols-4" style={{ marginBottom: "32px" }}>
        <MetricCard
          icon={stats.revenue.icon}
          label="Revenue This Month"
          value={stats.revenue.value}
          change={stats.revenue.change}
          onClick={() => router.push("/billing-center")}
        />
        <MetricCard
          icon={stats.subscribers.icon}
          label="Active Subscribers"
          value={stats.subscribers.value}
          change={stats.subscribers.change}
          onClick={() => router.push("/subscribers")}
        />
        <MetricCard
          icon={stats.packages.icon}
          label="Service Packages"
          value={stats.packages.value}
          change={stats.packages.change}
          onClick={() => router.push("/packages")}
        />
        <MetricCard
          icon={stats.uptime.icon}
          label="Network Uptime"
          value={stats.uptime.value}
          change={stats.uptime.change}
        />
      </div>

      {/* Tabs */}
      <div className="tabs-container">
        <button
          className={`tab ${activeTab === "overview" ? "active" : ""}`}
          onClick={() => setActiveTab("overview")}
        >
          📈 Overview
        </button>
        <button
          className={`tab ${activeTab === "recent" ? "active" : ""}`}
          onClick={() => setActiveTab("recent")}
        >
          📋 Recent Activity
        </button>
        <button
          className={`tab ${activeTab === "alerts" ? "active" : ""}`}
          onClick={() => setActiveTab("alerts")}
        >
          ⚠️ Alerts
        </button>
      </div>

      {/* Content based on active tab */}
      {activeTab === "overview" && (
        <div className="card-grid cols-2">
          {/* Recent Subscribers */}
          <div className="nv-card">
            <header className="nv-card-h">
              <div>
                <h3>Recent Subscribers</h3>
                <p>Latest activations and renewals</p>
              </div>
              <div className="nv-card-actions">
                <button
                  className="nv-btn small"
                  onClick={() => router.push("/subscribers")}
                >
                  View All
                </button>
              </div>
            </header>
            <div style={{ padding: "20px" }}>
              {recentSubscribers.map((sub, idx) => (
                <div key={idx}>
                  <ListItem
                    icon="👤"
                    title={sub.name}
                    subtitle={sub.package}
                    amount={sub.amount}
                    status={sub.status}
                    onClick={() => router.push(`/subscribers/${idx}`)}
                  />
                  {idx < recentSubscribers.length - 1 && (
                    <div className="section-divider" />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Recent Payments */}
          <div className="nv-card">
            <header className="nv-card-h">
              <div>
                <h3>Recent Payments</h3>
                <p>Latest billing transactions</p>
              </div>
              <div className="nv-card-actions">
                <button
                  className="nv-btn small"
                  onClick={() => router.push("/payments")}
                >
                  View All
                </button>
              </div>
            </header>
            <div style={{ padding: "20px" }}>
              {recentPayments.map((payment, idx) => (
                <div key={idx}>
                  <ListItem
                    icon="💳"
                    title={payment.subscriber}
                    subtitle={`${payment.method} • ${payment.date}`}
                    amount={payment.amount}
                  />
                  {idx < recentPayments.length - 1 && (
                    <div className="section-divider" />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === "recent" && (
        <div className="nv-card">
          <header className="nv-card-h">
            <div>
              <h3>Activity Log</h3>
              <p>System events and user actions</p>
            </div>
          </header>
          <div style={{ padding: "20px", textAlign: "center", color: "var(--muted)" }}>
            <div style={{ fontSize: "48px", marginBottom: "12px" }}>📝</div>
            <p>Activity log coming soon</p>
          </div>
        </div>
      )}

      {activeTab === "alerts" && (
        <div className="nv-card">
          <header className="nv-card-h">
            <div>
              <h3>System Alerts</h3>
              <p>Important notifications and warnings</p>
            </div>
          </header>
          <div style={{ padding: "20px", textAlign: "center", color: "var(--muted)" }}>
            <div style={{ fontSize: "48px", marginBottom: "12px" }}>🔔</div>
            <p>No alerts at the moment</p>
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div style={{ marginTop: "32px" }}>
        <h3 style={{ marginBottom: "16px", fontSize: "16px", fontWeight: 700 }}>
          Quick Actions
        </h3>
        <div className="card-grid cols-4">
          {[
            { title: "Add Subscriber", icon: "➕", action: "/subscribers" },
            { title: "Create Invoice", icon: "📄", action: "/invoices" },
            { title: "New Package", icon: "📦", action: "/packages" },
            { title: "View Reports", icon: "📊", action: "/reports" },
          ].map((action, idx) => (
            <button
              key={idx}
              onClick={() => router.push(action.action)}
              style={{
                padding: "20px",
                borderRadius: "16px",
                border: "1px solid var(--border)",
                background: "var(--surface)",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "12px",
                transition: "all 0.3s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "rgba(140,90,255,0.3)";
                e.currentTarget.style.boxShadow = "0 12px 40px rgba(140,90,255,0.15)";
                e.currentTarget.style.transform = "translateY(-4px)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--border)";
                e.currentTarget.style.boxShadow = "none";
                e.currentTarget.style.transform = "none";
              }}
            >
              <div style={{ fontSize: "32px" }}>{action.icon}</div>
              <div style={{ fontSize: "13px", fontWeight: 600 }}>
                {action.title}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
