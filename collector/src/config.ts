import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CollectorConfig {
  apiBase: string;
  token: string;
  collectorId: string;
  profileDir: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  navigationTimeoutMs: number;
  headless: boolean;
  runOnce: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`환경변수 ${name} 값이 필요합니다.`);
  return value;
}

function duration(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 값은 ${min}~${max} 범위의 정수여야 합니다.`);
  }
  return value;
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean) {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} 값은 true 또는 false여야 합니다.`);
}

function defaultProfileDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "ReviewMoa", "chrome-profile");
  }
  if (platform === "win32") {
    return join(
      env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "ReviewMoa",
      "chrome-profile",
    );
  }
  return join(homedir(), ".local", "share", "reviewmoa", "chrome-profile");
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CollectorConfig {
  const apiBase = required(env, "REVIEWMOA_API_BASE").replace(/\/$/, "");
  const url = new URL(apiBase);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("REVIEWMOA_API_BASE는 HTTPS 주소여야 합니다.");
  }

  const collectorId = required(env, "REVIEWMOA_COLLECTOR_ID");
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(collectorId)) {
    throw new Error("REVIEWMOA_COLLECTOR_ID 형식이 올바르지 않습니다.");
  }

  return {
    apiBase,
    token: required(env, "REVIEWMOA_COLLECTOR_TOKEN"),
    collectorId,
    profileDir: resolve(env.REVIEWMOA_PROFILE_DIR ?? defaultProfileDir(platform, env)),
    pollIntervalMs: duration(env, "REVIEWMOA_POLL_INTERVAL_MS", 5_000, 1_000, 60_000),
    heartbeatIntervalMs: duration(
      env,
      "REVIEWMOA_HEARTBEAT_INTERVAL_MS",
      30_000,
      5_000,
      60_000,
    ),
    navigationTimeoutMs: duration(
      env,
      "REVIEWMOA_NAVIGATION_TIMEOUT_MS",
      60_000,
      10_000,
      180_000,
    ),
    headless: boolean(env, "REVIEWMOA_HEADLESS", false),
    runOnce: boolean(env, "REVIEWMOA_RUN_ONCE", false),
  };
}
