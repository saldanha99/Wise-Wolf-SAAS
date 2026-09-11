import { assertResource, MEET_API, unseal } from "./core.ts";
export const env = (name: string) => Deno.env.get(name)?.trim() || "";
export const enabledTenants = () =>
  env("GOOGLE_MEET_ENABLED_TENANTS").split(",").map((x) => x.trim()).filter(
    Boolean,
  );
export const configured = () =>
  enabledTenants().length > 0 &&
  [
    "GOOGLE_MEET_CLIENT_ID",
    "GOOGLE_MEET_CLIENT_SECRET",
    "GOOGLE_MEET_REDIRECT_URI",
    "GOOGLE_MEET_TOKEN_KEY",
  ].every((name) => Boolean(env(name)));
export class MeetError extends Error {
  constructor(public code: string, public status = 400) {
    super(code);
  }
}
export async function googleRequest(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    // Deliberately never include Google's body: it can contain account or credential data.
    throw new MeetError(
      response.status === 401
        ? "google_reconnect_required"
        : response.status === 403
        ? "google_permission_or_plan"
        : response.status === 429
        ? "google_rate_limit"
        : "google_unavailable",
      response.status === 429 ? 429 : 502,
    );
  }
  return await response.json();
}
export async function accessToken(connection: any) {
  const refresh = await unseal(
    connection.encrypted_refresh_token,
    env("GOOGLE_MEET_TOKEN_KEY"),
    `${connection.tenant_id}:${connection.teacher_id}`,
  );
  const data = await googleRequest("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env("GOOGLE_MEET_CLIENT_ID"),
      client_secret: env("GOOGLE_MEET_CLIENT_SECRET"),
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  if (!data.access_token) throw new MeetError("google_reconnect_required");
  return String(data.access_token);
}
export async function meet(
  token: string,
  path: string,
  init: RequestInit = {},
) {
  if (
    !/^(spaces|conferenceRecords)(\/|\?|$)/.test(path) || path.includes("..")
  ) throw new MeetError("invalid_google_path");
  return await googleRequest(MEET_API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}
export async function pages(
  token: string,
  path: string,
  key: string,
  max = 50,
): Promise<any[]> {
  const rows: any[] = [];
  let pageToken = "";
  for (let page = 0; page < max; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const data = await meet(
      token,
      `${path}${separator}pageSize=100${
        pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""
      }`,
    );
    if (!Array.isArray(data[key]) && data[key] !== undefined) {
      throw new MeetError("invalid_google_response");
    }
    rows.push(...(data[key] || []));
    pageToken = data.nextPageToken || "";
    if (!pageToken) return rows;
  }
  throw new MeetError("transcript_too_large");
}
export function conferencePath(name: string) {
  return assertResource(name, "conferenceRecords");
}
