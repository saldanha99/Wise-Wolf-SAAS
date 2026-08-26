import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

type LedgerPage = {
  busy?: boolean;
  processed?: number;
  inserted?: number;
  flags_corrected?: number;
  next_after_id?: string | null;
  has_more?: boolean;
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
    const requested = (await req.json().catch(() => ({}))) as {
      batchSize?: unknown;
    };
    const parsedBatchSize = Number(requested.batchSize);
    const batchSize = Number.isInteger(parsedBatchSize)
      ? Math.max(1, Math.min(parsedBatchSize, 500))
      : 100;

    let cursor: string | null = null;
    let pages = 0;
    let busy = false;
    const totals = { processed: 0, inserted: 0, flags_corrected: 0 };

    // The database RPC selects by NOT EXISTS and owns its advisory lock. It
    // also repairs lying flags independently. Continue until the cursor says
    // the entire eligible set was visited; never use ledger_entry_created as a
    // filter in this Edge Function.
    while (pages < 10_000) {
      const { data, error } = await auth.context.admin.rpc(
        "reconcile_student_payment_ledger",
        { p_limit: batchSize, p_after_id: cursor },
      );
      if (error) throw error;
      const page = (data || {}) as LedgerPage;
      pages++;
      busy = page.busy === true;
      totals.processed += Number(page.processed || 0);
      totals.inserted += Number(page.inserted || 0);
      totals.flags_corrected += Number(page.flags_corrected || 0);

      if (busy || page.has_more !== true) break;
      const nextCursor = typeof page.next_after_id === "string"
        ? page.next_after_id
        : null;
      if (!nextCursor || nextCursor === cursor) {
        throw new Error("ledger_reconciliation_cursor_stalled");
      }
      cursor = nextCursor;
    }

    if (pages >= 10_000) throw new Error("ledger_reconciliation_page_limit");
    return new Response(
      JSON.stringify({
        success: true,
        busy,
        pages,
        ...totals,
      }),
      { status: busy ? 202 : 200, headers: corsHeaders },
    );
  } catch (error) {
    console.error("[reconcile-ledger] reconciliation failed", {
      type: error instanceof Error ? error.name : "unknown",
    });
    return new Response(JSON.stringify({ error: "RECONCILIATION_FAILED" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
