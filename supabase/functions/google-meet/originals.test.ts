/// <reference lib="deno.ns" />
// Originais no Drive → lixeira (PURGE_ORIGINALS, migration 20260927120000).
// Tudo com fetch falso: nenhuma chamada ao Google sai daqui.
import { DRIVE_READONLY_SCOPE, DRIVE_WRITE_SCOPE } from "./core.ts";
import {
  discoveryComplete,
  originalFilesFromArtifacts,
  type OriginalsBackendAction,
  readOriginalFiles,
  runOriginalsPurge,
} from "./originals.ts";
import { GoogleMeetProvider, type MeetConference } from "./provider.ts";

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
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type Call = { method: string; url: URL; body: Record<string, unknown> };
/** Google falso: responde por rota (método + caminho) e registra cada chamada. */
function fakeGoogle(
  route: (call: Call) => Response | undefined,
): { calls: Call[]; request: typeof fetch } {
  const calls: Call[] = [];
  const request = (url: string | URL | Request, init?: RequestInit) => {
    const call = {
      method: String(init?.method || "GET"),
      url: new URL(String(url)),
      body: JSON.parse(String(init?.body || "{}")),
    };
    calls.push(call);
    const response = route(call);
    if (!response) {
      throw new Error(`chamada inesperada: ${call.method} ${call.url}`);
    }
    return Promise.resolve(response);
  };
  return { calls, request: request as typeof fetch };
}

const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const DRIVE_FILE = `/drive/v3/files/${DOC_ID}`;
const docMeta = (overrides: Record<string, unknown> = {}) => ({
  id: DOC_ID,
  mimeType: "application/vnd.google-apps.document",
  trashed: false,
  ownedByMe: true,
  ...overrides,
});
/** Sequência fixa de respostas (a ordem das chamadas é a do teste). */
const sequence = (responses: Response[]) => fakeGoogle(() => responses.shift());
const paths = (calls: Call[]) =>
  calls.map((call) => `${call.method} ${call.url.pathname}`);

// ---------------------------------------------------------------------------
// files.update trashed=true, arquivo a arquivo
// ---------------------------------------------------------------------------
Deno.test("original da conta central vai para a lixeira: confere, depois files.update trashed=true", async () => {
  const google = sequence([
    json(docMeta()),
    json({ id: DOC_ID, trashed: true }),
  ]);
  const result = await new GoogleMeetProvider("t", google.request)
    .trashDriveFile(DOC_ID, "TRANSCRIPT");
  assertEquals(result, { result: "TRASHED", code: null });
  assertEquals(paths(google.calls), [
    `GET ${DRIVE_FILE}`,
    `PATCH ${DRIVE_FILE}`,
  ]);
  // Só metadados na conferência; nada de busca (q=) nem de conteúdo.
  assertEquals(
    google.calls[0].url.searchParams.get("fields"),
    "id,mimeType,trashed,ownedByMe",
  );
  assertEquals(google.calls[0].url.searchParams.get("q"), null);
  // Lixeira (reversível por 30 dias no Drive), nunca DELETE definitivo.
  assertEquals(google.calls[1].body, { trashed: true });
  assertEquals(google.calls.some((call) => call.method === "DELETE"), false);
});

Deno.test("planilha de presença guardada também vai para a lixeira", async () => {
  const google = sequence([
    json(docMeta({ mimeType: "application/vnd.google-apps.spreadsheet" })),
    json({ id: DOC_ID, trashed: true }),
  ]);
  assertEquals(
    await new GoogleMeetProvider("t", google.request).trashDriveFile(
      DOC_ID,
      "ATTENDANCE_REPORT",
    ),
    { result: "TRASHED", code: null },
  );
});

Deno.test("404 = a conta já não tem o arquivo (GONE); já na lixeira também é feito", async () => {
  const missing = sequence([json({ error: { code: 404 } }, 404)]);
  assertEquals(
    await new GoogleMeetProvider("t", missing.request).trashDriveFile(
      DOC_ID,
      "SMART_NOTES",
    ),
    { result: "GONE", code: "google_drive_file_not_found" },
  );
  assertEquals(missing.calls.length, 1);
  const trashed = sequence([json(docMeta({ trashed: true }))]);
  assertEquals(
    await new GoogleMeetProvider("t", trashed.request).trashDriveFile(
      DOC_ID,
      "TRANSCRIPT",
    ),
    { result: "GONE", code: "google_drive_already_trashed" },
  );
  assertEquals(trashed.calls.length, 1);
});

