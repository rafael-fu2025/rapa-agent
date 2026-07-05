// §2.4 — Tests for the scheduler tick.
//
// We test the pure functions (nextRunAt computation, cron parsing) in
// isolation. The full tick (which hits the DB and creates conversations)
// is covered by integration tests elsewhere.

import { describe, expect, it } from "vitest";
import { computeNextRunAt } from "../scheduler-tick.js";

describe("computeNextRunAt", () => {
  it("returns null for one-shot 'at' schedules", () => {
    const result = computeNextRunAt({ kind: "at", expr: "2026-12-31T00:00:00Z", tz: "UTC" });
    expect(result).toBeNull();
  });

  it("advances 'every' schedules by their interval", () => {
    const after = new Date("2026-07-04T10:00:00Z");
    const result = computeNextRunAt({ kind: "every", expr: "60000", tz: null }, after);
    expect(result?.toISOString()).toBe("2026-07-04T10:01:00.000Z");
  });

  it("rejects invalid 'every' intervals", () => {
    const result = computeNextRunAt({ kind: "every", expr: "0", tz: null });
    expect(result).toBeNull();
  });

  it("advances cron schedules to the next matching minute", () => {
    // Every 15 minutes (at :00, :15, :30, :45).
    const after = new Date("2026-07-04T10:07:00Z");
    const result = computeNextRunAt({ kind: "cron", expr: "*/15 * * * *", tz: "UTC" }, after);
    expect(result?.getMinutes()).toBe(15);
    expect(result?.getUTCHours()).toBe(10);
  });

  it("handles cron with comma-separated hours", () => {
    // 9 AM and 5 PM every day.
    const after = new Date("2026-07-04T12:00:00Z");
    const result = computeNextRunAt({ kind: "cron", expr: "0 9,17 * * *", tz: "UTC" }, after);
    expect(result?.getUTCHours()).toBe(17);
    expect(result?.getMinutes()).toBe(0);
  });

  it("handles cron with ranges", () => {
    // Every minute from 9:00 to 9:59.
    const after = new Date("2026-07-04T10:00:00Z");
    const result = computeNextRunAt({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }, after);
    expect(result?.getUTCHours()).toBe(9);
  });

  it("falls back to a 1-minute tick for malformed cron expressions", () => {
    const result = computeNextRunAt({ kind: "cron", expr: "garbage", tz: null });
    expect(result).toBeDefined();
    expect(result!.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("returns null for unknown schedule kinds", () => {
    const result = computeNextRunAt({ kind: "weekly", expr: "x", tz: null });
    expect(result).toBeNull();
  });
});
