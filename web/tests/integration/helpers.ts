import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";

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
  let lastError: Error | null = null;

  while (Date.now() - startTime < timeoutMs) {
    attempts++;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (response.status === 200 || response.status === 404) {
        // Verify we can actually read the response
        await response.text();
        console.log(
          `Server ready after ${Date.now() - startTime}ms (${attempts} attempts)`,
        );
        return;
      }
    } catch (err) {
      // Server not ready yet
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempts % 5 === 0) {
        console.log(
          `Waiting for server... (${Math.round((Date.now() - startTime) / 1000)}s)`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    `Server did not start within ${timeoutMs}ms at ${url} after ${attempts} attempts${lastError ? `: ${lastError.message}` : ""}`,
  );
}

export function startPreviewServer(): ChildProcess {
  // Kill any existing process on port 8787 with multiple attempts
  console.log("Cleaning up port 8787...");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Kill by port
      execSync("lsof -ti:8787 | xargs kill -9 2>/dev/null || true", {
        stdio: "ignore",
      });
      // Kill by command
      execSync("pkill -9 -f wrangler 2>/dev/null || true", {
        stdio: "ignore",
      });
      execSync("pkill -9 -f workerd 2>/dev/null || true", {
        stdio: "ignore",
      });
    } catch {
      // Ignore errors during cleanup
    }
    // Wait before next attempt
    execSync("sleep 0.2", { stdio: "ignore" });
  }

  // Wait for port to actually be released (TCP TIME_WAIT state)
  let portFree = false;
  for (let i = 0; i < 100; i++) {
    const result = spawnSync("bash", ["-c", "lsof -i :8787 > /dev/null 2>&1"], {
      stdio: "ignore",
    });
    if (result.status !== 0) {
      // Port is free
      portFree = true;
      console.log(`Port 8787 is now available (waited ${i * 100}ms)`);
      break;
    }
    // Sleep 100ms synchronously
    execSync("sleep 0.1", { stdio: "ignore" });
  }

  if (!portFree) {
    console.warn(
      "Port 8787 may still be in use, attempting to start server anyway",
    );
  }

  // Start the Cloudflare worker preview server
  console.log("Starting Cloudflare worker preview server...");
  const devServer = spawn("npm", ["run", "preview"], {
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

export async function exitProcess(
  process: ChildProcess,
  timeoutMs: number = 5000,
): Promise<void> {
  return new Promise((resolve) => {
    if (!process.pid) {
      console.log("[Cleanup] Process already exited");
      resolve();
      return;
    }

    let exitedNormally = false;

    const exitHandler = () => {
      exitedNormally = true;
      console.log("[Cleanup] Process exited normally");
      resolve();
    };

    process.once("exit", exitHandler);

    // Send SIGTERM
    console.log("[Cleanup] Sending SIGTERM to process");
    process.kill("SIGTERM");

    // Set timeout for force kill
    const killTimeout = setTimeout(() => {
      if (!exitedNormally) {
        process.removeListener("exit", exitHandler);
        console.log("[Cleanup] Process did not exit, sending SIGKILL");
        try {
          process.kill("SIGKILL");
        } catch {
          // Process may already be dead
        }
        resolve();
      }
    }, timeoutMs);

    // Clean up timeout if process exits normally
    process.once("exit", () => {
      clearTimeout(killTimeout);
    });
  });
}
