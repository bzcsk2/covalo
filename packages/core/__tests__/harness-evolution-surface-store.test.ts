import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SurfaceStore } from "../src/harness-evolution/surfaces/surface-store";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_BASE = "/tmp/covalo-test-surfaces-" + Math.random().toString(36).slice(2, 8);

describe("SurfaceStore", () => {
  let store: SurfaceStore;

  beforeAll(async () => {
    store = new SurfaceStore(TEST_BASE);
  });

  afterAll(() => {
    if (existsSync(TEST_BASE)) {
      rmSync(TEST_BASE, { recursive: true, force: true });
    }
  });

  test("list returns all 11 surfaces", () => {
    const surfaces = store.list();
    expect(surfaces.length).toBe(11);
    expect(surfaces).toContain("supervisor-system-prompt");
    expect(surfaces).toContain("worker-system-prompt");
    expect(surfaces).toContain("task-digest-template");
    expect(surfaces).toContain("review-rubric");
    expect(surfaces).toContain("incident-taxonomy");
    expect(surfaces).toContain("recovery-playbook");
    expect(surfaces).toContain("context-selection-policy");
    expect(surfaces).toContain("tool-use-policy");
    expect(surfaces).toContain("eval-gate-policy");
    expect(surfaces).toContain("memory-recall-policy");
    expect(surfaces).toContain("runtime-guard-policy");
  });

  test("get returns default content for valid surfaces", async () => {
    const content = await store.get("supervisor-system-prompt");
    expect(content).toContain("Supervisor");
    expect(content.length).toBeGreaterThan(50);
  });

  test("get returns content for all surfaces", async () => {
    for (const surface of store.list()) {
      const content = await store.get(surface);
      expect(content.length).toBeGreaterThan(20);
    }
  });

  test("getHash returns deterministic hash", async () => {
    const hash1 = await store.getHash("supervisor-system-prompt");
    const hash2 = await store.getHash("supervisor-system-prompt");
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(16); // sha256 truncated to 16 chars
  });

  test("getHash varies between surfaces", async () => {
    const hash1 = await store.getHash("supervisor-system-prompt");
    const hash2 = await store.getHash("worker-system-prompt");
    expect(hash1).not.toBe(hash2);
  });

  test("getAll returns record of all surfaces", async () => {
    const all = await store.getAll();
    expect(Object.keys(all).length).toBe(11);
    expect(all["supervisor-system-prompt"]).toContain("Supervisor");
  });

  test("getAllHashes returns record of all hashes", async () => {
    const hashes = await store.getAllHashes();
    expect(Object.keys(hashes).length).toBe(11);
    for (const hash of Object.values(hashes)) {
      expect(hash.length).toBe(16);
    }
  });

  test("user override takes precedence over default", async () => {
    // 之前的测试已经触发过 store.get("supervisor-system-prompt")（如 getAll / getHash），
    // cache 中已填入默认内容。这里直接 writeFileSync 不会清 cache，导致后续 get 命中默认内容失败。
    // 改用 store.writeOverride API：它写文件后会自动 invalidate cache，保证测试一致性。
    await store.writeOverride("supervisor-system-prompt", "Custom supervisor content");

    const content = await store.get("supervisor-system-prompt");
    expect(content).toBe("Custom supervisor content");
  });

  test("throws for unknown surface", async () => {
    let threw = false;
    try {
      await (store as any).get("nonexistent-surface");
    } catch (e: any) {
      threw = true;
      expect(e.message).toContain("Unknown harness surface");
    }
    expect(threw).toBe(true);
  });

  test("list returns empty on nonexistent surface validation", () => {
    expect(store.list()).not.toContain("nonexistent-surface");
  });

  test("writeOverride persists user content", async () => {
    await store.writeOverride("worker-system-prompt", "Custom worker prompt");
    const content = await store.get("worker-system-prompt");
    expect(content).toBe("Custom worker prompt");
  });

  test("writeOverride throws for unknown surface", async () => {
    try {
      await (store as any).writeOverride("bad-surface", "content");
      expect.unreachable("Should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("Unknown harness surface");
    }
  });
});
