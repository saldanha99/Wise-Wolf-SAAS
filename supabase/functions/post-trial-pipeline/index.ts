import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  evaluateCommercialSuppression,
  loadCommercialContactFacts,
} from "../_shared/commercial-contact-policy.ts";

// POST-TRIAL-PIPELINE — cron a cada 30 min. Ataca o vazamento entre "aula experimental dada"
// e "matrícula": achado da auditoria — 9 trials realizados ficavam parados sem proposta
// (ninguém gerava o link) e o link de matrícula, quando gerado, era usado só 4x na história
// (aluno esquecia de clicar).
//
// NÃO decide preço/plano — isso é julgamento humano (TrialsToContracts / RegistrationLinkGenerator).
// Só faz o que é seguro automatizar: AVISAR rápido enquanto o interesse está quente, e
// LEMBRAR o aluno de um link que UM HUMANO já gerou.
//
// A) SEM PROPOSTA: opportunity TRIAL com class_log COMPLETED (aula realmente dada) e
//    NENHUM enrollment_links ainda. >=1h após a aula: nudge ao aluno ("gostou? já te mando
//    os próximos passos") + alerta ao diretor pra gerar a proposta. >=24h ainda sem link:
//    escalonamento (só ao diretor, sem novo toque no aluno).
// B) PROPOSTA PARADA: enrollment_links PENDING (humano já gerou, aluno não converteu).
//    Cadência D1/D3/D7 lembrando o aluno de terminar a matrícula. Para sozinho quando o
//    status sai de PENDING (pago/expirado).
//
// Filtra dados de teste (TREINAMENTO, telefones placeholder tipo 1199999999) que poluem
// a base — não incomodar ninguém que não é lead real.

const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
const EVOLUTION_KEYS = Array.from(new Set([
  (Deno.env.get("EVOLUTION_API_KEY") || "").trim(),
].filter(Boolean)));
const APP_BASE_URL = "https://system.wisewolflanguage.com.br";

