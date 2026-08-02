import type { LearningUniverseId } from "../experienceCatalog";
import type { WolfieExperienceMode } from "../types";

export const WOLFIE_VISUAL_SECTOR_IDS = [
  "pharma_health",
  "manufacturing_foundry",
  "banking_finance",
  "technology_ai",
  "logistics",
  "information_technology",
  "tax",
  "beauty_cosmetics_perfumery",
  "retail_wholesale",
  "food_beverage",
  "veterinary_pet",
  "tourism_hospitality",
  "sales_expansion",
  "projects_operations",
] as const;

export type WolfieVisualSectorId =
  (typeof WOLFIE_VISUAL_SECTOR_IDS)[number];

export const WOLFIE_VISUAL_LAYOUTS = [
  "conversation",
  "roleplay",
  "meeting",
  "presentation",
  "interview",
  "exam",
  "lab",
  "mission",
  "writing",
] as const;

export type WolfieVisualLayout = (typeof WOLFIE_VISUAL_LAYOUTS)[number];
export type WolfieVisualCamera = "close" | "medium" | "wide";
export type WolfieVisualCharacterSide = "left" | "right" | "center";
export type WolfieVisualHudVariant =
  | "conversation"
  | "meeting"
  | "exam"
  | "mission"
  | "studio";

export interface WolfieVisualPalette {
  accent: string;
  glow: string;
  scrim: string;
  gradient: string;
}

/**
 * Asset URLs are deterministic manifest entries. The renderer must keep the
 * palette gradient visible while an image loads and after an image error.
 */
export interface WolfieVisualAssetSet {
  desktopAvif?: string;
  desktopWebp?: string;
  mobileAvif?: string;
  mobileWebp?: string;
  posterWebp?: string;
}

export interface WolfieVisualSceneProfile {
  version: 1;
  key: string;
  experienceId?: string;
  universeId?: LearningUniverseId;
  sector?: WolfieVisualSectorId;
  experienceMode?: WolfieExperienceMode;
  layout: WolfieVisualLayout;
  environmentId: string;
  environmentDescription: string;
  castIds: readonly string[];
  camera: WolfieVisualCamera;
  characterSide: WolfieVisualCharacterSide;
  palette: WolfieVisualPalette;
  assets?: WolfieVisualAssetSet;
  hudVariant: WolfieVisualHudVariant;
  accessibleEnvironmentLabel: string;
}

export interface WolfieVisualScenarioProfile
  extends WolfieVisualSceneProfile {
  experienceId: string;
  universeId: LearningUniverseId;
  experienceMode: WolfieExperienceMode;
}

export interface WolfieSceneContext {
  experienceId?: string | null;
  sector?: string | null;
  universeId?: string | null;
  experienceMode?: string | null;
}

export type WolfieSceneResolutionSource =
  | "experience"
  | "sector"
  | "universe"
  | "mode"
  | "neutral";

export interface WolfieResolvedScene {
  profile: WolfieVisualSceneProfile;
  source: WolfieSceneResolutionSource;
}
