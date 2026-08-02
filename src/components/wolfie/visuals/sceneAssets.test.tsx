import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WOLFIE_CHARACTER_IMAGE,
  DEFAULT_WOLFIE_SPEAKING_MOUTH_IMAGE,
} from "./WolfieCharacter";
import { WOLFIE_SCENE_BY_EXPERIENCE_ID } from "./sceneCatalog";
import visualAssetManifest from "./visualAssetManifest.json";

interface LockedAssetFile {
  url: string;
  width: number;
  height: number;
  bytes: number;
  maxBytes: number;
  sha256: string;
}

const publicFile = (url: string): string =>
  resolve(process.cwd(), "public", url.replace(/^\//, ""));

const sha256 = (filePath: string): string =>
  createHash("sha256").update(readFileSync(filePath)).digest("hex");

const readWebpDimensions = (
  filePath: string,
): { width: number; height: number } => {
  const buffer = readFileSync(filePath);
  if (
    buffer.length < 20 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw new Error(`${filePath} is not a valid WebP RIFF container`);
  }

  const riffSize = buffer.readUInt32LE(4);
  if (riffSize !== buffer.length - 8) {
    throw new Error(`${filePath} has a divergent WebP RIFF size`);
  }

  let offset = 12;
  let dimensions: { width: number; height: number } | undefined;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      throw new Error(`${filePath} has trailing bytes outside a WebP chunk`);
    }
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    const paddedEnd = payloadOffset + chunkSize + (chunkSize % 2);
    if (paddedEnd > buffer.length) {
      throw new Error(`${filePath} has a truncated ${chunkType} chunk`);
    }

    if (chunkType === "VP8X") {
      if (chunkSize < 10) {
        throw new Error(`${filePath} has an invalid VP8X header`);
      }
      dimensions = {
        width: buffer.readUIntLE(payloadOffset + 4, 3) + 1,
        height: buffer.readUIntLE(payloadOffset + 7, 3) + 1,
      };
    } else if (chunkType === "VP8 ") {
      const signatureOffset = payloadOffset + 3;
      if (
        chunkSize < 10 ||
        buffer[signatureOffset] !== 0x9d ||
        buffer[signatureOffset + 1] !== 0x01 ||
        buffer[signatureOffset + 2] !== 0x2a
      ) {
        throw new Error(`${filePath} has an invalid VP8 frame header`);
      }
      dimensions ??= {
        width: buffer.readUInt16LE(payloadOffset + 6) & 0x3fff,
        height: buffer.readUInt16LE(payloadOffset + 8) & 0x3fff,
      };
    } else if (chunkType === "VP8L") {
      if (chunkSize < 5 || buffer[payloadOffset] !== 0x2f) {
        throw new Error(`${filePath} has an invalid VP8L frame header`);
      }
      const packedDimensions = buffer.readUInt32LE(payloadOffset + 1);
      dimensions ??= {
        width: (packedDimensions & 0x3fff) + 1,
        height: ((packedDimensions >>> 14) & 0x3fff) + 1,
      };
    }

    offset = paddedEnd;
  }

  if (!dimensions) {
    throw new Error(`${filePath} does not contain a supported WebP image chunk`);
  }
  return dimensions;
};

const assertLockedFile = (asset: LockedAssetFile): void => {
  expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(asset.bytes).toBeGreaterThan(0);
  expect(asset.maxBytes).toBeGreaterThan(0);
  expect(asset.bytes).toBeLessThanOrEqual(asset.maxBytes);

  const filePath = publicFile(asset.url);
  expect(existsSync(filePath), `${asset.url} is missing`).toBe(true);
  expect(statSync(filePath).size, `${asset.url} byte lock changed`).toBe(
    asset.bytes,
  );
  expect(sha256(filePath), `${asset.url} SHA-256 lock changed`).toBe(
    asset.sha256,
  );
  expect(readWebpDimensions(filePath), `${asset.url} dimensions changed`)
    .toEqual({ width: asset.width, height: asset.height });
};

