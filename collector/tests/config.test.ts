import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const REQUIRED = {
  REVIEWMOA_API_BASE: "https://reviewmoa-api.example",
  REVIEWMOA_COLLECTOR_TOKEN: "local-secret",
  REVIEWMOA_COLLECTOR_ID: "home-mac-01",
};

describe("collector config", () => {
  it("loads safe defaults for macOS", () => {
    const config = loadConfig(REQUIRED, "darwin");

    expect(config.apiBase).toBe("https://reviewmoa-api.example");
    expect(config.collectorId).toBe("home-mac-01");
    expect(config.profileDir).toContain("Library/Application Support/ReviewMoa/chrome-profile");
    expect(config.headless).toBe(false);
    expect(config.pollIntervalMs).toBe(5_000);
  });

  it("allows HTTP only for a local Worker", () => {
    expect(() => loadConfig({
      ...REQUIRED,
      REVIEWMOA_API_BASE: "http://127.0.0.1:8787",
    }, "darwin")).not.toThrow();
    expect(() => loadConfig({
      ...REQUIRED,
      REVIEWMOA_API_BASE: "http://example.com",
    }, "darwin")).toThrow("HTTPS");
  });

  it("rejects invalid collector IDs and intervals", () => {
    expect(() => loadConfig({
      ...REQUIRED,
      REVIEWMOA_COLLECTOR_ID: "home mac",
    }, "darwin")).toThrow("형식");
    expect(() => loadConfig({
      ...REQUIRED,
      REVIEWMOA_POLL_INTERVAL_MS: "10",
    }, "darwin")).toThrow("1000~60000");
  });
});
