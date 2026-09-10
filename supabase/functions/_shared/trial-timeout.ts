export const TEACHER_ACCEPTANCE_TIMEOUT_MS = 60 * 60_000;

export async function claimSdrNotice(sb: any, tenantId: string, phone: string) {
  const { data, error } = await sb.rpc("claim_sdr_notice", {
    p_tenant_id: tenantId,
    p_phone: phone,
  });
  if (error) throw new Error("sdr_notice_lease_failed");
  return {
    ok: data?.claimed === true,
    finish: async (success = true) => {
      const { error } = await sb.rpc("finish_sdr_work", {
        p_tenant_id: tenantId,
        p_phone: phone,
        p_token: data?.token,
        p_success: success,
      });
      if (error) throw new Error("sdr_notice_finalize_failed");
    },
  };
}

export async function readAllTimeoutRows(makeQuery: () => any): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0;; offset += 100) {
    const { data, error } = await makeQuery().range(offset, offset + 99);
    if (error) throw new Error("trial_timeout_scan_failed");
    rows.push(...(data || []));
    if (!data || data.length < 100) return rows;
  }
}

/** Per-event claim has a fixed date, including retries on a different day. */
export async function claimTrialTimeoutNotice(
  sb: any,
  tenantId: string,
  requestId: string,
) {
  const key = {
    kind: "TRIAL_RESCHEDULE_TIMEOUT",
    subject_id: `${tenantId}:${requestId}`,
    ref_date: "1970-01-01",
  };
  const { error } = await sb.from("automation_sent").insert(key);
  if (error && error.code !== "23505") {
    throw new Error("timeout_notice_claim_failed");
  }
  return {
    ok: !error,
    undo: async () => {
      const { error } = await sb.from("automation_sent").delete().match(key);
      if (error) throw new Error("timeout_notice_release_failed");
    },
  };
}

/** All checks happen before the delivery claim. New negotiations supersede old ones. */
export async function loadExpiredRescheduleContext(sb: any, request: any) {
  const { data, error } = await sb.rpc("expire_trial_reschedule_confirmation", {
    p_tenant_id: request.tenant_id,
    p_request_id: request.id,
  });
  if (error || !data?.ok) throw new Error("reschedule_expiration_failed");
  if (!data.expired) return null;
  const [latest, appointment, opportunity, lead, logs] = await Promise.all([
    sb.from("trial_reschedule_requests").select("id,status")
      .eq("tenant_id", request.tenant_id).eq(
        "appointment_id",
        request.appointment_id,
      )
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("appointments").select("start_time,status")
      .eq("tenant_id", request.tenant_id).eq("id", request.appointment_id)
      .maybeSingle(),
    sb.from("opportunities").select(
      "id,status,trial_status,student_phone,student_name",
    )
      .eq("tenant_id", request.tenant_id).eq("id", request.opportunity_id)
      .maybeSingle(),
    sb.from("crm_leads").select(
      "id,name,phone,status,weekly_availability,ai_handoff,ai_handoff_at",
    )
      .eq("tenant_id", request.tenant_id).eq("id", request.lead_id)
      .maybeSingle(),
    sb.from("class_logs").select("id").eq(
      "appointment_id",
      String(request.appointment_id),
    ).limit(1),
  ]);
  if ([latest, appointment, opportunity, lead, logs].some((r) => r.error)) {
    throw new Error("reschedule_context_unavailable");
  }
  if (
    latest.data?.id !== request.id || latest.data?.status !== "EXPIRED" ||
    !lead.data ||
    !["CLAIMED", "FILLED", "TAKEN"].includes(opportunity.data?.status) ||
    ["DONE", "COMPLETED", "CANCELLED", "CANCELED"].includes(
      String(opportunity.data?.trial_status).toUpperCase(),
    ) ||
    !["scheduled", "confirmed", "no_show"].includes(
      String(appointment.data?.status).toLowerCase(),
    ) ||
    Date.parse(appointment.data?.start_time) !==
      Date.parse(request.from_start_time) ||
    logs.data?.length
  ) return null;
  return { lead: lead.data, opportunity: opportunity.data };
}

export function rescheduleTimeoutMessage(requestedStart: string): string {
  const local = new Date(Date.parse(requestedStart) - 3 * 60 * 60_000)
    .toISOString();
  const day = local.slice(0, 10).split("-").reverse().join("/");
  return `Ainda não recebi o aceite do professor para mudar sua aula para ${day} às ${
    local.slice(11, 16)
  }. A alteração não foi confirmada. Qual outro dia e horário funciona para você? Vou verificar uma nova opção com o professor.`;
}
