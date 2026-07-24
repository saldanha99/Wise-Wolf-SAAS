import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";

const RAW_ASAAS_URL = (Deno.env.get("ASAAS_API_URL") || "").trim();
const ASAAS_URL = RAW_ASAAS_URL.replace(/\/+$/, "")
  .replace(/\/v3$/, "")
  .replace(/\/api\/v3$/, "")
  .replace(/\/api$/, "");
const ASAAS_API_KEY = (Deno.env.get("ASAAS_API_KEY") || "").trim() ||
  (Deno.env.get("ASAAS_ACCESS_TOKEN") || "").trim();
const ASAAS_PATH_PREFIX =
  ASAAS_URL.includes("api-sandbox") || ASAAS_URL.includes("api.asaas.com")
    ? "/v3"
    : "/api/v3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type AsaasDeletionResult = {
  subscriptionDeleted: boolean;
  customerDeleted: boolean;
  error: string | null;
  failedStage: "subscription" | "customer" | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function domainFailure(
  error: string,
  details: Record<string, unknown> = {},
) {
  // O caller atual lê data.error. Manter HTTP 200 aqui preserva a mensagem útil
  // na interface, sem jamais responder success:true em uma exclusão parcial.
  return json({ success: false, error, ...details });
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

function isAuthNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: number; message?: string };
  return candidate.status === 404 ||
    /not found|does not exist/i.test(candidate.message || "");
}