Deno.test("arquivo que não é da conta central, ou de outro tipo, NÃO é movido", async () => {
  const notOwner = sequence([json(docMeta({ ownedByMe: false }))]);
  assertEquals(
    await new GoogleMeetProvider("t", notOwner.request).trashDriveFile(
      DOC_ID,
      "TRANSCRIPT",
    ),
    { result: "REFUSED", code: "google_drive_not_owner" },
  );
  assertEquals(notOwner.calls.length, 1);
  // Esperava planilha de presença; o id aponta para um documento.
  const wrongType = sequence([json(docMeta())]);
  assertEquals(
    await new GoogleMeetProvider("t", wrongType.request).trashDriveFile(
      DOC_ID,
      "ATTENDANCE_REPORT",
    ),
    { result: "REFUSED", code: "google_drive_unexpected_type" },
  );
  assertEquals(wrongType.calls.length, 1);
});

Deno.test("falha ao mover é erro (o banco agenda nova tentativa); 404 no meio é GONE", async () => {
  const denied = sequence([
    json(docMeta()),
    json({ error: { code: 403 } }, 403),
  ]);
  await assertRejects(
    () =>
      new GoogleMeetProvider("t", denied.request).trashDriveFile(
        DOC_ID,
        "TRANSCRIPT",
      ),
    "google_permission_or_edition_required",
  );
  const unconfirmed = sequence([
    json(docMeta()),
    json({ id: DOC_ID, trashed: false }),
  ]);
  await assertRejects(
    () =>
      new GoogleMeetProvider("t", unconfirmed.request).trashDriveFile(
        DOC_ID,
        "TRANSCRIPT",
      ),
    "google_drive_trash_unconfirmed",
  );
  const vanished = sequence([
    json(docMeta()),
    json({ error: { code: 404 } }, 404),
  ]);
  assertEquals(
    await new GoogleMeetProvider("t", vanished.request).trashDriveFile(
      DOC_ID,
      "TRANSCRIPT",
    ),
    { result: "GONE", code: "google_drive_file_not_found" },
  );
});

