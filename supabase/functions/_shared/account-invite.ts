/// <reference lib="deno.ns" />

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";

export function secureInitialPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(36));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    })[character] || character);
}

export type PreparedAccountActivation = {
  endpoint: string;
  apiKey: string;
  idempotencyKey: string | null;
  payload: string;
};

export class AccountActivationProviderError extends Error {
  constructor(
    readonly status: number,
    readonly providerCode: string,
  ) {
    super(
      `Activation email failed with status ${status}${
        providerCode ? ` (${providerCode})` : ""
      }`,
    );
    this.name = "AccountActivationProviderError";
  }
}

export function resendErrorCode(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const candidate = payload as Record<string, unknown>;
  for (const key of ["name", "code", "type", "error"]) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().toLowerCase();
    }
  }
  return "";
}

export function isOperationalAccountActivationUser(user: unknown): boolean {
  if (!user || typeof user !== "object" || Array.isArray(user)) return false;
  const candidate = user as Record<string, unknown>;
  if (
    typeof candidate.email !== "string" || !candidate.email.trim() ||
    typeof candidate.email_confirmed_at !== "string" ||
    !candidate.email_confirmed_at.trim() ||
    (typeof candidate.deleted_at === "string" && candidate.deleted_at.trim())
  ) return false;
  if (candidate.banned_until == null || candidate.banned_until === "") {
    return true;
  }
  if (typeof candidate.banned_until !== "string") return false;
  const bannedUntil = Date.parse(candidate.banned_until);
  return Number.isFinite(bannedUntil) && bannedUntil <= Date.now();
}

type AccountActivationInput = {
  email: string;
  name: string;
  accountLabel: string;
  idempotencyKey?: string;
};

function activationProviderConfig(): {
  endpoint: string;
  apiKey: string;
} {
  const apiKey = Deno.env.get("RESEND_API_KEY")?.trim() || "";
  if (!apiKey) throw new Error("RESEND_API_KEY is unavailable");
  return {
    endpoint: "https://api.resend.com/emails",
    apiKey,
  };
}

function validateIdempotencyKey(value?: string): string | null {
  const idempotencyKey = value?.trim() || null;
  if (idempotencyKey && idempotencyKey.length > 256) {
    throw new Error("Activation idempotency key is invalid");
  }
  return idempotencyKey;
}

function validateStoredActivationPayload(
  payload: string,
  expectedEmail: string,
): void {
  if (payload.length < 2 || payload.length > 50_000) {
    throw new Error("Stored activation payload is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    throw new Error("Stored activation payload is invalid");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Stored activation payload is invalid");
  }
  const candidate = decoded as Record<string, unknown>;
  const to = candidate.to;
  if (
    !Array.isArray(to) || to.length !== 1 || typeof to[0] !== "string" ||
    to[0].trim().toLowerCase() !== expectedEmail.trim().toLowerCase() ||
    typeof candidate.from !== "string" || !candidate.from.trim() ||
    candidate.subject !== "Ative seu acesso à Wise Wolf" ||
    typeof candidate.html !== "string" || !candidate.html.trim()
  ) {
    throw new Error("Stored activation payload is invalid");
  }
}

export function preparedAccountActivationFromStoredPayload(input: {
  payload: string;
  expectedEmail: string;
  idempotencyKey: string;
}): PreparedAccountActivation {
  validateStoredActivationPayload(input.payload, input.expectedEmail);
  const provider = activationProviderConfig();
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  if (!idempotencyKey) {
    throw new Error("Activation idempotency key is required for recovery");
  }
  return {
    ...provider,
    idempotencyKey,
    // Preserve the exact bytes staged before the first provider attempt.
    payload: input.payload,
  };
}

