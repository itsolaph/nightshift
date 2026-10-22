import { connection } from "next/server";
import { store } from "@/lib/db";
import { connections } from "@/lib/summary";
import { SettingsForm } from "@/components/settings-form";
import { ACTION_LABELS } from "@/lib/domain";

export const metadata = { title: "Settings" };

function Status({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="spread" style={{ padding: "10px 0", borderBottom: "1px solid var(--ns-border)" }}>
      <span className="row">
        <span className={`dot ${ok ? "on" : "off"}`} />
        <strong style={{ fontWeight: 600 }}>{label}</strong>
      </span>
      <span className="small muted" style={{ textAlign: "right", maxWidth: "60%" }}>{detail}</span>
    </div>
  );
}

const POLICY_TABLE: [string, string, string][] = [
  [ACTION_LABELS.capture_authorization, "Shipped order, amount equals the authorization, under the limit, no earlier decline", "Not shipped, above limit, partial or over amount, earlier decline; forbidden above 115% / +$75 or after expiry"],
  [ACTION_LABELS.reauthorize_authorization, "Same or lower amount", "More than the original; forbidden above 115% / +$75 or after expiry"],
  [ACTION_LABELS.send_invoice_reminder, "Invoice open and not reminded inside the cooldown", "Reminded recently; forbidden when paid or cancelled"],
  [ACTION_LABELS.void_authorization, "Never", "Always"],
  [ACTION_LABELS.refund_capture, "Never", "Always; forbidden above what is left to refund"],
  [ACTION_LABELS.mark_resolved, "When the ledger shows the money settled", "When money is still at risk"],
  [ACTION_LABELS.ask_owner, "Never", "Always (it is a question)"],
  ["Anything else", "Never", "Never: forbidden"],
];

export default async function SettingsPage() {
  await connection();
  const s = store();
  const c = connections(s);
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>Policy, clock and connections</h1>
        </div>
      </div>
      <div className="grid main-side">
        <SettingsForm initial={s.settings()} />
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Connections</h2>
            </div>
            <Status ok={c.paypal} label="PayPal sandbox" detail={c.paypal ? "Client credentials set (api-m.sandbox.paypal.com)" : "Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET"} />
            <Status
              ok={Boolean(c.webhookId)}
              label="Webhooks"
              detail={c.webhookId ? `Webhook ${c.webhookId}, every delivery verified with verify-webhook-signature` : c.publicBaseUrl ? "Not registered yet" : "Needs an https PUBLIC_BASE_URL; the sweep still runs"}
            />
            <Status
              ok={Boolean(c.lastSweep && !c.lastSweep.errors.length)}
              label="Sweep and Transaction Search"
              detail={c.lastSweep ? `Last ${c.lastSweep.at.slice(0, 16).replace("T", " ")} UTC: ${c.lastSweep.orders} orders, ${c.lastSweep.invoices} invoices${c.lastSweep.errors.length ? `, ${c.lastSweep.errors.length} warning(s)` : ""}` : "Not run yet"}
            />
            <Status ok={c.llm} label="AI agent" detail={c.llm ? `${c.llmModel} via ${c.llmBaseUrl}` : "No LLM_API_KEY: rule-based triage, clearly labelled"} />
            <Status ok={c.telegram} label="Telegram approvals" detail={c.telegram ? "Bot configured" : "Optional: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID"} />
            <Status ok={c.agStudioLicensed} label="AG Studio licence" detail={c.agStudioLicensed ? "Licence key set" : "No key: trial watermark on deployed hosts"} />
            <Status ok label="Worker" detail={c.workerMode === "inline" ? "Runs inside the web server" : c.workerMode === "external" ? "Runs as a separate process" : "Off"} />
          </div>
          <div className="card">
            <div className="card-head">
              <h2>What the gate allows</h2>
            </div>
            <div className="stack" style={{ gap: 10 }}>
              {POLICY_TABLE.map(([action, auto, approval]) => (
                <div key={action} style={{ borderBottom: "1px solid var(--ns-border)", paddingBottom: 10 }}>
                  <strong style={{ fontWeight: 600 }}>{action}</strong>
                  <div className="small"><span className="green">Auto:</span> <span className="muted">{auto}</span></div>
                  <div className="small"><span className="amber">Needs you:</span> <span className="muted">{approval}</span></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
