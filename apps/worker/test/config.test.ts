import { describe, expect, it } from "vitest";
import { parseIntegerEnvironmentValue } from "../src/config.js";

describe("worker environment parsing", () => {
  it("uses defaults only for missing or blank values", () => {
    expect(parseIntegerEnvironmentValue("WORKER_CONCURRENCY", undefined, 4, 1, 32)).toBe(4);
    expect(parseIntegerEnvironmentValue("WORKER_CONCURRENCY", "   ", 4, 1, 32)).toBe(4);
  });

  it("accepts valid bounded decimal integers", () => {
    expect(parseIntegerEnvironmentValue("WORKER_CONCURRENCY", "12", 4, 1, 32)).toBe(12);
    expect(parseIntegerEnvironmentValue("WORKER_CONCURRENCY", "1", 4, 1, 32)).toBe(1);
  });

  it.each(["2workers", "2.5", "-1", "1e2", "0", "33"])(
    "rejects invalid or out-of-range values: %s",
    (raw) => {
      expect(() =>
        parseIntegerEnvironmentValue("WORKER_CONCURRENCY", raw, 4, 1, 32),
      ).toThrow("WORKER_CONCURRENCY must be an integer between 1 and 32.");
    },
  );
});
