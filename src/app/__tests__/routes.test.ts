import { describe, expect, it } from "vitest";

import { getInputDockShellClass } from "../utils/layout";

describe("getInputDockShellClass", () => {
  it("uses the app surface for the existing conversation footer", () => {
    expect(getInputDockShellClass(false)).toContain("bg-app/95");
  });
});
