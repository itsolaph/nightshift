"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
    <div className="stack lab-stack">
      <section className="sheet run-night">
        <div className="run-night-copy">
          <h2>Run the night</h2>
          <p className="prose">
            Creates real sandbox orders, captures, refunds and invoices, moves the demo clock forward in three steps (<span className="num">+1</span>, <span className="num">+5</span>, <span className="num">+27</span> days) and lets
            the watcher, the agent and the policy gate handle each step. Expect a few auto-fixes, a couple of refusals from PayPal, and at least one decision waiting in Approvals.
          </p>
          <p className="small muted">About a minute with card payments; a few minutes when a sandbox buyer has to approve each order on PayPal&apos;s checkout page.</p>
        </div>
        <div className="row run-night-actions">
          <button type="button" className="btn primary big" disabled={disabled} onClick={() => start("night")}>
            {running ? "Running…" : busy === "night" ? "Starting…" : "Run the night"}
          </button>
          <button type="button" className="btn ghost" disabled={running || !!busy} onClick={reset}>
            Reset local data
          </button>
        </div>
        {message ? <div className={`banner ${message.bad ? "bad" : "info"}`} role="status">{message.text}</div> : null}
      </section>

      <section>
        <div className="section-head">
          <h2>Single scenarios</h2>
          <p className="sub">Each one creates its own sandbox objects. Time-based ones move the demo clock forward if needed.</p>
        </div>
        <table className="ledger scenarios">
          <thead>
            <tr>
              <th scope="col">Scenario</th>
              <th scope="col">What happens</th>
              <th scope="col">Incidents</th>
              <th scope="col" className="num">
                Clock
              </th>
              <th scope="col">
                <span className="visually-hidden">Run</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {scenarios.map((s) => (
              <tr key={s.id} className="scenario">
                <th scope="row">{s.title}</th>
                <td className="story">{s.story}</td>
                <td className="small muted">{s.incidentTypes.join(", ").replaceAll("_", " ")}</td>
                <td className="num">{s.clockDays ? `+${s.clockDays}d` : null}</td>
                <td className="run-cell">
                  <button type="button" className="btn small" disabled={disabled} onClick={() => start(s.id)}>
                    {busy === s.id ? "Starting…" : "Run"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
