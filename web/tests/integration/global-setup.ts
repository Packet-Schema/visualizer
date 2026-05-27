import type { ChildProcess } from "node:child_process";
import { startPreviewServer, exitProcess, waitForServer } from "./helpers";

let devServer: ChildProcess | null = null;

export async function setup() {
  console.log("Global setup: starting preview server...");
  devServer = await startPreviewServer();
  await waitForServer("http://localhost:8787", 90000, devServer);
  console.log("Global setup: server ready");

  // Return cleanup function that vitest will call
  return async () => {
    if (devServer) {
      console.log("Global teardown: stopping preview server...");
      await exitProcess(devServer);
      // Close stdio streams to prevent hanging
      devServer.stdout?.destroy();
      devServer.stderr?.destroy();
      // Give a moment for cleanup
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
}
