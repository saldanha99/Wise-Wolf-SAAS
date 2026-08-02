#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fail = (message) => {
  throw new Error(`[Wolfie assets] ${message}`);
};

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const formatIndex = args.indexOf("--format");
const rootName = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
const outputFormat = formatIndex >= 0 ? args[formatIndex + 1] : "summary";
const expectedArgumentCount = outputFormat === "tsv" ? 4 : 2;
if (
  args.length !== expectedArgumentCount ||
  !["public", "dist"].includes(rootName) ||
  !["summary", "tsv"].includes(outputFormat)
) {
  fail(
    "uso: node scripts/verify-wolfie-visual-assets.mjs " +
      "--root public|dist [--format tsv]",
  );
}
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = resolve(projectRoot, rootName);
const manifestPath = resolve(
  projectRoot,
  "src/components/wolfie/visuals/visualAssetManifest.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const wolfieRoot = resolve(assetRoot, "assets/wolfie");
const decoderOutput = process.platform === "win32" ? "NUL" : "/dev/null";

const isInside = (base, candidate) => {
  const pathFromBase = relative(base, candidate);
  return pathFromBase !== "" && !pathFromBase.startsWith("..") &&
    !isAbsolute(pathFromBase);
};

const validateUrl = (url) => {
  if (
    typeof url !== "string" ||
    !url.startsWith("/assets/wolfie/") ||
    !url.endsWith(".webp") ||
    url.includes("\\") ||
    url.includes("?") ||
    url.includes("#") ||
    url.includes("//") ||
    posix.normalize(url) !== url
  ) {
    fail(`URL inválida: ${String(url)}`);
  }
};

const readWebpDimensions = (buffer, label) => {
  if (
    buffer.length < 20 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    fail(`${label} não é um container RIFF/WEBP válido`);
  }
  const riffSize = buffer.readUInt32LE(4);
  if (riffSize !== buffer.length - 8) {
    fail(`${label} possui tamanho RIFF divergente`);
  }

  let offset = 12;
  let dimensions;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      fail(`${label} possui bytes residuais fora de um chunk`);
    }
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    const paddedEnd = payloadOffset + chunkSize + (chunkSize % 2);
    if (paddedEnd > buffer.length) {
      fail(`${label} possui chunk ${chunkType} truncado`);
    }
    if (chunkType === "VP8X") {
      if (chunkSize < 10) fail(`${label} possui cabeçalho VP8X inválido`);
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
        fail(`${label} possui cabeçalho VP8 inválido`);
      }
      dimensions ??= {
        width: buffer.readUInt16LE(payloadOffset + 6) & 0x3fff,
        height: buffer.readUInt16LE(payloadOffset + 8) & 0x3fff,
      };
    } else if (chunkType === "VP8L") {
      if (chunkSize < 5 || buffer[payloadOffset] !== 0x2f) {
        fail(`${label} possui cabeçalho VP8L inválido`);
      }
      const packed = buffer.readUInt32LE(payloadOffset + 1);
      dimensions ??= {
        width: (packed & 0x3fff) + 1,
        height: ((packed >>> 14) & 0x3fff) + 1,
      };
    }
    offset = paddedEnd;
  }
  if (!dimensions) fail(`${label} não possui frame WebP suportado`);
  return dimensions;
};

const assertRegularDirectory = (directory, label) => {
  const status = lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    fail(`${label} não é um diretório real: ${directory}`);
  }
};

assertRegularDirectory(assetRoot, "raiz selecionada");
assertRegularDirectory(resolve(assetRoot, "assets"), "diretório assets");
assertRegularDirectory(wolfieRoot, "raiz Wolfie");
const wolfieRootReal = realpathSync(wolfieRoot);

