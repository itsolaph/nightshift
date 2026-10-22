import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The worker loop and SQLite access only run on the Node.js server.
  // playwright-core is optional: the scenario lab's headless sandbox buyer.
  serverExternalPackages: ["@paypal/agent-toolkit", "playwright-core"],
  poweredByHeader: false,
  // Don't write AGENTS.md into the repo on `next dev`.
  agentRules: false,
};

export default nextConfig;
