import { describe, test, expect } from "bun:test";
import { resolveWithinRoot, isWithinRoot, UnsafeEvalPathError } from "../path-guards";

describe("path-guards", () => {
  const root = "/tmp/covalo-path-guards";

  test("allows simple relative paths within root", () => {
    const resolved = resolveWithinRoot(root, "index.ts", "file");
    expect(resolved).toBe(`${root}/index.ts`);
  });

  test("allows nested relative paths within root", () => {
    const resolved = resolveWithinRoot(root, "src/a.ts", "file");
    expect(resolved).toBe(`${root}/src/a.ts`);
  });

  test("rejects parent directory traversal", () => {
    expect(() => resolveWithinRoot(root, "../secret.txt", "file")).toThrow(UnsafeEvalPathError);
  });

  test("rejects absolute paths", () => {
    expect(() => resolveWithinRoot(root, "/etc/passwd", "file")).toThrow(UnsafeEvalPathError);
  });

  test("rejects NUL character", () => {
    expect(() => resolveWithinRoot(root, "a\0b", "file")).toThrow(UnsafeEvalPathError);
  });

  test("rejects empty string", () => {
    expect(() => resolveWithinRoot(root, "", "file")).toThrow(UnsafeEvalPathError);
  });

  test("rejects non-string", () => {
    expect(() => resolveWithinRoot(root, 123 as unknown as string, "file")).toThrow(UnsafeEvalPathError);
  });
});
