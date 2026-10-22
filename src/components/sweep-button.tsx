"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SweepButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span className="row">
      {message ? <span className="small muted">{message}</span> : null}
      <button
        className="btn ghost"
        disabled={disabled || busy}
        title="Read PayPal now: tracked orders, invoices, disputes and Transaction Search"
        onClick={async () => {
          setBusy(true);
          setMessage(null);
          try {
            const res = await fetch("/api/sweep", { method: "POST" });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) setMessage(body.error ?? `Sweep failed (${res.status})`);
            else {
              const errors: string[] = body.lastSweep?.errors ?? [];
              setMessage(errors.length ? `Swept with ${errors.length} warning(s)` : "Swept");
            }
            router.refresh();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Sweeping..." : "Sweep now"}
      </button>
    </span>
  );
}
