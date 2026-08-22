import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { authorizeAutomation } from "../_shared/automation-auth.ts";
import { loadTenantWhatsAppRoute } from "../_shared/tenant-communication.ts";

// ORAL-TEST-SCAN — detects students due for the periodic oral checkpoint and
// notifies the tenant director. Database claims prevent concurrent cron runs
// from sending the same row twice.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const EVOLUTION_BASE = (Deno.env.get("EVOLUTION_API_URL") || "")
  .trim()
  .replace(/\/+$/, "");
const EVOLUTION_KEYS = Array.from(
  new Set(
    [(Deno.env.get("EVOLUTION_API_KEY") || "").trim()].filter(Boolean),
  ),
);
const CLAIM_LEASE_MS = 10 * 60 * 1000;

type DueRow = {
  id: string;
  student_id: string;
  native_teacher_id: string | null;
  due_date: string;
  student?: { is_test_account?: boolean | null } | null;
};
type ProfileNameRow = {
  id: string;
  full_name: string | null;
};
type TeacherNameRow = {
  full_name: string | null;
};

async function sendWhats(
  instance: string,
  number: string,
  text: string,
): Promise<boolean> {
  if (!EVOLUTION_BASE || EVOLUTION_KEYS.length === 0) return false;
  for (const key of EVOLUTION_KEYS) {
    try {
      const response = await fetch(
        `${EVOLUTION_BASE}/message/sendText/${encodeURIComponent(instance)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: key },
          body: JSON.stringify({
            number,
            text,
            delay: 1200,
            linkPreview: false,
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (response.status === 401) continue;
      return response.ok;
    } catch {
      return false;
    }
  }
  return false;
}

async function releaseClaims(
  supabase: SupabaseClient,
  ids: string[],
): Promise<boolean> {
  if (ids.length === 0) return true;
  const { error } = await supabase
    .from("oral_tests")
    .update({ director_notification_claimed_at: null })
    .in("id", ids)
    .is("director_notified_at", null);
  return !error;
}

async function markNotified(
  supabase: SupabaseClient,
  ids: string[],
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase
      .from("oral_tests")
      .update({
        director_notified_at: new Date().toISOString(),
        director_notification_claimed_at: null,
      })
      .in("id", ids)
      .is("director_notified_at", null)
      .select("id");
    if (!error && (data?.length ?? 0) === ids.length) return true;
  }
  return false;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }
  const authError = await authorizeAutomation(req, corsHeaders);
  if (authError) return authError;

  try {
    const requestUrl = new URL(req.url);
    const dryrun = requestUrl.searchParams.get("dryrun") === "1";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: tenants, error: tenantsError } = await supabase
      .from("tenants")
      .select("id");
    if (tenantsError) throw tenantsError;

    const summary: Array<Record<string, unknown>> = [];
    let persistenceFailed = false;

    for (const tenant of tenants ?? []) {
      const tenantId = String(tenant.id || "");
      if (!tenantId) continue;
      const route = await loadTenantWhatsAppRoute(supabase, tenantId, "teacher");
      if (!route?.teachersGroupId || !route.ownerPhone) continue;

      let detected = 0;
      if (!dryrun) {
        const { data, error: detectionError } = await supabase.rpc(
          "detect_due_oral_tests",
          { p_tenant: tenantId },
        );
        if (detectionError) throw detectionError;
        detected = typeof data === "number" ? data : 0;
      }

      if (!dryrun) {
        const staleBefore = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
        const { error: recoveryError } = await supabase
          .from("oral_tests")
          .update({ director_notification_claimed_at: null })
          .eq("tenant_id", tenantId)
          .is("director_notified_at", null)
          .lt("director_notification_claimed_at", staleBefore);
        if (recoveryError) throw recoveryError;
      }

      const { data: dueRows, error: dueError } = await supabase
        .from("oral_tests")
        .select(`
          id,
          student_id,
          native_teacher_id,
          due_date,
          student:student_id ( is_test_account )
        `)
        .eq("tenant_id", tenantId)
        .eq("status", "DUE")
        .is("director_notified_at", null)
        .is("director_notification_claimed_at", null);
      if (dueError) throw dueError;

      const candidates = ((dueRows ?? []) as DueRow[])
        .filter((row) => row.student?.is_test_account !== true);
      if (candidates.length === 0) {
        summary.push({ tenantId, detected, pending_new: 0 });
        continue;
      }

      const claimed: DueRow[] = [];
      if (dryrun) {
        claimed.push(...candidates);
      } else {
        for (const candidate of candidates) {
          const { data: claim, error: claimError } = await supabase
            .from("oral_tests")
            .update({
              director_notification_claimed_at: new Date().toISOString(),
            })
            .eq("id", candidate.id)
            .is("director_notified_at", null)
            .is("director_notification_claimed_at", null)
            .select("id")
            .maybeSingle();
          if (claimError) throw claimError;
          if (claim) claimed.push(candidate);
        }
      }

      if (claimed.length === 0) {
        summary.push({ tenantId, detected, pending_new: 0 });
        continue;
      }

      const profileIds = [
        ...new Set([
          ...claimed.map((row) => row.student_id),
          ...claimed.map((row) => row.native_teacher_id).filter(Boolean),
        ]),
      ] as string[];
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", profileIds);
      if (profilesError) {
        if (!dryrun) {
          await releaseClaims(supabase, claimed.map((row) => row.id));
        }
        throw profilesError;
      }
      const nameOf = new Map(
        ((profiles ?? []) as ProfileNameRow[]).map((profile) => [
          profile.id,
          (profile.full_name || "").trim(),
        ]),
      );

      const { data: eligibleTeachers, error: eligibleError } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("tenant_id", tenantId)
        .eq("role", "TEACHER")
        .eq("can_oral_test", true);
      if (eligibleError) {
        if (!dryrun) {
          await releaseClaims(supabase, claimed.map((row) => row.id));
        }
        throw eligibleError;
      }
      const eligibleNames = ((eligibleTeachers ?? []) as TeacherNameRow[])
        .map((teacher) => (teacher.full_name || "").split(" ")[0])
        .filter(Boolean)
        .join(", ") || "(nenhum marcado)";

      const lines = claimed.slice(0, 40).map((row) => {
        const studentName = nameOf.get(row.student_id) || "Aluno";
        const teacherName = row.native_teacher_id
          ? (nameOf.get(row.native_teacher_id) || "").split(" ")[0]
          : "-";
        return `• ${studentName} — prof. atual: ${teacherName}`;
      });
      const extra = claimed.length > 40
        ? `\n…e mais ${claimed.length - 40}.`
        : "";
      const message =
        `🎓 *Testes Orais pendentes* (${claimed.length} aluno${claimed.length > 1 ? "s" : ""})\n\nEstes alunos já passaram de ~45 dias de aula e precisam do teste oral — aplicado por um *professor APTO* ou pela *diretoria*, NUNCA pelo professor do próprio aluno.\n\n${lines.join("\n")}${extra}\n\n🧑‍🏫 *Aptos hoje:* ${eligibleNames}\n📋 Agende pelo painel de Testes Orais.`;

      let sent = false;
      let markerSaved = true;
      if (!dryrun) {
        sent = await sendWhats(
          route.instanceName,
          route.ownerPhone,
          message,
        );

        const claimedIds = claimed.map((row) => row.id);
        if (sent) {
          markerSaved = await markNotified(supabase, claimedIds);
          if (!markerSaved) {
            persistenceFailed = true;
            console.error("Oral-test notification marker failed", {
              tenantId,
              count: claimedIds.length,
            });
          }
        } else {
          markerSaved = await releaseClaims(supabase, claimedIds);
          persistenceFailed ||= !markerSaved;
        }
      }

      summary.push({
        tenantId,
        detected,
        pending_new: claimed.length,
        sent,
        marker_saved: markerSaved,
        preview: dryrun ? message : undefined,
      });
    }

    return new Response(
      JSON.stringify({ ok: !persistenceFailed, dryrun, summary }),
      {
        status: persistenceFailed ? 500 : 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: unknown) {
    console.error("Oral-test scan failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return new Response(
      JSON.stringify({ ok: false, error: "oral_test_scan_failed" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
