import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowService: true,
    allowedRoles: ["SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;

  try {
    const supabase = auth.context.admin;

    console.log("🔄 Starting Ledger Reconciliation...");

    // 1. Fetch Unreconciled Payments
    //
    // ⚠️ O conjunto de status tem de ser IDÊNTICO ao do trigger
    // `ledger_on_payment_received` e ao do `get_cashflow`/`dre_gerencial`.
    // Estava `['RECEIVED','CONFIRMED']` — divergia nas DUAS pontas: incluía
    // CONFIRMED (que saiu do trigger, porque na Asaas é pagamento
    // reconhecido e ainda não liquidado, e o painel de caixa nunca o
    // contou) e ignorava RECEIVED_IN_CASH (que o trigger sempre lançou).
    // Duas fontes com regras diferentes para "isto é caixa?" é exatamente
    // o defeito que esta conciliação existe para acabar.
    const { data: payments, error: fetchError } = await supabase
      .from("student_payments")
      .select("*")
      .in("status", ["RECEIVED", "RECEIVED_IN_CASH"])
      .eq("ledger_entry_created", false)
      .limit(100); // Batch size

    if (fetchError) throw fetchError;

    console.log(`📊 Found ${payments?.length || 0} payments to reconcile.`);

    const results = {
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
    };

    if (payments && payments.length > 0) {
      for (const payment of payments) {
        results.processed++;

        // Double check if transaction already exists (Idempotency)
        // We check by `student_payment_id`
        const { data: existing, error: checkError } = await supabase
          .from("financial_transactions")
          .select("id")
          .eq("student_payment_id", payment.id)
          .single();

        if (existing) {
          console.warn(
            `⚠️ Transaction already exists for Payment ID ${payment.id}. Marking as reconciled.`,
          );
          await supabase.from("student_payments").update({
            ledger_entry_created: true,
          }).eq("id", payment.id);
          results.skipped++;
          continue;
        }

        // Pagamento sem tenant NÃO vira receita da Wise Wolf por default.
        // O fallback que estava aqui adotava em silêncio o dinheiro de
        // quem não tem escola definida — a mesma razão pela qual 38
        // pagamentos órfãos (R$ 11.466,74) aparecem hoje como receita
        // dela. Sem tenant, registra a pendência e segue.
        if (!payment.tenant_id) {
          console.warn(
            `[reconcile-ledger] pagamento sem tenant, não conciliado: ${payment.id}`,
          );
          await supabase.from("reconciliation_issues").insert({
            // ⚠️ reconciliation_issues.tenant_id é NOT NULL — inserir
            // null aqui falhava em silêncio (supabase-js devolve erro
            // em vez de lançar, e o `continue` engolia). Pagamento sem
            // escola é item de triagem da plataforma.
            tenant_id: "master",
            kind: "PAYMENT_WITHOUT_TENANT",
            student_payment_id: payment.id,
            details: { value: payment.value, description: payment.description },
          });
          results.skipped++;
          continue;
        }

        const valor = Number(payment.value) || 0;
        const amountCents = payment.amount_cents || Math.round(valor * 100);

        const { error: insertError } = await supabase
          .from("financial_transactions")
          .insert({
            tenant_id: payment.tenant_id,
            type: "ENTRADA",
            // Mesma categoria do trigger `ledger_on_payment_received`.
            // Esta função gravava 'student_tuition' e o trigger
            // 'MENSALIDADE' — duas eras para a mesma coisa na mesma
            // tabela, que o mapa do DRE tem de reconciliar na leitura.
            category: "MENSALIDADE",
            // ⚠️ `amount` é NOT NULL e esta função NUNCA o enviava:
            // todo insert morria em "null value in column amount
            // violates not-null constraint". Era o único caminho de
            // conserto dos 27 pagamentos sem lançamento (R$ 9.390,00)
            // e estava morto — provado em BEGIN/ROLLBACK contra a VPS.
            amount: valor,
            amount_cents: amountCents,
            description: `Mensalidade - Ref: ${payment.description || "Asaas"}`,
            student_payment_id: payment.id,
            reference_id: payment.student_id, // Legacy field, keeping for now
            // Mesma cadeia de competência de get_cashflow e do trigger.
            // `new Date()` só como última rede: usá-lo cedo joga o
            // pagamento para o mês em que a conciliação rodou, não
            // para o mês em que o aluno pagou.
            occurred_at: payment.paid_at || payment.payment_date ||
              payment.due_date || new Date().toISOString(),
          });

        if (insertError) {
          console.error(
            `❌ Failed to create transaction for Payment ${payment.id}:`,
            insertError,
          );

          // Log Issue
          await supabase.from("reconciliation_issues").insert({
            tenant_id: payment.tenant_id,
            kind: "LEDGER_INSERT_FAILED",
            student_payment_id: payment.id,
            details: { error: insertError },
          });
          results.failed++;
        } else {
          // Mark as Reconciled
          const { error: updateError } = await supabase
            .from("student_payments")
            .update({ ledger_entry_created: true })
            .eq("id", payment.id);

          if (updateError) {
            console.error(
              `❌ Failed to update Payment status ${payment.id}:`,
              updateError,
            );
            // This is bad, we created the transaction but failed to mark it.
            // Idempotency check in next run should handle it, but still risky.
            results.failed++;
          } else {
            results.success++;
          }
        }
      }
    }

    return new Response(
      JSON.stringify({
        message: "Reconciliation Completed",
        stats: results,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      },
    );
  } catch (err: any) {
    console.error("❌ Critical Reconciliation Error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      headers: corsHeaders,
      status: 500,
    });
  }
});
