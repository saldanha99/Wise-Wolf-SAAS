import {
  formatTranscriptEntries,
  googleEmail,
  isRecord,
  safeMeetingUri,
  safeResource,
  SUMMARY_RESPONSE_SCHEMA,
  text,
  type TranscriptEntry,
} from "./core.ts";
export type Fetcher = typeof fetch;
export type MeetConference = {
  name: string;
  startTime: string;
  endTime: string;
};
export type MeetArtifactKind = "TRANSCRIPT" | "SMART_NOTES";
export type MeetArtifact = {
  name: string;
  kind: MeetArtifactKind;
  state: string;
  document: string | null;
  conference: MeetConference;
};
// Campos que a revogação desliga na sala já criada (spaces.patch). Mesmo formato
// do guia do Meet (updateMask=config.accessType), um caminho por campo.
export const ARTIFACT_UPDATE_MASK = [
  "config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration",
  "config.artifactConfig.smartNotesConfig.autoSmartNotesGeneration",
].join(",");
export class GoogleProviderError extends Error {
  constructor(
    public code: string,
    public status: number,
    // Motivo e recurso que o Google devolve no corpo do erro (ErrorInfo), quando
    // houver. Não carrega texto livre do provedor.
    public reason = "",
    public feature = "",
  ) {
    super(code);
  }
}
/** Extrai reason/feature_name do ErrorInfo de um corpo de erro do Google. */
export function googleErrorInfo(
  body: unknown,
): { reason: string; feature: string } {
  const details = isRecord(body) && isRecord(body.error) &&
      Array.isArray(body.error.details)
    ? body.error.details
    : [];
  for (const detail of details) {
    if (!isRecord(detail) || !text(detail.reason, 120)) continue;
    const metadata = isRecord(detail.metadata) ? detail.metadata : {};
    return {
      reason: text(detail.reason, 120),
      feature: text(metadata.feature_name, 120),
    };
  }
  return { reason: "", feature: "" };
}
export class GoogleMeetProvider {
  constructor(private token: string, private request: Fetcher = fetch) {}
  private static errorCode(status: number): string {
    return status === 401
      ? "google_reconnect_required"
      : status === 403
      ? "google_permission_or_edition_required"
      : status === 404
      ? "google_resource_unavailable"
      : status === 429
      ? "google_rate_limited"
      : "google_provider_error";
  }
  private async json(
    url: string,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.request(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new GoogleProviderError("google_request_uncertain", 503);
    }
    if (!response.ok) {
      let info = { reason: "", feature: "" };
      try {
        info = googleErrorInfo(await response.json());
      } catch { /* corpo não-JSON: segue só com o status */ }
      throw new GoogleProviderError(
        GoogleMeetProvider.errorCode(response.status),
        response.status,
        info.reason,
        info.feature,
      );
    }
    const result = await response.json();
    if (!isRecord(result)) {
      throw new GoogleProviderError("google_response_invalid", 502);
    }
    return result;
  }
  async createSpace(
    options: { attendanceReport?: boolean } = {},
  ): Promise<{ space_name: string; meeting_uri: string }> {
    let result: Record<string, unknown>;
    try {
      result = await this.postSpace("RESTRICTED", options);
    } catch (error) {
      // Workspace sobre Gmail (sem domínio): o Google recusa escolher o tipo de
      // acesso (403 FEATURE_UNAVAILABLE_TO_USER, updateAccessType), medido em
      // 26/09/2026. Nada foi criado; repete com TRUSTED, que ali equivale ao
      // restrito: a conta da escola não tem colegas de domínio, o professor
      // entra direto como membro convidado e o aluno pede para entrar.
      if (
        !(error instanceof GoogleProviderError) ||
        error.reason !== "FEATURE_UNAVAILABLE_TO_USER" ||
        error.feature !== "updateAccessType"
      ) throw error;
      result = await this.postSpace("TRUSTED", options);
    }
    return {
      space_name: safeResource(result.name, "space"),
      meeting_uri: safeMeetingUri(result.meetingUri),
    };
  }
  private postSpace(
    accessType: "RESTRICTED" | "TRUSTED",
    options: { attendanceReport?: boolean },
  ): Promise<Record<string, unknown>> {
    return this.json("https://meet.googleapis.com/v2/spaces", {
      method: "POST",
      body: JSON.stringify({
        config: {
          accessType,
          moderation: "ON",
          // Relatório de presença nativo do Google (Business Plus): planilha no
          // Drive da conta da escola. Só com a flag de presença ligada.
          attendanceReportGenerationType: options.attendanceReport
            ? "GENERATE_REPORT"
            : "DO_NOT_GENERATE",
          artifactConfig: {
            recordingConfig: { autoRecordingGeneration: "OFF" },
            transcriptionConfig: { autoTranscriptionGeneration: "ON" },
            smartNotesConfig: { autoSmartNotesGeneration: "ON" },
          },
        },
      }),
    });
  }
  /**
   * Liga ou desliga a transcrição e as anotações automáticas de uma sala JÁ
   * criada (spaces.patch). É o que a revogação do termo faz na sala da aula:
   * quem entrar depois não é mais transcrito. O updateMask lista só os dois
   * campos (FieldMask em JSON: caminhos camelCase separados por vírgula), então
   * acesso, moderação e relatório de presença ficam como estão. A resposta é o
   * Space atualizado: valor diferente do pedido não conta como feito.
   */
  async setArtifactGeneration(space: string, enabled: boolean): Promise<void> {
    const name = safeResource(space, "space"), value = enabled ? "ON" : "OFF";
    const url = new URL(`https://meet.googleapis.com/v2/${name}`);
    url.searchParams.set("updateMask", ARTIFACT_UPDATE_MASK);
    const result = await this.json(url.toString(), {
      method: "PATCH",
      body: JSON.stringify({
        config: {
          artifactConfig: {
            transcriptionConfig: { autoTranscriptionGeneration: value },
            smartNotesConfig: { autoSmartNotesGeneration: value },
          },
        },
      }),
    });
    const artifact = isRecord(result.config) &&
        isRecord(result.config.artifactConfig)
      ? result.config.artifactConfig
      : {};
    const returned = [
      isRecord(artifact.transcriptionConfig)
        ? text(artifact.transcriptionConfig.autoTranscriptionGeneration, 40)
        : "",
      isRecord(artifact.smartNotesConfig)
        ? text(artifact.smartNotesConfig.autoSmartNotesGeneration, 40)
        : "",
    ];
    if (returned.some((found) => found && found !== value)) {
      throw new GoogleProviderError("google_room_update_unconfirmed", 502);
    }
  }
  /**
   * Deixa a conta confirmada do professor como a ÚNICA coanfitriã da sala
   * (decisão da direção: coanfitrião é só a conta confirmada por login). A conta
   * nova entra (ou é promovida) PRIMEIRO; só depois sai quem era coanfitrião com
   * outro e-mail — a conta antiga do professor, ou a de outro professor quando a
   * aula mudou de mãos. Se a remoção falhar, a sala não fica sem ninguém para
   * admitir o aluno, e a fila tenta de novo.
   */
  async ensureCohost(space: string, email: string): Promise<void> {
    const name = safeResource(space, "space"), identity = googleEmail(email);
    const members = await this.list(
      `https://meet.googleapis.com/v2/${name}/members`,
      "members",
    );
    const memberNameOf = (member: Record<string, unknown>): string => {
      const memberName = text(member.name, 250);
      if (!new RegExp(`^${name}/members/[A-Za-z0-9_-]+$`).test(memberName)) {
        throw new Error("google_member_invalid");
      }
      return memberName;
    };
    const existing = members.find((member) =>
      text(member.email).toLowerCase() === identity
    );
    if (existing && existing.role !== "COHOST") {
      await this.json(
        `https://meet.googleapis.com/v2/${
          memberNameOf(existing)
        }?updateMask=role`,
        { method: "PATCH", body: JSON.stringify({ role: "COHOST" }) },
      );
    } else if (!existing) {
      await this.json(`https://meet.googleapis.com/v2/${name}/members`, {
        method: "POST",
        body: JSON.stringify({ email: identity, role: "COHOST" }),
      });
    }
    for (const member of members) {
      if (
        member.role !== "COHOST" ||
        text(member.email).toLowerCase() === identity
      ) continue;
      await this.removeMember(memberNameOf(member));
    }
  }
  /** Tira um membro da sala. Já ausente (404) é o estado pedido. */
  private async removeMember(memberName: string): Promise<void> {
    let response: Response;
    try {
      response = await this.request(
        `https://meet.googleapis.com/v2/${memberName}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(20000),
        },
      );
    } catch {
      throw new GoogleProviderError("google_request_uncertain", 503);
    }
    if (response.ok || response.status === 404) return;
    throw new GoogleProviderError(
      GoogleMeetProvider.errorCode(response.status),
      response.status,
    );
  }
  async list(
    urlString: string,
    key: string,
    maxPages = 20,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [], url = new URL(urlString);
    url.searchParams.set("pageSize", "100");
    for (let page = 0; page < maxPages; page++) {
      const result = await this.json(url.toString());
      const rows = Array.isArray(result[key])
        ? result[key].filter(isRecord)
        : [];
      items.push(...rows);
      const next = text(result.nextPageToken, 4000);
      if (!next) return items;
      url.searchParams.set("pageToken", next);
    }
    throw new GoogleProviderError("google_pagination_limit", 503);
  }
  /**
   * Conferências da sala num intervalo (o dia da aula, no fuso da escola — ver
   * saoPauloDayWindow): só identidade e horário da reunião. A sala é exclusiva
   * da sessão, então aula remarcada por fora no mesmo dia continua sendo achada;
   * antes a busca era ±2 h do horário da agenda e virava caso falso de
   * "fora da sala".
   */
  async conferences(
    space: string,
    window?: { start: string; end: string },
  ): Promise<MeetConference[]> {
    const url = new URL("https://meet.googleapis.com/v2/conferenceRecords");
    let filter = `space.name = "${safeResource(space, "space")}"`;
    if (window) {
      const start = Date.parse(window.start),
        end = Date.parse(window.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new Error("invalid_session_window");
      }
      filter += ` AND start_time >= "${
        new Date(start).toISOString()
      }" AND start_time <= "${new Date(end).toISOString()}"`;
    }
    url.searchParams.set("filter", filter);
    // Identidade e horário da conferência: é o que localiza os documentos da
    // aula e o relatório de presença. Participantes não são consultados.
    url.searchParams.set(
      "fields",
      "conferenceRecords(name,startTime,endTime),nextPageToken",
    );
    const rows = await this.list(url.toString(), "conferenceRecords");
    return rows.map((row) => ({
      name: safeResource(row.name, "conference"),
      startTime: text(row.startTime, 40),
      endTime: text(row.endTime, 40),
    }));
  }
  /**
   * Documentos de UM tipo de uma conferência. Separado por tipo de propósito:
   * a falha ao listar as anotações não pode esconder a transcrição (nem a
   * presença) — quem chama trata cada lista no seu próprio try/catch.
   */
  async artifactsOf(
    conference: MeetConference,
    kind: MeetArtifactKind,
  ): Promise<MeetArtifact[]> {
    const name = safeResource(conference.name, "conference");
    const resource = kind === "TRANSCRIPT" ? "transcripts" : "smartNotes";
    const artifactUrl =
      `https://meet.googleapis.com/v2/${name}/${resource}?fields=${resource}(name,state,docsDestination),nextPageToken`;
    const prefix = `${name}/${resource}/`;
    return (await this.list(artifactUrl, resource)).map((row) => {
      const artifactName = text(row.name, 250);
      if (
        !artifactName.startsWith(prefix) ||
        !/^[A-Za-z0-9_-]+$/.test(artifactName.slice(prefix.length))
      ) throw new GoogleProviderError("google_response_invalid", 502);
      const document = isRecord(row.docsDestination)
        ? text(row.docsDestination.document, 200)
        : "";
      return {
        name: artifactName,
        kind,
        state: text(row.state, 40),
        document: /^[A-Za-z0-9_-]+$/.test(document) ? document : null,
        conference,
      };
    });
  }
  /**
   * Plano B da transcrição: as falas pela API do Meet, quando o Google Docs não
   * exporta (403, arquivo ausente, Drive sem espaço para gerar o documento).
   * Pede só participante, texto e horário da fala. O nome de quem falou vem de
   * participants.get com máscara de campos restrita ao NOME DE EXIBIÇÃO — é o
   * rótulo que o próprio documento do Google traria; horários de entrada e
   * saída (earliestStartTime/latestEndTime) e participantSessions nunca são
   * pedidos. Presença continua vindo só do relatório de presença.
   */
  async transcriptText(transcriptName: string): Promise<string> {
    const name = safeResource(transcriptName, "transcript");
    const entriesUrl =
      `https://meet.googleapis.com/v2/${name}/entries?fields=transcriptEntries(participant,text,startTime),nextPageToken`;
    const entries: TranscriptEntry[] =
      (await this.list(entriesUrl, "transcriptEntries", 60)).map((row) => ({
        participant: text(row.participant, 250),
        text: text(row.text, 20000),
        startTime: text(row.startTime, 40),
      }));
    const names = new Map<string, string>();
    let unnamed = 0;
    // Numeração de quem ficou sem nome segue a ordem em que falou.
    const chronological = [...entries].sort((a, b) =>
      (Date.parse(a.startTime) || 0) - (Date.parse(b.startTime) || 0)
    );
    for (const entry of chronological) {
      if (!entry.participant || names.has(entry.participant)) continue;
      if (names.size >= 30) {
        names.set(entry.participant, `Participante ${++unnamed}`);
        continue;
      }
      try {
        names.set(
          entry.participant,
          await this.participantDisplayName(entry.participant),
        );
      } catch {
        names.set(entry.participant, `Participante ${++unnamed}`);
      }
    }
    const result = formatTranscriptEntries(entries, names);
    if (result.length > 500000) {
      throw new GoogleProviderError("google_document_too_large", 422);
    }
    return result;
  }
  private async participantDisplayName(participant: string): Promise<string> {
    const name = safeResource(participant, "participant");
    const result = await this.json(
      `https://meet.googleapis.com/v2/${name}?fields=signedinUser(displayName),anonymousUser(displayName),phoneUser(displayName)`,
    );
    for (const key of ["signedinUser", "anonymousUser", "phoneUser"]) {
      const user = result[key];
      if (isRecord(user) && text(user.displayName, 120)) {
        return text(user.displayName, 120).replace(/[\r\n:]+/g, " ");
      }
    }
    throw new GoogleProviderError("google_participant_unnamed", 404);
  }
  /**
   * Planilhas da PRÓPRIA conta da escola criadas na janela da aula. Com
   * drive.readonly a busca enxergaria também planilhas compartilhadas por
   * terceiros; 'me' in owners mantém só as que o Meet gerou para a organizadora.
   * Quem escolhe a planilha certa é pickAttendanceReport (código da sala no nome).
   */
  async attendanceReportCandidates(
    from: string,
    to: string,
  ): Promise<{ id: string; name: string; createdTime: string }[]> {
    const start = Date.parse(from), end = Date.parse(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error("invalid_session_window");
    }
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set(
      "q",
      `mimeType = 'application/vnd.google-apps.spreadsheet' and 'me' in owners and trashed = false and createdTime >= '${
        new Date(start).toISOString()
      }' and createdTime <= '${new Date(end).toISOString()}'`,
    );
    url.searchParams.set("fields", "files(id,name,createdTime),nextPageToken");
    url.searchParams.set("orderBy", "createdTime");
    const files = await this.list(url.toString(), "files");
    return files.map((file) => ({
      id: safeResource(file.id, "document"),
      name: text(file.name, 300),
      createdTime: text(file.createdTime, 40),
    }));
  }
  async spreadsheetCsv(fileId: string): Promise<string> {
    const id = safeResource(fileId, "document");
    let response: Response;
    try {
      response = await this.request(
        `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text%2Fcsv`,
        {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(20000),
        },
      );
    } catch {
      throw new GoogleProviderError("google_document_unavailable", 503);
    }
    if (!response.ok) {
      throw new GoogleProviderError(
        response.status === 403
          ? "google_document_permission_required"
          : "google_document_unavailable",
        response.status,
      );
    }
    const result = await response.text();
    if (result.length > 200000) {
      throw new GoogleProviderError("google_document_too_large", 422);
    }
    return result;
  }
  async documentText(documentId: string): Promise<string> {
    const id = safeResource(documentId, "document");
    let response: Response;
    try {
      response = await this.request(
        `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text%2Fplain`,
        {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(20000),
        },
      );
    } catch {
      throw new GoogleProviderError("google_document_unavailable", 503);
    }
    if (!response.ok) {
      throw new GoogleProviderError(
        response.status === 403
          ? "google_document_permission_required"
          : "google_document_unavailable",
        response.status,
      );
    }
    const result = await response.text();
    if (result.length > 500000) {
      throw new GoogleProviderError("google_document_too_large", 422);
    }
    if (!result.trim()) {
      throw new GoogleProviderError("google_document_empty", 422);
    }
    return result;
  }
}
// Erros do endpoint de token que significam "este refresh token não vale mais
// para este cliente": revogado, expirado, senha trocada (invalid_grant) ou
// emitido para outro cliente OAuth, como depois de trocar o cliente no Cloud
// (unauthorized_client). Só eles pedem reconectar a conta central.
const REVOKED_TOKEN_ERRORS = new Set(["invalid_grant", "unauthorized_client"]);

