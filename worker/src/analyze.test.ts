import { describe, expect, it } from "vitest";
import { parseAiPayload } from "./analyze";

describe("parseAiPayload", () => {
  it("parses the Responses API output_text shortcut", () => {
    expect(parseAiPayload({
      output_text: JSON.stringify({
        positive: "배송이 빨라요.",
        negative: "내구성은 아쉬워요.",
        conclusion: "단기 사용에 적합해요.",
      }),
    })).toEqual({
      positive: "배송이 빨라요.",
      negative: "내구성은 아쉬워요.",
      conclusion: "단기 사용에 적합해요.",
    });
  });

  it("parses nested OpenRouter Responses API output", () => {
    expect(parseAiPayload({
      output: [{
        content: [{
          type: "output_text",
          text: JSON.stringify({
            positive: "사용이 편해요.",
            negative: "포장이 약해요.",
            conclusion: "포장 상태를 확인하세요.",
          }),
        }],
      }],
    })?.conclusion).toBe("포장 상태를 확인하세요.");
  });

  it("rejects incomplete or malformed analysis", () => {
    expect(parseAiPayload({ output_text: "not-json" })).toBeNull();
    expect(parseAiPayload({
      output_text: JSON.stringify({ positive: "좋아요." }),
    })).toBeNull();
  });
});
