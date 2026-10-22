import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The worker loop and SQLite access only run on the Node.js server.
  serverExternalPackages: [],
  poweredByHeader: false,
};

export default nextConfig;
