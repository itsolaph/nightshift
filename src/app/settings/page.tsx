import { connection } from "next/server";
import { store } from "@/lib/db";
import { connections } from "@/lib/summary";
import { SettingsForm } from "@/components/settings-form";
import { ACTION_LABELS } from "@/lib/domain";
import { cookies } from "next/headers";
import { OWNER_COOKIE, ownerPasscode, ownerToken } from "@/lib/owner";
import { OwnerUnlock } from "@/components/owner-unlock";

export const metadata = { title: "Settings" };

function Status({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className={`word ${ok ? "" : "quiet"}`}>{ok ? "Ready" : "Not set"}</td>
      <td className="small muted">{detail}</td>
    </tr>
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
  const passcodeRequired = Boolean(ownerPasscode());
  const owner = !passcodeRequired || (await cookies()).get(OWNER_COOKIE)?.value === ownerToken();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Policy, clock and connections</h1>
        </div>
      </div>
      <div className="grid main-side settings-grid">
        <SettingsForm initial={s.settings()} />
        <div className="stack side-stack">
          {passcodeRequired ? (
            <section className="panel">
              <div className="card-head">
                <div>
                  <h2>Owner access</h2>
                  <p>Approvals, policy changes and the lab need the owner passcode on this instance.</p>
                </div>
              </div>
              <OwnerUnlock owner={owner} />
            </section>
          ) : null}
          <section className="panel">
            <div className="card-head">
              <h2>Connections</h2>
            </div>
            <table className="ledger compact">
              <tbody>
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
              </tbody>
            </table>
          </section>
        </div>
      </div>

      <section className="section">
        <h2>What the gate allows</h2>
        <table className="ledger policy-table">
          <thead>
            <tr>
              <th scope="col">Action</th>
              <th scope="col">Auto</th>
              <th scope="col">Needs you</th>
            </tr>
          </thead>
          <tbody>
            {POLICY_TABLE.map(([action, auto, approval]) => (
              <tr key={action}>
                <th scope="row">{action}</th>
                <td>{auto}</td>
                <td>{approval}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
