export function resolveWolfieScenarioUiV2Enabled(value: unknown): boolean {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("en-US") !== "false";
}

export const WOLFIE_SCENARIO_UI_V2_ENABLED =
  resolveWolfieScenarioUiV2Enabled(
    import.meta.env.VITE_WOLFIE_SCENARIO_UI_V2,
  );