/**
 * Troca de token com a conta central. Só token revogado desconecta
 * (google_reconnect_required → REAUTH_REQUIRED). Instabilidade do Google (5xx,
 * 429, rede) é transitória: antes qualquer resposta não-OK marcava a conta para
 * reconectar e parava todas as salas e importações até a direção agir.
 */
export async function exchangeToken(
  input: Record<string, string>,
  request: Fetcher = fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(input),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new GoogleProviderError("google_oauth_unavailable", 503);
  }
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new GoogleProviderError("google_oauth_unavailable", 503);
    }
    let oauthError = "";
    try {
      const body = await response.json();
      oauthError = isRecord(body) ? text(body.error, 80) : "";
    } catch { /* corpo não-JSON: fica sem o código do OAuth */ }
    if (
      (response.status === 400 || response.status === 401) &&
      REVOKED_TOKEN_ERRORS.has(oauthError)
    ) throw new GoogleProviderError("google_reconnect_required", 401);
    // invalid_client (segredo trocado), invalid_request…: é configuração, e
    // reconectar a conta não resolve. Não desconecta; o código fica visível.
    throw new GoogleProviderError("google_oauth_rejected", response.status);
  }
  const result = await response.json();
  if (!isRecord(result) || !text(result.access_token, 8000)) {
    throw new GoogleProviderError("google_oauth_response_invalid", 502);
  }
  return result;
}
export const providerErrorCode = (error: unknown, fallback: string): string =>
  error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
    ? error.message
    : fallback;

