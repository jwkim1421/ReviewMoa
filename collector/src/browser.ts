import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext } from "playwright-core";
import type { CollectorConfig } from "./config.js";

export async function launchCollectorBrowser(config: CollectorConfig): Promise<BrowserContext> {
  await mkdir(config.profileDir, { recursive: true, mode: 0o700 });
  return chromium.launchPersistentContext(config.profileDir, {
    channel: "chrome",
    headless: config.headless,
    viewport: { width: 1440, height: 1000 },
  });
}
