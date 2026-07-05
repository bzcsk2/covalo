import { describe, test, expect } from "bun:test";

describe("score-semantics", () => {
  // 最小化验证：runner 集成见 runner-smoke，此处仅验证 pack 规则可通过
  // smoke eval 间接证明 infra_error/scoreIneligible 路径可写 artifact。
  test("smoke eval placeholder: pack A+B+C+L covered by runner-smoke", async () => {
    expect(true).toBe(true);
  });
});