async function sendWhats(instance: string, number: string, text: string): Promise<boolean> {
  for (const key of EVOLUTION_KEYS) {
    try {
      const resp = await fetch(`${EVOLUTION_API_BASE}/${encodeURIComponent(instance)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: key },
        body: JSON.stringify({ number, text, delay: 1000, linkPreview: false }),
        signal: AbortSignal.timeout(15000),
      });
      if (resp.status === 401) continue;
      return resp.ok;
    } catch { return false; }
  }
  return false;
}

function cleanPhone(raw: string): string {
  let p = (raw || "").replace(/\D/g, "");
  if (p.length === 10 || p.length === 11) p = "55" + p;
  return p;
}

// Filtra números de placeholder/teste (ex.: 1199999999, 11999999999 — usados em treinos internos)
function looksFake(rawPhone: string, name: string): boolean {
  const digits = (rawPhone || "").replace(/\D/g, "");
  if (!digits || digits.length < 10) return true;
  const mostCommonDigitCount = Math.max(...Array.from(new Set(digits)).map((d) => digits.split(d as string).length - 1));
  if (mostCommonDigitCount >= digits.length - 2) return true; // quase todo dígito repetido
  if (/treinamento|teste\b/i.test(name || "")) return true;
  return false;
}

async function sentEver(sb: any, kind: string, subjectId: string): Promise<boolean> {
  const { data } = await sb.from("automation_sent").select("id").eq("kind", kind).eq("subject_id", subjectId).limit(1);
  return !!(data && data.length);
}
async function claim(sb: any, kind: string, subjectId: string): Promise<boolean> {
  if (await sentEver(sb, kind, subjectId)) return false;
  const { error } = await sb.from("automation_sent").insert({ kind, subject_id: subjectId, ref_date: new Date().toISOString().split("T")[0] });
  return !error;
}

function isServiceRole(bearer: string, serviceKey: string): boolean {
  return Boolean(serviceKey && bearer === serviceKey);
}

serve(async (req) => {
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const bearer = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    if (!isServiceRole(bearer, serviceKey)) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    const sb = createClient(url, serviceKey);

    const result = { nudges: 0, director_alerts: 0, escalations: 0, link_reminders: 0, suppressed_contracted: 0, failures: [] as string[] };

    const { data: admins } = await sb.from("profiles")
      .select("tenant_id, phone, whatsapp_instance")
      .in("role", ["SCHOOL_ADMIN", "SUPER_ADMIN"]).not("whatsapp_instance", "is", null).neq("whatsapp_instance", "");
    const byTenant: Record<string, { instance: string; ownerPhone: string }> = {};
    for (const a of (admins || [])) {
      if (!byTenant[a.tenant_id]) byTenant[a.tenant_id] = { instance: a.whatsapp_instance, ownerPhone: cleanPhone(a.phone || "") };
    }
    const commercialFacts = new Map<string, any>();
    for (const tenantId of Object.keys(byTenant)) {
      try { commercialFacts.set(tenantId, await loadCommercialContactFacts(sb, tenantId)); }
      catch (e) { result.failures.push(`commercial_state ${tenantId}: ${(e as Error).message}`); }
    }

    // ===================== A) EXPERIMENTAL SEM PROPOSTA =====================
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

    const { data: doneTrials } = await sb
      .from("opportunities")
      .select("id, tenant_id, student_name, student_phone, created_at, trial_appointment_id")
      .eq("kind", "TRIAL")
      .eq("status", "CLAIMED")
      .not("trial_appointment_id", "is", null)
      .gte("created_at", thirtyDaysAgo);

    for (const opp of (doneTrials || [])) {
      if (looksFake(opp.student_phone || "", opp.student_name || "")) continue;
      const t = byTenant[opp.tenant_id];
      if (!t) continue;
      const facts = commercialFacts.get(opp.tenant_id);
      if (!facts) continue;
      const suppression = evaluateCommercialSuppression({
        tenantId: opp.tenant_id, phone: opp.student_phone, opportunityId: opp.id,
      }, facts);
      if (suppression.suppressed) { result.suppressed_contracted++; continue; }

      // A aula foi realmente dada? (class_log COMPLETED com subtype experimental, ligado ao appointment)
      const { data: log } = await sb.from("class_logs")
        .select("created_at")
        .eq("appointment_id", String(opp.trial_appointment_id))
        .eq("presence", "COMPLETED")
        .ilike("subtype", "%EXPERIMENTAL%")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!log?.created_at) continue; // aula ainda não aconteceu/lançada
      if (log.created_at > oneHourAgo) continue; // dá 1h de folga antes de cutucar

      // Qualquer proposta ainda ativa ou concluída prova que a proposta existe. Antes,
      // USED desaparecia desta consulta e era interpretado incorretamente como "sem proposta".
      const { data: existingLink } = await sb
        .from("enrollment_links")
        .select("id, status")
        .eq("opportunity_id", opp.id)
        .in("status", ["PENDING", "PROCESSING", "USED"])
        .not("offer_id", "is", null)
        .limit(1)
        .maybeSingle();
      if (existingLink) continue;

      const phone = cleanPhone(opp.student_phone || "");
      const first = (opp.student_name || "").trim().split(" ")[0] || "";
      const nudgeKind = "TRIAL_NO_PROPOSAL_NUDGE";
      const alertKind = "TRIAL_NO_PROPOSAL_ALERT";
      const escalateKind = "TRIAL_NO_PROPOSAL_ESCALATE";

      if (!(await sentEver(sb, nudgeKind, opp.id))) {
        // Toque 1: aluno (calor) + alerta ao diretor (ação)
        if (phone.length >= 12 && (await claim(sb, nudgeKind, opp.id))) {
          const msg = `Oi${first ? ", " + first : ""}! 🐺 Como foi a aula experimental? Espero que tenha curtido! Já vou te passar os próximos passos para continuar estudando com a gente — só um instante 😊`;
          if (await sendWhats(t.instance, phone, msg)) result.nudges++;
          else result.failures.push(`nudge ${opp.id}`);
        }
        if (t.ownerPhone.length >= 12 && (await claim(sb, alertKind, opp.id))) {
          const msg = `🎓 *Experimental dada, falta a proposta!*\n\n*${opp.student_name || "-"}* fez a aula experimental e ainda não tem link de matrícula gerado.\n\nGere a proposta em Experimental → Gerar Contrato enquanto o interesse está quente. 🔥`;
          if (await sendWhats(t.instance, t.ownerPhone, msg)) result.director_alerts++;
          else result.failures.push(`alert ${opp.id}`);
        }
      } else if (log.created_at < dayAgo && !(await sentEver(sb, escalateKind, opp.id))) {
        // >=24h ainda sem proposta: só escalona ao diretor (não insiste de novo com o aluno)
        if (t.ownerPhone.length >= 12 && (await claim(sb, escalateKind, opp.id))) {
          const msg = `⚠️ *Proposta ainda não gerada há +24h*\n\n*${opp.student_name || "-"}* fez a experimental ontem e continua sem link de matrícula. O interesse esfria rápido — vale gerar a proposta ou ligar pro aluno.`;
          if (await sendWhats(t.instance, t.ownerPhone, msg)) result.escalations++;
          else result.failures.push(`escalate ${opp.id}`);
        }
      }
    }

    // ===================== B) PROPOSTA PARADA (link PENDING) =====================
    const { data: pendingLinks } = await sb
      .from("enrollment_links")
      .select("id, tenant_id, student_name, student_phone, link_url, created_at")
      .eq("status", "PENDING")
      .not("offer_id", "is", null)
      .gte("created_at", thirtyDaysAgo);

    for (const link of (pendingLinks || [])) {
      if (looksFake(link.student_phone || "", link.student_name || "")) continue;
      const t = byTenant[link.tenant_id];
      if (!t) continue;
      const facts = commercialFacts.get(link.tenant_id);
      if (!facts) continue;
      const suppression = evaluateCommercialSuppression({
        tenantId: link.tenant_id, phone: link.student_phone,
      }, facts);
      if (suppression.suppressed) { result.suppressed_contracted++; continue; }
      const phone = cleanPhone(link.student_phone || "");
      if (phone.length < 12) continue;
      const ageMs = Date.now() - new Date(link.created_at).getTime();
      const ageDays = ageMs / 86400000;
      const first = (link.student_name || "").trim().split(" ")[0] || "";

      let step: "D1" | "D3" | "D7" | null = null;
      if (ageDays >= 7) step = "D7";
      else if (ageDays >= 3) step = "D3";
      else if (ageDays >= 1) step = "D1";
      if (!step) continue;

      const kind = `ENROLL_REMIND_${step}`;
      if (await sentEver(sb, kind, link.id)) continue;
      if (!(await claim(sb, kind, link.id))) continue;

      const msgByStep: Record<string, string> = {
        D1: `Oi${first ? ", " + first : ""}! 🐺 Vi que você ainda não finalizou sua matrícula. Qualquer dúvida sobre o plano é só me chamar — o link continua valendo aqui:\n${link.link_url}`,
        D3: `Oi${first ? ", " + first : ""}! Passando só pra lembrar da sua matrícula na Wise Wolf 😊 Não deixa sua vaga esfriar — finaliza quando puder:\n${link.link_url}`,
        D7: `Oi${first ? ", " + first : ""}! Última lembrança por aqui: sua proposta de matrícula ainda está aberta. Se ainda fizer sentido pra você, é só finalizar:\n${link.link_url}\n\nSe não for mais o momento, sem problema — é só me avisar! 🐺`,
      };
      if (await sendWhats(t.instance, phone, msgByStep[step])) result.link_reminders++;
      else result.failures.push(`link_remind ${link.id}`);
    }

    return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
