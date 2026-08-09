"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { AssistantChat } from "../components/assistant-chat";

/**
 * Assistant — the full-page view of the same guide as the floating ✦ popup.
 *
 * The popup is right for a quick "where is X" while you work; this is for
 * actually reading a long answer, or working through a setup step by step.
 * Both render the same AssistantChat, so answers are identical either way.
 */
export default function AssistantPage() {
  const router = useRouter();

  return (
    <div className="asp">
      <style>{CSS}</style>

      <div className="asp-head">
        <div>
          <h1>✦ Assistant</h1>
          <p>Ask anything about the panel — where a feature lives, how to use it,
            and what happens before you commit. Answers come from the same guide as
            the Documentation page.</p>
        </div>
        <button onClick={() => router.push("/docs")}>📖 Browse documentation</button>
      </div>

      <div className="asp-panel">
        <AssistantChat big />
      </div>
    </div>
  );
}

const CSS = `
.asp{padding:20px;max-width:900px;margin:0 auto;color:var(--text);
  display:flex;flex-direction:column;height:calc(100vh - 120px);min-height:520px}
.asp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;
  flex-wrap:wrap;margin-bottom:14px;flex:none}
.asp-head h1{font-size:24px;font-weight:800;margin:0 0 5px}
.asp-head p{font-size:13px;color:var(--muted);margin:0;line-height:1.7;max-width:66ch}
.asp-head button{background:var(--surface);border:1px solid var(--border);color:var(--text);
  border-radius:10px;padding:9px 14px;font-size:12.5px;font-weight:700;cursor:pointer;
  font-family:inherit;white-space:nowrap}
.asp-head button:hover{border-color:var(--accent);color:var(--accent)}
.asp-panel{flex:1;min-height:0;display:flex;flex-direction:column;
  background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:4px 16px 16px}
`;
