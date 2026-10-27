import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { InvalidIndicator, keyedHash, normalizePhone, normalizeUrl, parseIndicator } from "../src/normalize.js";

const SECRET = "unit-test-secret-0123456789abcdef01234";

describe("normalizePhone", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["+91 98765 43210", "+919876543210"],
    ["091-9876543210".replace("091", "0"), "+919876543210"],
    ["919876543210", "+919876543210"],
    ["(987) 654-3210", "+919876543210"],
    ["+1 415 555 0100", "+14155550100"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each(["12345", "5876543210", "+12", "not a number"])("rejects %s", (raw) => {
    expect(() => normalizePhone(raw)).toThrow(InvalidIndicator);
  });
});

describe("normalizeUrl", () => {
  it.each([
    ["https://www.Free-Prize.example/claim?id=1", "free-prize.example"],
    ["free-prize.example/other/path", "free-prize.example"],
    ["HTTP://FREE-PRIZE.EXAMPLE.", "free-prize.example"],
    ["https://pаypal.example/login", "xn--pypal-4ve.example"], // Cyrillic 'а' look-alike
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeUrl(raw)).toBe(expected);
  });

  it.each(["javascript:alert(1)", "ftp://files.example", "localhost", "http://"])("rejects %s", (raw) => {
    expect(() => normalizeUrl(raw)).toThrow(InvalidIndicator);
  });
});

describe("parseIndicator", () => {
  it("auto-detects phones and URLs", () => {
    expect(parseIndicator("+91 98765 43210", SECRET).kind).toBe("phone");
    expect(parseIndicator("kyc-update.example", SECRET).kind).toBe("url");
  });

  it("maps every variant of an indicator to one key", () => {
    const keys = ["9876543210", "+91-98765-43210", "09876543210"].map((r) => parseIndicator(r, SECRET).key);
    expect(new Set(keys).size).toBe(1);
  });

  it("never exposes the raw value in the key", () => {
    const { key } = parseIndicator("9876543210", SECRET);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain("9876543210");
  });

  it("separates kinds in the key space", () => {
    expect(parseIndicator("9876543210", SECRET, "phone").key).not.toBe(parseIndicator("9876543210.example", SECRET, "url").key);
  });
});

describe("keyedHash", () => {
  it("is deterministic for one secret", () => {
    expect(keyedHash(SECRET, "phone", "+919876543210")).toBe(keyedHash(SECRET, "phone", "+919876543210"));
  });

  it("produces unrelated keys under a different secret", () => {
    const other = "another-secret-0123456789abcdef0123456";
    expect(parseIndicator("9876543210", SECRET).key).not.toBe(parseIndicator("9876543210", other).key);
  });

  it("cannot be reproduced by an unkeyed hash (blocks dictionary attacks on phone numbers)", () => {
    const unkeyed = createHash("sha256").update("phone:+919876543210").digest("hex").slice(0, 32);
    expect(parseIndicator("9876543210", SECRET).key).not.toBe(unkeyed);
  });

  it("separates domains so a reporter id never collides with an indicator key", () => {
    expect(keyedHash(SECRET, "reporter", "x")).not.toBe(keyedHash(SECRET, "url", "x"));
  });

  it("rejects short secrets", () => {
    expect(() => keyedHash("too-short", "url", "a.example")).toThrow(/at least 32/);
  });
});