export type ArtifactReading = {
  status: "PENDING" | "IMPORTED" | "EMPTY";
  source: "DRIVE_EXPORT" | "MEET_ENTRIES" | null;
  sourceText: string;
  // Com IMPORTED pelas falas, guarda por que o Docs não serviu (visível na tela).
  errorCode: string | null;
};

// Transcrição que parou em ENDED (arquivo nunca gerado — por exemplo, Drive da
// conta sem espaço) é montada pelas falas depois desta espera.
export const TRANSCRIPT_FILE_GRACE_MS = 3_600_000;

/**
 * O que fazer com UM documento do Meet. Lança erro só quando o documento
 * falhou de verdade (quem chama registra a falha daquele artefato e segue):
 * - ainda gerando → PENDING;
 * - Docs vazio (aula sem fala) → EMPTY, estado final, nunca vira falha repetida;
 * - transcrição que o Docs não exporta, sem documento, ou parada em ENDED há
 *   mais de 1 h → plano B pelas falas da API (MEET_ENTRIES).
 */
export async function readArtifact(
  provider: GoogleMeetProvider,
  item: MeetArtifact,
  nowMs: number,
): Promise<ArtifactReading> {
  const fromEntries = async (reason: string): Promise<ArtifactReading> => {
    let entries: string;
    try {
      entries = await provider.transcriptText(item.name);
    } catch {
      // O plano B também falhou: o erro que conta é o do documento.
      throw new GoogleProviderError(reason, 502);
    }
    return entries.trim()
      ? {
        status: "IMPORTED",
        source: "MEET_ENTRIES",
        sourceText: entries,
        errorCode: reason,
      }
      : {
        status: "EMPTY",
        source: "MEET_ENTRIES",
        sourceText: "",
        errorCode: reason,
      };
  };
  if (item.state !== "FILE_GENERATED") {
    const ended = Date.parse(item.conference.endTime);
    if (
      item.kind === "TRANSCRIPT" && item.state === "ENDED" &&
      Number.isFinite(ended) && nowMs - ended > TRANSCRIPT_FILE_GRACE_MS
    ) return await fromEntries("google_document_not_generated");
    return { status: "PENDING", source: null, sourceText: "", errorCode: null };
  }
  if (!item.document) {
    if (item.kind === "TRANSCRIPT") {
      return await fromEntries("google_document_missing");
    }
    throw new GoogleProviderError("google_document_missing", 502);
  }
  try {
    const sourceText = await provider.documentText(item.document);
    return {
      status: "IMPORTED",
      source: "DRIVE_EXPORT",
      sourceText,
      errorCode: null,
    };
  } catch (error) {
    const code = providerErrorCode(error, "google_document_unavailable");
    if (code === "google_document_empty") {
      return {
        status: "EMPTY",
        source: "DRIVE_EXPORT",
        sourceText: "",
        errorCode: null,
      };
    }
    if (item.kind === "TRANSCRIPT") return await fromEntries(code);
    throw error;
  }
}

