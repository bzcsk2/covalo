import { describe, test, expect } from "bun:test";
import { extractAssessment } from "../supervisor-assessment";

describe("supervisor-assessment", () => {
  test("extracts pure JSON", () => {
    const output = '{"dimensions":{"taskCompletion":80,"verification":90}}';
    expect(extractAssessment(output)).toEqual({
      taskCompletion: 0.8,
      verification: 0.9,
    });
  });

  test("extracts fenced JSON block", () => {
    const output = `
分析如下：
\`\`\`json
{"dimensions":{"taskCompletion":80}}
\`\`\`
`;
    expect(extractAssessment(output)).toEqual({
      taskCompletion: 0.8,
    });
  });

  test("picks first valid JSON with dimensions among multiple candidates", () => {
    const output = `
{"caseId":"x"}
{"dimensions":{"taskCompletion":80}}
`;
    expect(extractAssessment(output)).toEqual({
      taskCompletion: 0.8,
    });
  });

  test("normalizes 0-100 scores to 0-1", () => {
    const output = '{"dimensions":{"taskCompletion":100,"safety":0}}';
    expect(extractAssessment(output)).toEqual({
      taskCompletion: 1,
      safety: 0,
    });
  });

  test("ignores string scores", () => {
    const output = '{"dimensions":{"taskCompletion":"high"}}';
    expect(extractAssessment(output)).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(extractAssessment("not json")).toBeNull();
  });

  test("returns null when dimensions missing", () => {
    expect(extractAssessment('{"foo":1}')).toBeNull();
  });
});
