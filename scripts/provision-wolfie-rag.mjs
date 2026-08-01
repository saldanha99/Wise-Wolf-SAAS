#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

const PURPOSE = "WOLFIE_TUTOR";
const PROVIDER = "OPENROUTER";
const DEFAULT_MODEL = "openai/text-embedding-3-small";
const DEFAULT_CORPORA = [
  {
    url: new URL("../docs/wolfie-tutor-knowledge-core.md", import.meta.url),
    sourceRef: "wolfie-tutor-knowledge-core-v1",
    title: "Wolfie Tutor — núcleo pedagógico aprovado",
    version: 1,
  },
  {
    url: new URL("../docs/wolfie-global-meeting-coach-v1.md", import.meta.url),
    sourceRef: "wolfie-global-meeting-coach-v1",
    title: "Wolfie Tutor — programa aprovado de reuniões globais",
    version: 1,
  },
];
const EMBEDDING_DIMENSIONS = 1_536;

function usage() {
  process.stdout.write(`
Provisiona a RAG reutilizável do Wolfie por tenant.

Uso:
  node scripts/provision-wolfie-rag.mjs --validate-only
  node scripts/provision-wolfie-rag.mjs --apply
  node scripts/provision-wolfie-rag.mjs --validate-only --corpus ./arquivo.md

Variáveis exigidas com --apply:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  OPENROUTER_API_KEY

O modo padrão é dry-run. Nenhum fato individual de aluno é enviado ou gravado.
Corpora customizados nunca podem ser publicados; adicione e revise um corpus
versionado no repositório antes de usar --apply.
`.trimStart());
}