async function asaasError(response: Response) {
  const payload = await response.json().catch(() => null) as
    | { errors?: Array<{ description?: string }>; error?: string }
    | null;
  const descriptions = payload?.errors
    ?.map((item) => item.description)
    .filter(Boolean)
    .join("; ");
  const message = descriptions || payload?.error ||
    `HTTP ${response.status}`;
  return message.slice(0, 500);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Método não permitido." }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[delete-student-account] Supabase runtime incompleto");
      return json({ error: "Serviço temporariamente indisponível." }, 503);
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Sessão ausente." }, 401);
    }
    const token = authHeader.slice("Bearer ".length).trim();
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      token,
    );
    if (authError || !user) {
      return json({ error: "Sessão inválida." }, 401);
    }

    const { data: adminProfile, error: adminError } = await supabase
      .from("profiles")
      .select("id, role, tenant_id")
      .eq("id", user.id)
      .maybeSingle();
    if (adminError) {
      console.error(
        "[delete-student-account] Falha ao consultar solicitante",
        adminError.message,
      );
      return json({ error: "Não foi possível validar sua permissão." }, 503);
    }
    if (
      !adminProfile ||
      !["SCHOOL_ADMIN", "SUPER_ADMIN"].includes(adminProfile.role)
    ) {
      return json({ error: "Ação permitida apenas para administradores." }, 403);
    }
    if (
      adminProfile.role === "SCHOOL_ADMIN" &&
      !adminProfile.tenant_id
    ) {
      return json({
        error: "Administrador sem escola vinculada. A exclusão foi bloqueada.",
      }, 403);
    }

    const body = await req.json().catch(() => null) as
      | {
        studentId?: unknown;
        applyPenalty?: unknown;
        penaltyValue?: unknown;
      }
      | null;
    if (!body || !isUuid(body.studentId)) {
      return json({ error: "Aluno inválido." }, 400);
    }
    const studentId = body.studentId;
    if (studentId === user.id) {
      return json({
        error: "Você não pode excluir sua própria conta enquanto estiver logado.",
      }, 400);
    }

    const applyPenaltyRequested = body.applyPenalty === true;

    const { data: studentProfile, error: profileError } = await supabase
      .from("profiles")
      .select(
        "id, role, tenant_id, asaas_customer_id, subscription_id, is_test_account",
      )
      .eq("id", studentId)
      .maybeSingle();
    if (profileError) {
      console.error(
        "[delete-student-account] Falha ao consultar alvo",
        profileError.message,
      );
      return json({ error: "Não foi possível validar o aluno." }, 503);
    }
    if (!studentProfile) {
      return json({ error: "Aluno não encontrado." }, 404);
    }
    if (studentProfile.role !== "STUDENT") {
      return json({
        error: "Esta função só pode excluir contas com papel de aluno.",
      }, 409);
    }
    if (
      adminProfile.role !== "SUPER_ADMIN" &&
      studentProfile.tenant_id !== adminProfile.tenant_id
    ) {
      return json({ error: "Aluno pertence a outra escola." }, 403);
    }
    if (!studentProfile.is_test_account) {
      return domainFailure(
        "A exclusão permanente é reservada a contas de teste. Para um aluno real, use a opção “Desligar”, que cancela as cobranças futuras e preserva o histórico.",
      );
    }

    const customerId = studentProfile.asaas_customer_id;
    const subscriptionId = studentProfile.subscription_id;
    // Fixtures jamais geram multa rescisória, mesmo que um caller antigo envie
    // a opção que existia na tela de exclusão de alunos reais.
    const needsAsaas = Boolean(customerId || subscriptionId);
    const asaas: AsaasDeletionResult = {
      subscriptionDeleted: false,
      customerDeleted: false,
      error: null,
      failedStage: null,
    };

    if (needsAsaas && (!RAW_ASAAS_URL || !ASAAS_API_KEY)) {
      return domainFailure(
        "A exclusão foi interrompida porque a integração financeira não está configurada. Nenhum dado local foi removido.",
        { asaas: { ...asaas, error: "Integração Asaas indisponível" } },
      );
    }

    if (needsAsaas) {
      try {
        if (subscriptionId) {
          const response = await fetch(
            `${ASAAS_URL}${ASAAS_PATH_PREFIX}/subscriptions/${subscriptionId}`,
            {
              method: "DELETE",
              headers: { access_token: ASAAS_API_KEY },
            },
          );
          if (response.ok || response.status === 404) {
            asaas.subscriptionDeleted = true;
          } else {
            asaas.failedStage = "subscription";
            asaas.error = await asaasError(response);
          }
        }

        if (!asaas.error && customerId) {
          const response = await fetch(
            `${ASAAS_URL}${ASAAS_PATH_PREFIX}/customers/${customerId}`,
            {
              method: "DELETE",
              headers: { access_token: ASAAS_API_KEY },
            },
          );
          if (response.ok || response.status === 404) {
            asaas.customerDeleted = true;
          } else {
            asaas.failedStage = "customer";
            asaas.error = await asaasError(response);
          }
        }
      } catch (error) {
        asaas.error = error instanceof Error
          ? error.message.slice(0, 500)
          : "Falha de comunicação com o Asaas";
      }
    }

    if (asaas.error) {
      console.error(
        `[delete-student-account] Limpeza Asaas interrompida em ${
          asaas.failedStage || "network"
        }: ${asaas.error}`,
      );
      return domainFailure(
        "A exclusão foi interrompida por uma falha no Asaas. Os dados locais foram preservados; verifique a cobrança antes de tentar novamente.",
        { asaas, retryable: true },
      );
    }

    const { data: deletionTarget, error: deletionTargetError } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", studentId)
      .eq("role", "STUDENT")
      .eq("is_test_account", true)
      .maybeSingle();
    if (deletionTargetError || !deletionTarget) {
      return domainFailure(
        "A conta deixou de estar marcada como teste durante a operação. A exclusão local foi cancelada.",
        { retryable: false, asaas },
      );
    }

    // A ausência no Auth é aceitável apenas para reparar um perfil órfão já
    // autorizado acima por papel e tenant. Outros erros abortam antes do perfil.
    const authLookup = await supabase.auth.admin.getUserById(studentId);
    if (authLookup.error && !isAuthNotFound(authLookup.error)) {
      console.error(
        "[delete-student-account] Falha ao verificar Auth",
        authLookup.error.message,
      );
      return domainFailure(
        "Não foi possível confirmar a conta de acesso. A exclusão local não foi iniciada.",
        { retryable: true },
      );
    }

    let authDeleted = !authLookup.data.user;
    if (authLookup.data.user) {
      const { error: deleteAuthError } = await supabase.auth.admin.deleteUser(
        studentId,
      );
      if (deleteAuthError && !isAuthNotFound(deleteAuthError)) {
        console.error(
          "[delete-student-account] Falha ao excluir Auth",
          deleteAuthError.message,
        );
        return domainFailure(
          "O acesso do aluno não pôde ser removido. O perfil foi preservado.",
          { retryable: true },
        );
      }
      authDeleted = true;
    }

    // A instalação atual não pode depender de cascade Auth -> profiles.
    // A condição role=STUDENT evita ampliar o alvo caso ele tenha mudado
    // entre a autorização e esta etapa.
    const { error: deleteProfileError } = await supabase
      .from("profiles")
      .delete()
      .eq("id", studentId)
      .eq("role", "STUDENT")
      .eq("is_test_account", true);

    const [{ data: remainingProfile, error: profileCheckError }, authCheck] =
      await Promise.all([
        supabase.from("profiles").select("id").eq("id", studentId)
          .maybeSingle(),
        supabase.auth.admin.getUserById(studentId),
      ]);
    const authStillExists = Boolean(authCheck.data.user);
    const authCheckFailed = Boolean(
      authCheck.error && !isAuthNotFound(authCheck.error),
    );

    if (
      deleteProfileError || profileCheckError || remainingProfile ||
      authStillExists || authCheckFailed || !authDeleted
    ) {
      console.error("[delete-student-account] Pós-condição não satisfeita", {
        studentId,
        authStillExists,
        profileStillExists: Boolean(remainingProfile),
        authCheckFailed,
        profileDeleteError: deleteProfileError?.message,
        profileCheckError: profileCheckError?.message,
      });
      return domainFailure(
        "A exclusão ficou incompleta e não foi confirmada. O administrador técnico deve concluir a limpeza antes de uma nova tentativa.",
        {
          partial: true,
          authDeleted: !authStillExists && !authCheckFailed,
          profileDeleted: !remainingProfile && !profileCheckError,
          asaas,
        },
      );
    }

    return json({
      success: true,
      message: "Aluno removido do acesso, do perfil e do financeiro.",
      penaltyIgnoredForTest: applyPenaltyRequested,
      asaas,
    });
  } catch (error) {
    console.error(
      "[delete-student-account] Erro inesperado",
      error instanceof Error ? error.message : error,
    );
    return json({ error: "Erro inesperado ao excluir o aluno." }, 500);
  }
});
