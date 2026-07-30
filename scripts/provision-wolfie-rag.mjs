#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

const PURPOSE = "WOLFIE_TUTOR";
const PROVIDER = "OPENROUTER";
const DEFAULT_MODEL = "openai/text-embedding-3-small";
const DEFAULT_CORPUS = new URL(
  "../docs/wolfie-tutor-knowledge-core.md",
  import.meta.url,
);
const SOURCE_REF = "wolfie-tutor-knowledge-core-v1";
const EMBEDDING_DIMENSIONS = 1_536;

function usage() {
  process.stdout.write(`
Provisiona a RAG reutilizável do Wolfie por tenant.

Uso:
  node scripts/provision-wolfie-rag.mjs --validate-only
  node scripts/provision-wolfie-rag.mjs --apply

Variáveis exigidas com --apply:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  OPENROUTER_API_KEY

O modo padrão é dry-run. Nenhum fato individual de aluno é enviado ou gravado.
`.trimStart());
}

function parseArgs(argv) {
  const options = {
    apply: false,
    validateOnly: false,
    corpus: DEFAULT_CORPUS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--validate-only") {
      options.validateOnly = true;
    } else if (argument === "--corpus") {
      const value = argv[index + 1];
      if (!value) throw new Error("--corpus exige um caminho.");
      options.corpus = new URL(value, `file://${process.cwd()}/`);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Argumento desconhecido: ${argument}`);
    }
  }
  if (options.apply && options.validateOnly) {
    throw new Error("--apply e --validate-only são mutuamente exclusivos.");
  }
  return options;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function splitCorpus(markdown) {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (!normalized.startsWith("# Wolfie Tutor")) {
    throw new Error("O corpus não possui o cabeçalho aprovado do Wolfie.");
  }
  const sections = normalized
    .split(/\n(?=## )/g)
    .slice(1)
    .map((section, index) => {
      const [heading, ...bodyParts] = section.split("\n");
      const title = heading.replace(/^##\s+/, "").trim();
      const content = bodyParts.join("\n").trim();
      if (!title || content.length < 180 || content.length > 4_000) {
        throw new Error(`Seção inválida no corpus: ${title || index + 1}`);
      }
      return {
        index,
        title,
        content: `${title}\n\n${content}`,
      };
    });
  if (sections.length < 5 || sections.length > 12) {
    throw new Error("O corpus deve possuir entre 5 e 12 seções aprovadas.");
  }
  const forbidden = [
    /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/,
    /\b(?:api[_-]?key|password|senha|secret|token)\s*[:=]/i,
  ];
  for (const section of sections) {
    if (forbidden.some((pattern) => pattern.test(section.content))) {
      throw new Error(`Possível dado sensível na seção: ${section.title}`);
    }
  }
  return { normalized, sections };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function vectorIsValid(vector) {
  return Array.isArray(vector) &&
    vector.length === EMBEDDING_DIMENSIONS &&
    vector.every((value) => Number.isFinite(value));
}

async function requestJson(url, {
  method = "GET",
  headers = {},
  body,
  expected = [200],
} = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!expected.includes(response.status)) {
    throw new Error(
      `Requisição falhou (${response.status}) em ${new URL(url).pathname}: ${
        text.slice(0, 500)
      }`,
    );
  }
  return text ? JSON.parse(text) : null;
}

function supabaseRequestFactory(baseUrl, serviceRoleKey) {
  const root = `${baseUrl.replace(/\/+$/, "")}/rest/v1`;
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
  return (path, options = {}) =>
    requestJson(`${root}/${path}`, {
      ...options,
      headers: { ...headers, ...options.headers },
    });
}

async function createEmbeddings(apiKey, model, inputs) {
  const payload = await requestJson(
    "https://openrouter.ai/api/v1/embeddings",
    {
      method: "POST",
      expected: [200],
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://system.wisewolflanguage.com.br",
        "X-Title": "Wise Wolf - Wolfie Tutor RAG",
      },
      body: { model, input: inputs },
    },
  );
  const ordered = [...(payload?.data ?? [])].sort(
    (left, right) => left.index - right.index,
  );
  const vectors = ordered.map((item) => item.embedding);
  if (
    vectors.length !== inputs.length ||
    vectors.some((vector) => !vectorIsValid(vector))
  ) {
    throw new Error("O provedor retornou embeddings incompatíveis.");
  }
  return vectors;
}

async function ensureKnowledgeBase(supabase, tenantId, model) {
  const query = new URLSearchParams({
    select: "id,tenant_id,embedding_model,embedding_dimensions",
    tenant_id: `eq.${tenantId}`,
    provider: `eq.${PROVIDER}`,
    purpose: `eq.${PURPOSE}`,
    status: "eq.ACTIVE",
    order: "version.desc",
    limit: "1",
  });
  const existing = await supabase(`ai_knowledge_bases?${query}`);
  if (existing.length) {
    const base = existing[0];
    if (
      base.embedding_model !== model ||
      base.embedding_dimensions !== EMBEDDING_DIMENSIONS
    ) {
      throw new Error(
        `Base Wolfie incompatível no tenant ${tenantId}; crie uma nova versão.`,
      );
    }
    return base;
  }
  const created = await supabase("ai_knowledge_bases", {
    method: "POST",
    expected: [201],
    headers: { Prefer: "return=representation" },
    body: {
      tenant_id: tenantId,
      provider: PROVIDER,
      purpose: PURPOSE,
      embedding_model: model,
      embedding_dimensions: EMBEDDING_DIMENSIONS,
      version: 1,
      status: "ACTIVE",
      retrieval_config: { match_count: 5, min_similarity: 0.45 },
    },
  });
  return created[0];
}

async function ensureDocument({
  supabase,
  tenantId,
  knowledgeBase,
  corpus,
  sections,
  embeddings,
}) {
  const checksum = sha256(corpus);
  const query = new URLSearchParams({
    select: "id,status",
    knowledge_base_id: `eq.${knowledgeBase.id}`,
    source_type: "eq.MANUAL",
    source_ref: `eq.${SOURCE_REF}`,
    checksum_sha256: `eq.${checksum}`,
    limit: "1",
  });
  const existing = await supabase(`ai_knowledge_documents?${query}`);
  if (existing[0]?.status === "READY") {
    return { created: false, documentId: existing[0].id };
  }

  let documentId = existing[0]?.id;
  if (!documentId) {
    const created = await supabase("ai_knowledge_documents", {
      method: "POST",
      expected: [201],
      headers: { Prefer: "return=representation" },
      body: {
        knowledge_base_id: knowledgeBase.id,
        tenant_id: tenantId,
        source_type: "MANUAL",
        source_ref: SOURCE_REF,
        title: "Wolfie Tutor — núcleo pedagógico aprovado",
        checksum_sha256: checksum,
        content: corpus,
        metadata: {
          scope: PURPOSE,
          contains_student_facts: false,
          corpus_version: 1,
        },
        status: "INDEXING",
        approved_at: new Date().toISOString(),
      },
    });
    documentId = created[0].id;
  } else {
    await supabase(
      `ai_knowledge_chunks?document_id=eq.${encodeURIComponent(documentId)}`,
      { method: "DELETE", expected: [204] },
    );
  }

  await supabase("ai_knowledge_chunks", {
    method: "POST",
    expected: [201],
    headers: { Prefer: "return=minimal" },
    body: sections.map((section, index) => ({
      knowledge_base_id: knowledgeBase.id,
      tenant_id: tenantId,
      document_id: documentId,
      chunk_index: section.index,
      content: section.content,
      token_count: Math.ceil(section.content.length / 4),
      metadata: {
        title: section.title,
        scope: PURPOSE,
        corpus_version: 1,
      },
      embedding: embeddings[index],
    })),
  });

  const indexedAt = new Date().toISOString();
  await supabase(
    `ai_knowledge_documents?id=eq.${encodeURIComponent(documentId)}`,
    {
      method: "PATCH",
      expected: [204],
      headers: { Prefer: "return=minimal" },
      body: {
        status: "READY",
        indexed_at: indexedAt,
        error_message: null,
      },
    },
  );
  return { created: true, documentId };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const markdown = await readFile(options.corpus, "utf8");
  const { normalized, sections } = splitCorpus(markdown);
  process.stdout.write(
    `Corpus Wolfie válido: ${sections.length} seções, checksum ${
      sha256(normalized).slice(0, 12)
    }.\n`,
  );
  if (options.validateOnly) return;
  if (!options.apply) {
    process.stdout.write("DRY_RUN: nenhuma chamada externa ou gravação feita.\n");
    return;
  }

  const supabaseUrl = requiredEnvironment("SUPABASE_URL");
  const serviceRoleKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
  const openRouterApiKey = requiredEnvironment("OPENROUTER_API_KEY");
  const embeddingModel = process.env.OPENROUTER_EMBEDDING_MODEL?.trim() ||
    DEFAULT_MODEL;
  const supabase = supabaseRequestFactory(supabaseUrl, serviceRoleKey);
  const tenants = await supabase("tenants?select=id&order=id.asc");
  if (!Array.isArray(tenants) || tenants.length === 0) {
    throw new Error("Nenhum tenant encontrado para provisionamento.");
  }

  const embeddings = await createEmbeddings(
    openRouterApiKey,
    embeddingModel,
    sections.map((section) => section.content),
  );
  let createdDocuments = 0;
  for (const tenant of tenants) {
    const knowledgeBase = await ensureKnowledgeBase(
      supabase,
      tenant.id,
      embeddingModel,
    );
    const result = await ensureDocument({
      supabase,
      tenantId: tenant.id,
      knowledgeBase,
      corpus: normalized,
      sections,
      embeddings,
    });
    if (result.created) createdDocuments += 1;
  }

  const activeBases = await supabase(
    `ai_knowledge_bases?select=id&purpose=eq.${PURPOSE}&status=eq.ACTIVE`,
  );
  const readyDocuments = await supabase(
    `ai_knowledge_documents?select=id&source_ref=eq.${SOURCE_REF}&status=eq.READY`,
  );
  const chunks = await supabase(
    `ai_knowledge_chunks?select=id&metadata->>scope=eq.${PURPOSE}`,
  );
  const expectedChunks = tenants.length * sections.length;
  if (
    activeBases.length < tenants.length ||
    readyDocuments.length < tenants.length ||
    chunks.length < expectedChunks
  ) {
    throw new Error("A verificação final da RAG não cobriu todos os tenants.");
  }
  process.stdout.write(
    `RAG Wolfie pronta: ${activeBases.length} bases ativas, ${
      readyDocuments.length
    } documentos, ${chunks.length} chunks, ${createdDocuments} novos.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`ERRO: ${error.message}\n`);
  process.exitCode = 1;
});