function parseArgs(argv) {
  const options = {
    apply: false,
    validateOnly: false,
    corpora: DEFAULT_CORPORA,
    customCorpus: false,
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
      options.corpora = [{
        url: new URL(value, `file://${process.cwd()}/`),
        sourceRef: "wolfie-tutor-custom-v1",
        title: "Wolfie Tutor — corpus pedagógico aprovado",
        version: 1,
      }];
      options.customCorpus = true;
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
  if (options.customCorpus && !options.validateOnly) {
    throw new Error(
      "Corpus customizado só pode ser validado localmente; a publicação exige um corpus versionado e aprovado no repositório.",
    );
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
  sourceRef,
  title,
  corpusVersion,
}) {
  const checksum = sha256(corpus);
  const sourceFamily = sourceRef.replace(/-v[1-9][0-9]*$/, "");
  const loadFamilyDocuments = async () => {
    const filters = new URLSearchParams({
      select: "id,source_ref,checksum_sha256,status",
      knowledge_base_id: `eq.${knowledgeBase.id}`,
      source_type: "eq.MANUAL",
    });
    const candidates = await supabase(`ai_knowledge_documents?${filters}`);
    return candidates
      .map((document) => {
        const versionMatch = typeof document.source_ref === "string"
          ? document.source_ref.match(/^(.*)-v([1-9][0-9]*)$/)
          : null;
        return {
          ...document,
          sourceFamily: versionMatch?.[1] ?? "",
          sourceVersion: versionMatch ? Number(versionMatch[2]) : 0,
        };
      })
      .filter((document) => document.sourceFamily === sourceFamily);
  };
  const familyBeforeWrite = await loadFamilyDocuments();
  if (
    familyBeforeWrite.some((document) =>
      document.source_ref === sourceRef &&
      document.checksum_sha256 !== checksum
    )
  ) {
    throw new Error(
      `O corpus ${sourceRef} já existe com outro conteúdo; crie a próxima versão em vez de alterar uma versão publicada.`,
    );
  }
  const newerDocument = familyBeforeWrite.find((document) =>
    document.sourceVersion > corpusVersion
  );
  if (newerDocument) {
    throw new Error(
      `Downgrade recusado para ${sourceRef}: ${newerDocument.source_ref} já foi registrado nesta base.`,
    );
  }
  const retireSupersededDocuments = async (currentDocumentId) => {
    const candidates = await loadFamilyDocuments();
    const superseded = candidates.filter((document) =>
      document.id !== currentDocumentId &&
      document.sourceVersion < corpusVersion &&
      document.status !== "REMOVED"
    );
    await Promise.all(superseded.map((document) =>
      supabase(
        `ai_knowledge_documents?id=eq.${encodeURIComponent(document.id)}`,
        {
          method: "PATCH",
          expected: [204],
          headers: { Prefer: "return=minimal" },
          body: { status: "REMOVED" },
        },
      )
    ));
  };
  const verifyCurrentDocument = async (currentDocumentId) => {
    const family = await loadFamilyDocuments();
    if (
      family.some((document) =>
        document.source_ref === sourceRef &&
        document.checksum_sha256 !== checksum
      )
    ) {
      throw new Error(
        `Conflito de conteúdo detectado para a versão imutável ${sourceRef}.`,
      );
    }
    const concurrentNewer = family.find((document) =>
      document.sourceVersion > corpusVersion
    );
    if (concurrentNewer) {
      if (concurrentNewer.status === "READY") {
        await supabase(
          `ai_knowledge_documents?id=eq.${
            encodeURIComponent(currentDocumentId)
          }`,
          {
            method: "PATCH",
            expected: [204],
            headers: { Prefer: "return=minimal" },
            body: { status: "REMOVED" },
          },
        );
      }
      throw new Error(
        `Publicação concorrente mais nova detectada: ${concurrentNewer.source_ref}.`,
      );
    }
    const ready = family.filter((document) => document.status === "READY");
    if (ready.length !== 1 || ready[0].id !== currentDocumentId) {
      throw new Error(
        `A família ${sourceFamily} não possui uma única versão READY atual.`,
      );
    }
    const chunkQuery = new URLSearchParams({
      select: "document_id,chunk_index,metadata",
      document_id: `eq.${currentDocumentId}`,
      order: "chunk_index.asc",
    });
    const persistedChunks = await supabase(
      `ai_knowledge_chunks?${chunkQuery}`,
    );
    if (
      persistedChunks.length !== sections.length ||
      persistedChunks.some((chunk, index) =>
        chunk.document_id !== currentDocumentId ||
        chunk.chunk_index !== index ||
        chunk.metadata?.scope !== PURPOSE ||
        chunk.metadata?.corpus_version !== corpusVersion
      )
    ) {
      throw new Error(
        `Os chunks persistidos de ${sourceRef} não correspondem ao corpus aprovado.`,
      );
    }
    return persistedChunks.length;
  };
  const existing = familyBeforeWrite.filter((document) =>
    document.source_ref === sourceRef &&
    document.checksum_sha256 === checksum
  );
  if (existing[0]?.status === "READY") {
    await retireSupersededDocuments(existing[0].id);
    return {
      created: false,
      documentId: existing[0].id,
      verifiedChunks: await verifyCurrentDocument(existing[0].id),
    };
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
        source_ref: sourceRef,
        title,
        checksum_sha256: checksum,
        content: corpus,
        metadata: {
          scope: PURPOSE,
          contains_student_facts: false,
          corpus_version: corpusVersion,
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
        corpus_version: corpusVersion,
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
  await retireSupersededDocuments(documentId);
  return {
    created: true,
    documentId,
    verifiedChunks: await verifyCurrentDocument(documentId),
  };
}

async function verifyRetrieval(
  supabase,
  tenantId,
  knowledgeBaseId,
  expectedDocumentId,
  queryEmbedding,
) {
  const matches = await supabase("rpc/match_wise_wolf_knowledge", {
    method: "POST",
    expected: [200],
    body: {
      p_tenant_id: tenantId,
      p_knowledge_base_id: knowledgeBaseId,
      p_query_embedding: queryEmbedding,
      p_match_count: 3,
      p_min_similarity: 0.8,
    },
  });
  const bestMatch = Array.isArray(matches)
    ? matches.find((match) => match?.document_id === expectedDocumentId)
    : null;
  if (
    !bestMatch ||
    typeof bestMatch.content !== "string" ||
    bestMatch.content.length < 100 ||
    typeof bestMatch.similarity !== "number" ||
    bestMatch.similarity < 0.8 ||
    bestMatch.metadata?.scope !== PURPOSE
  ) {
    throw new Error(`Busca vetorial do Wolfie falhou no tenant ${tenantId}.`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const corpora = await Promise.all(options.corpora.map(async (definition) => {
    const markdown = await readFile(definition.url, "utf8");
    const parsed = splitCorpus(markdown);
    return { ...definition, ...parsed };
  }));
  for (const corpus of corpora) {
    process.stdout.write(
      `Corpus Wolfie válido (${corpus.sourceRef}): ${corpus.sections.length} seções, checksum ${
        sha256(corpus.normalized).slice(0, 12)
      }.\n`,
    );
  }
  const sourceRefs = corpora.map((corpus) => corpus.sourceRef);
  if (
    new Set(sourceRefs).size !== sourceRefs.length ||
    sourceRefs.some((sourceRef, index) => {
      const versionSuffix = sourceRef.match(/-v([1-9][0-9]*)$/);
      return !/^[a-z0-9][a-z0-9-]{2,79}$/.test(sourceRef) ||
        !versionSuffix ||
        Number(versionSuffix[1]) !== corpora[index].version;
    })
  ) {
    throw new Error(
      "Os source refs dos corpora devem ser únicos e versionados.",
    );
  }
  const totalSections = corpora.reduce(
    (total, corpus) => total + corpus.sections.length,
    0,
  );
  if (
    totalSections < corpora.length * 5 || totalSections > corpora.length * 12
  ) {
    throw new Error(
      "O plano multi-corpus possui uma contagem de seções inválida.",
    );
  }
  process.stdout.write(
    `Plano multi-corpus válido: ${corpora.length} documentos e ${totalSections} chunks por tenant.\n`,
  );
  if (options.validateOnly) return;
  if (!options.apply) {
    process.stdout.write(
      "DRY_RUN: nenhuma chamada externa ou gravação feita.\n",
    );
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

  const embeddingInputs = corpora.flatMap((corpus) =>
    corpus.sections.map((section) => section.content)
  );
  const embeddings = await createEmbeddings(
    openRouterApiKey,
    embeddingModel,
    embeddingInputs,
  );
  let createdDocuments = 0;
  let verifiedDocuments = 0;
  let verifiedChunks = 0;
  let verifiedRetrievals = 0;
  const usedKnowledgeBaseIds = new Set();
  for (const tenant of tenants) {
    const knowledgeBase = await ensureKnowledgeBase(
      supabase,
      tenant.id,
      embeddingModel,
    );
    usedKnowledgeBaseIds.add(knowledgeBase.id);
    let embeddingOffset = 0;
    for (const corpus of corpora) {
      const corpusEmbeddings = embeddings.slice(
        embeddingOffset,
        embeddingOffset + corpus.sections.length,
      );
      embeddingOffset += corpus.sections.length;
      const result = await ensureDocument({
        supabase,
        tenantId: tenant.id,
        knowledgeBase,
        corpus: corpus.normalized,
        sections: corpus.sections,
        embeddings: corpusEmbeddings,
        sourceRef: corpus.sourceRef,
        title: corpus.title,
        corpusVersion: corpus.version,
      });
      if (result.created) createdDocuments += 1;
      verifiedDocuments += 1;
      verifiedChunks += result.verifiedChunks;
      await verifyRetrieval(
        supabase,
        tenant.id,
        knowledgeBase.id,
        result.documentId,
        corpusEmbeddings[0],
      );
      verifiedRetrievals += 1;
    }
  }

  const activeBases = await supabase(
    `ai_knowledge_bases?select=id,tenant_id&provider=eq.${PROVIDER}&purpose=eq.${PURPOSE}&status=eq.ACTIVE`,
  );
  const expectedDocuments = tenants.length * corpora.length;
  const expectedChunks = tenants.length * embeddingInputs.length;
  const expectedRetrievals = tenants.length * corpora.length;
  if (
    usedKnowledgeBaseIds.size !== tenants.length ||
    activeBases.length !== tenants.length ||
    activeBases.some((base) => !usedKnowledgeBaseIds.has(base.id)) ||
    verifiedDocuments !== expectedDocuments ||
    verifiedChunks !== expectedChunks ||
    verifiedRetrievals !== expectedRetrievals
  ) {
    throw new Error("A verificação final da RAG não cobriu todos os tenants.");
  }
  process.stdout.write(
    `RAG Wolfie pronta: ${activeBases.length} bases ativas, ${verifiedDocuments} documentos, ${verifiedChunks} chunks, ${verifiedRetrievals} buscas vetoriais, ${createdDocuments} novos.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`ERRO: ${error.message}\n`);
  process.exitCode = 1;
});
