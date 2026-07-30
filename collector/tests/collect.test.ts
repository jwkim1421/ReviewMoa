import { describe, expect, it } from "vitest";
import { classifyPageInterruption } from "../src/collect";

describe("collector page interruption classification", () => {
  it("recognizes Naver receipt security verification as CAPTCHA", () => {
    expect(classifyPageInterruption(
      "NAVER 보안 확인을 완료해 주세요. 실제 사용자임을 확인합니다. 빈 칸을 채워주세요.",
    )).toEqual({ kind: "interrupted", reason: "captcha" });
  });

  it("keeps a Naver system error available for operator handoff", () => {
    expect(classifyPageInterruption(
      "",
      "[에러] 에러페이지 - 시스템오류",
    )).toEqual({ kind: "interrupted", reason: "operator_required" });
  });
});
