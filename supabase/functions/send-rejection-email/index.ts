import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import {
  authorizeRequest,
  hasTenantAccess,
  methodNotAllowed,
} from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const jsonResponse = (
  status: number,
  payload: Record<string, unknown>,
): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["SCHOOL_ADMIN", "SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }
  if (
    typeof rawBody !== "object" ||
    rawBody === null ||
    Array.isArray(rawBody)
  ) {
    return jsonResponse(400, { error: "JSON body must be an object" });
  }
  const body = rawBody as { student_id?: unknown };

  const studentId = typeof body.student_id === "string"
    ? body.student_id.trim()
    : "";
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(studentId)) {
    return jsonResponse(400, {
      error: "A valid student_id is required",
    });
  }

  const admin = auth.context.admin;
  const { data: student, error: studentError } = await admin
    .from("profiles")
    .select(
      "id, role, tenant_id, email, full_name, is_test_account, documentation_status, rejection_reason",
    )
    .eq("id", studentId)
    .maybeSingle();

  if (studentError) {
    console.error("Rejection email student lookup failed", {
      code: studentError.code,
    });
    return jsonResponse(500, { error: "Could not validate student" });
  }
  if (!student || student.role !== "STUDENT" || !student.tenant_id) {
    return jsonResponse(404, { error: "Student not found" });
  }
  if (!hasTenantAccess(auth.context, student.tenant_id)) {
    return jsonResponse(403, { error: "Student is outside the allowed tenant" });
  }
  const reason = student.rejection_reason?.trim() ?? "";
  if (
    student.documentation_status !== "REJECTED" ||
    reason.length < 3 ||
    reason.length > 1000
  ) {
    return jsonResponse(409, {
      error: "The student documentation is not in a valid rejected state",
    });
  }

  if (student.is_test_account === true) {
    return jsonResponse(200, {
      success: true,
      skipped: "test_fixture",
    });
  }

  const email = student.email?.trim() ?? "";
  if (!email) {
    return jsonResponse(422, { error: "Student has no email address" });
  }

  const resendApiKey = Deno.env.get("RESEND_API_KEY")?.trim();
  if (!resendApiKey) {
    console.error("Rejection email provider is not configured");
    return jsonResponse(503, { error: "Email provider is unavailable" });
  }

  const resendFromEmail = Deno.env.get("RESEND_FROM_EMAIL")?.trim() ||
    "Wise Wolf <nao-responda@wisewolflanguage.com.br>";
  const resendReplyTo = Deno.env.get("RESEND_REPLY_TO")?.trim();
  const systemUrl = (Deno.env.get("SYSTEM_URL")?.trim() ||
    "https://system.wisewolflanguage.com.br").replace(/\/+$/, "");
  const reasonHash = await sha256(reason);
  const { data: claimStatus, error: claimError } = await admin.rpc(
    "claim_rejection_email",
    {
      p_student_id: student.id,
      p_reason: reason,
      p_reason_hash: reasonHash,
    },
  );
  if (claimError) {
    console.error("Rejection email claim failed", { code: claimError.code });
    return jsonResponse(409, { error: "Rejection state changed" });
  }
  if (claimStatus === "already_sent" || claimStatus === "in_progress") {
    return jsonResponse(200, {
      success: true,
      skipped: claimStatus,
    });
  }
  if (claimStatus !== "claimed") {
    return jsonResponse(500, { error: "Could not claim rejection email" });
  }

  const releaseClaim = async (): Promise<void> => {
    const { error } = await admin
      .from("profiles")
      .update({ rejection_email_claimed_at: null })
      .eq("id", student.id)
      .eq("rejection_email_reason_hash", reasonHash)
      .is("rejection_email_sent_at", null);
    if (error) {
      console.error("Rejection email claim release failed", {
        code: error.code,
      });
    }
  };
  const safeStudentName = escapeHtml(student.full_name?.trim() || "aluno");
  const safeReason = escapeHtml(reason).replace(/\n/g, "<br>");

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
      <h2 style="color: #D32F2F; text-align: center;">Documentação Pendente de Correção</h2>
      <p>Olá, <strong>${safeStudentName}</strong>.</p>
      <p>Identificamos uma inconsistência na documentação enviada para o contrato da Wise Wolf Language.</p>
      <div style="background-color: #fce8e8; padding: 15px; border-left: 4px solid #D32F2F; margin: 20px 0;">
        <p style="margin: 0; font-weight: bold;">Motivo da rejeição:</p>
        <p style="margin: 5px 0 0 0;">${safeReason}</p>
      </div>
      <p>Acesse o portal e reenvie o documento ou assine novamente para regularizar sua matrícula.</p>
      <div style="text-align: center; margin-top: 30px;">
        <a href="${systemUrl}" style="background-color: #002366; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">Acessar Portal do Aluno</a>
      </div>
    </div>
  `;

  let data: { id?: string } | null = null;
  try {
    const providerResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: resendFromEmail,
        to: [email],
        subject: "Ação necessária: correção de documentação",
        html: htmlContent,
        ...(resendReplyTo ? { reply_to: resendReplyTo } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const providerPayload: unknown = await providerResponse.json().catch(() =>
      null
    );
    if (!providerResponse.ok) {
      console.error("Rejection email provider rejected request", {
        status: providerResponse.status,
      });
      await releaseClaim();
      return jsonResponse(502, { error: "Email provider rejected the request" });
    }
    data = typeof providerPayload === "object" &&
        providerPayload !== null &&
        !Array.isArray(providerPayload) &&
        typeof (providerPayload as { id?: unknown }).id === "string"
      ? { id: (providerPayload as { id: string }).id }
      : null;
  } catch (error) {
    console.error("Rejection email provider request failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    await releaseClaim();
    return jsonResponse(502, { error: "Email provider is unavailable" });
  }

  let markerSaved = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: marked, error: markerError } = await admin
      .from("profiles")
      .update({
        rejection_email_sent_at: new Date().toISOString(),
        rejection_email_claimed_at: null,
      })
      .eq("id", student.id)
      .eq("rejection_email_reason_hash", reasonHash)
      .select("id")
      .maybeSingle();
    if (!markerError && marked) {
      markerSaved = true;
      break;
    }
  }
  if (!markerSaved) {
    console.error("Rejection email delivery marker failed", {
      studentId: student.id,
    });
    return jsonResponse(500, {
      error: "Email was accepted but its delivery marker could not be saved",
    });
  }

  return jsonResponse(200, {
    success: true,
    message_id: data?.id ?? null,
  });
});
