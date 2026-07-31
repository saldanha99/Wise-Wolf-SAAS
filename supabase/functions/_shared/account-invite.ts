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
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] || character);
}

export async function sendAccountActivation(
  admin: SupabaseClient,
  input: { email: string; name: string; accountLabel: string },
): Promise<void> {
  const systemUrl = (Deno.env.get("SYSTEM_URL")?.trim() || "https://system.wisewolflanguage.com.br")
    .replace(/\/+$/, "");
  const resendApiKey = Deno.env.get("RESEND_API_KEY")?.trim() || "";
  const resendFromEmail = Deno.env.get("RESEND_FROM_EMAIL")?.trim()
    || "Wise Wolf <nao-responda@wisewolflanguage.com.br>";
  if (!resendApiKey) throw new Error("RESEND_API_KEY is unavailable");

  const { data, error } = await admin.auth.admin.generateLink({
    type: "recovery",
    email: input.email,
    options: { redirectTo: `${systemUrl}/reset-password` },
  });
  const actionLink = data?.properties?.action_link;
  if (error || !actionLink) throw new Error("Could not generate activation link");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: resendFromEmail,
      to: [input.email],
      subject: "Ative seu acesso à Wise Wolf",
      html: `
        <div style="background:#07111f;padding:40px 16px;font-family:Arial,sans-serif;color:#eaf2ff">
          <div style="max-width:560px;margin:0 auto;background:#0c1b2e;border:1px solid #27415f;border-radius:20px;padding:36px">
            <p style="margin:0 0 10px;color:#6ee7d8;font-size:13px;font-weight:700;letter-spacing:.08em">WISE WOLF</p>
            <h1 style="margin:0 0 18px;font-size:27px;line-height:1.2">Seu acesso está pronto</h1>
            <p style="color:#b8c7dc;line-height:1.65">Olá, ${escapeHtml(input.name)}. Sua conta de ${escapeHtml(input.accountLabel)} foi criada. Defina uma senha pessoal para entrar com segurança.</p>
            <p style="margin:30px 0"><a href="${actionLink}" style="display:inline-block;background:#34d3c3;color:#04201d;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:800">Definir minha senha</a></p>
            <p style="color:#8294ac;font-size:12px;line-height:1.55">Este link é individual. Se você não esperava este convite, ignore esta mensagem.</p>
          </div>
        </div>`,
    }),
  });
  if (!response.ok) throw new Error(`Activation email failed with status ${response.status}`);
}