describe("Wolfie visual asset manifest", () => {
  it("keeps the scene catalog and manifest in a one-to-one lock", () => {
    expect(visualAssetManifest.schemaVersion).toBe(1);
    expect(visualAssetManifest.scenes).toHaveLength(56);

    const manifestIds = visualAssetManifest.scenes.map(
      (entry) => entry.experienceId,
    );
    expect(new Set(manifestIds).size).toBe(manifestIds.length);

    const catalogProfiles = Object.values(WOLFIE_SCENE_BY_EXPERIENCE_ID)
      .filter((profile) => profile.assets);
    expect(catalogProfiles.map((profile) => profile.experienceId).sort())
      .toEqual([...manifestIds].sort());

    for (const entry of visualAssetManifest.scenes) {
      const profile = WOLFIE_SCENE_BY_EXPERIENCE_ID[entry.experienceId];
      expect(profile.universeId).toBe(entry.universeId);
      expect(profile.assets).toEqual({
        desktopWebp: entry.desktop.url,
        mobileWebp: entry.mobile.url,
      });
    }
  });

  it("verifies every scene URL, byte budget, hash and WebP dimension", () => {
    const urls: string[] = [];

    for (const entry of visualAssetManifest.scenes) {
      expect(entry.sourceId).toMatch(
        /^exec-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.png$/,
      );
      const expectedDirectory =
        `/assets/wolfie/scenes/${entry.universeId}/${entry.experienceId}`;

      for (const [variant, asset] of [
        ["desktop", entry.desktop],
        ["mobile", entry.mobile],
      ] as const) {
        expect(asset.url.startsWith(`${expectedDirectory}/`)).toBe(true);
        expect(basename(asset.url)).toMatch(
          new RegExp(`^${variant}\\.[a-f0-9]{12}\\.webp$`),
        );
        const fingerprint = basename(asset.url).match(
          new RegExp(`^${variant}\\.([a-f0-9]{12})\\.webp$`),
        )?.[1];
        expect(fingerprint).toBe(asset.sha256.slice(0, 12));
        urls.push(asset.url);
        assertLockedFile(asset);
      }
    }

    expect(new Set(urls).size).toBe(urls.length);
  });

  it("locks the V2 character and speaking mouth with the same integrity checks", () => {
    expect(visualAssetManifest.characters).toHaveLength(2);
    const charactersByState = new Map(
      visualAssetManifest.characters.map((character) => [
        character.state,
        character,
      ]),
    );
    const listening = charactersByState.get("listening");
    const speaking = charactersByState.get("speaking");

    expect(listening).toMatchObject({
      characterId: "wolfie-coach",
      state: "listening",
      version: 2,
    });
    expect(speaking).toMatchObject({
      characterId: "wolfie-coach",
      state: "speaking",
      version: 2,
    });
    expect(listening?.asset.url).toBe(DEFAULT_WOLFIE_CHARACTER_IMAGE);
    expect(speaking?.asset.url).toBe(DEFAULT_WOLFIE_SPEAKING_MOUTH_IMAGE);

    for (const character of visualAssetManifest.characters) {
      expect(character.sourceId).toMatch(
        /^exec-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.png$/,
      );
      expect(character.asset.url).toMatch(
        new RegExp(
          `^/assets/wolfie/characters/wolfie-coach/wolfie-v2-${character.state}\\.[a-f0-9]{12}\\.webp$`,
        ),
      );
      expect(
        basename(character.asset.url).match(/\.([a-f0-9]{12})\.webp$/)?.[1],
      ).toBe(character.asset.sha256.slice(0, 12));
      assertLockedFile(character.asset);
    }
  });

  it("preserves transitional V1 aliases with the exact primary bytes", () => {
    expect(visualAssetManifest.legacyAliases).toHaveLength(25);
    const primaryAssets = new Map<string, LockedAssetFile>();
    for (const scene of visualAssetManifest.scenes) {
      primaryAssets.set(scene.desktop.url, scene.desktop);
      primaryAssets.set(scene.mobile.url, scene.mobile);
    }
    for (const character of visualAssetManifest.characters) {
      primaryAssets.set(character.asset.url, character.asset);
    }

    const targets = new Set<string>();
    for (const alias of visualAssetManifest.legacyAliases) {
      const target = primaryAssets.get(alias.targetUrl);
      expect(target, `${alias.targetUrl} is not a primary asset`).toBeDefined();
      if (!target) throw new Error(`Missing primary asset ${alias.targetUrl}`);

      expect(alias.url).toBe(
        alias.targetUrl.replace(/\.[a-f0-9]{12}\.webp$/, ".webp"),
      );
      expect(targets.has(alias.targetUrl)).toBe(false);
      targets.add(alias.targetUrl);
      assertLockedFile({ ...target, url: alias.url });
    }
  });
});