export async function prepareAccountActivation(
  admin: SupabaseClient,
  input: AccountActivationInput,
): Promise<PreparedAccountActivation> {
  const systemUrl = (Deno.env.get("SYSTEM_URL")?.trim() ||
    "https://system.wisewolflanguage.com.br")
    .replace(/\/+$/, "");
  const provider = activationProviderConfig();
  const resendFromEmail = Deno.env.get("RESEND_FROM_EMAIL")?.trim() ||
    "Wise Wolf <nao-responda@wisewolflanguage.com.br>";
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const resetUrl = `${systemUrl}/reset-password`;

  const { data, error } = await admin.auth.admin.generateLink({
    type: "recovery",
    email: input.email,
    options: { redirectTo: resetUrl },
  });
  const actionLink = data?.properties?.action_link;
  if (error || !actionLink) {
    throw new Error("Could not generate activation link");
  }
  const properties = data.properties as unknown as Record<string, unknown>;
  let actionRedirect = "";
  try {
    actionRedirect = new URL(actionLink).searchParams.get("redirect_to") || "";
  } catch {
    throw new Error("Activation redirect validation failed");
  }
  if (properties.redirect_to !== resetUrl || actionRedirect !== resetUrl) {
    // GoTrue may fall back to SITE_URL when the requested redirect is not in
    // its allow-list. Never email that silently altered link.
    throw new Error("Activation redirect validation failed");
  }
  const safeActionLink = escapeHtml(actionLink);

  return {
    ...provider,
    idempotencyKey,
    payload: JSON.stringify({
      from: resendFromEmail,
      to: [input.email],
      subject: "Ative seu acesso à Wise Wolf",
      html: `
        <div style="background:#07111f;padding:40px 16px;font-family:Arial,sans-serif;color:#eaf2ff">
          <div style="max-width:560px;margin:0 auto;background:#0c1b2e;border:1px solid #27415f;border-radius:20px;padding:36px">
            <p style="margin:0 0 10px;color:#6ee7d8;font-size:13px;font-weight:700;letter-spacing:.08em">WISE WOLF</p>
            <h1 style="margin:0 0 18px;font-size:27px;line-height:1.2">Seu acesso está pronto</h1>
            <p style="color:#b8c7dc;line-height:1.65">Olá, ${
        escapeHtml(input.name)
      }. Sua conta de ${
        escapeHtml(input.accountLabel)
      } foi criada. Defina uma senha pessoal para entrar com segurança.</p>
            <p style="margin:30px 0"><a href="${safeActionLink}" style="display:inline-block;background:#34d3c3;color:#04201d;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:800">Definir minha senha</a></p>
            <p style="color:#8294ac;font-size:12px;line-height:1.55">Este link é individual. Se você não esperava este convite, ignore esta mensagem.</p>
          </div>
        </div>`,
    }),
  };
}

export async function sendPreparedAccountActivation(
  prepared: PreparedAccountActivation,
  fetcher: typeof fetch = fetch,
): Promise<{ providerMessageId: string | null }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${prepared.apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": "wise-wolf-saas/1.0",
  };
  if (prepared.idempotencyKey) {
    headers["Idempotency-Key"] = prepared.idempotencyKey;
  }
  const response = await fetcher(prepared.endpoint, {
    method: "POST",
    headers,
    body: prepared.payload,
  });
  const responseText = await response.text();
  let responsePayload: unknown = null;
  if (responseText) {
    try {
      responsePayload = JSON.parse(responseText);
    } catch {
      responsePayload = null;
    }
  }
  const errorCode = resendErrorCode(responsePayload);
  if (!response.ok) {
    throw new AccountActivationProviderError(response.status, errorCode);
  }
  let providerMessageId: string | null = null;
  if (responsePayload && typeof responsePayload === "object") {
    const id = (responsePayload as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) {
      providerMessageId = id.trim().slice(0, 240);
    }
  }
  return { providerMessageId };
}

export async function sendAccountActivation(
  admin: SupabaseClient,
  input: AccountActivationInput,
): Promise<{ providerMessageId: string | null }> {
  const prepared = await prepareAccountActivation(admin, input);
  return await sendPreparedAccountActivation(prepared);
}