Deno.test("id que não é id do Drive é recusado antes de qualquer chamada", async () => {
  const google = sequence([]);
  for (const bad of ["../x", "abc?q=name", "a b", ""]) {
    await assertRejects(
      () =>
        new GoogleMeetProvider("t", google.request).trashDriveFile(
          bad,
          "TRANSCRIPT",
        ),
      "google_resource_invalid",
    );
  }
  assertEquals(google.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Regras puras
// ---------------------------------------------------------------------------
const conference: MeetConference = {
  name: "conferenceRecords/conf1",
  startTime: "2026-09-26T13:00:00Z",
  endTime: "2026-09-26T13:30:00Z",
};

Deno.test("só docsDestination vira original; sem repetição e sem planilha", () => {
  assertEquals(
    originalFilesFromArtifacts([
      { kind: "TRANSCRIPT", document: "docT" },
      { kind: "SMART_NOTES", document: "docN" },
      { kind: "TRANSCRIPT", document: "docT" },
      { kind: "SMART_NOTES", document: null },
      { kind: "TRANSCRIPT", document: "não/é/id" },
    ]),
    [
      { file_id: "docT", kind: "TRANSCRIPT" },
      { file_id: "docN", kind: "SMART_NOTES" },
    ],
  );
  assertEquals(
    readOriginalFiles([
      { file_id: "sheet1", kind: "ATTENDANCE_REPORT" },
      { file_id: "a/b", kind: "TRANSCRIPT" },
      { file_id: "docX", kind: "RECORDING" },
      "lixo",
    ]),
    [{ file_id: "sheet1", kind: "ATTENDANCE_REPORT" }],
  );
});

Deno.test("lista fechada: sem conferência aberta e sem documento ainda sendo gerado", () => {
  const ended = Date.parse(conference.endTime);
  const withDoc = { document: "docT", state: "FILE_GENERATED", conference };
  const generating = { document: null, state: "STARTED", conference };
  assertEquals(
    discoveryComplete([withDoc], [conference], ended + 60_000),
    true,
  );
  assertEquals(
    discoveryComplete([withDoc, generating], [conference], ended + 60_000),
    false,
  );
  // Seis horas depois, o arquivo que não veio não vem mais.
  assertEquals(
    discoveryComplete(
      [withDoc, generating],
      [conference],
      ended + 7 * 3_600_000,
    ),
    true,
  );
  assertEquals(
    discoveryComplete([], [{ ...conference, endTime: "" }], ended),
    false,
  );
  // Aula sem conferência nenhuma: nada a registrar, lista fechada.
  assertEquals(discoveryComplete([], [], ended), true);
});

// ---------------------------------------------------------------------------
// O trabalho PURGE_ORIGINALS
// ---------------------------------------------------------------------------
type BackendCall = { action: OriginalsBackendAction; payload: unknown };
function fakeBackend(
  state: Record<string, unknown>,
  registerResult: Record<string, unknown> = { registered: 0, files_due: [] },
) {
  const calls: BackendCall[] = [];
  const backend = (
    action: OriginalsBackendAction,
    payload: Record<string, unknown> = {},
  ) => {
    calls.push({ action, payload });
    if (action === "session_state") return Promise.resolve(state);
    if (action === "register") return Promise.resolve(registerResult);
    return Promise.resolve({ ok: true });
  };
  return { calls, backend };
}
const ROOM = { space_name: "spaces/salaAula1", organizer_sub: "sub-central" };
const WRITE = ["openid", "email", DRIVE_WRITE_SCOPE];
const READ_ONLY = ["openid", "email", DRIVE_READONLY_SCOPE];
const due = [
  { file_id: "docTranscript01", kind: "TRANSCRIPT" },
  { file_id: "sheetPresenca01", kind: "ATTENDANCE_REPORT" },
];
/** Drive falso para os dois originais vencidos: um vai, a planilha falha. */
const driveFor = () =>
  fakeGoogle((call) => {
    const id = call.url.pathname.split("/").pop();
    if (
      call.url.pathname.startsWith("/drive/v3/files/") &&
      !call.url.search.includes("q=")
    ) {
      if (id === "docTranscript01") {
        return call.method === "GET"
          ? json(docMeta({ id }))
          : json({ id, trashed: true });
      }
      if (id === "sheetPresenca01") {
        return json({ error: { code: 500 } }, 500);
      }
    }
    return undefined;
  });

Deno.test("nada vencido e nada a conferir: não pede token nem chama o Google", async () => {
  const db = fakeBackend({
    room: ROOM,
    discovery_needed: false,
    files_due: [],
  });
  let asked = false;
  const outcome = await runOriginalsPurge(
    { deleteEnabled: true, deadline: Date.now() + 60_000 },
    {
      backend: db.backend,
      access: () => {
        asked = true;
        throw new Error("não devia pedir token");
      },
    },
  );
  assertEquals(outcome.status, "NOTHING");
  assertEquals(asked, false);
  assertEquals(db.calls.map((call) => call.action), ["session_state"]);
});

Deno.test("vencidos vão para a lixeira um a um; falha fica registrada para nova tentativa", async () => {
  const db = fakeBackend({
    room: ROOM,
    session: { class_date: "2026-06-20" },
    discovery_needed: false,
    files_due: due,
  });
  const google = driveFor();
  const outcome = await runOriginalsPurge(
    { deleteEnabled: true, deadline: Date.now() + 60_000 },
    {
      backend: db.backend,
      access: () =>
        Promise.resolve({
          provider: new GoogleMeetProvider("t", google.request),
          organizerSub: "sub-central",
          grantedScopes: WRITE,
        }),
    },
  );
  assertEquals(
    {
      status: outcome.status,
      trashed: outcome.trashed,
      failed: outcome.failed,
    },
    { status: "DONE", trashed: 1, failed: 1 },
  );
  assertEquals(
    db.calls.filter((call) => call.action === "file_result").map((call) =>
      call.payload
    ),
    [
      { file_id: "docTranscript01", result: "TRASHED", error_code: null },
      {
        file_id: "sheetPresenca01",
        result: "FAILED",
        error_code: "google_provider_error",
      },
    ],
  );
  // Nunca uma busca por nome no Drive.
  assertEquals(
    google.calls.some((call) => call.url.searchParams.has("q")),
    false,
  );
});

Deno.test("lixeira desligada ou conta sem o escopo drive: espera sem gastar tentativa e sem tocar no Drive", async () => {
  for (
    const [deleteEnabled, scopes, code] of [
      [false, WRITE, "google_drive_delete_disabled"],
      [true, READ_ONLY, "google_drive_scope_missing"],
    ] as const
  ) {
    const db = fakeBackend({
      room: ROOM,
      discovery_needed: false,
      files_due: due,
    });
    const google = fakeGoogle(() => undefined);
    const outcome = await runOriginalsPurge(
      { deleteEnabled, deadline: Date.now() + 60_000 },
      {
        backend: db.backend,
        access: () =>
          Promise.resolve({
            provider: new GoogleMeetProvider("t", google.request),
            organizerSub: "sub-central",
            grantedScopes: scopes,
          }),
      },
    );
    assertEquals(outcome.status, "DEFERRED");
    assertEquals(google.calls.length, 0);
    assertEquals(db.calls.at(-1), {
      action: "defer",
      payload: { error_code: code, minutes: 360 },
    });
  }
});

Deno.test("conta central trocada: nada é lido nem movido, e a aula espera", async () => {
  const db = fakeBackend({
    room: ROOM,
    session: { class_date: "2026-09-26" },
    discovery_needed: true,
    files_due: due,
  });
  const google = fakeGoogle(() => undefined);
  const outcome = await runOriginalsPurge(
    { deleteEnabled: true, deadline: Date.now() + 60_000 },
    {
      backend: db.backend,
      access: () =>
        Promise.resolve({
          provider: new GoogleMeetProvider("t", google.request),
          organizerSub: "outra-conta",
          grantedScopes: WRITE,
        }),
    },
  );
  assertEquals(outcome.status, "FAILED");
  assertEquals(outcome.error, "google_organizer_changed");
  assertEquals(google.calls.length, 0);
  assertEquals(db.calls.map((call) => call.action), [
    "session_state",
    "discovery_failed",
    "defer",
  ]);
});

Deno.test("conferência: lista a sala no dia da aula, registra só docsDestination e move o que venceu", async () => {
  const db = fakeBackend(
    {
      room: ROOM,
      session: { class_date: "2026-09-26" },
      discovery_needed: true,
      files_due: [],
    },
    // Pedido de exclusão: o documento achado vence na hora.
    {
      registered: 2,
      files_due: [{ file_id: "docTranscript01", kind: "TRANSCRIPT" }],
    },
  );
  const google = fakeGoogle((call) => {
    const path = call.url.pathname;
    if (path === "/v2/conferenceRecords") {
      return json({ conferenceRecords: [conference] });
    }
    if (path === "/v2/conferenceRecords/conf1/transcripts") {
      return json({
        transcripts: [{
          name: "conferenceRecords/conf1/transcripts/t1",
          state: "FILE_GENERATED",
          docsDestination: { document: "docTranscript01" },
        }],
      });
    }
    if (path === "/v2/conferenceRecords/conf1/smartNotes") {
      return json({
        smartNotes: [{
          name: "conferenceRecords/conf1/smartNotes/n1",
          state: "FILE_GENERATED",
          docsDestination: { document: "docNotes01" },
        }],
      });
    }
    if (path === "/drive/v3/files/docTranscript01") {
      return call.method === "GET"
        ? json(docMeta({ id: "docTranscript01" }))
        : json({ id: "docTranscript01", trashed: true });
    }
    return undefined;
  });
  const outcome = await runOriginalsPurge(
    { deleteEnabled: true, deadline: Date.now() + 60_000 },
    {
      backend: db.backend,
      access: () =>
        Promise.resolve({
          provider: new GoogleMeetProvider("t", google.request),
          organizerSub: "sub-central",
          grantedScopes: WRITE,
        }),
      now: () => Date.parse("2026-09-26T18:00:00Z"),
    },
  );
  assertEquals(
    {
      status: outcome.status,
      discovered: outcome.discovered,
      registered: outcome.registered,
      trashed: outcome.trashed,
    },
    { status: "DONE", discovered: true, registered: 2, trashed: 1 },
  );
  assertEquals(db.calls.find((call) => call.action === "register")?.payload, {
    organizer_sub: "sub-central",
    files: [
      { file_id: "docTranscript01", kind: "TRANSCRIPT" },
      { file_id: "docNotes01", kind: "SMART_NOTES" },
    ],
    discovered: true,
  });
  // Conferências só da SALA e só no dia da aula (fuso da escola).
  const filter = google.calls[0].url.searchParams.get("filter") || "";
  assertEquals(filter.includes('space.name = "spaces/salaAula1"'), true);
  assertEquals(filter.includes("2026-09-26T03:00:00.000Z"), true);
  // Nenhuma leitura de conteúdo nem busca no Drive.
  assertEquals(
    google.calls.some((call) =>
      call.url.pathname.endsWith("/export") || call.url.searchParams.has("q")
    ),
    false,
  );
});

Deno.test("conferência com documento ainda sendo gerado: registra o que há e tenta de novo depois", async () => {
  const db = fakeBackend({
    room: ROOM,
    session: { class_date: "2026-09-26" },
    discovery_needed: true,
    files_due: [],
  });
  const google = fakeGoogle((call) => {
    const path = call.url.pathname;
    if (path === "/v2/conferenceRecords") {
      return json({ conferenceRecords: [conference] });
    }
    if (path === "/v2/conferenceRecords/conf1/transcripts") {
      return json({
        transcripts: [{
          name: "conferenceRecords/conf1/transcripts/t1",
          state: "ENDED",
        }],
      });
    }
    if (path === "/v2/conferenceRecords/conf1/smartNotes") {
      return json({ smartNotes: [] });
    }
    return undefined;
  });
  const outcome = await runOriginalsPurge(
    { deleteEnabled: true, deadline: Date.now() + 60_000 },
    {
      backend: db.backend,
      access: () =>
        Promise.resolve({
          provider: new GoogleMeetProvider("t", google.request),
          organizerSub: "sub-central",
          grantedScopes: WRITE,
        }),
      now: () => Date.parse("2026-09-26T14:00:00Z"),
    },
  );
  assertEquals(outcome.discovered, false);
  assertEquals(db.calls.map((call) => call.action), [
    "session_state",
    "register",
    "discovery_failed",
  ]);
  assertEquals(db.calls[1].payload, {
    organizer_sub: "sub-central",
    files: [],
    discovered: false,
  });
  assertEquals(db.calls[2].payload, {
    error_code: "google_documents_still_generating",
  });
});

Deno.test("falha ao listar não impede a lixeira do que já estava vencido", async () => {
  const db = fakeBackend({
    room: ROOM,
    session: { class_date: "2026-09-26" },
    discovery_needed: true,
    files_due: [{ file_id: "docTranscript01", kind: "TRANSCRIPT" }],
  });
  const google = fakeGoogle((call) => {
    const path = call.url.pathname;
    if (path === "/v2/conferenceRecords") {
      return json({ error: { code: 403 } }, 403);
    }
    if (path === "/drive/v3/files/docTranscript01") {
      return call.method === "GET"
        ? json(docMeta({ id: "docTranscript01" }))
        : json({ id: "docTranscript01", trashed: true });
    }
    return undefined;
  });
  const outcome = await runOriginalsPurge(
    { deleteEnabled: true, deadline: Date.now() + 60_000 },
    {
      backend: db.backend,
      access: () =>
        Promise.resolve({
          provider: new GoogleMeetProvider("t", google.request),
          organizerSub: "sub-central",
          grantedScopes: WRITE,
        }),
    },
  );
  assertEquals(outcome.trashed, 1);
  assertEquals(
    db.calls.find((call) => call.action === "discovery_failed")
      ?.payload,
    { error_code: "google_permission_or_edition_required" },
  );
});

Deno.test("prazo da rodada vencido: o resto fica para a próxima, sem chamar o Drive", async () => {
  const db = fakeBackend({
    room: ROOM,
    discovery_needed: false,
    files_due: due,
  });
  const google = fakeGoogle(() => undefined);
  const outcome = await runOriginalsPurge(
    { deleteEnabled: true, deadline: 1_000 },
    {
      backend: db.backend,
      access: () =>
        Promise.resolve({
          provider: new GoogleMeetProvider("t", google.request),
          organizerSub: "sub-central",
          grantedScopes: WRITE,
        }),
      now: () => 2_000,
    },
  );
  assertEquals(outcome.deferred, 2);
  assertEquals(google.calls.length, 0);
  assertEquals(
    db.calls.some((call) => call.action === "file_result"),
    false,
  );
});