/**
 * O laço de importação: um documento por vez, cada um no seu try/catch. Falha
 * de um documento é registrada NELE (recordFailure) e o laço segue — antes a
 * primeira falha derrubava a sessão inteira, e nem a presença era lida.
 * - EMPTY é final (nunca relido); IMPORTED só é relido na importação manual;
 * - passado o prazo da rodada, o que falta fica PENDING para a próxima.
 */
export async function importArtifacts(
  provider: GoogleMeetProvider,
  artifacts: MeetArtifact[],
  options: {
    known: Map<string, { status: string }>;
    force?: boolean;
    deadline: number;
    now?: () => number;
    persist: (item: MeetArtifact, reading: ArtifactReading) => Promise<void>;
    recordFailure: (item: MeetArtifact, code: string) => Promise<void>;
  },
): Promise<{
  statuses: ("PENDING" | "IMPORTED" | "EMPTY" | "FAILED")[];
  deferred: boolean;
}> {
  const now = options.now || Date.now;
  const statuses: ("PENDING" | "IMPORTED" | "EMPTY" | "FAILED")[] = [];
  let deferred = false;
  for (const item of artifacts) {
    const previous = options.known.get(item.name)?.status;
    if (
      previous === "EMPTY" || (previous === "IMPORTED" && !options.force)
    ) {
      statuses.push(previous);
      continue;
    }
    if (now() > options.deadline) {
      deferred = true;
      statuses.push("PENDING");
      continue;
    }
    try {
      const reading = await readArtifact(provider, item, now());
      await options.persist(item, reading);
      statuses.push(reading.status);
    } catch (error) {
      statuses.push("FAILED");
      try {
        await options.recordFailure(
          item,
          providerErrorCode(error, "google_document_import_failed"),
        );
      } catch { /* a falha já ficou no log; o próximo ciclo tenta de novo */ }
    }
  }
  return { statuses, deferred };
}

