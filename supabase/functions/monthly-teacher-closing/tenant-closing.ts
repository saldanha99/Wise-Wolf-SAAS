/// <reference lib="deno.ns" />

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";

export interface TenantClosingGeneration {
  month: string;
  created: number;
  updated: number;
  carried_over: number;
  updated_teacher_ids: string[];
}

interface CarryoverRow {
  class_log_id: string;
  origin_month: string;
  amount: number | string | null;
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeClosingMonth(
  requestedMonth: unknown,
  now = new Date(),
): string {
  if (
    requestedMonth === null || requestedMonth === undefined ||
    requestedMonth === ""
  ) {
    const previousMonth = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() - 1,
      1,
    ));
    return `${previousMonth.getUTCFullYear()}-${
      String(previousMonth.getUTCMonth() + 1).padStart(2, "0")
    }`;
  }
  if (
    typeof requestedMonth !== "string" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth)
  ) {
    throw new Error("invalid_month");
  }
  return requestedMonth;
}

export function closingMonthBounds(month: string): {
  start: string;
  end: string;
} {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

export async function runTenantMonthlyTeacherClosing(
  supabase: SupabaseClient,
  tenantId: string,
  month: string,
): Promise<TenantClosingGeneration> {
  const { data: teachers, error: teachersError } = await supabase
    .from("profiles")
    .select("id, tenant_id")
    .eq("tenant_id", tenantId)
    .eq("role", "TEACHER");
  if (teachersError) throw teachersError;

  let created = 0;
  let updated = 0;
  let carriedOver = 0;
  const updatedTeacherIds: string[] = [];

  for (const teacher of teachers ?? []) {
    if (teacher.tenant_id !== tenantId) continue;

    const carryoverResult = await supabase.rpc(
      "teacher_pending_carryover_in_tenant",
      {
        p_tenant: tenantId,
        p_teacher: teacher.id,
      },
    );
    if (carryoverResult.error) throw carryoverResult.error;

    const carryovers = (carryoverResult.data ?? []) as CarryoverRow[];
    if (carryovers.length > 0) {
      const { error: carryoverError } = await supabase
        .from("closing_carryovers")
        .upsert(
          carryovers.map((carryover) => ({
            class_log_id: carryover.class_log_id,
            teacher_id: teacher.id,
            origin_month: carryover.origin_month,
            absorbed_month: month,
            amount: finiteNumber(carryover.amount),
          })),
          { onConflict: "class_log_id", ignoreDuplicates: true },
        );
      if (carryoverError) throw carryoverError;
      carriedOver += carryovers.length;
    }

    const { data: refresh, error: refreshError } = await supabase.rpc(
      "refresh_teacher_closing_snapshot",
      {
        p_tenant: tenantId,
        p_teacher: teacher.id,
        p_month: month,
        p_allow_create: true,
      },
    );
    if (refreshError) throw refreshError;
    const state = String(
      (refresh as Record<string, unknown> | null)?.state || "",
    );
    if (state === "created") {
      created++;
    } else if (state === "updated") {
      updated++;
      updatedTeacherIds.push(teacher.id);
    }
  }

  return {
    month,
    created,
    updated,
    carried_over: carriedOver,
    updated_teacher_ids: updatedTeacherIds,
  };
}
