"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Shown in Settings when OWNER_PASSCODE is set: unlocks approvals, settings and the lab in this browser. */
export function OwnerUnlock({ owner }: { owner: boolean }) {
  const router = useRouter();
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (owner) {
    return (
      <div className="spread">
        <span className="row small">
          Signed in as owner in this browser
        </span>
        <button
          type="button"
          className="btn small ghost"
          onClick={async () => {
            await fetch("/api/owner", { method: "DELETE" });
            router.refresh();
          }}
        >
          Lock
        </button>
      </div>
    );
  }
  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const res = await fetch("/api/owner", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode }) });
        setBusy(false);
        if (!res.ok) setError("Wrong passcode");
        else router.refresh();
      }}
    >
      <input className="input passcode" type="password" aria-label="Owner passcode" placeholder="Owner passcode" value={passcode} onChange={(e) => setPasscode(e.target.value)} />
      <button type="submit" className="btn primary" disabled={busy || !passcode}>
        Sign in as owner
      </button>
      {error ? <span className="small word firm" role="status">{error}</span> : null}
    </form>
  );
}
