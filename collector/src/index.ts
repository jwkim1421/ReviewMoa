import { CollectorApi } from "./api.js";
import { launchCollectorBrowser } from "./browser.js";
import { loadConfig } from "./config.js";
import { runCollector } from "./daemon.js";

async function main() {
  const config = loadConfig();
  const api = new CollectorApi(config);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const browser = await launchCollectorBrowser(config);
  try {
    await runCollector(api, browser, config, controller.signal);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "collector_fatal",
    error: error instanceof Error ? error.message : "unknown",
  }));
  process.exitCode = 1;
});
