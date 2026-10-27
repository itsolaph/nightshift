"use client";

import dynamic from "next/dynamic";
import type { AnalyticsData } from "@/lib/summary";

// AG Studio is browser-only; load it without server rendering.
const InsightsStudio = dynamic(() => import("./studio"), {
  ssr: false,
  loading: () => <div className="studio-frame studio-loading">Loading the dashboard…</div>,
});

export function InsightsLoader(props: { data: AnalyticsData; licenseKey?: string; aiModel?: string; clockOffsetMs: number }) {
  return <InsightsStudio {...props} />;
}
