/// <reference lib="deno.ns" />

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";

export interface TenantClosingGeneration {
  month: string;
  created: number;
  updated: number;
  carried_over: number;
  updated_teacher_ids: string[];
}

interface PayableClassRow {
  id: string;
  rate_efetivo: number | string | null;
}

interface CarryoverRow {
  class_log_id: string;
  origin_month: string;
  amount: number | string | null;
}

interface ExistingClosingRow {
  id: string;
  status: string | null;
  total_lessons: number | string | null;
  total_amount: number | string | null;
  teacher_confirmation_status: string | null;
  teacher_confirmation_date: string | null;
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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
  const bounds = closingMonthBounds(month);
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

    const [payableResult, existingResult, carryoverResult] = await Promise.all([
      supabase
        .from("v_payable_class_logs")
        .select("id, rate_efetivo")
        .eq("tenant_id", tenantId)
        .eq("teacher_id", teacher.id)
        .gte("class_date", bounds.start)
        .lte("class_date", bounds.end),
      supabase
        .from("teacher_closings")
        .select(
          "id, status, total_lessons, total_amount, teacher_confirmation_status, teacher_confirmation_date",
        )
        .eq("tenant_id", tenantId)
        .eq("teacher_id", teacher.id)
        .eq("month_year", month)
        .limit(1)
        .maybeSingle(),
      supabase.rpc("teacher_pending_carryover", { p_teacher: teacher.id }),
    ]);
    if (payableResult.error) throw payableResult.error;
    if (existingResult.error) throw existingResult.error;
    if (carryoverResult.error) throw carryoverResult.error;

    const payable = (payableResult.data ?? []) as PayableClassRow[];
    const carryovers = (carryoverResult.data ?? []) as CarryoverRow[];
    const existing = existingResult.data as ExistingClosingRow | null;
    if (!existing && payable.length === 0 && carryovers.length === 0) continue;

    const lessons = payable.length + carryovers.length;
    const amount = roundMoney(
      payable.reduce((sum, row) => sum + finiteNumber(row.rate_efetivo), 0) +
        carryovers.reduce((sum, row) => sum + finiteNumber(row.amount), 0),
    );

    let closingId: string | null = null;
    if (existing) {
      if (existing.status !== "PENDENTE") continue;
      if (
        finiteNumber(existing.total_lessons) === lessons &&
        roundMoney(finiteNumber(existing.total_amount)) === amount
      ) {
        continue;
      }

      const confirmationWasAccepted =
        existing.teacher_confirmation_status === "OK";
      const { data: changed, error: updateError } = await supabase
        .from("teacher_closings")
        .update({
          total_lessons: lessons,
          total_amount: amount,
          updated_at: new Date().toISOString(),
          teacher_confirmation_status: confirmationWasAccepted
            ? "PENDENTE"
            : existing.teacher_confirmation_status,
          teacher_confirmation_date: confirmationWasAccepted
            ? null
            : existing.teacher_confirmation_date,
        })
        .eq("id", existing.id)
        .eq("tenant_id", tenantId)
        .eq("teacher_id", teacher.id)
        .eq("status", "PENDENTE")
        .select("id")
        .maybeSingle();
      if (updateError) throw updateError;
      if (!changed) continue;

      const subjectId = `${teacher.id}:${month}`;
      const { error: dedupeError } = await supabase
        .from("automation_sent")
        .delete()
        .eq("kind", "MONTHLY_CLOSING")
        .eq("subject_id", subjectId);
      if (dedupeError) throw dedupeError;

      closingId = changed.id;
      updated++;
      updatedTeacherIds.push(teacher.id);
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from("teacher_closings")
        .insert({
          teacher_id: teacher.id,
          tenant_id: tenantId,
          month_year: month,
          total_lessons: lessons,
          total_amount: amount,
          status: "PENDENTE",
          period_start: bounds.start,
          period_end: bounds.end,
        })
        .select("id")
        .single();
      if (insertError) throw insertError;
      closingId = inserted.id;
      created++;
    }

    if (closingId && carryovers.length > 0) {
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
  }

  return {
    month,
    created,
    updated,
    carried_over: carriedOver,
    updated_teacher_ids: updatedTeacherIds,
  };
}
