import { describe, expect, it } from "vitest";
import { resolveWolfieScenarioUiV2Enabled } from "./featureFlags";

describe("resolveWolfieScenarioUiV2Enabled", () => {
  it("keeps the scenario interface enabled when the build flag is omitted", () => {
    expect(resolveWolfieScenarioUiV2Enabled(undefined)).toBe(true);
    expect(resolveWolfieScenarioUiV2Enabled(null)).toBe(true);
    expect(resolveWolfieScenarioUiV2Enabled("")).toBe(true);
    expect(resolveWolfieScenarioUiV2Enabled("unexpected-value")).toBe(true);
  });

  it("allows an explicit rollback and normalizes an explicit enablement", () => {
    expect(resolveWolfieScenarioUiV2Enabled("false")).toBe(false);
    expect(resolveWolfieScenarioUiV2Enabled(" TRUE ")).toBe(true);
  });
});
