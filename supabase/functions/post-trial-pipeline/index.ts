import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  evaluateCommercialSuppression,
  loadCommercialContactFacts,
} from "../_shared/commercial-contact-policy.ts";
import { loadTenantWhatsAppRoute } from "../_shared/tenant-communication.ts";
import {
  type AutomationClaimReceipt,
  type AutomationClaimStore,
  claimAutomationDelivery,
  classifyProviderHttpResponse,
  isEnrollmentOfferReminderEligible,
  isMeaningfulEnrollmentOffer,
  isOpenConversionStatus,
  isPendingEnrollmentLinkStatus,
  type ProviderDeliveryOutcome,
  requireAutomationReceiptInsert,
  requireRootAutomationRows,
  shouldReleaseAutomationClaim,
} from "./core.ts";

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
const EVOLUTION_KEYS = Array.from(
  new Set([
    (Deno.env.get("EVOLUTION_API_KEY") || "").trim(),
  ].filter(Boolean)),
);

async function sendWhats(
  instance: string,
  number: string,
  text: string,
): Promise<ProviderDeliveryOutcome> {
  for (const key of EVOLUTION_KEYS) {
    try {
      const resp = await fetch(
        `${EVOLUTION_API_BASE}/${encodeURIComponent(instance)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: key },
          body: JSON.stringify({
            number,
            text,
            delay: 1000,
            linkPreview: false,
          }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (resp.status === 401) continue;
      return classifyProviderHttpResponse(resp.status);
    } catch {
      // Timeout/queda de rede depois do POST pode esconder uma aceitação. Manter
      // o recibo evita que o cron duplique uma mensagem de resultado incerto.
      return "UNCERTAIN";
    }
  }
  // Sem credencial válida, o limite do provedor não foi cruzado.
  return "REJECTED";
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
  const mostCommonDigitCount = Math.max(
    ...Array.from(new Set(digits)).map((d) =>
      digits.split(d as string).length - 1
    ),
  );
  if (mostCommonDigitCount >= digits.length - 2) return true; // quase todo dígito repetido
  if (/treinamento|teste\b/i.test(name || "")) return true;
  return false;
}

function automationClaimStore(sb: any): AutomationClaimStore {
  return {
    hasReceipt: async (kind, subjectId) => {
      const { data, error } = await sb.from("automation_sent").select("id")
        .eq("kind", kind).eq("subject_id", subjectId).limit(1).maybeSingle();
      if (error) {
        throw new Error(
          `automation_receipt_lookup_failed:${error.code || "query"}`,
        );
      }
      return Boolean(data?.id);
    },
    insertReceipt: async ({ kind, subjectId, refDate }) => {
      const result = await sb.from("automation_sent").insert({
        kind,
        subject_id: subjectId,
        ref_date: refDate,
      }).select("id").maybeSingle();
      return requireAutomationReceiptInsert(result);
    },
    deleteReceiptById: async (id) => {
      const { data, error } = await sb.from("automation_sent").delete().eq(
        "id",
        id,
      ).select("id").maybeSingle();
      if (error || data?.id !== id) {
        throw new Error(
          `automation_receipt_release_failed:${error?.code || "missing"}`,
        );
      }
    },
  };
}

async function revalidateOpenOpportunity(
  sb: any,
  tenantId: string,
  opportunityId: string,
): Promise<"ELIGIBLE" | "CLOSED" | "UNAVAILABLE"> {
  const { data, error } = await sb.from("opportunities")
    .select("id,conversion_status")
    .eq("id", opportunityId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) return "UNAVAILABLE";
  return data?.id === opportunityId &&
      isOpenConversionStatus(data.conversion_status)
    ? "ELIGIBLE"
    : "CLOSED";
}

async function revalidatePendingLinkForOpenOpportunity(
  sb: any,
  tenantId: string,
  linkId: string,
  opportunityId: string,
): Promise<"ELIGIBLE" | "CLOSED" | "UNAVAILABLE"> {
  const { data, error } = await sb.from("enrollment_links")
    .select("id,status,opportunity_id,offer_id")
    .eq("id", linkId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) return "UNAVAILABLE";
  if (
    data?.id !== linkId || data.opportunity_id !== opportunityId ||
    !data.offer_id ||
    !isPendingEnrollmentLinkStatus(data.status)
  ) {
    return "CLOSED";
  }

  const { data: offer, error: offerError } = await sb.from("offers")
    .select(
      "id,kind,opportunity_id,revoked_at,consumed_at,expires_at,processing_state",
    )
    .eq("id", data.offer_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (offerError) return "UNAVAILABLE";
  if (
    !offer ||
    !isEnrollmentOfferReminderEligible(offer, opportunityId, Date.now())
  ) return "CLOSED";

  return await revalidateOpenOpportunity(sb, tenantId, opportunityId);
}

async function revalidateNoMeaningfulEnrollmentProposal(
  sb: any,
  tenantId: string,
  opportunityId: string,
): Promise<"ELIGIBLE" | "CLOSED" | "UNAVAILABLE"> {
  const opportunityState = await revalidateOpenOpportunity(
    sb,
    tenantId,
    opportunityId,
  );
  if (opportunityState !== "ELIGIBLE") return opportunityState;

  const { data: links, error: linksError } = await sb
    .from("enrollment_links")
    .select("offer_id")
    .eq("tenant_id", tenantId)
    .eq("opportunity_id", opportunityId)
    .in("status", ["PENDING", "PROCESSING", "USED"])
    .not("offer_id", "is", null)
    .limit(10);
  if (linksError) return "UNAVAILABLE";

  const offerIds = Array.from(
    new Set(
      (links || []).map((link: any) => String(link.offer_id || ""))
        .filter(Boolean),
    ),
  );
  if (offerIds.length === 0) return "ELIGIBLE";

  const { data: offers, error: offersError } = await sb.from("offers")
    .select(
      "id,kind,opportunity_id,revoked_at,consumed_at,expires_at,processing_state",
    )
    .eq("tenant_id", tenantId)
    .in("id", offerIds);
  if (offersError) return "UNAVAILABLE";

  return (offers || []).some((offer: any) =>
      isMeaningfulEnrollmentOffer(offer, opportunityId, Date.now())
    )
    ? "CLOSED"
    : "ELIGIBLE";
}

function isServiceRole(bearer: string, serviceKey: string): boolean {
  return Boolean(serviceKey && bearer === serviceKey);
}

serve(async (req) => {
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const bearer = (req.headers.get("Authorization") || "").replace(
      "Bearer ",
      "",
    ).trim();
    if (!isServiceRole(bearer, serviceKey)) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
      });
    }
    const sb = createClient(url, serviceKey);

    const result = {
      nudges: 0,
      director_alerts: 0,
      escalations: 0,
      link_reminders: 0,
      awaiting_feedback: 0,
      suppressed_contracted: 0,
      suppressed_closed: 0,
      failures: [] as string[],
    };
    const claimStore = automationClaimStore(sb);
    const refDate = new Date().toISOString().split("T")[0];
    const sentEver = (kind: string, subjectId: string) =>
      claimStore.hasReceipt(kind, subjectId);
    const releaseClaim = async (
      receipt: AutomationClaimReceipt,
      label: string,
    ) => {
      try {
        await receipt.undo();
      } catch (error) {
        result.failures.push(
          `${label}_receipt_release ${receipt.id}: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
    };
    const deliverClaimed = async (input: {
      kind: string;
      subjectId: string;
      label: string;
      instance: string;
      number: string;
      message: string;
      validate: () => Promise<"ELIGIBLE" | "CLOSED" | "UNAVAILABLE">;
      accepted: () => void;
    }) => {
      const receipt = await claimAutomationDelivery(
        claimStore,
        input.kind,
        input.subjectId,
        refDate,
      );
      if (!receipt) return;

      // A claim e a leitura inicial podem ter ocorrido antes de a gestao marcar
      // LOST/WON ou de o aluno iniciar a matricula. Revalida no ultimo ponto
      // seguro antes do limite externo.
      const eligibility = await input.validate();
      if (eligibility !== "ELIGIBLE") {
        await releaseClaim(receipt, input.label);
        if (eligibility === "UNAVAILABLE") {
          result.failures.push(
            `${input.label}_state_unavailable ${input.subjectId}`,
          );
        } else {
          result.suppressed_closed++;
        }
        return;
      }

      const outcome = await sendWhats(
        input.instance,
        input.number,
        input.message,
      );
      if (outcome === "ACCEPTED") {
        input.accepted();
        return;
      }
      if (shouldReleaseAutomationClaim(outcome)) {
        await releaseClaim(receipt, input.label);
      }
      result.failures.push(
        `${input.label}${
          outcome === "UNCERTAIN" ? "_uncertain" : ""
        } ${input.subjectId}`,
      );
    };
    const routeCache = new Map<
      string,
      ReturnType<typeof loadTenantWhatsAppRoute>
    >();
    const routeFor = (tenantId: string, audience: "general" | "student") => {
      const normalizedTenantId = String(tenantId || "").trim();
      const key = `${normalizedTenantId}:${audience}`;
      if (!normalizedTenantId) return Promise.resolve(null);
      let pending = routeCache.get(key);
      if (!pending) {
        pending = loadTenantWhatsAppRoute(sb, normalizedTenantId, audience)
          .catch((error) => {
            result.failures.push(
              `whatsapp_route ${normalizedTenantId}: ${
                (error as Error).message
              }`,
            );
            return null;
          });
        routeCache.set(key, pending);
      }
      return pending;
    };
    const commercialFacts = new Map<string, Promise<any | null>>();
    const factsFor = (tenantId: string) => {
      const key = String(tenantId || "").trim();
      if (!key) return Promise.resolve(null);
      let pending = commercialFacts.get(key);
      if (!pending) {
        pending = loadCommercialContactFacts(sb, key).catch((error) => {
          result.failures.push(
            `commercial_state ${key}: ${(error as Error).message}`,
          );
          return null;
        });
        commercialFacts.set(key, pending);
      }
      return pending;
    };

    // ===================== A) EXPERIMENTAL SEM PROPOSTA =====================
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000)
      .toISOString();

    const doneTrialsResult = await sb
      .from("opportunities")
      .select(
        "id, tenant_id, student_name, student_phone, created_at, trial_appointment_id, winner_teacher_id, professor_id, conversion_status, feedback_required",
      )
      .eq("kind", "TRIAL")
      .eq("status", "CLAIMED")
      .eq("conversion_status", "OPEN")
      .not("trial_appointment_id", "is", null);
    const doneTrials = requireRootAutomationRows(
      "done_trials",
      doneTrialsResult,
    );

    for (const opp of doneTrials) {
      if (looksFake(opp.student_phone || "", opp.student_name || "")) continue;
      const [studentRoute, internalRoute] = await Promise.all([
        routeFor(opp.tenant_id, "student"),
        routeFor(opp.tenant_id, "general"),
      ]);
      if (!studentRoute && !internalRoute) continue;
      const facts = await factsFor(opp.tenant_id);
      if (!facts) continue;
      const suppression = evaluateCommercialSuppression({
        tenantId: opp.tenant_id,
        phone: opp.student_phone,
        opportunityId: opp.id,
      }, facts);
      if (suppression.suppressed) {
        result.suppressed_contracted++;
        continue;
      }

      // A aula foi realmente dada? (class_log COMPLETED com subtype experimental, ligado ao appointment)
      const { data: log, error: logError } = await sb.from("class_logs")
        .select("created_at")
        .eq("appointment_id", String(opp.trial_appointment_id))
        .eq("presence", "COMPLETED")
        .ilike("subtype", "%EXPERIMENTAL%")
        .gte("created_at", thirtyDaysAgo)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (logError) {
        result.failures.push(
          `trial_class_log_unavailable ${opp.id}: ${logError.code || "query"}`,
        );
        continue;
      }
      if (!log?.created_at) continue; // aula ainda não aconteceu/lançada
      if (log.created_at > oneHourAgo) continue; // dá 1h de folga antes de cutucar

      if (opp.feedback_required === true) {
        const { data: feedback, error: feedbackError } = await sb
          .from("trial_feedback")
          .select("id,booking_id,teacher_id")
          .eq("opportunity_id", opp.id)
          .eq("tenant_id", opp.tenant_id)
          .limit(1)
          .maybeSingle();
        if (feedbackError) {
          result.failures.push(`trial_feedback_unavailable ${opp.id}`);
          continue;
        }
        const responsibleTeacherId = opp.winner_teacher_id || opp.professor_id;
        if (
          !feedback?.id ||
          !responsibleTeacherId ||
          feedback.booking_id !== opp.trial_appointment_id ||
          feedback.teacher_id !== responsibleTeacherId
        ) {
          result.awaiting_feedback++;
          continue;
        }
      }

      // Uma proposta só conta se o link e a oferta correspondente continuarem
      // utilizáveis ou se a matrícula já tiver começado/concluído. Link PENDING
      // apontando para oferta revogada/expirada não pode mascarar o vazamento.
      const { data: existingLinks, error: existingLinksError } = await sb
        .from("enrollment_links")
        .select("id,status,offer_id")
        .eq("opportunity_id", opp.id)
        .in("status", ["PENDING", "PROCESSING", "USED"])
        .not("offer_id", "is", null)
        .limit(10);
      if (existingLinksError) {
        result.failures.push(`proposal_links_unavailable ${opp.id}`);
        continue;
      }

      const offerIds = Array.from(
        new Set(
          (existingLinks || []).map((link: any) => String(link.offer_id || ""))
            .filter(Boolean),
        ),
      );
      let meaningfulProposal = false;
      if (offerIds.length > 0) {
        const { data: offers, error: offersError } = await sb.from("offers")
          .select(
            "id,kind,opportunity_id,revoked_at,consumed_at,expires_at,processing_state",
          )
          .eq("tenant_id", opp.tenant_id)
          .in("id", offerIds);
        if (offersError) {
          result.failures.push(`proposal_offers_unavailable ${opp.id}`);
          continue;
        }
        meaningfulProposal = (offers || []).some((offer: any) =>
          isMeaningfulEnrollmentOffer(offer, opp.id, Date.now())
        );
      }
      if (meaningfulProposal) continue;

      const phone = cleanPhone(opp.student_phone || "");
      const first = (opp.student_name || "").trim().split(" ")[0] || "";
      const nudgeKind = "TRIAL_NO_PROPOSAL_NUDGE";
      const alertKind = "TRIAL_NO_PROPOSAL_ALERT";
      const escalateKind = "TRIAL_NO_PROPOSAL_ESCALATE";

      if (!(await sentEver(nudgeKind, opp.id))) {
        // Toque 1: aluno (calor) + alerta ao diretor (ação)
        if (studentRoute && phone.length >= 12) {
          const msg = `Oi${
            first ? ", " + first : ""
          }! Como foi a aula experimental? Espero que tenha curtido! Já vou te passar os próximos passos para continuar estudando com a gente — só um instante 😊`;
          await deliverClaimed({
            kind: nudgeKind,
            subjectId: opp.id,
            label: "nudge",
            instance: studentRoute.instanceName,
            number: phone,
            message: msg,
            validate: () =>
              revalidateNoMeaningfulEnrollmentProposal(
                sb,
                opp.tenant_id,
                opp.id,
              ),
            accepted: () => result.nudges++,
          });
        }
        if (
          internalRoute?.ownerPhone && internalRoute.ownerPhone.length >= 12
        ) {
          const msg = `🎓 *Experimental dada, falta a proposta!*\n\n*${
            opp.student_name || "-"
          }* fez a aula experimental e ainda não tem link de matrícula gerado.\n\nGere a proposta em Experimental → Gerar Contrato enquanto o interesse está quente. 🔥`;
          await deliverClaimed({
            kind: alertKind,
            subjectId: opp.id,
            label: "alert",
            instance: internalRoute.instanceName,
            number: internalRoute.ownerPhone,
            message: msg,
            validate: () =>
              revalidateNoMeaningfulEnrollmentProposal(
                sb,
                opp.tenant_id,
                opp.id,
              ),
            accepted: () => result.director_alerts++,
          });
        }
      } else if (
        log.created_at < dayAgo && !(await sentEver(escalateKind, opp.id))
      ) {
        // >=24h ainda sem proposta: só escalona ao diretor (não insiste de novo com o aluno)
        if (
          internalRoute?.ownerPhone && internalRoute.ownerPhone.length >= 12
        ) {
          const msg = `⚠️ *Proposta ainda não gerada há +24h*\n\n*${
            opp.student_name || "-"
          }* fez a experimental ontem e continua sem link de matrícula. O interesse esfria rápido — vale gerar a proposta ou ligar pro aluno.`;
          await deliverClaimed({
            kind: escalateKind,
            subjectId: opp.id,
            label: "escalate",
            instance: internalRoute.instanceName,
            number: internalRoute.ownerPhone,
            message: msg,
            validate: () =>
              revalidateNoMeaningfulEnrollmentProposal(
                sb,
                opp.tenant_id,
                opp.id,
              ),
            accepted: () => result.escalations++,
          });
        }
      }
    }

    // ===================== B) PROPOSTA PARADA (link PENDING) =====================
    const pendingLinksResult = await sb
      .from("enrollment_links")
      .select(
        "id, tenant_id, opportunity_id, student_name, student_phone, link_url, created_at",
      )
      .eq("status", "PENDING")
      .not("offer_id", "is", null)
      .not("opportunity_id", "is", null)
      .gte("created_at", thirtyDaysAgo);
    const pendingLinks = requireRootAutomationRows(
      "pending_enrollment_links",
      pendingLinksResult,
    );

    for (const link of pendingLinks) {
      if (looksFake(link.student_phone || "", link.student_name || "")) {
        continue;
      }
      const t = await routeFor(link.tenant_id, "student");
      if (!t) continue;
      const facts = await factsFor(link.tenant_id);
      if (!facts) continue;
      const suppression = evaluateCommercialSuppression({
        tenantId: link.tenant_id,
        phone: link.student_phone,
      }, facts);
      if (suppression.suppressed) {
        result.suppressed_contracted++;
        continue;
      }
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
      if (await sentEver(kind, link.id)) continue;

      const msgByStep: Record<string, string> = {
        D1: `Oi${
          first ? ", " + first : ""
        }! Vi que você ainda não finalizou sua matrícula. Qualquer dúvida sobre o plano é só me chamar — o link continua valendo aqui:\n${link.link_url}`,
        D3: `Oi${
          first ? ", " + first : ""
        }! Passando só pra lembrar da sua matrícula na ${t.identity.brandName} 😊 Não deixa sua vaga esfriar — finaliza quando puder:\n${link.link_url}`,
        D7: `Oi${
          first ? ", " + first : ""
        }! Última lembrança por aqui: sua proposta de matrícula ainda está aberta. Se ainda fizer sentido pra você, é só finalizar:\n${link.link_url}\n\nSe não for mais o momento, sem problema — é só me avisar!`,
      };
      await deliverClaimed({
        kind,
        subjectId: link.id,
        label: "link_remind",
        instance: t.instanceName,
        number: phone,
        message: msgByStep[step],
        validate: () =>
          revalidatePendingLinkForOpenOpportunity(
            sb,
            link.tenant_id,
            link.id,
            link.opportunity_id,
          ),
        accepted: () => result.link_reminders++,
      });
    }

    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
