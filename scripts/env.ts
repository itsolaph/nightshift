// Loads .env.local for scripts run outside Next.js (Next.js loads it itself).
import fs from "node:fs";

export function loadEnvLocal() {
  for (const file of [".env.local", ".env"]) {
    if (fs.existsSync(file)) process.loadEnvFile(file);
  }
}
