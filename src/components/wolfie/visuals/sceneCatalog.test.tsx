import { describe, expect, it } from "vitest";
import {
  ALL_EXPERIENCES,
  getUniverseForExperience,
  LEARNING_UNIVERSE_IDS,
} from "../experienceCatalog";
import {
  SCENE_CATALOG,
  WOLFIE_MODE_FALLBACKS,
  WOLFIE_SCENE_BY_EXPERIENCE_ID,
  WOLFIE_SECTOR_FALLBACKS,
  WOLFIE_UNIVERSE_FALLBACKS,
} from "./sceneCatalog";
import { WOLFIE_VISUAL_SECTOR_IDS } from "./types";
import visualAssetManifest from "./visualAssetManifest.json";

const EXPECTED_EXPERIENCE_IDS = [
  "introduce-yourself",
  "my-routine",
  "my-home",
  "my-family",
  "my-childhood",
  "my-plans",
  "home-organization",
  "food-cooking",
  "skincare-beauty",
  "health-symptoms",
  "shopping",
  "services",
  "digital-life",
  "record-a-story",
  "tell-a-story",
  "describe-what-you-see",
  "give-your-opinion",
  "speak-for-a-minute",
  "game-worlds",
  "roblox-inspired-missions",
  "create-your-avatar",
  "school-life",
  "series-characters",
  "mystery-adventures",
  "job-interviews",
  "first-job",
  "multinationals",
  "promotion",
  "career-networking",
  "career-change",
  "meetings-business",
  "meetings-medicine",
  "meetings-human-reproduction",
  "meetings-laboratories",
  "meetings-beauty",
  "meetings-retail",
  "meetings-technology",
  "meetings-logistics",
  "meetings-tourism",
  "meetings-aviation",
  "events-networking",
  "medical-congresses",
  "talks",
  "panels",
  "trade-shows",
  "poster-presentation",
  "exam-cambridge",
  "exam-toefl",
  "exam-ielts",
  "exam-toeic",
  "exam-duolingo",
  "listening-lab",
  "pronunciation-lab",
  "writing-lab",
  "vocabulary-lab",
  "presentation-lab",
] as const;

const sorted = (values: readonly string[]) => [...values].sort();

const EXPECTED_MANIFEST_SCENE_IDS = [
  "career-networking",
  "describe-what-you-see",
  "digital-life",
  "exam-cambridge",
  "exam-duolingo",
  "exam-ielts",
  "exam-toefl",
  "exam-toeic",
  "food-cooking",
  "give-your-opinion",
  "health-symptoms",
  "home-organization",
  "job-interviews",
  "listening-lab",
  "medical-congresses",
  "meetings-aviation",
  "meetings-beauty",
  "meetings-business",
  "meetings-human-reproduction",
  "meetings-laboratories",
  "meetings-logistics",
  "meetings-medicine",
  "meetings-retail",
  "meetings-technology",
  "meetings-tourism",
  "presentation-lab",
  "promotion",
  "pronunciation-lab",
  "record-a-story",
  "services",
  "shopping",
  "skincare-beauty",
  "speak-for-a-minute",
  "talks",
  "tell-a-story",
  "trade-shows",
  "vocabulary-lab",
  "writing-lab",
] as const;

