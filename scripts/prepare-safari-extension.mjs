import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "extension");
const target = resolve(root, "safari", "package");
const files = [
  "manifest.json",
  "background.js",
  "bridge.js",
  "content.js",
  "site-configs.js",
  "runtime-config.js",
  "popup.html",
  "popup.js",
];

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await Promise.all(files.map((file) =>
  copyFile(resolve(source, file), resolve(target, file))
));

const manifestPath = resolve(target, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
delete manifest.background?.type;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const runtimeConfigPath = resolve(target, "runtime-config.js");
const backgroundPath = resolve(target, "background.js");
const runtimeConfig = (await readFile(runtimeConfigPath, "utf8"))
  .replace(/^export\s+/, "")
  .trim();
const background = await readFile(backgroundPath, "utf8");
const runtimeConfigImport = 'import { REVIEWMOA_API_BASE } from "./runtime-config.js";';
if (!background.includes(runtimeConfigImport)) {
  throw new Error("Safari용 background.js에서 runtime config import를 찾지 못했습니다.");
}
await writeFile(
  backgroundPath,
  background.replace(runtimeConfigImport, runtimeConfig),
);

console.log(`Safari WebExtension 패키지 준비 완료: ${target}`);
