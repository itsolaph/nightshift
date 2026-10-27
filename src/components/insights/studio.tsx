"use client";

// The AG Studio analytics dashboard: Nightshift's data sources, the "Last night" report, the custom
// authorization countdown widget, the night theme, and the AI assistant (Studio's built-in agents
// plus the Nightshift analyst) talking to the LLM through Nightshift's server-side proxy.

import { useMemo, useState } from "react";
import { AgStudioAiModule, enableStudioDevValidations, type AgStudioMode, type AgWidgetsConfig } from "ag-studio";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import type { AnalyticsData } from "@/lib/summary";
import { buildAi } from "./ai";
import { countdownDefinition, type NightshiftRegistry, type StudioContext } from "./countdown-widget";
import { buildStudioData } from "./data";
import { initialReport } from "./report";
import { nightshiftStudioTheme } from "./theme";

if (process.env.NODE_ENV !== "production") enableStudioDevValidations();

const STORAGE_KEY = "nightshift.insights.report.v2";

type Props = { data: AnalyticsData; licenseKey?: string; aiModel?: string; clockOffsetMs: number };

export default function InsightsStudio({ data, licenseKey, aiModel, clockOffsetMs }: Props) {
  const [mode, setMode] = useState<AgStudioMode>("view");
  const [studioData] = useState(() => buildStudioData(data));
  const [initialState] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved) as typeof initialReport;
    } catch {
      /* ignore broken saved state */
    }
    return initialReport;
  });
  const [context] = useState<StudioContext>(() => ({
    clockOffsetMs,
    authorizations: data.authorizations
      .filter((a) => ["CREATED", "PARTIALLY_CAPTURED", "PENDING"].includes(a.status))
      .map((a) => ({ id: a.id, orderId: a.orderId, uncaptured: a.uncaptured, expiresAt: a.expiresAt, honorEndsAt: a.honorEndsAt, fulfillment: a.fulfillment })),
  }));
  const ai = useMemo(() => (aiModel ? buildAi(aiModel) : undefined), [aiModel]);
  const widgets = useMemo(
    () => (defaults: AgWidgetsConfig) =>
      createWidgets<NightshiftRegistry>({
        additionalTypes: [countdownDefinition],
        menu: [...(defaults.menu ?? []), { label: "Nightshift", widgetIds: ["auth-countdown"] }],
      }),
    [],
  );
  const modules = useMemo(() => (ai ? [AgStudioAiModule] : undefined), [ai]);

  return (
    <div className="stack studio-stack">
      <div className="spread studio-bar">
        <div className="row" role="group" aria-label="Dashboard mode">
          <button type="button" aria-pressed={mode === "view"} className={`seg ${mode === "view" ? "active" : ""}`} onClick={() => setMode("view")}>
            View
          </button>
          <button type="button" aria-pressed={mode === "edit"} className={`seg ${mode === "edit" ? "active" : ""}`} onClick={() => setMode("edit")}>
            Edit
          </button>
          <button
            type="button"
            className="btn small ghost"
            onClick={() => {
              localStorage.removeItem(STORAGE_KEY);
              location.reload();
            }}
          >
            Reset layout
          </button>
        </div>
        <span className="small muted">
          {ai ? "Ask the assistant (bottom right in view mode, side panel in edit mode)." : "Set LLM_API_KEY to enable the AI assistant."} Layout changes are saved in this browser.
        </span>
      </div>
      <div className="studio-frame">
        <AgStudioProvider licenseKey={licenseKey || undefined} modules={modules}>
          <AgStudio<NightshiftRegistry>
            style={{ height: "100%", width: "100%" }}
            theme={nightshiftStudioTheme}
            data={studioData}
            widgets={widgets}
            initialState={initialState}
            mode={mode}
            ai={ai}
            context={context}
            layout={{ widgetBorderEnabled: true }}
            aiToolDisplay={{
              get_policy_rules: { label: ({ result }) => ({ text: result ? "Read the policy rules" : "Reading the policy rules" }) },
              get_incident_story: { label: ({ result }) => ({ text: result ? "Read the incident story" : "Reading the incident story" }) },
            }}
            onStateUpdated={(event) => {
              try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(event.state));
              } catch {
                /* storage full or blocked */
              }
            }}
          />
        </AgStudioProvider>
      </div>
    </div>
  );
}
