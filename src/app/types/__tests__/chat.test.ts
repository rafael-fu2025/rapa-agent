import { describe, it, expect } from "vitest";
import { RESUMABLE_RUN_STATUSES } from "../chat";

describe("RESUMABLE_RUN_STATUSES", () => {
  it("contains expected statuses", () => {
    expect(RESUMABLE_RUN_STATUSES.has("max_iterations")).toBe(true);
    expect(RESUMABLE_RUN_STATUSES.has("failed")).toBe(true);
    expect(RESUMABLE_RUN_STATUSES.has("interrupted")).toBe(true);
  });

  it("does not contain completed status", () => {
    expect(RESUMABLE_RUN_STATUSES.has("completed")).toBe(false);
  });
});
