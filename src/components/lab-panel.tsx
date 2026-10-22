"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { IconPlay } from "./icons";

type ScenarioInfo = { id: string; title: string; story: string; incidentTypes: string[]; clockDays: number };

export function LabPanel({ scenarios, running, paypal }: { scenarios: ScenarioInfo[]; running: boolean; paypal: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const disabled = !paypal || running || !!busy;

  const start = async (scenario: string) => {
    setBusy(scenario);
    setMessage(null);
    try {
      const res = await fetch("/api/lab/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario }),
      });
      const body = await res.json().catch(() => ({}));
      setMessage(res.ok ? { text: scenario === "night" ? "The night has started. Watch the log below, or open Tonight." : "Scenario started." } : { text: body.error ?? `Failed (${res.status})`, bad: true });
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    if (!confirm("Clear Nightshift's local ledger, incidents and audit trail? Sandbox objects at PayPal are not touched.")) return;
    setBusy("reset");
    const res = await fetch("/api/lab/reset", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    setMessage(res.ok ? { text: "Local data cleared, demo clock back to +0 days." } : { text: body.error ?? "Reset failed", bad: true });
    setBusy(null);
    router.refresh();
  };

  return (
    <div className="stack">
      <div className="moon-card">
        <div className="spread">
          <div style={{ maxWidth: 640 }}>
            <h2>Run the night</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              Creates real sandbox orders, captures, refunds and invoices, moves the demo clock forward in three steps (+1, +5, +27 days) and lets the watcher, the agent and the policy gate handle each step.
              Expect a few auto-fixes, a couple of refusals from PayPal, and at least one decision waiting in Approvals. Takes about a minute with card payments, a few minutes when a
              sandbox buyer has to approve each order on PayPal&apos;s checkout page.
            </p>
          </div>
          <div className="row">
            <button className="btn primary big" disabled={disabled} onClick={() => start("night")}>
              <IconPlay size={16} /> {running ? "Running..." : busy === "night" ? "Starting..." : "Run the night"}
            </button>
            <button className="btn ghost" disabled={running || !!busy} onClick={reset}>
              Reset local data
            </button>
          </div>
        </div>
        {message ? <div className={`banner ${message.bad ? "bad" : "info"}`} style={{ marginTop: 14 }}>{message.text}</div> : null}
      </div>

      <div>
        <h2 style={{ marginBottom: 4 }}>Single scenarios</h2>
        <p className="muted small" style={{ marginBottom: 12 }}>Each one creates its own sandbox objects. Time-based ones move the demo clock forward if needed.</p>
        <div className="grid cols-3">
          {scenarios.map((s) => (
            <div key={s.id} className="scenario">
              <div className="spread">
                <h3>{s.title}</h3>
                {s.clockDays ? <span className="badge amber">+{s.clockDays}d</span> : null}
              </div>
              <p>{s.story}</p>
              <div className="spread">
                <span className="tiny faint">{s.incidentTypes.join(", ").replaceAll("_", " ")}</span>
                <button className="btn small" disabled={disabled} onClick={() => start(s.id)}>
                  {busy === s.id ? "Starting..." : "Run"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
