import { describe, expect, it } from "vitest";
import { quorum } from "../src/rpc.js";

const after = <T>(ms: number, v: T, fail = false) =>
  new Promise<T>((resolve, reject) => setTimeout(() => (fail ? reject(new Error("x")) : resolve(v)), ms));

describe("quorum", () => {
  it("resolves once enough promises fulfil, without waiting for the slowest", async () => {
    const start = Date.now();
    const { ok } = await quorum([after(5, "a"), after(10, "b"), after(2000, "c")], 2);
    expect(ok.map((o) => o.value).sort()).toEqual(["a", "b"]);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("reports failures and resolves when everything has settled", async () => {
    const { ok, failed } = await quorum([after(1, "a"), after(1, "b", true), after(1, "c", true)], 2);
    expect(ok).toHaveLength(1);
    expect(failed.sort()).toEqual([1, 2]);
  });

  it("handles an empty list", async () => {
    expect(await quorum([], 1)).toEqual({ ok: [], failed: [] });
  });
});
