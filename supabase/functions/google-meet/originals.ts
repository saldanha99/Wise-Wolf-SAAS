// Originais das aulas no Drive da conta central → LIXEIRA (operação
// PURGE_ORIGINALS da fila; migration 20260927120000).
//
// Decisão da direção (26/09/2026): documento da transcrição, documento das
// anotações do Gemini e planilha de presença vão para a lixeira do Drive 90 dias
// depois da aula, e na hora quando a direção apaga os registros de um aluno a
// pedido dele. Lixeira, não exclusão definitiva: o Drive guarda 30 dias.
//
// Regra de ouro: só vai para a lixeira arquivo cujo id veio da Meet API
// (docsDestination) ou da planilha de presença guardada pelo sistema. Nada aqui
// procura arquivo por NOME. A conferência da lista (discovery) lê só a Meet API
// — conferências e documentos da SALA da aula, no dia da aula — para achar os
// documentos que a importação não registrou (aceite revogado, importação que
// venceu, pedido de exclusão).
import {
  hasDriveWriteScope,
  isRecord,
  saoPauloDayWindow,
  text,
} from "./core.ts";
import {
  type GoogleMeetProvider,
  type MeetArtifact,
  type MeetArtifactKind,
  type OriginalKind,
  providerErrorCode,
  type TrashOutcome,
} from "./provider.ts";

export type OriginalsBackendAction =
  | "session_state"
  | "register"
  | "discovery_failed"
  | "defer"
  | "file_result";