/**
 * Resultado de ligar/desligar a documentação da sala, no formato que o banco
 * grava (room_artifacts_save). Sala que não existe mais no Google (404) não
 * transcreve ninguém: para DESLIGAR, isso já é o estado pedido. Qualquer outra
 * falha fica registrada e a fila tenta de novo (15 min, dobrando até 2 h).
 */
export async function applyRoomArtifacts(
  provider: GoogleMeetProvider,
  space: string,
  enable: boolean,
): Promise<
  { result: "ENABLED" | "DISABLED" | "FAILED"; errorCode: string | null }
> {
  try {
    await provider.setArtifactGeneration(space, enable);
    return { result: enable ? "ENABLED" : "DISABLED", errorCode: null };
  } catch (error) {
    const code = providerErrorCode(error, "google_room_update_failed");
    if (!enable && code === "google_resource_unavailable") {
      return { result: "DISABLED", errorCode: code };
    }
    return { result: "FAILED", errorCode: code };
  }
}

/**
 * Código gravado na sala quando a criação falha. Nos dois casos a sala volta a
 * ser tentada sozinha (FAILED, espera crescente): recusa do Google e falha
 * incerta (rede, 5xx, timeout) não deixam link salvo, e só o link salvo é
 * distribuído — um space criado no Google e não salvo aqui nunca chega a
 * ninguém, então tentar de novo não produz dois links em uso.
 */
