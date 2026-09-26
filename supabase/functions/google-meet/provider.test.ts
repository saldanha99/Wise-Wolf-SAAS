/// <reference lib="deno.ns" />
import {
  applyRoomArtifacts,
  ARTIFACT_UPDATE_MASK,
  exchangeToken,
  googleErrorInfo,
  GoogleMeetProvider,
  GoogleProviderError,
  importArtifacts,
  type MeetArtifact,
  readArtifact,
  roomCreationErrorCode,
} from "./provider.ts";

function assertEquals(actual: unknown, expected: unknown, message = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message}\n  esperado: ${e}\n  recebido: ${a}`);
  }
}
async function assertRejects(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
  } catch (error) {
    assertEquals((error as Error).message, code);
    return;
  }
  throw new Error(`esperava rejeição ${code}`);
}

// Resposta real do Google em 26/09/2026 para accessType RESTRICTED na conta
// Business Plus sobre Gmail.
const ACCESS_TYPE_UNAVAILABLE = {
  error: {
    code: 403,
    message: "updateAccessType is not available to the user.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "FEATURE_UNAVAILABLE_TO_USER",
        domain: "meet.googleapis.com",
        metadata: { feature_name: "updateAccessType" },
      },
    ],
  },
};
const SPACE = {
  name: "spaces/nLYkAE855egB",
  meetingUri: "https://meet.google.com/fxj-hykv-jev",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function fakeGoogle(responses: Response[]) {
  const sent: { accessType?: string; attendance?: string }[] = [];
  const request = (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    sent.push({
      accessType: body.config?.accessType,
      attendance: body.config?.attendanceReportGenerationType,
    });
    const next = responses.shift();
    if (!next) throw new Error("chamada inesperada");
    return Promise.resolve(next);
  };
  return { sent, request: request as typeof fetch };
}

Deno.test("ErrorInfo do Google vira reason/feature", () => {
  assertEquals(googleErrorInfo(ACCESS_TYPE_UNAVAILABLE), {
    reason: "FEATURE_UNAVAILABLE_TO_USER",
    feature: "updateAccessType",
  });
  assertEquals(googleErrorInfo({ error: { code: 403 } }), {
    reason: "",
    feature: "",
  });
  assertEquals(googleErrorInfo("texto"), { reason: "", feature: "" });
});

Deno.test("conta que aceita RESTRICTED cria a sala restrita, uma chamada só", async () => {
  const google = fakeGoogle([json(SPACE)]);
  const room = await new GoogleMeetProvider("t", google.request).createSpace({
    attendanceReport: true,
  });
  assertEquals(room, {
    space_name: "spaces/nLYkAE855egB",
    meeting_uri: "https://meet.google.com/fxj-hykv-jev",
  });
  assertEquals(google.sent, [{
    accessType: "RESTRICTED",
    attendance: "GENERATE_REPORT",
  }]);
});

Deno.test("Workspace sobre Gmail: RESTRICTED recusado cai para TRUSTED com a mesma configuração", async () => {
  const google = fakeGoogle([json(ACCESS_TYPE_UNAVAILABLE, 403), json(SPACE)]);
  const room = await new GoogleMeetProvider("t", google.request).createSpace({
    attendanceReport: true,
  });
  assertEquals(room.meeting_uri, "https://meet.google.com/fxj-hykv-jev");
  assertEquals(google.sent, [
    { accessType: "RESTRICTED", attendance: "GENERATE_REPORT" },
    { accessType: "TRUSTED", attendance: "GENERATE_REPORT" },
  ]);
});

Deno.test("outro 403 não troca o tipo de acesso por conta própria", async () => {
  const edition = {
    error: {
      code: 403,
      details: [{
        reason: "FEATURE_UNAVAILABLE_TO_USER",
        metadata: { feature_name: "transcription" },
      }],
    },
  };
  const google = fakeGoogle([json(edition, 403)]);
  await assertRejects(
    () => new GoogleMeetProvider("t", google.request).createSpace(),
    "google_permission_or_edition_required",
  );
  assertEquals(google.sent.length, 1);
  const plain = fakeGoogle([json({ error: { code: 403 } }, 403)]);
  await assertRejects(
    () => new GoogleMeetProvider("t", plain.request).createSpace(),
    "google_permission_or_edition_required",
  );
  assertEquals(plain.sent.length, 1);
});

Deno.test("TRUSTED também recusado devolve o erro, sem terceira tentativa", async () => {
  const google = fakeGoogle([
    json(ACCESS_TYPE_UNAVAILABLE, 403),
    json(ACCESS_TYPE_UNAVAILABLE, 403),
  ]);
  await assertRejects(
    () => new GoogleMeetProvider("t", google.request).createSpace(),
    "google_permission_or_edition_required",
  );
  assertEquals(google.sent.length, 2);
});

// ---- Importação por documento (20260926170000) ----------------------------
const CONFERENCE = {
  name: "conferenceRecords/conf1",
  startTime: "2026-09-26T13:00:00Z",
  endTime: "2026-09-26T13:31:00Z",
};
const TRANSCRIPT: MeetArtifact = {
  name: "conferenceRecords/conf1/transcripts/tr1",
  kind: "TRANSCRIPT",
  state: "FILE_GENERATED",
  document: "doc_tr1",
  conference: CONFERENCE,
};
const NOTES: MeetArtifact = {
  name: "conferenceRecords/conf1/smartNotes/sn1",
  kind: "SMART_NOTES",
  state: "FILE_GENERATED",
  document: "doc_sn1",
  conference: CONFERENCE,
};
const AFTER_CLASS = Date.parse("2026-09-26T13:40:00Z");

/** Google falso por rota; guarda as URLs para conferir o que foi pedido. */
function routes(table: Record<string, () => Response>) {
  const urls: string[] = [];
  const request = (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const key = Object.keys(table).find((prefix) => url.includes(prefix));
    if (!key) throw new Error(`chamada inesperada: ${url}`);
    return Promise.resolve(table[key]());
  };
  return { urls, request: request as typeof fetch };
}
const ENTRIES = {
  transcriptEntries: [
    {
      participant: "conferenceRecords/conf1/participants/p2",
      text: "My name is Ana.",
      startTime: "2026-09-26T13:02:10Z",
    },
    {
      participant: "conferenceRecords/conf1/participants/p1",
      text: "What is your name?",
      startTime: "2026-09-26T13:02:00Z",
    },
  ],
};

Deno.test("documento vazio (aula sem fala) é estado final, não falha", async () => {
  const google = routes({
    "/files/doc_tr1/export": () => new Response("  \n ", { status: 200 }),
  });
  const reading = await readArtifact(
    new GoogleMeetProvider("t", google.request),
    TRANSCRIPT,
    AFTER_CLASS,
  );
  assertEquals(reading.status, "EMPTY");
  // Vazio no Docs não tenta o plano B: não há fala para montar.
  assertEquals(google.urls.length, 1);
});

Deno.test("transcrição que o Docs não exporta sai pelas falas da API, com nome e hora", async () => {
  const google = routes({
    "/files/doc_tr1/export": () => new Response("", { status: 403 }),
    "/transcripts/tr1/entries": () => json(ENTRIES),
    "/participants/p1": () =>
      json({ signedinUser: { displayName: "Teacher Bruna" } }),
    "/participants/p2": () => json({ anonymousUser: { displayName: "Ana" } }),
  });
  const reading = await readArtifact(
    new GoogleMeetProvider("t", google.request),
    TRANSCRIPT,
    AFTER_CLASS,
  );
  assertEquals(reading, {
    status: "IMPORTED",
    source: "MEET_ENTRIES",
    sourceText:
      "[10:02:00] Teacher Bruna: What is your name?\n[10:02:10] Ana: My name is Ana.",
    errorCode: "google_document_permission_required",
  });
  // Do participante só o NOME DE EXIBIÇÃO; nada de horário de entrada/saída.
  const participantUrls = google.urls.filter((url) =>
    url.includes("/participants/")
  );
  assertEquals(participantUrls.length, 2);
  for (const url of participantUrls) {
    assertEquals(
      new URL(url).searchParams.get("fields"),
      "signedinUser(displayName),anonymousUser(displayName),phoneUser(displayName)",
    );
  }
  if (
    google.urls.some((url) => /participantSessions|earliestStartTime/.test(url))
  ) {
    throw new Error("pediu telemetria de participante");
  }
  const entries = google.urls.find((url) => url.includes("/entries"))!;
  assertEquals(
    new URL(entries).searchParams.get("fields"),
    "transcriptEntries(participant,text,startTime),nextPageToken",
  );
});

Deno.test("nome que não vem vira 'Participante N' e não derruba a transcrição", async () => {
  const google = routes({
    "/files/doc_tr1/export": () => new Response("", { status: 500 }),
    "/transcripts/tr1/entries": () => json(ENTRIES),
    "/participants/": () => json({ error: { code: 404 } }, 404),
  });
  const reading = await readArtifact(
    new GoogleMeetProvider("t", google.request),
    TRANSCRIPT,
    AFTER_CLASS,
  );
  assertEquals(reading.status, "IMPORTED");
  assertEquals(
    reading.sourceText,
    "[10:02:00] Participante 1: What is your name?\n[10:02:10] Participante 2: My name is Ana.",
  );
});

Deno.test("plano B sem fala também é vazio; plano B que falha devolve o erro do documento", async () => {
  const empty = routes({
    "/files/doc_tr1/export": () => new Response("", { status: 403 }),
    "/transcripts/tr1/entries": () => json({}),
  });
  const reading = await readArtifact(
    new GoogleMeetProvider("t", empty.request),
    TRANSCRIPT,
    AFTER_CLASS,
  );
  assertEquals(reading.status, "EMPTY");
  const broken = routes({
    "/files/doc_tr1/export": () => new Response("", { status: 403 }),
    "/transcripts/tr1/entries": () => json({}, 503),
  });
  await assertRejects(
    () =>
      readArtifact(
        new GoogleMeetProvider("t", broken.request),
        TRANSCRIPT,
        AFTER_CLASS,
      ),
    "google_document_permission_required",
  );
});

Deno.test("anotação que falha no export é falha daquele documento (sem plano B)", async () => {
  const google = routes({
    "/files/doc_sn1/export": () => new Response("", { status: 403 }),
  });
  await assertRejects(
    () =>
      readArtifact(
        new GoogleMeetProvider("t", google.request),
        NOTES,
        AFTER_CLASS,
      ),
    "google_document_permission_required",
  );
  assertEquals(google.urls.length, 1);
});

Deno.test("documento ainda sendo gerado espera; transcrição parada em ENDED há 1 h+ sai pelas falas", async () => {
  const idle = routes({});
  const pending = await readArtifact(
    new GoogleMeetProvider("t", idle.request),
    { ...NOTES, state: "STARTED", document: null },
    AFTER_CLASS,
  );
  assertEquals(pending.status, "PENDING");
  const recent = await readArtifact(
    new GoogleMeetProvider("t", idle.request),
    { ...TRANSCRIPT, state: "ENDED", document: null },
    AFTER_CLASS,
  );
  assertEquals(recent.status, "PENDING");
  assertEquals(idle.urls.length, 0);
  const google = routes({
    "/transcripts/tr1/entries": () => json(ENTRIES),
    "/participants/": () => json({ phoneUser: { displayName: "Aluno" } }),
  });
  const stuck = await readArtifact(
    new GoogleMeetProvider("t", google.request),
    { ...TRANSCRIPT, state: "ENDED", document: null },
    Date.parse("2026-09-26T15:00:00Z"),
  );
  assertEquals(stuck.status, "IMPORTED");
  assertEquals(stuck.errorCode, "google_document_not_generated");
});

// ---- Token: só revogado desconecta ------------------------------------------
Deno.test("token revogado pede reconectar; instabilidade do Google não desconecta", async () => {
  const answer = (status: number, body: unknown) => () =>
    Promise.resolve(json(body, status));
  const cases: [() => Promise<Response>, string][] = [
    [answer(400, { error: "invalid_grant" }), "google_reconnect_required"],
    [
      answer(401, { error: "unauthorized_client" }),
      "google_reconnect_required",
    ],
    [answer(500, { error: "internal_failure" }), "google_oauth_unavailable"],
    [answer(503, {}), "google_oauth_unavailable"],
    [answer(429, { error: "rate_limit_exceeded" }), "google_oauth_unavailable"],
    [answer(401, { error: "invalid_client" }), "google_oauth_rejected"],
    [answer(400, { error: "invalid_request" }), "google_oauth_rejected"],
    [
      () => Promise.resolve(new Response("<html>", { status: 400 })),
      "google_oauth_rejected",
    ],
    [
      () => Promise.reject(new TypeError("rede caiu")),
      "google_oauth_unavailable",
    ],
  ];
  for (const [respond, code] of cases) {
    await assertRejects(
      () =>
        exchangeToken(
          { grant_type: "refresh_token" },
          (() => respond()) as unknown as typeof fetch,
        ),
      code,
    );
  }
});

Deno.test("falha ao criar sala: recusa guarda o motivo, incerteza vira código próprio", () => {
  assertEquals(
    roomCreationErrorCode(
      new GoogleProviderError("google_permission_or_edition_required", 403),
    ),
    "google_permission_or_edition_required",
  );
  assertEquals(
    roomCreationErrorCode(
      new GoogleProviderError("google_request_uncertain", 503),
    ),
    "google_room_creation_uncertain",
  );
  assertEquals(
    roomCreationErrorCode(
      new GoogleProviderError("google_provider_error", 500),
    ),
    "google_room_creation_uncertain",
  );
  assertEquals(
    roomCreationErrorCode(new Error("x")),
    "google_room_creation_failed",
  );
});

Deno.test("um documento que falha não derruba os outros; vazio e importado não são relidos", async () => {
  const second: MeetArtifact = {
    ...TRANSCRIPT,
    name: "conferenceRecords/conf2/transcripts/tr2",
    document: "doc_tr2",
  };
  const google = routes({
    "/files/doc_sn1/export": () => new Response("", { status: 403 }),
    "/files/doc_tr1/export": () => new Response(" ", { status: 200 }),
    "/files/doc_tr2/export": () => new Response("Hello, teacher."),
  });
  const saved: string[] = [], failed: string[] = [];
  const run = await importArtifacts(
    new GoogleMeetProvider("t", google.request),
    [NOTES, TRANSCRIPT, second],
    {
      known: new Map(),
      deadline: Number.MAX_SAFE_INTEGER,
      persist: (item, reading) => {
        saved.push(`${item.name}:${reading.status}`);
        return Promise.resolve();
      },
      recordFailure: (item, code) => {
        failed.push(`${item.name}:${code}`);
        // Nem o banco fora na hora de registrar a falha para o laço.
        return Promise.reject(new Error("google_meet_storage_unavailable"));
      },
    },
  );
  assertEquals(run.statuses, ["FAILED", "EMPTY", "IMPORTED"]);
  assertEquals(failed, [
    "conferenceRecords/conf1/smartNotes/sn1:google_document_permission_required",
  ]);
  assertEquals(saved, [
    "conferenceRecords/conf1/transcripts/tr1:EMPTY",
    "conferenceRecords/conf2/transcripts/tr2:IMPORTED",
  ]);
  // Rodada seguinte: vazio é final e importado não é relido; só a anotação tenta de novo.
  const again = routes({
    "/files/doc_sn1/export": () => new Response("Notas da aula."),
  });
  const next = await importArtifacts(
    new GoogleMeetProvider("t", again.request),
    [NOTES, TRANSCRIPT, second],
    {
      known: new Map([
        [TRANSCRIPT.name, { status: "EMPTY" }],
        [second.name, { status: "IMPORTED" }],
        [NOTES.name, { status: "FAILED" }],
      ]),
      deadline: Number.MAX_SAFE_INTEGER,
      persist: () => Promise.resolve(),
      recordFailure: () => Promise.resolve(),
    },
  );
  assertEquals(next.statuses, ["IMPORTED", "EMPTY", "IMPORTED"]);
  assertEquals(again.urls.length, 1);
  // Importação manual relê o importado (edição do documento), nunca o vazio.
  const manual = routes({
    "/files/doc_tr2/export": () => new Response("Hello again."),
  });
  await importArtifacts(
    new GoogleMeetProvider("t", manual.request),
    [TRANSCRIPT, second],
    {
      known: new Map([
        [TRANSCRIPT.name, { status: "EMPTY" }],
        [second.name, { status: "IMPORTED" }],
      ]),
      force: true,
      deadline: Number.MAX_SAFE_INTEGER,
      persist: () => Promise.resolve(),
      recordFailure: () => Promise.resolve(),
    },
  );
  assertEquals(manual.urls.length, 1);
});

Deno.test("passado o prazo da rodada, o resto fica para a próxima (sem chamar o Google)", async () => {
  const google = routes({});
  const run = await importArtifacts(
    new GoogleMeetProvider("t", google.request),
    [NOTES, TRANSCRIPT],
    {
      known: new Map(),
      deadline: 1_000,
      now: () => 2_000,
      persist: () => Promise.resolve(),
      recordFailure: () => Promise.resolve(),
    },
  );
  assertEquals(run, { statuses: ["PENDING", "PENDING"], deferred: true });
  assertEquals(google.urls.length, 0);
});

// ===== Revogação desliga a documentação da sala já criada (spaces.patch) =====

function fakePatch(responses: Response[]) {
  const calls: { method: string; url: URL; body: Record<string, unknown> }[] =
    [];
  const request = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: String(init?.method || "GET"),
      url: new URL(String(url)),
      body: JSON.parse(String(init?.body || "{}")),
    });
    const next = responses.shift();
    if (!next) throw new Error("chamada inesperada");
    return Promise.resolve(next);
  };
  return { calls, request: request as typeof fetch };
}
const spaceWith = (value: string) => ({
  name: "spaces/nLYkAE855egB",
  config: {
    artifactConfig: {
      transcriptionConfig: { autoTranscriptionGeneration: value },
      smartNotesConfig: { autoSmartNotesGeneration: value },
      recordingConfig: { autoRecordingGeneration: "OFF" },
    },
  },
});

Deno.test("desligar: PATCH na sala com updateMask só dos dois campos e valor OFF", async () => {
  assertEquals(
    ARTIFACT_UPDATE_MASK,
    "config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration,config.artifactConfig.smartNotesConfig.autoSmartNotesGeneration",
  );
  const google = fakePatch([json(spaceWith("OFF"))]);
  const outcome = await applyRoomArtifacts(
    new GoogleMeetProvider("t", google.request),
    "spaces/nLYkAE855egB",
    false,
  );
  assertEquals(outcome, { result: "DISABLED", errorCode: null });
  assertEquals(google.calls.length, 1);
  const call = google.calls[0];
  assertEquals(call.method, "PATCH");
  assertEquals(
    call.url.origin + call.url.pathname,
    "https://meet.googleapis.com/v2/spaces/nLYkAE855egB",
  );
  assertEquals(call.url.searchParams.get("updateMask"), ARTIFACT_UPDATE_MASK);
  assertEquals(call.body, {
    config: {
      artifactConfig: {
        transcriptionConfig: { autoTranscriptionGeneration: "OFF" },
        smartNotesConfig: { autoSmartNotesGeneration: "OFF" },
      },
    },
  });
});

Deno.test("religar: mesmo PATCH com ON", async () => {
  const google = fakePatch([json(spaceWith("ON"))]);
  const outcome = await applyRoomArtifacts(
    new GoogleMeetProvider("t", google.request),
    "spaces/nLYkAE855egB",
    true,
  );
  assertEquals(outcome, { result: "ENABLED", errorCode: null });
  assertEquals(google.calls[0].body, {
    config: {
      artifactConfig: {
        transcriptionConfig: { autoTranscriptionGeneration: "ON" },
        smartNotesConfig: { autoSmartNotesGeneration: "ON" },
      },
    },
  });
});

Deno.test("Google devolve a sala ainda ligada: não conta como desligada", async () => {
  const google = fakePatch([json(spaceWith("ON"))]);
  assertEquals(
    await applyRoomArtifacts(
      new GoogleMeetProvider("t", google.request),
      "spaces/nLYkAE855egB",
      false,
    ),
    { result: "FAILED", errorCode: "google_room_update_unconfirmed" },
  );
});

Deno.test("sala que não existe mais no Google já está desligada; religar nela é falha", async () => {
  const gone = () => json({ error: { code: 404 } }, 404);
  assertEquals(
    await applyRoomArtifacts(
      new GoogleMeetProvider("t", fakePatch([gone()]).request),
      "spaces/nLYkAE855egB",
      false,
    ),
    { result: "DISABLED", errorCode: "google_resource_unavailable" },
  );
  assertEquals(
    await applyRoomArtifacts(
      new GoogleMeetProvider("t", fakePatch([gone()]).request),
      "spaces/nLYkAE855egB",
      true,
    ),
    { result: "FAILED", errorCode: "google_resource_unavailable" },
  );
});

Deno.test("recusa ou rede fora: falha registrada (a fila tenta de novo), sem exceção", async () => {
  assertEquals(
    await applyRoomArtifacts(
      new GoogleMeetProvider(
        "t",
        fakePatch([json({ error: { code: 403 } }, 403)]).request,
      ),
      "spaces/nLYkAE855egB",
      false,
    ),
    { result: "FAILED", errorCode: "google_permission_or_edition_required" },
  );
  const offline = (() => Promise.reject(new TypeError("rede"))) as typeof fetch;
  assertEquals(
    await applyRoomArtifacts(
      new GoogleMeetProvider("t", offline),
      "spaces/nLYkAE855egB",
      false,
    ),
    { result: "FAILED", errorCode: "google_request_uncertain" },
  );
  // Nome de sala fora do formato nem chega ao Google.
  assertEquals(
    await applyRoomArtifacts(
      new GoogleMeetProvider("t", fakePatch([]).request),
      "spaces/../x",
      false,
    ),
    { result: "FAILED", errorCode: "google_resource_invalid" },
  );
});

// ===== Coanfitrião = só a conta confirmada do professor =======================

const MEMBERS_PATH = "/v2/spaces/nLYkAE855egB/members";
const member = (id: string, email: string, role: string) => ({
  name: `spaces/nLYkAE855egB/members/${id}`,
  email,
  role,
});
const callsOf = (
  calls: { method: string; url: URL }[],
) => calls.map((call) => `${call.method} ${call.url.pathname}`);

Deno.test("sala nova: a conta confirmada entra como coanfitriã, ninguém sai", async () => {
  const google = fakePatch([
    json({ members: [] }),
    json(member("m1", "prof.b@gmail.com", "COHOST")),
  ]);
  await new GoogleMeetProvider("t", google.request).ensureCohost(
    "spaces/nLYkAE855egB",
    "Prof.B@gmail.com",
  );
  assertEquals(callsOf(google.calls), [
    `GET ${MEMBERS_PATH}`,
    `POST ${MEMBERS_PATH}`,
  ]);
  assertEquals(google.calls[1].body, {
    email: "prof.b@gmail.com",
    role: "COHOST",
  });
});

Deno.test("professor trocou de conta: a nova entra PRIMEIRO e a antiga sai da sala", async () => {
  const google = fakePatch([
    json({ members: [member("old", "prof.a@gmail.com", "COHOST")] }),
    json(member("new", "prof.b@gmail.com", "COHOST")),
    json({}),
  ]);
  await new GoogleMeetProvider("t", google.request).ensureCohost(
    "spaces/nLYkAE855egB",
    "prof.b@gmail.com",
  );
  assertEquals(callsOf(google.calls), [
    `GET ${MEMBERS_PATH}`,
    `POST ${MEMBERS_PATH}`,
    `DELETE ${MEMBERS_PATH}/old`,
  ]);
});

Deno.test("conta nova já coanfitriã: só a antiga sai; membro comum fica; 404 é já removido", async () => {
  const google = fakePatch([
    json({
      members: [
        member("old", "prof.a@gmail.com", "COHOST"),
        member("new", "prof.b@gmail.com", "COHOST"),
        member("guest", "convidado@gmail.com", "MEMBER"),
      ],
    }),
    new Response(null, { status: 404 }),
  ]);
  await new GoogleMeetProvider("t", google.request).ensureCohost(
    "spaces/nLYkAE855egB",
    "prof.b@gmail.com",
  );
  assertEquals(callsOf(google.calls), [
    `GET ${MEMBERS_PATH}`,
    `DELETE ${MEMBERS_PATH}/old`,
  ]);
});

Deno.test("conta nova era membro comum: é promovida, e a antiga sai", async () => {
  const google = fakePatch([
    json({
      members: [
        member("old", "prof.a@gmail.com", "COHOST"),
        member("new", "prof.b@gmail.com", "MEMBER"),
      ],
    }),
    json(member("new", "prof.b@gmail.com", "COHOST")),
    json({}),
  ]);
  await new GoogleMeetProvider("t", google.request).ensureCohost(
    "spaces/nLYkAE855egB",
    "prof.b@gmail.com",
  );
  assertEquals(callsOf(google.calls), [
    `GET ${MEMBERS_PATH}`,
    `PATCH ${MEMBERS_PATH}/new`,
    `DELETE ${MEMBERS_PATH}/old`,
  ]);
  assertEquals(google.calls[1].url.searchParams.get("updateMask"), "role");
  assertEquals(google.calls[1].body, { role: "COHOST" });
});

Deno.test("falha ao tirar a conta antiga é erro (a fila tenta de novo), com a nova já dentro", async () => {
  const google = fakePatch([
    json({ members: [member("old", "prof.a@gmail.com", "COHOST")] }),
    json(member("new", "prof.b@gmail.com", "COHOST")),
    json({ error: { code: 500 } }, 500),
  ]);
  await assertRejects(
    () =>
      new GoogleMeetProvider("t", google.request).ensureCohost(
        "spaces/nLYkAE855egB",
        "prof.b@gmail.com",
      ),
    "google_provider_error",
  );
  assertEquals(callsOf(google.calls), [
    `GET ${MEMBERS_PATH}`,
    `POST ${MEMBERS_PATH}`,
    `DELETE ${MEMBERS_PATH}/old`,
  ]);
});
