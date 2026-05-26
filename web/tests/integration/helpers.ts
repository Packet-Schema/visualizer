import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export const PORT = 8787;
export const BASE_URL = `http://localhost:${PORT}`;

export const fetchWithRetry = async (
  url: string,
  maxRetries: number = 3,
): Promise<Response> => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      return response;
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
    }
  }
  throw new Error("Unreachable");
};

export async function waitForServer(
  url: string,
  timeoutMs: number = 60000,
): Promise<void> {
  const startTime = Date.now();
  const interval = 1000;
  let attempts = 0;

  while (Date.now() - startTime < timeoutMs) {
    attempts++;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (response.status === 404 || response.status === 200) {
        console.log(
          `Server ready after ${Date.now() - startTime}ms (${attempts} attempts)`,
        );
        return;
      }
    } catch {
      // Server not ready yet
      if (attempts % 5 === 0) {
        console.log(
          `Waiting for server... (${Math.round((Date.now() - startTime) / 1000)}s)`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    `Server did not start within ${timeoutMs}ms at ${url} after ${attempts} attempts`,
  );
}

export function startPreviewServer(): ChildProcess {
  // Kill any existing process on port 8787
  console.log("Cleaning up port 8787...");
  spawnSync(
    "bash",
    ["-c", "lsof -ti:8787 | xargs kill -9 2>/dev/null || true"],
    {
      stdio: "ignore",
    },
  );

  // Start the Cloudflare worker preview server
  console.log("Starting Cloudflare worker preview server...");
  const devServer = spawn("npm", ["run", "preview:worker:start"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });

  // Log server output for debugging
  devServer.stdout?.on("data", (data) => {
    const lines = data.toString().split("\n");
    lines.forEach((line: string) => {
      if (line.trim()) {
        console.log(`[Server stdout] ${line.trim()}`);
      }
    });
  });
  devServer.stderr?.on("data", (data) => {
    const lines = data.toString().split("\n");
    lines.forEach((line: string) => {
      if (line.trim()) {
        console.log(`[Server stderr] ${line.trim()}`);
      }
    });
  });

  // Log when server exits unexpectedly
  devServer.on("error", (err) => {
    console.error("[Server error]", err);
  });
  devServer.on("exit", (code) => {
    console.log(`[Server exited with code ${code}]`);
  });

  return devServer;
}