describe("Wolfie visual scene catalog", () => {
  it("covers exactly the canonical 56 experience IDs", () => {
    expect(EXPECTED_EXPERIENCE_IDS).toHaveLength(56);
    expect(ALL_EXPERIENCES).toHaveLength(56);
    expect(SCENE_CATALOG).toHaveLength(56);

    expect(sorted(ALL_EXPERIENCES.map((experience) => experience.id))).toEqual(
      sorted(EXPECTED_EXPERIENCE_IDS),
    );
    expect(sorted(SCENE_CATALOG.map((profile) => profile.experienceId))).toEqual(
      sorted(EXPECTED_EXPERIENCE_IDS),
    );
  });

  it("declares one unique, complete and versioned profile per experience", () => {
    const experienceIds = SCENE_CATALOG.map((profile) => profile.experienceId);
    const profileKeys = SCENE_CATALOG.map((profile) => profile.key);
    const environmentIds = SCENE_CATALOG.map((profile) => profile.environmentId);

    expect(new Set(experienceIds).size).toBe(56);
    expect(new Set(profileKeys).size).toBe(56);
    expect(new Set(environmentIds).size).toBe(56);
    expect(Object.keys(WOLFIE_SCENE_BY_EXPERIENCE_ID)).toHaveLength(56);

    for (const profile of SCENE_CATALOG) {
      expect(profile.version).toBe(1);
      expect(profile.key).toBe(`experience:${profile.experienceId}`);
      expect(profile.environmentDescription.trim()).not.toBe("");
      expect(profile.accessibleEnvironmentLabel.trim()).not.toBe("");
      expect(profile.castIds.length).toBeGreaterThan(0);
      expect(profile.palette.gradient).toContain("linear-gradient");
      expect(WOLFIE_SCENE_BY_EXPERIENCE_ID[profile.experienceId]).toBe(profile);
    }
  });

  it("keeps visual universe, mode and sector aligned with the pedagogical catalog", () => {
    for (const experience of ALL_EXPERIENCES) {
      const profile = WOLFIE_SCENE_BY_EXPERIENCE_ID[experience.id];
      expect(profile, `${experience.id} has no visual profile`).toBeDefined();
      expect(profile.experienceMode).toBe(experience.experienceMode);
      expect(profile.universeId).toBe(
        getUniverseForExperience(experience.id)?.id,
      );
      expect(profile.sector).toBe(experience.sector);
    }
  });

  it("advertises exactly the scene files locked by the visual asset manifest", () => {
    expect(visualAssetManifest.schemaVersion).toBe(1);
    expect(visualAssetManifest.scenes).toHaveLength(38);

    const profilesWithAssets = SCENE_CATALOG.filter((profile) => profile.assets);
    const manifestExperienceIds = visualAssetManifest.scenes.map(
      (entry) => entry.experienceId,
    );
    expect(sorted(manifestExperienceIds)).toEqual(
      sorted(EXPECTED_MANIFEST_SCENE_IDS),
    );
    expect(sorted(profilesWithAssets.map((profile) => profile.experienceId)))
      .toEqual(sorted(manifestExperienceIds));

    for (const entry of visualAssetManifest.scenes) {
      const profile = WOLFIE_SCENE_BY_EXPERIENCE_ID[entry.experienceId];
      expect(profile.universeId).toBe(entry.universeId);
      expect(profile.assets?.desktopWebp).toBe(entry.desktop.url);
      expect(profile.assets?.mobileWebp).toBe(entry.mobile.url);
      expect(profile.assets?.desktopAvif).toBeUndefined();
      expect(profile.assets?.mobileAvif).toBeUndefined();
      expect(profile.assets?.posterWebp).toBeUndefined();
    }
  });

  it("gives every global-meeting experience a distinguishable environment", () => {
    const meetingProfiles = SCENE_CATALOG.filter(
      (profile) => profile.universeId === "global-meetings",
    );
    expect(meetingProfiles).toHaveLength(10);
    expect(new Set(meetingProfiles.map((profile) => profile.environmentId)).size)
      .toBe(10);
    expect(meetingProfiles.every((profile) => profile.hudVariant === "meeting"))
      .toBe(true);
    expect(meetingProfiles.every((profile) => Boolean(profile.sector))).toBe(true);
  });

  it("manifests every trusted sector, universe and experience mode fallback", () => {
    expect(sorted(Object.keys(WOLFIE_SECTOR_FALLBACKS))).toEqual(
      sorted(WOLFIE_VISUAL_SECTOR_IDS),
    );
    expect(sorted(Object.keys(WOLFIE_UNIVERSE_FALLBACKS))).toEqual(
      sorted(LEARNING_UNIVERSE_IDS),
    );
    expect(Object.keys(WOLFIE_MODE_FALLBACKS)).toHaveLength(16);

    const fallbacks = [
      ...Object.values(WOLFIE_SECTOR_FALLBACKS),
      ...Object.values(WOLFIE_UNIVERSE_FALLBACKS),
      ...Object.values(WOLFIE_MODE_FALLBACKS),
    ];
    for (const profile of fallbacks) {
      expect(profile.version).toBe(1);
      expect(profile.assets).toBeUndefined();
      expect(profile.palette.gradient).toContain("linear-gradient");
      expect(profile.accessibleEnvironmentLabel.trim()).not.toBe("");
    }
  });
});
