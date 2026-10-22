"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ActionRecord } from "@/lib/domain";
import { toDecimal } from "@/lib/money";

/** Approve / reject / edit amount, or answer the agent's question. Big touch targets for phones. */
export function ApprovalControls({ action }: { action: ActionRecord }) {
  const router = useRouter();
  const [amount, setAmount] = useState(action.amountCents ? toDecimal(action.amountCents) : "");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isQuestion = action.type === "ask_owner";
  const editable = action.amountCents !== null && ["capture_authorization", "refund_capture", "reauthorize_authorization"].includes(action.type);

  const send = async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(`/api/actions/${action.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.error ?? `Failed (${res.status})`);
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  if (isQuestion) {
    return (
      <div className="stack" style={{ gap: 10 }}>
        <label className="field">
          Your answer (kept in the audit trail)
          <textarea className="input" rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="e.g. Ships Thursday, capture then. Or: void it, I'll email the buyer." />
        </label>
        <div className="row">
          <button className="btn good big" disabled={!!busy || !reply.trim()} onClick={() => send({ decision: "answer", reply }, "answer")}>
            {busy === "answer" ? "Saving..." : "Answer and close"}
          </button>
          <button className="btn ghost big" disabled={!!busy} onClick={() => send({ decision: "reject", reason: "Dismissed by the owner" }, "reject")}>
            Dismiss
          </button>
        </div>
        {error ? <div className="banner bad">{error}</div> : null}
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        {editable ? (
          <label className="field" style={{ maxWidth: 160 }}>
            Amount ({action.currency})
            <span className="money-input">
              <span>$</span>
              <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </span>
          </label>
        ) : null}
        <button
          className="btn good big"
          disabled={!!busy}
          onClick={() =>
            send(
              { decision: "approve", ...(editable && amount && amount !== toDecimal(action.amountCents ?? 0) ? { amount } : {}) },
              "approve",
            )
          }
        >
          {busy === "approve" ? "Calling PayPal..." : "Approve"}
        </button>
        <button className="btn danger big" disabled={!!busy} onClick={() => send({ decision: "reject", reason: "Rejected by the owner" }, "reject")}>
          {busy === "reject" ? "Rejecting..." : "Reject"}
        </button>
      </div>
      {editable ? <p className="tiny faint">Edited amounts go back through the policy gate before anything is sent to PayPal.</p> : null}
      {error ? <div className="banner bad">{error}</div> : null}
    </div>
  );
}
