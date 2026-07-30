import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "extension");
const target = resolve(root, "safari", "package");
const generatedRoot = resolve(root, "safari", "generated", "ReviewMoa");
const generatedResources = resolve(generatedRoot, "ReviewMoa Extension", "Resources");
const generatedProject = resolve(generatedRoot, "ReviewMoa.xcodeproj", "project.pbxproj");
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

const generatedProjectSource = await readFile(generatedProject, "utf8").catch(() => null);
if (generatedProjectSource) {
  await mkdir(generatedResources, { recursive: true });
  await Promise.all(files.map((file) =>
    copyFile(resolve(target, file), resolve(generatedResources, file))
  ));

  const [major = 0, minor = 0, patch = 0] = String(manifest.version)
    .split(".")
    .map((value) => Number.parseInt(value, 10) || 0);
  const buildNumber = major * 10_000 + minor * 100 + patch;
  const updatedProject = generatedProjectSource
    .replace(
      /CURRENT_PROJECT_VERSION = \d+;/g,
      `CURRENT_PROJECT_VERSION = ${Math.max(buildNumber, 1)};`,
    )
    .replace(
      /MARKETING_VERSION = [^;]+;/g,
      `MARKETING_VERSION = ${manifest.version};`,
    );
  await writeFile(generatedProject, updatedProject);
  console.log(
    `Xcode 프로젝트 동기화 완료: ${manifest.version} (${Math.max(buildNumber, 1)})`,
  );
}

console.log(`Safari WebExtension 패키지 준비 완료: ${target}`);
