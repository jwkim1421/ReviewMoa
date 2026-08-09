import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const releasePath = resolve(import.meta.dirname, "..", "safari", "release.json");
const release = JSON.parse(await readFile(releasePath, "utf8"));
const current = Number(release.buildNumber);
if (!Number.isInteger(current) || current < 1) {
  throw new Error("safari/release.json의 buildNumber는 1 이상의 정수여야 합니다.");
}
release.buildNumber = current + 1;
await writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`);
console.log(`Safari TestFlight 빌드 번호: ${current} → ${release.buildNumber}`);