const urls = new Set();
const hashes = new Set();
const lockRows = [];
const primaryAssets = new Map();
const verifyFile = (
  asset,
  expected,
  label,
  { allowDuplicateHash = false, decode = true } = {},
) => {
  validateUrl(asset.url);
  if (urls.has(asset.url)) fail(`URL duplicada: ${asset.url}`);
  urls.add(asset.url);
  if (
    !Number.isInteger(asset.width) ||
    !Number.isInteger(asset.height) ||
    !Number.isInteger(asset.bytes) ||
    !Number.isInteger(asset.maxBytes) ||
    asset.width <= 0 ||
    asset.height <= 0 ||
    asset.bytes <= 0 ||
    asset.maxBytes <= 0 ||
    asset.bytes > asset.maxBytes ||
    asset.maxBytes !== expected.maxBytes ||
    asset.width !== expected.width ||
    asset.height !== expected.height ||
    !/^[a-f0-9]{64}$/.test(asset.sha256)
  ) {
    fail(`lock inválido para ${label}`);
  }
  if (hashes.has(asset.sha256) && !allowDuplicateHash) {
    fail(`SHA-256 duplicado: ${asset.sha256}`);
  }
  hashes.add(asset.sha256);

  const filePath = resolve(assetRoot, asset.url.slice(1));
  if (!isInside(resolve(assetRoot, "assets/wolfie"), filePath)) {
    fail(`caminho fora da raiz Wolfie: ${asset.url}`);
  }
  const fileStatus = lstatSync(filePath);
  if (fileStatus.isSymbolicLink() || !fileStatus.isFile()) {
    fail(`asset não é arquivo regular: ${asset.url}`);
  }
  const fileReal = realpathSync(filePath);
  if (!isInside(wolfieRootReal, fileReal)) {
    fail(`asset resolve fora da raiz Wolfie real: ${asset.url}`);
  }
  if (statSync(filePath).size !== asset.bytes) {
    fail(`bytes divergentes em ${asset.url}`);
  }
  const buffer = readFileSync(filePath);
  const digest = createHash("sha256").update(buffer).digest("hex");
  if (digest !== asset.sha256) fail(`SHA-256 divergente em ${asset.url}`);
  const dimensions = readWebpDimensions(buffer, asset.url);
  if (dimensions.width !== asset.width || dimensions.height !== asset.height) {
    fail(`dimensões divergentes em ${asset.url}`);
  }
  if (decode) {
    const decoded = spawnSync(
      "dwebp",
      [filePath, "-mt", "-quiet", "-o", decoderOutput],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    if (decoded.error?.code === "ENOENT") {
      fail("decoder real ausente: instale o utilitário dwebp (libwebp)");
    }
    if (decoded.error || decoded.status !== 0) {
      fail(`dwebp não conseguiu decodificar ${asset.url}`);
    }
  }
  lockRows.push([asset.url, String(asset.bytes), asset.sha256]);
};

if (
  manifest.schemaVersion !== 1 ||
  !Array.isArray(manifest.scenes) ||
  !Array.isArray(manifest.characters) ||
  !Array.isArray(manifest.legacyAliases) ||
  manifest.scenes.length === 0 ||
  manifest.characters.length === 0 ||
  manifest.legacyAliases.length !== 25
) {
  fail("manifesto ausente ou com schema incompatível");
}

const sceneIds = new Set();
for (const scene of manifest.scenes) {
  if (
    !/^[a-z0-9-]+$/.test(scene.experienceId) ||
    !/^[a-z0-9-]+$/.test(scene.universeId) ||
    !/^exec-[a-f0-9-]{36}\.png$/.test(scene.sourceId) ||
    sceneIds.has(scene.experienceId)
  ) {
    fail(`entrada de cena inválida: ${String(scene.experienceId)}`);
  }
  sceneIds.add(scene.experienceId);
  for (const [variant, asset, dimensions] of [
    ["desktop", scene.desktop, { width: 1600, height: 900, maxBytes: 320_000 }],
    ["mobile", scene.mobile, { width: 900, height: 1200, maxBytes: 180_000 }],
  ]) {
    const expectedPrefix =
      `/assets/wolfie/scenes/${scene.universeId}/${scene.experienceId}/`;
    if (!asset.url.startsWith(expectedPrefix)) {
      fail(`diretório incompatível para ${scene.experienceId}/${variant}`);
    }
    const filename = posix.basename(asset.url);
    const match = filename.match(
      new RegExp(`^${variant}\\.([a-f0-9]{12})\\.webp$`),
    );
    if (!match) fail(`nome inválido: ${filename}`);
    if (match[1] !== asset.sha256.slice(0, 12)) {
      fail(`fingerprint divergente: ${asset.url}`);
    }
    primaryAssets.set(asset.url, { asset, expected: dimensions });
    verifyFile(asset, dimensions, `${scene.experienceId}/${variant}`);
  }
}

const characterKeys = new Set();
for (const character of manifest.characters) {
  const key = `${character.characterId}:${character.state}:${character.version}`;
  if (
    !/^[a-z0-9-]+$/.test(character.characterId) ||
    !/^[a-z0-9-]+$/.test(character.state) ||
    !Number.isInteger(character.version) ||
    !/^exec-[a-f0-9-]{36}\.png$/.test(character.sourceId) ||
    characterKeys.has(key) ||
    !character.asset.url.startsWith(
      `/assets/wolfie/characters/${character.characterId}/`,
    )
  ) {
    fail(`entrada de personagem inválida: ${key}`);
  }
  const characterFingerprint = posix.basename(character.asset.url).match(
    /^wolfie-v2-listening\.([a-f0-9]{12})\.webp$/,
  )?.[1];
  if (characterFingerprint !== character.asset.sha256.slice(0, 12)) {
    fail(`fingerprint divergente: ${character.asset.url}`);
  }
  characterKeys.add(key);
  const characterExpected = {
    width: 1024,
    height: 1536,
    maxBytes: 400_000,
  };
  primaryAssets.set(character.asset.url, {
    asset: character.asset,
    expected: characterExpected,
  });
  verifyFile(
    character.asset,
    characterExpected,
    key,
  );
}

const aliasedTargets = new Set();
for (const alias of manifest.legacyAliases) {
  const target = primaryAssets.get(alias.targetUrl);
  validateUrl(alias.url);
  if (!target || aliasedTargets.has(alias.targetUrl)) {
    fail(`alias legado inválido: ${String(alias.url)}`);
  }
  const targetFilename = posix.basename(alias.targetUrl);
  const targetMatch = targetFilename.match(
    /^(.*)\.([a-f0-9]{12})\.webp$/,
  );
  const expectedAliasUrl = targetMatch
    ? `${posix.dirname(alias.targetUrl)}/${targetMatch[1]}.webp`
    : "";
  if (alias.url !== expectedAliasUrl) {
    fail(`alias legado não corresponde ao target: ${alias.url}`);
  }
  aliasedTargets.add(alias.targetUrl);
  verifyFile(
    { ...target.asset, url: alias.url },
    target.expected,
    `alias:${alias.url}`,
    { allowDuplicateHash: true, decode: false },
  );
}

const managedUrls = new Set();
const collectManagedWebps = (directory) => {
  const directoryStatus = lstatSync(directory);
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    fail(`diretório gerenciado inválido: ${directory}`);
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    const entryStatus = lstatSync(entryPath);
    if (entryStatus.isSymbolicLink()) fail(`symlink não permitido: ${entryPath}`);
    if (entryStatus.isDirectory()) {
      collectManagedWebps(entryPath);
    } else if (entryStatus.isFile() && entry.name.endsWith(".webp")) {
      managedUrls.add(`/${relative(assetRoot, entryPath).split(sep).join("/")}`);
    }
  }
};

collectManagedWebps(resolve(wolfieRoot, "scenes"));
collectManagedWebps(resolve(wolfieRoot, "characters"));
const orphanUrls = [...managedUrls].filter((url) => !urls.has(url));
const missingFromDisk = [...urls].filter((url) => !managedUrls.has(url));
if (orphanUrls.length > 0 || missingFromDisk.length > 0) {
  fail(
    `inventário divergente; órfãos=${orphanUrls.join(",") || "nenhum"}; ` +
      `ausentes=${missingFromDisk.join(",") || "nenhum"}`,
  );
}

if (outputFormat === "tsv") {
  for (const row of lockRows.sort(([left], [right]) => left.localeCompare(right))) {
    console.log(row.join("\t"));
  }
} else {
  console.log(`Wolfie visual assets verificados: ${urls.size} arquivos em ${rootName}`);
}
