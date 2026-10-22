import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The worker loop and SQLite access only run on the Node.js server.
  serverExternalPackages: ["@paypal/agent-toolkit"],
  poweredByHeader: false,
  // Don't write AGENTS.md into the repo on `next dev`.
  agentRules: false,
};

export default nextConfig;
