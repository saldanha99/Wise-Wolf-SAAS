import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WOLFIE_SCENE_CATALOG } from "./sceneCatalog";

const publicFile = (url: string): string =>
  resolve(process.cwd(), "public", url.replace(/^\//, ""));

describe("Wolfie visual assets", () => {
  it("keeps every declared scene asset local and available", () => {
    const urls = WOLFIE_SCENE_CATALOG.flatMap((profile) =>
      Object.values(profile.assets ?? {}).filter(
        (url): url is string => typeof url === "string",
      )
    );

    expect(urls).toHaveLength(24);
    expect(new Set(urls).size).toBe(urls.length);

    for (const url of urls) {
      expect(url.startsWith("/assets/wolfie/scenes/")).toBe(true);
      expect(existsSync(publicFile(url)), `${url} is missing`).toBe(true);
    }
  });

  it("keeps generated backgrounds and the initial character inside their budgets", () => {
    const sceneUrls = WOLFIE_SCENE_CATALOG.flatMap((profile) =>
      Object.entries(profile.assets ?? {}).map(([slot, url]) => ({ slot, url }))
    );

    for (const { slot, url } of sceneUrls) {
      const maximumBytes = slot.startsWith("mobile") ? 180_000 : 320_000;
      expect(statSync(publicFile(url)).size, `${url} exceeds its budget`)
        .toBeLessThanOrEqual(maximumBytes);
    }

    const character = publicFile(
      "/assets/wolfie/characters/wolfie-coach/wolfie-v2-listening.webp",
    );
    expect(existsSync(character)).toBe(true);
    expect(statSync(character).size).toBeLessThanOrEqual(400_000);
  });
});
