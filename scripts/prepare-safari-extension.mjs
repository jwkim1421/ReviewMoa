import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "extension");
const target = resolve(root, "safari", "package");
const generatedRoot = resolve(root, "safari", "generated", "ReviewMoa");
const generatedResources = resolve(generatedRoot, "ReviewMoa Extension", "Resources");
const generatedProject = resolve(generatedRoot, "ReviewMoa.xcodeproj", "project.pbxproj");
const generatedApp = resolve(generatedRoot, "ReviewMoa");
const generatedAppInfo = resolve(generatedApp, "Info.plist");
const generatedAppIconSet = resolve(
  generatedApp,
  "Assets.xcassets",
  "AppIcon.appiconset",
);
const appTemplate = resolve(root, "safari", "app-template");
const releasePath = resolve(root, "safari", "release.json");
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
const iconSizes = [48, 96, 128, 256, 512];

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await Promise.all(files.map((file) =>
  copyFile(resolve(source, file), resolve(target, file))
));
await mkdir(resolve(target, "icons"), { recursive: true });
await Promise.all(iconSizes.map((size) =>
  copyFile(
    resolve(source, "icons", `icon-${size}.png`),
    resolve(target, "icons", `icon-${size}.png`),
  )
));

const manifestPath = resolve(target, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const release = JSON.parse(await readFile(releasePath, "utf8"));
if (
  !/^([a-zA-Z][a-zA-Z0-9-]*\.)+[a-zA-Z][a-zA-Z0-9-]*$/.test(release.bundleIdentifier) ||
  release.extensionBundleIdentifier !== `${release.bundleIdentifier}.Extension` ||
  !Number.isInteger(release.buildNumber) ||
  release.buildNumber < 1
) {
  throw new Error("safari/release.json의 Bundle ID 또는 buildNumber가 올바르지 않습니다.");
}
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
  const generatedAppInfoSource = await readFile(generatedAppInfo, "utf8");
  const updatedAppInfo = generatedAppInfoSource.includes("ITSAppUsesNonExemptEncryption")
    ? generatedAppInfoSource
    : generatedAppInfoSource.replace(
      /<\/dict>\s*<\/plist>\s*$/,
      "\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>\n</dict>\n</plist>\n",
    );
  await mkdir(generatedResources, { recursive: true });
  await mkdir(resolve(generatedApp, "Resources", "Base.lproj"), { recursive: true });
  await mkdir(generatedAppIconSet, { recursive: true });
  await mkdir(resolve(generatedResources, "icons"), { recursive: true });
  await Promise.all(files.map((file) =>
    copyFile(resolve(target, file), resolve(generatedResources, file))
  ));
  await Promise.all(iconSizes.map((size) =>
    copyFile(
      resolve(target, "icons", `icon-${size}.png`),
      resolve(generatedResources, "icons", `icon-${size}.png`),
    )
  ));
  await Promise.all([
    copyFile(
      resolve(appTemplate, "Main.html"),
      resolve(generatedApp, "Resources", "Base.lproj", "Main.html"),
    ),
    copyFile(resolve(appTemplate, "Style.css"), resolve(generatedApp, "Resources", "Style.css")),
    copyFile(resolve(appTemplate, "ViewController.swift"), resolve(generatedApp, "ViewController.swift")),
    copyFile(resolve(appTemplate, "AppIcon.png"), resolve(generatedAppIconSet, "AppIcon.png")),
    copyFile(resolve(appTemplate, "AppIcon.png"), resolve(generatedApp, "Resources", "Icon.png")),
    writeFile(generatedAppInfo, updatedAppInfo),
    writeFile(
      resolve(generatedAppIconSet, "Contents.json"),
      `${JSON.stringify({
        images: [
          {
            filename: "AppIcon.png",
            idiom: "universal",
            platform: "ios",
            size: "1024x1024",
          },
        ],
        info: { author: "xcode", version: 1 },
      }, null, 2)}\n`,
    ),
  ]);

  const updatedProject = generatedProjectSource
    .replace(
      /CURRENT_PROJECT_VERSION = \d+;/g,
      `CURRENT_PROJECT_VERSION = ${release.buildNumber};`,
    )
    .replace(
      /MARKETING_VERSION = [^;]+;/g,
      `MARKETING_VERSION = ${manifest.version};`,
    )
    .replace(
      /PRODUCT_BUNDLE_IDENTIFIER = [^;]+\.Extension;/g,
      `PRODUCT_BUNDLE_IDENTIFIER = ${release.extensionBundleIdentifier};`,
    )
    .replace(
      /PRODUCT_BUNDLE_IDENTIFIER = (?![^;]*\.Extension;)[^;]+;/g,
      `PRODUCT_BUNDLE_IDENTIFIER = ${release.bundleIdentifier};`,
    );
  await writeFile(generatedProject, updatedProject);
  console.log(
    `Xcode 프로젝트 동기화 완료: ${manifest.version} (${release.buildNumber})`,
  );
}

console.log(`Safari WebExtension 패키지 준비 완료: ${target}`);
