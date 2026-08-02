import {
  getExperienceById,
  getUniverseForExperience,
  LEARNING_UNIVERSE_IDS,
} from "../experienceCatalog";
import type { LearningUniverseId } from "../experienceCatalog";
import type { WolfieExperienceMode } from "../types";
import {
  WOLFIE_MODE_FALLBACKS,
  WOLFIE_NEUTRAL_SCENE,
  WOLFIE_SCENE_BY_EXPERIENCE_ID,
  WOLFIE_SECTOR_FALLBACKS,
  WOLFIE_UNIVERSE_FALLBACKS,
} from "./sceneCatalog";
import {
  WOLFIE_VISUAL_SECTOR_IDS,
  type WolfieResolvedScene,
  type WolfieSceneContext,
  type WolfieVisualScenarioProfile,
  type WolfieVisualSceneProfile,
  type WolfieVisualSectorId,
} from "./types";

const universeIds = new Set<string>(LEARNING_UNIVERSE_IDS);
const sectorIds = new Set<string>(WOLFIE_VISUAL_SECTOR_IDS);

const normalizedKey = (value?: string | null): string | undefined => {
  const normalized = value?.trim();
  return normalized || undefined;
};

const hasOwn = <T extends object>(
  object: T,
  key: PropertyKey,
): key is keyof T => Object.prototype.hasOwnProperty.call(object, key);

const asUniverseId = (
  value?: string | null,
): LearningUniverseId | undefined => {
  const candidate = normalizedKey(value);
  return candidate && universeIds.has(candidate)
    ? (candidate as LearningUniverseId)
    : undefined;
};

const asSectorId = (
  value?: string | null,
): WolfieVisualSectorId | undefined => {
  const candidate = normalizedKey(value);
  return candidate && sectorIds.has(candidate)
    ? (candidate as WolfieVisualSectorId)
    : undefined;
};

const asExperienceMode = (
  value?: string | null,
): WolfieExperienceMode | undefined => {
  const candidate = normalizedKey(value);
  return candidate && hasOwn(WOLFIE_MODE_FALLBACKS, candidate)
    ? (candidate as WolfieExperienceMode)
    : undefined;
};

export const getExactSceneProfile = (
  experienceId?: string | null,
): WolfieVisualScenarioProfile | undefined => {
  const candidate = normalizedKey(experienceId);
  if (!candidate || !hasOwn(WOLFIE_SCENE_BY_EXPERIENCE_ID, candidate)) {
    return undefined;
  }
  return WOLFIE_SCENE_BY_EXPERIENCE_ID[candidate];
};

/**
 * Resolves only allow-listed catalog keys. Learner names, prompts, scenarios and
 * transcript text are deliberately not part of this input contract.
 */
export const resolveSceneWithMetadata = (
  context: WolfieSceneContext = {},
): WolfieResolvedScene => {
  const experienceId = normalizedKey(context.experienceId);
  const exactProfile = getExactSceneProfile(experienceId);
  if (exactProfile) {
    return { profile: exactProfile, source: "experience" };
  }

  const pedagogicalExperience = experienceId
    ? getExperienceById(experienceId)
    : undefined;
  const pedagogicalUniverse = experienceId
    ? getUniverseForExperience(experienceId)
    : undefined;

  const sector = asSectorId(context.sector) ??
    asSectorId(pedagogicalExperience?.sector);
  if (sector) {
    return { profile: WOLFIE_SECTOR_FALLBACKS[sector], source: "sector" };
  }

  const universeId = asUniverseId(context.universeId) ??
    pedagogicalUniverse?.id;
  if (universeId) {
    return {
      profile: WOLFIE_UNIVERSE_FALLBACKS[universeId],
      source: "universe",
    };
  }

  const experienceMode = asExperienceMode(context.experienceMode) ??
    pedagogicalExperience?.experienceMode;
  if (experienceMode) {
    return {
      profile: WOLFIE_MODE_FALLBACKS[experienceMode],
      source: "mode",
    };
  }

  return { profile: WOLFIE_NEUTRAL_SCENE, source: "neutral" };
};

export const resolveScene = (
  context: WolfieSceneContext = {},
): WolfieVisualSceneProfile => resolveSceneWithMetadata(context).profile;

export const resolveWolfieScene = resolveScene;
