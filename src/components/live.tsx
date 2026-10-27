"use client";

// Subscribes to /api/stream (server-sent events). Any new timeline event triggers a throttled
// router.refresh(), so every server-rendered page (feed, incident timeline, approvals, KPIs)
// updates live without its own client state.

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const THROTTLE_MS = 1200;
// The AG Studio dashboard holds its own state; refreshing it mid-edit would be rude.
const PAUSED = ["/insights"];

export function LiveRefresh() {
  const router = useRouter();
  const pathname = usePathname();
  const [connected, setConnected] = useState(false);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef(0);
  const paused = PAUSED.some((p) => pathname.startsWith(p));

  useEffect(() => {
    if (paused) return;
    const source = new EventSource("/api/stream");
    const refresh = () => {
      const wait = Math.max(0, THROTTLE_MS - (Date.now() - last.current));
      if (pending.current) return;
      pending.current = setTimeout(() => {
        pending.current = null;
        last.current = Date.now();
        router.refresh();
      }, wait);
    };
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("timeline", refresh);
    return () => {
      source.close();
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
    };
  }, [router, paused]);

  return (
    <span className={`live-state ${connected && !paused ? "on" : ""}`} title={connected ? "Receiving live updates" : "Reconnecting"}>
      {paused ? "Paused" : connected ? "Live" : "Connecting"}
    </span>
  );
}
