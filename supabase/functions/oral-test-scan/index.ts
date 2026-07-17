import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ORAL-TEST-SCAN — detecta alunos no prazo do teste oral (~45 dias, periódico) e avisa
// o diretor no WhatsApp. Roda via cron diário. Os painéis (admin/professor apto) leem a
// tabela oral_tests diretamente. ?dryrun=1 detecta e retorna a lista SEM enviar mensagem.
//
// Regra: teste oral obrigatório a cada ~45 dias; aplicado por PROFESSOR APTO (can_oral_test)
// ou pela DIRETORIA — nunca pelo professor do próprio aluno. Não é pago (prof apto usa o
// próprio horário já agendado = aula padrão).

const SCAN_TOKEN = "wwlf-oral-7c3a91f5";
const EVOLUTION_BASE = "https://api.2b.app.br";
const EVOLUTION_KEYS = Array.from(new Set([
  (Deno.env.get("EVOLUTION_API_KEY") || "").trim(),
].filter(Boolean)));

async function sendWhats(instance: string, number: string, text: string): Promise<boolean> {
  for (const key of EVOLUTION_KEYS) {
    try {
      const resp = await fetch(`${EVOLUTION_BASE}/message/sendText/${encodeURIComponent(instance)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: key },
        body: JSON.stringify({ number, text, delay: 1200, linkPreview: false }),
        signal: AbortSignal.timeout(15000),
      });
      if (resp.status === 401) continue;
      return resp.ok;
    } catch { return false; }
  }
  return false;
}

function pickOwner(rows: any[]): any | null {
  if (!rows || rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const ga = a.teachers_group_id ? 0 : 1, gb = b.teachers_group_id ? 0 : 1;
    if (ga !== gb) return ga - gb;
    const ra = a.role === "SCHOOL_ADMIN" ? 0 : 1, rb = b.role === "SCHOOL_ADMIN" ? 0 : 1;
    return ra - rb;
  })[0];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200 });
  try {
    const reqUrl = new URL(req.url);
    if (reqUrl.searchParams.get("token") !== SCAN_TOKEN) return new Response("forbidden", { status: 403 });
    const dryrun = reqUrl.searchParams.get("dryrun") === "1";

    const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

    // Tenants operacionais: têm admin com instância + grupo de professores configurado.
    const { data: admins } = await sb.from("profiles")
      .select("id, tenant_id, phone, whatsapp_instance, teachers_group_id, role")
      .in("role", ["SCHOOL_ADMIN", "SUPER_ADMIN"]).not("whatsapp_instance", "is", null).neq("whatsapp_instance", "");
    const byTenant = new Map<string, any[]>();
    for (const a of (admins || [])) {
      if (!a.tenant_id) continue;
      if (!byTenant.has(a.tenant_id)) byTenant.set(a.tenant_id, []);
      byTenant.get(a.tenant_id)!.push(a);
    }

    const summary: any[] = [];

    for (const [tenantId, rows] of byTenant) {
      const owner = pickOwner(rows);
      if (!owner?.teachers_group_id) continue; // só o tenant operacional

      // 1) Detecta novos DUE
      const { data: detected } = await sb.rpc("detect_due_oral_tests", { p_tenant: tenantId });

      // 2) DUE ainda não avisados ao diretor
      const { data: due } = await sb.from("oral_tests")
        .select("id, student_id, native_teacher_id, due_date")
        .eq("tenant_id", tenantId).eq("status", "DUE").is("director_notified_at", null);

      if (!due || due.length === 0) { summary.push({ tenantId, detected, pending_new: 0 }); continue; }

      // Nomes de alunos e professores
      const ids = [...new Set([...due.map((d: any) => d.student_id), ...due.map((d: any) => d.native_teacher_id).filter(Boolean)])];
      const { data: profs } = await sb.from("profiles").select("id, full_name").in("id", ids);
      const nameOf = new Map((profs || []).map((p: any) => [p.id, (p.full_name || "").trim()]));

      // Professores aptos (para o diretor saber quem pode aplicar)
      const { data: apt } = await sb.from("profiles").select("full_name")
        .eq("tenant_id", tenantId).eq("role", "TEACHER").eq("can_oral_test", true);
      const aptNames = (apt || []).map((a: any) => (a.full_name || "").split(" ")[0]).join(", ") || "(nenhum marcado)";

      const lines = due.slice(0, 40).map((d: any) => {
        const st = nameOf.get(d.student_id) || "Aluno";
        const te = d.native_teacher_id ? (nameOf.get(d.native_teacher_id) || "").split(" ")[0] : "-";
        return `• ${st} — prof. atual: ${te}`;
      });
      const extra = due.length > 40 ? `\n…e mais ${due.length - 40}.` : "";
      const msg = `🎓 *Testes Orais pendentes* (${due.length} aluno${due.length > 1 ? "s" : ""})\n\nEstes alunos já passaram de ~45 dias de aula e precisam do teste oral — aplicado por um *professor APTO* ou pela *diretoria*, NUNCA pelo professor do próprio aluno.\n\n${lines.join("\n")}${extra}\n\n🧑‍🏫 *Aptos hoje:* ${aptNames}\n📋 Agende pelo painel de Testes Orais.`;

      let sent = false;
      if (!dryrun) {
        let phone = (owner.phone || "").replace(/\D/g, "");
        if (phone.length === 10 || phone.length === 11) phone = "55" + phone;
        if (phone.length >= 12) {
          sent = await sendWhats(owner.whatsapp_instance, phone, msg);
          if (sent) {
            const idsToMark = due.map((d: any) => d.id);
            await sb.from("oral_tests").update({ director_notified_at: new Date().toISOString() }).in("id", idsToMark);
          }
        }
      }

      summary.push({ tenantId, detected, pending_new: due.length, sent, preview: dryrun ? msg : undefined });
    }

    return new Response(JSON.stringify({ ok: true, dryrun, summary }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("oral-test-scan error", e?.message);
    return new Response(JSON.stringify({ ok: false, error: e?.message }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
});
