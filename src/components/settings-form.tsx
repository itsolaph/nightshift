"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Settings } from "@/lib/domain";

type NumField = { key: keyof Settings; label: string; hint: string; unit?: string; scale?: number; step?: number };

const FIELDS: NumField[] = [
  { key: "autoCaptureMaxCents", label: "Auto-capture limit", hint: "Captures above this always wait for you.", unit: "$", scale: 100, step: 1 },
  { key: "uncapturedAfterHours", label: "Shipped but not captured after", hint: "How long a shipped order may wait before it is an incident.", unit: "hours" },
  { key: "honorWarningHours", label: "Honor period warning", hint: "Warn this long before the 3-day honor period ends.", unit: "hours" },
  { key: "expiryWarningDays", label: "Expiry warning", hint: "Warn this many days before the 29-day limit.", unit: "days" },
  { key: "duplicateWindowMinutes", label: "Double-charge window", hint: "Same payer, cart and amount within this window.", unit: "min" },
  { key: "refundSpikeRate", label: "Refund spike threshold", hint: "Refunds as a share of captures in 24 hours.", unit: "%", scale: 0.01, step: 1 },
  { key: "refundSpikeMinCount", label: "Refund spike minimum", hint: "Ignore spikes with fewer refunds than this.", unit: "refunds" },
  { key: "invoiceReminderCooldownHours", label: "Reminder cooldown", hint: "A second reminder inside this window needs you.", unit: "hours" },
];

const CLOCK_PRESETS = [0, 1, 5, 27, 30];

export function SettingsForm({ initial }: { initial: Settings }) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  const save = async (patch: Partial<Settings>) => {
    setSaving(true);
    setMessage(null);
    const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const body = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) return setMessage({ text: body.error ?? "Could not save", bad: true });
    setSettings(body);
    setMessage({ text: "Saved." });
    router.refresh();
  };

  const display = (f: NumField) => {
    const v = settings[f.key] as number;
    return f.scale ? Math.round(v / f.scale) : v;
  };

  return (
    <div className="stack form-stack">
      <section className="panel" id="clock">
        <div className="card-head">
          <div>
            <h2>Demo clock</h2>
            <p>Moves Nightshift&apos;s detector clock forward so time-based incidents show up now. PayPal always sees real time, and nothing sent to PayPal changes.</p>
          </div>
          <span className={`clock-figure num ${settings.demoClockOffsetDays ? "" : "idle"}`}>+{settings.demoClockOffsetDays} days</span>
        </div>
        <div className="row" role="group" aria-label="Demo clock offset">
          {CLOCK_PRESETS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={settings.demoClockOffsetDays === d}
              className={`seg ${settings.demoClockOffsetDays === d ? "active" : ""}`}
              disabled={saving}
              onClick={() => save({ demoClockOffsetDays: d })}
            >
              {d === 0 ? "Real time" : `+${d} days`}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="card-head">
          <div>
            <h2>Policy</h2>
            <p>The rules the gate applies to every proposal. Refunds and voids always need you; nothing outside the allowlist ever runs.</p>
          </div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={settings.autopilot} onChange={(e) => save({ autopilot: e.target.checked })} disabled={saving} />
          <span>
            <strong>Autopilot</strong>
            <span className="muted small"> {settings.autopilot ? "on: safe actions run without asking" : "off: every action waits for you"}</span>
          </span>
        </label>
        <form
          className="grid cols-2 policy-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const patch: Partial<Settings> = {};
            for (const f of FIELDS) {
              const raw = Number(form.get(f.key));
              if (!Number.isFinite(raw)) continue;
              const value = raw * (f.scale ?? 1);
              (patch as Record<string, number>)[f.key] = f.key === "refundSpikeRate" ? Math.round(value * 100) / 100 : Math.round(value);
            }
            void save(patch);
          }}
        >
          {FIELDS.map((f) => (
            <label key={f.key} className="field">
              {f.label}
              <span className="row input-unit">
                <input className="input num" name={f.key} type="number" min={0} step={f.step ?? 1} defaultValue={display(f)} key={`${f.key}-${settings[f.key]}`} />
                <span className="small muted unit">{f.unit}</span>
              </span>
              <span className="hint">{f.hint}</span>
            </label>
          ))}
          <div className="row form-actions">
            <button className="btn primary" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save policy"}
            </button>
            {message ? (
              <span className={`small ${message.bad ? "word firm" : "muted"}`} role="status">
                {message.text}
              </span>
            ) : null}
          </div>
        </form>
      </section>
    </div>
  );
}