/** google_meet_originals_backend já amarrado à escola e à aula. */
export type OriginalsBackend = (
  action: OriginalsBackendAction,
  payload?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export type OriginalFile = { file_id: string; kind: OriginalKind };

// A Meet API pode ainda estar gerando um documento sem docsDestination; depois
// de 6 h da conferência ele não vai mais aparecer (ex.: Drive cheio).
export const DOCUMENT_SETTLE_MS = 6 * 3_600_000;
// Lixeira desligada nesta instalação: os vencidos esperam 6 h sem gastar
// tentativa. Conta central trocada: 24 h (só a conta antiga move os arquivos).
const DEFER_MINUTES = 360;
const ORGANIZER_CHANGED_MINUTES = 1440;

const ORIGINAL_KINDS = new Set<string>([
  "TRANSCRIPT",
  "SMART_NOTES",
  "ATTENDANCE_REPORT",
]);

/** Lista de originais vinda do banco, validada (id do Drive e tipo). */
export function readOriginalFiles(value: unknown): OriginalFile[] {
  if (!Array.isArray(value)) return [];
  const files: OriginalFile[] = [];
  for (const row of value) {
    if (!isRecord(row)) continue;
    const fileId = text(row.file_id, 200), kind = text(row.kind, 40);
    if (!/^[A-Za-z0-9_-]+$/.test(fileId) || !ORIGINAL_KINDS.has(kind)) continue;
    files.push({ file_id: fileId, kind: kind as OriginalKind });
  }
  return files;
}

/**
 * Documentos da aula com id vindo da Meet API (docsDestination), sem repetição.
 * Só transcrição e anotações: a planilha de presença entra pelo registro que o
 * sistema guardou, nunca por busca.
 */
export function originalFilesFromArtifacts(
  artifacts: Pick<MeetArtifact, "kind" | "document">[],
): { file_id: string; kind: MeetArtifactKind }[] {
  const seen = new Set<string>();
  const files: { file_id: string; kind: MeetArtifactKind }[] = [];
  for (const artifact of artifacts) {
    const document = text(artifact.document, 200);
    if (!/^[A-Za-z0-9_-]+$/.test(document) || seen.has(document)) continue;
    seen.add(document);
    files.push({ file_id: document, kind: artifact.kind });
  }
  return files.slice(0, 50);
}

/**
 * A lista está fechada quando nenhuma conferência está aberta e todo documento
 * já tem arquivo (ou o Google o deu por gerado sem arquivo, ou a conferência
 * acabou há mais de 6 h — o arquivo não vem mais).
 */
export function discoveryComplete(
  artifacts: Pick<MeetArtifact, "document" | "state" | "conference">[],
  conferences: { endTime: string }[],
  nowMs: number,
): boolean {
  if (conferences.some((conference) => !conference.endTime)) return false;
  return artifacts.every((artifact) => {
    if (artifact.document || artifact.state === "FILE_GENERATED") return true;
    const ended = Date.parse(artifact.conference.endTime);
    return Number.isFinite(ended) && nowMs - ended > DOCUMENT_SETTLE_MS;
  });
}

type DiscoveryProvider = Pick<
  GoogleMeetProvider,
  "conferences" | "artifactsOf"
>;
/** Conferências da sala no dia da aula e os documentos de cada uma. */
export async function discoverOriginals(
  provider: DiscoveryProvider,
  space: string,
  classDate: string,
  nowMs: number,
): Promise<
  { files: { file_id: string; kind: MeetArtifactKind }[]; complete: boolean }
> {
  const conferences = await provider.conferences(
    space,
    saoPauloDayWindow(classDate),
  );
  const artifacts: MeetArtifact[] = [];
  for (const conference of conferences) {
    for (const kind of ["TRANSCRIPT", "SMART_NOTES"] as MeetArtifactKind[]) {
      artifacts.push(...await provider.artifactsOf(conference, kind));
    }
  }
  return {
    files: originalFilesFromArtifacts(artifacts),
    complete: discoveryComplete(artifacts, conferences, nowMs),
  };
}

export interface OriginalsAccess {
  provider:
    & DiscoveryProvider
    & Pick<GoogleMeetProvider, "trashDriveFile">;
  // Conta central conectada agora (a sala só é mexida por quem a criou).
  organizerSub: string;
  grantedScopes: unknown;
}

export interface OriginalsDeps {
  backend: OriginalsBackend;
  // Token e conexão da escola: só pedidos quando há o que fazer no Google.
  access: () => Promise<OriginalsAccess>;
  now?: () => number;
}

export type OriginalsOutcome = {
  status: "NOTHING" | "DONE" | "DEFERRED" | "FAILED";
  error?: string;
  discovered: boolean;
  registered: number;
  trashed: number;
  gone: number;
  refused: number;
  failed: number;
  // Arquivos vencidos que ficaram para a próxima rodada (prazo da rodada).
  deferred: number;
};

/**
 * Um trabalho PURGE_ORIGINALS: confere a lista de documentos da aula (se o
 * banco pedir), registra, e move para a lixeira o que venceu — um arquivo por
 * vez, cada resultado gravado no banco (TRASHED, GONE, REFUSED ou FAILED com
 * nova tentativa). Resposta sem conteúdo de aula: só contagens e códigos.
 */
export async function runOriginalsPurge(
  input: { deleteEnabled: boolean; deadline: number },
  deps: OriginalsDeps,
): Promise<OriginalsOutcome> {
  const now = deps.now || Date.now;
  const outcome: OriginalsOutcome = {
    status: "NOTHING",
    discovered: false,
    registered: 0,
    trashed: 0,
    gone: 0,
    refused: 0,
    failed: 0,
    deferred: 0,
  };
  const state = await deps.backend("session_state");
  const room = isRecord(state.room) ? state.room : null;
  const space = text(room?.space_name, 200);
  const owner = text(room?.organizer_sub, 255);
  const session = isRecord(state.session) ? state.session : {};
  let due = readOriginalFiles(state.files_due);
  const discover = state.discovery_needed === true && !!space;
  if (!discover && !due.length) return outcome;

  const access = await deps.access();
  if (!owner || access.organizerSub !== owner) {
    // Os documentos estão no Drive da conta que criou a sala: com outra conta
    // conectada, nada é lido nem movido (a direção vê na tela).
    if (discover) {
      await deps.backend("discovery_failed", {
        error_code: "google_organizer_changed",
      });
    }
    if (due.length) {
      await deps.backend("defer", {
        error_code: "google_organizer_changed",
        minutes: ORGANIZER_CHANGED_MINUTES,
      });
    }
    return { ...outcome, status: "FAILED", error: "google_organizer_changed" };
  }

  if (discover) {
    try {
      const found = await discoverOriginals(
        access.provider,
        space,
        text(session.class_date, 10),
        now(),
      );
      const saved = await deps.backend("register", {
        organizer_sub: owner,
        files: found.files,
        discovered: found.complete,
      });
      outcome.registered = Number(saved.registered) || 0;
      outcome.discovered = found.complete;
      if (!found.complete) {
        await deps.backend("discovery_failed", {
          error_code: "google_documents_still_generating",
        });
      }
      due = readOriginalFiles(saved.files_due);
    } catch (error) {
      const code = providerErrorCode(error, "google_original_discovery_failed");
      console.error("[google-meet] conferência dos originais", { code });
      await deps.backend("discovery_failed", { error_code: code });
    }
  }

  outcome.status = "DONE";
  if (!due.length) return outcome;
  if (!input.deleteEnabled || !hasDriveWriteScope(access.grantedScopes)) {
    // Lixeira desligada nesta instalação, ou a conta central ainda não
    // autorizou escrever no Drive (reconectar): espera sem gastar tentativa.
    await deps.backend("defer", {
      error_code: input.deleteEnabled
        ? "google_drive_scope_missing"
        : "google_drive_delete_disabled",
      minutes: DEFER_MINUTES,
    });
    return { ...outcome, status: "DEFERRED", deferred: due.length };
  }

  for (const file of due) {
    if (now() > input.deadline) {
      outcome.deferred++;
      continue;
    }
    let result: TrashOutcome | { result: "FAILED"; code: string };
    try {
      result = await access.provider.trashDriveFile(file.file_id, file.kind);
    } catch (error) {
      result = {
        result: "FAILED",
        code: providerErrorCode(error, "google_drive_trash_failed"),
      };
    }
    await deps.backend("file_result", {
      file_id: file.file_id,
      result: result.result,
      error_code: result.code,
    });
    if (result.result === "TRASHED") outcome.trashed++;
    else if (result.result === "GONE") outcome.gone++;
    else if (result.result === "REFUSED") outcome.refused++;
    else outcome.failed++;
  }
  return outcome;
}
