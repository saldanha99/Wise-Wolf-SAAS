// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publisher = readFileSync(path.join(root, 'deploy/vps/release.sh'), 'utf8');
const functionsRoot = path.join(root, 'supabase/functions');
const sharedRoot = path.join(functionsRoot, '_shared');

function stringVariables(script: string): Map<string, string> {
  return new Map([...script.matchAll(/^([A-Z_]+)="([^"\n]+)"$/gm)]
    .map(match => [match[1], match[2]]));
}

function publishedEntrypoints(script: string): string[] {
  const directories = new Set([...stringVariables(script).values()]
    .filter(value => /^supabase\/functions\/[^/]+$/.test(value)));
  const hardened = script.match(/^HARDENED_FUNCTIONS=\(([\s\S]*?)^\)/m);
  if (!hardened) throw new Error('Cannot find HARDENED_FUNCTIONS publisher contract');
  for (const name of hardened[1].split(/\s+/).filter(Boolean)) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Unsupported function entry: ${name}`);
    directories.add(`supabase/functions/${name}`);
  }
  return [...directories].map(directory => path.join(root, directory, 'index.ts'));
}

/** Parse imports without evaluating modules, contacting APIs or starting workers. */
function moduleSpecifiers(filename: string): string[] {
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}

function importedSharedClosure(entrypoints: string[]): Map<string, string> {
  const visited = new Set<string>();
  const importedBy = new Map<string, string>();
  const pending = [...entrypoints];
  while (pending.length) {
    const filename = pending.pop()!;
    if (visited.has(filename)) continue;
    visited.add(filename);
    if (!existsSync(filename)) throw new Error(`Missing runtime import: ${path.relative(root, filename)}`);
    for (const specifier of moduleSpecifiers(filename)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(filename), specifier);
      if (!resolved.endsWith('.ts') && !resolved.endsWith('.tsx')) continue;
      if (resolved.startsWith(`${sharedRoot}${path.sep}`)) {
        importedBy.set(path.relative(sharedRoot, resolved), path.relative(root, filename));
      }
      pending.push(resolved);
    }
  }
  return importedBy;
}

function packagingFailures(script: string, imports: Map<string, string>): string[] {
  const variables = stringVariables(script);
  const flat = script.replace(/\\\n/g, ' ');
  const manifestLoop = flat.match(/for shared_relative in ([\s\S]*?); do\s+append_release_input_checksum/);
  if (!manifestLoop) throw new Error('Cannot find shared checksum manifest loop');
  const checksummed = new Set([...manifestLoop[1].matchAll(/"\$(SHARED_[A-Z_]+)"/g)]
    .map(match => variables.get(match[1])));
  const uploaded = new Set<string>();
  for (const match of flat.matchAll(/rsync -a -- "\$(SHARED_[A-Z_]+)"\s+"\$DEPLOY_SSH_HOST:\$remote_release\/functions\/_shared\/([^"\n]+)"/g)) {
    if (variables.get(match[1]) === `supabase/functions/_shared/${match[2]}`) uploaded.add(match[2]);
  }
  const activated = new Set<string>();
  for (const match of flat.matchAll(/for shared_name in ([^;]+); do([\s\S]*?)\bdone\b/g)) {
    // The explicit list only counts if its body really copies into the active tree.
    if (!/cp -a -- "\$release_dir\/functions\/_shared\/\$shared_name"\s+"\$functions_dir\/_shared\/\$shared_name"/.test(match[2])) continue;
    for (const filename of match[1].trim().split(/\s+/)) activated.add(filename);
  }
  for (const match of flat.matchAll(/cp -a -- "\$release_dir\/functions\/_shared\/([^"\n]+)"\s+"\$functions_dir\/_shared\/([^"\n]+)"/g)) {
    if (match[1] === match[2] && !match[1].includes('$')) activated.add(match[1]);
  }
  const failures: string[] = [];
  for (const [filename, consumer] of imports) {
    const missing = [
      !checksummed.has(`supabase/functions/_shared/${filename}`) && 'checksum manifest',
      !uploaded.has(filename) && 'artifact upload',
      !activated.has(filename) && 'active runtime copy',
    ].filter(Boolean);
    if (missing.length) failures.push(`${filename} imported by ${consumer}: missing ${missing.join(', ')}`);
  }
  return failures.sort();
}

const sharedImports = importedSharedClosure(publishedEntrypoints(publisher));

describe('VPS publisher — complete shared runtime import closure', () => {
  it('packages, checksums and activates every transitive shared import', () => {
    expect(sharedImports.size).toBeGreaterThan(20);
    expect(sharedImports.has('lesson-quality-reply.ts')).toBe(true);
    expect(packagingFailures(publisher, sharedImports)).toEqual([]);
  });

  it('rejects a helper omitted from the manifest even if Deno checks and imports it', () => {
    const broken = publisher.replace(/(for shared_relative in[\s\S]*?); do/, block =>
      block.replace(/^.*\$SHARED_WHATSAPP_INBOX_RELATIVE.*\n/m, ''));
    expect(broken).not.toBe(publisher);
    expect(packagingFailures(broken, sharedImports)).toContainEqual(expect.stringMatching(/^whatsapp-inbox\.ts .*missing checksum manifest/));
  });

  it('rejects a helper omitted from artifact upload but present in the manifest', () => {
    const broken = publisher.replace(/rsync -a -- "\$SHARED_WHATSAPP_INBOX_RELATIVE" \\\n\s+"[^"\n]+"/, '');
    expect(broken).not.toBe(publisher);
    expect(packagingFailures(broken, sharedImports)).toContainEqual(expect.stringMatching(/^whatsapp-inbox\.ts .*missing artifact upload/));
  });

  it('rejects a packaged helper omitted from the active runtime copy list', () => {
    const broken = publisher.replace(/for shared_name in [^;]+; do/g, block => block.replace(' whatsapp-inbox.ts', ''));
    expect(broken).not.toBe(publisher);
    expect(packagingFailures(broken, sharedImports)).toContainEqual(expect.stringMatching(/^whatsapp-inbox\.ts .*missing active runtime copy/));
  });
});
