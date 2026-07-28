import { describe, expect, it } from "vitest";
import worker from "./index";
import type { AppEnv } from "./types";

describe("Worker CORS", () => {
  it("returns a bodyless 204 preflight response for the production site", async () => {
    const request = new Request("https://reviewmoa-api.reviewmoa.workers.dev/v1/jobs/probe", {
      method: "OPTIONS",
      headers: {
        Origin: "https://reviewmoa.kro.kr",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    const response = await worker.fetch(
      request,
      { ALLOWED_ORIGIN: "https://reviewmoa.kro.kr" } as AppEnv,
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://reviewmoa.kro.kr");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});
