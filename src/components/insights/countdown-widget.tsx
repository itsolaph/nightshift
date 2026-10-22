"use client";

// Custom AG Studio widget: live countdowns to the next authorization deadlines (29-day expiry or
// 3-day honor period), on Nightshift's detector clock. Reads the open authorizations from the
// Studio `context` the host passes in, so it needs no data mapping.

import type { AgDefaultWidgetDefinition, AgExternalShape, AgStudioApi, AgWidgetDataFormat, AgWidgetParams } from "ag-studio";
import type { AgRegistry, AgWidgetDefinition } from "ag-studio-react";
import { useEffect, useState } from "react";

export type CountdownStyle = { mode?: "expiry" | "honor"; limit?: number };
export interface CountdownDef {
  type: "auth-countdown";
  dataMapping: Record<string, never>;
  format?: AgWidgetDataFormat<CountdownStyle>;
}
export interface NightshiftRegistry extends AgRegistry {
  widgets: readonly (AgDefaultWidgetDefinition | AgWidgetDefinition<"auth-countdown", CountdownDef>)[];
}

export type CountdownAuth = { id: string; orderId: string; uncaptured: number; expiresAt: string; honorEndsAt: string; fulfillment: string };
export type StudioContext = { authorizations: CountdownAuth[]; clockOffsetMs: number };

function split(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const hms = [Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
  return d > 0 ? `${d}d ${hms}` : hms;
}

export function CountdownWidget({ format, context, widgetApi }: AgWidgetParams<CountdownDef>) {
  const ctx = context as StudioContext | undefined;
  const mode = format?.style?.mode ?? "expiry";
  const limit = Math.max(1, Math.min(10, Number(format?.style?.limit ?? 5)));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const clock = now + (ctx?.clockOffsetMs ?? 0);
  const rows = (ctx?.authorizations ?? [])
    .map((a) => ({ ...a, due: new Date(mode === "honor" ? a.honorEndsAt : a.expiresAt).getTime() }))
    .filter((a) => a.uncaptured > 0)
    .sort((a, b) => a.due - b.due)
    .slice(0, limit);

  useEffect(() => {
    widgetApi.setDisplayState(rows.length ? "displayed" : "noData");
  }, [rows.length, widgetApi]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 6, padding: "2px 4px", overflow: "auto" }}>
      <div style={{ fontSize: 12, color: "#8494b3" }}>
        {mode === "honor" ? "Until the 3-day honor period ends" : "Until the 29-day authorization expires"}
        {ctx?.clockOffsetMs ? ` (detector clock +${Math.round(ctx.clockOffsetMs / 86400000)}d)` : ""}
      </div>
      {rows.map((a) => {
        const left = a.due - clock;
        const tone = left <= 0 ? "#ff7a7a" : left < 86400000 * (mode === "honor" ? 0.5 : 3) ? "#ffc35c" : "#46d39a";
        return (
          <div
            key={a.id}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              alignItems: "center",
              gap: 8,
              border: "1px solid #22314f",
              borderRadius: 8,
              padding: "6px 10px",
              background: "#0b1324",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#c3cde0", overflow: "hidden", textOverflow: "ellipsis" }}>{a.id}</div>
              <div style={{ fontSize: 11, color: "#8494b3" }}>
                ${a.uncaptured.toFixed(2)} uncaptured · {a.fulfillment}
              </div>
            </div>
            <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 18, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums" }}>
              {left <= 0 ? "expired" : split(left)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const countdownDefinition: AgWidgetDefinition<"auth-countdown", CountdownDef> = {
  id: "auth-countdown",
  label: "Authorization countdown",
  comp: CountdownWidget,
  defaultSize: { width: 420, height: 260 },
  minSize: { width: 240, height: 140 },
  defaultState: { format: { title: { enabled: true, text: "Authorization countdown" }, style: { mode: "expiry", limit: 5 } } },
  // Lets Studio's AI configure the widget. AG Studio exports no shape builder, so it is borrowed
  // from defineAiCommand, whose factory runs synchronously.
  formatShape: ({ api }) =>
    (api as AgStudioApi).defineAiCommand((s) => ({
      input: s
        .object({
          title: s.object({ enabled: s.boolean().optional(), text: s.string().optional() }).optional(),
          style: s
            .object({
              mode: s.enum(["expiry", "honor"] as const, { description: "expiry = 29-day limit, honor = 3-day honor period" }).optional(),
              limit: s.number({ description: "How many authorizations to show, 1-10" }).optional(),
            })
            .optional(),
        })
        .optional(),
      execute: () => ({ success: true as const, value: undefined }),
    })).shape as unknown as AgExternalShape<CountdownDef["format"]>,
  form: (params) => {
    const form = params.createDefaults({ dataMappingItems: [] });
    form.items[0].items.push({
      type: "section",
      key: "countdown",
      label: "Countdown",
      items: [
        {
          type: "select",
          id: "format.style.mode",
          label: "Deadline",
          items: [
            { label: { raw: "29-day expiry" }, value: "expiry" },
            { label: { raw: "3-day honor period" }, value: "honor" },
          ],
        },
        { type: "number", id: "format.style.limit", label: "Rows", min: 1, max: 10, step: 1 },
      ],
    });
    return form;
  },
  ai: {
    description: "Live countdowns to the next PayPal authorization deadlines (29-day expiry or 3-day honor period) for uncaptured money. Takes no data fields.",
    configuration: 'Set format.style.mode to "expiry" or "honor" and format.style.limit to the number of rows (1-10). Always send the whole format object, including title.',
  },
};
