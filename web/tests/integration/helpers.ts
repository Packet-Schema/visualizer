import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as net from "node:net";

export const PORT = 8787;
export const BASE_URL = `http://localhost:${PORT}`;

export const fetchWithRetry = async (
  url: string,
  maxRetries: number = 3,
): Promise<Response> => {
  for (let i = 0; i < maxRetries; i++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return response;
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
    } finally {
      clearTimeout(timeout);
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === 200) {
        await response.text();
        console.log(
          `Server ready after ${Date.now() - startTime}ms (${attempts} attempts)`,
        );
        return;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempts % 5 === 0) {
        console.log(
          `Waiting for server... (${Math.round((Date.now() - startTime) / 1000)}s)`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    `Server did not start within ${timeoutMs}ms at ${url} after ${attempts} attempts${lastError ? `: ${lastError.message}` : ""}`,
  );
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

async function waitForPortFree(
  port: number,
  timeoutMs: number = 10000,
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await isPortFree(port)) {
      console.log(
        `Port ${port} is now available (waited ${Date.now() - startTime}ms)`,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.warn(
    `Port ${port} may still be in use, attempting to start server anyway`,
  );
}

export async function startPreviewServer(): Promise<ChildProcess> {
  // If port is already in use, wait briefly for it to free (e.g. previous test run)
  if (!(await isPortFree(PORT))) {
    console.log(`Port ${PORT} is in use, waiting for it to free...`);
    await waitForPortFree(PORT);
  }

  console.log("Starting Cloudflare worker preview server...");
  const devServer = spawn("npm", ["run", "preview:start"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });

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

    console.log("[Cleanup] Sending SIGTERM to process");
    process.kill("SIGTERM");

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

    process.once("exit", () => {
      clearTimeout(killTimeout);
    });
  });
}
