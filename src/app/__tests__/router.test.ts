import { describe, expect, it } from "vitest";

import { router } from "../router";

describe("router module", () => {
  it("exports the app router from a dedicated module", () => {
    expect(router).toBeDefined();
  });
});
