import {
  googleEmail,
  isRecord,
  safeMeetingUri,
  safeResource,
  SUMMARY_RESPONSE_SCHEMA,
  text,
} from "./core.ts";
export type Fetcher = typeof fetch;
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
        response.status === 401
          ? "google_reconnect_required"
          : response.status === 403
          ? "google_permission_or_edition_required"
          : response.status === 404
          ? "google_resource_unavailable"
          : response.status === 429
          ? "google_rate_limited"
          : "google_provider_error",
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
  async ensureCohost(space: string, email: string): Promise<void> {
    const name = safeResource(space, "space"), identity = googleEmail(email);
    const members = await this.list(
      `https://meet.googleapis.com/v2/${name}/members`,
      "members",
    );
    const existing = members.find((member) =>
      text(member.email).toLowerCase() === identity
    );
    if (existing?.role === "COHOST") return;
    if (existing) {
      const memberName = text(existing.name, 250);
      if (!new RegExp(`^${name}/members/[A-Za-z0-9_-]+$`).test(memberName)) {
        throw new Error("google_member_invalid");
      }
      await this.json(
        `https://meet.googleapis.com/v2/${memberName}?updateMask=role`,
        { method: "PATCH", body: JSON.stringify({ role: "COHOST" }) },
      );
    } else {await this.json(`https://meet.googleapis.com/v2/${name}/members`, {
        method: "POST",
        body: JSON.stringify({ email: identity, role: "COHOST" }),
      });}
  }
  async list(
    urlString: string,
    key: string,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [], url = new URL(urlString);
    url.searchParams.set("pageSize", "100");
    for (let page = 0; page < 20; page++) {
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
  /** Conferências da sala na janela da agenda: só identidade e horário da reunião. */
  async conferences(
    space: string,
    sessionWindow?: { start: string; end: string },
  ): Promise<{ name: string; startTime: string; endTime: string }[]> {
    const url = new URL("https://meet.googleapis.com/v2/conferenceRecords");
    let filter = `space.name = "${safeResource(space, "space")}"`;
    if (sessionWindow) {
      const start = Date.parse(sessionWindow.start),
        end = Date.parse(sessionWindow.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new Error("invalid_session_window");
      }
      // Scope document discovery to this lesson. These query bounds are the
      // school's schedule, not provider presence/duration measurements.
      filter += ` AND start_time >= "${
        new Date(start - 2 * 3600000).toISOString()
      }" AND start_time <= "${new Date(end + 2 * 3600000).toISOString()}"`;
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
  async artifactMetadata(
    space: string,
    sessionWindow?: { start: string; end: string },
  ): Promise<Record<string, unknown>[]> {
    const artifacts: Record<string, unknown>[] = [];
    for (const conference of await this.conferences(space, sessionWindow)) {
      const name = conference.name;
      for (
        const [resource, kind] of [["transcripts", "TRANSCRIPT"], [
          "smartNotes",
          "SMART_NOTES",
        ]]
      ) {
        const artifactUrl =
          `https://meet.googleapis.com/v2/${name}/${resource}?fields=${resource}(name,state,docsDestination),nextPageToken`;
        for (const artifact of await this.list(artifactUrl, resource)) {
          artifacts.push({ ...artifact, kind });
        }
      }
    }
    return artifacts;
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
    throw new GoogleProviderError("google_reconnect_required", 401);
  }
  const result = await response.json();
  if (!isRecord(result) || !text(result.access_token, 8000)) {
    throw new GoogleProviderError("google_oauth_response_invalid", 502);
  }
  return result;
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