export function roomCreationErrorCode(error: unknown): string {
  if (!(error instanceof GoogleProviderError)) {
    return "google_room_creation_failed";
  }
  if (error.code === "google_request_uncertain" || error.status >= 500) {
    return "google_room_creation_uncertain";
  }
  return /^[a-z_]{1,80}$/.test(error.code)
    ? error.code
    : "google_room_creation_failed";
}
export async function googleIdentity(
  token: string,
  request: Fetcher = fetch,
): Promise<{ sub: string; email: string }> {
  const response = await request(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok) {
    throw new GoogleProviderError("google_identity_unavailable", 502);
  }
  const result = await response.json();
  if (
    !isRecord(result) || result.email_verified !== true ||
    !text(result.sub, 200)
  ) throw new GoogleProviderError("google_identity_unverified", 403);
  return { sub: text(result.sub, 200), email: googleEmail(result.email) };
}
export async function geminiSummary(
  prompt: string,
  key: string,
  model: string,
  request: Fetcher = fetch,
): Promise<Record<string, unknown>> {
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw new Error("google_summary_model_invalid");
  }
  const response = await request(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: SUMMARY_RESPONSE_SCHEMA,
          temperature: 0.1,
          maxOutputTokens: 6000,
        },
      }),
      signal: AbortSignal.timeout(50000),
    },
  );
  if (!response.ok) {
    throw new GoogleProviderError(
      "google_summary_generation_failed",
      response.status,
    );
  }
  const result = await response.json();
  if (!isRecord(result)) throw new Error("google_summary_response_invalid");
  return result;
}
