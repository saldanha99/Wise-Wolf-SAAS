import { describe, expect, it } from "vitest";
import {
  WOLFIE_MODE_FALLBACKS,
  WOLFIE_NEUTRAL_SCENE,
  WOLFIE_SCENE_BY_EXPERIENCE_ID,
  WOLFIE_SECTOR_FALLBACKS,
  WOLFIE_UNIVERSE_FALLBACKS,
} from "./sceneCatalog";
import {
  getExactSceneProfile,
  resolveScene,
  resolveSceneWithMetadata,
  resolveWolfieScene,
} from "./resolveScene";

describe("resolveScene", () => {
  it("resolves an exact experience before every conflicting fallback key", () => {
    const result = resolveSceneWithMetadata({
      experienceId: "meetings-business",
      sector: "pharma_health",
      universeId: "kids-teens",
      experienceMode: "exam",
    });

    expect(result.source).toBe("experience");
    expect(result.profile).toBe(
      WOLFIE_SCENE_BY_EXPERIENCE_ID["meetings-business"],
    );
  });

  it("resolves trusted sector before universe and mode", () => {
    const result = resolveSceneWithMetadata({
      experienceId: "future-experience",
      sector: "technology_ai",
      universeId: "career",
      experienceMode: "interview",
    });

    expect(result).toEqual({
      profile: WOLFIE_SECTOR_FALLBACKS.technology_ai,
      source: "sector",
    });
  });

  it("resolves universe before mode when no trusted sector exists", () => {
    const result = resolveSceneWithMetadata({
      sector: "not-a-trusted-sector",
      universeId: "events",
      experienceMode: "roleplay",
    });

    expect(result).toEqual({
      profile: WOLFIE_UNIVERSE_FALLBACKS.events,
      source: "universe",
    });
  });

  it("resolves all known modes, including reserved examiner and emergency", () => {
    for (const experienceMode of Object.keys(WOLFIE_MODE_FALLBACKS)) {
      const result = resolveSceneWithMetadata({ experienceMode });
      expect(result.source).toBe("mode");
      expect(result.profile).toBe(
        WOLFIE_MODE_FALLBACKS[
          experienceMode as keyof typeof WOLFIE_MODE_FALLBACKS
        ],
      );
    }
  });

  it("uses the neutral safe scene for absent or arbitrary keys", () => {
    expect(resolveSceneWithMetadata()).toEqual({
      profile: WOLFIE_NEUTRAL_SCENE,
      source: "neutral",
    });
    expect(
      resolveSceneWithMetadata({
        experienceId: "../../../private",
        sector: "pharma health",
        universeId: "my custom room",
        experienceMode: "constructor",
      }),
    ).toEqual({ profile: WOLFIE_NEUTRAL_SCENE, source: "neutral" });
  });

  it("trims catalog keys but never normalizes free text into a scene", () => {
    expect(getExactSceneProfile("  food-cooking  ")).toBe(
      WOLFIE_SCENE_BY_EXPERIENCE_ID["food-cooking"],
    );
    expect(resolveScene({ sector: " logistics " })).toBe(
      WOLFIE_SECTOR_FALLBACKS.logistics,
    );
    expect(resolveScene({ sector: "Logistics" })).toBe(WOLFIE_NEUTRAL_SCENE);
  });

  it("returns stable profile references through both public aliases", () => {
    const context = { universeId: "skill-labs" } as const;
    expect(resolveScene(context)).toBe(WOLFIE_UNIVERSE_FALLBACKS["skill-labs"]);
    expect(resolveWolfieScene(context)).toBe(
      WOLFIE_UNIVERSE_FALLBACKS["skill-labs"],
    );
    expect(resolveScene(context)).toBe(resolveScene(context));
  });
});
