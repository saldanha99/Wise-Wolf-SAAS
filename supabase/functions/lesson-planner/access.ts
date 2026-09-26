/**
 * Quem pode planejar para qual aluno — a regra mora no banco
 * (public.planner_teacher_can_access_student, migration 20260927130000), e a
 * edge só pergunta. Antes a edge consultava `bookings` do professor direto e
 * recusava o segundo professor, o substituto da cobertura e o professor da
 * reposição marcada.
 *
 * O banco devolve o motivo (BOOKING | SECOND_TEACHER | PRIMARY_TEACHER |
 * COVERAGE | RESCHEDULE) ou nulo. Qualquer outra coisa é recusa: resposta
 * estranha não pode abrir aluno.
 */

export const PLANNER_ACCESS_REASONS = [
  "BOOKING",
  "SECOND_TEACHER",
  "PRIMARY_TEACHER",
  "COVERAGE",
  "RESCHEDULE",
] as const;

export type PlannerAccessReason = typeof PLANNER_ACCESS_REASONS[number];

export const PLANNER_ACCESS_RPC = "planner_teacher_can_access_student";

export interface PlannerAccessArgs {
  p_teacher_id: string;
  p_student_id: string;
  p_tenant_id: string;
}

/** A chamada ao banco, injetada (a edge passa o cliente service_role). */
export type PlannerAccessRpc = (
  fn: typeof PLANNER_ACCESS_RPC,
  args: PlannerAccessArgs,
) => PromiseLike<{ data: unknown; error: unknown }>;

export type TeacherPlannerAccess =
  | { kind: "allowed"; reason: PlannerAccessReason }
  | { kind: "denied" }
  | { kind: "error"; code: string | null };

const isAccessReason = (value: unknown): value is PlannerAccessReason =>
  typeof value === "string" &&
  (PLANNER_ACCESS_REASONS as readonly string[]).includes(value);

const errorCode = (error: unknown): string | null =>
  error && typeof error === "object" && "code" in error &&
    typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;

export async function teacherPlannerAccess(
  rpc: PlannerAccessRpc,
  subject: { teacherId: string; studentId: string; tenantId: string },
): Promise<TeacherPlannerAccess> {
  if (!subject.teacherId || !subject.studentId || !subject.tenantId) {
    return { kind: "denied" };
  }
  try {
    const { data, error } = await rpc(PLANNER_ACCESS_RPC, {
      p_teacher_id: subject.teacherId,
      p_student_id: subject.studentId,
      p_tenant_id: subject.tenantId,
    });
    if (error) return { kind: "error", code: errorCode(error) };
    return isAccessReason(data)
      ? { kind: "allowed", reason: data }
      : { kind: "denied" };
  } catch {
    return { kind: "error", code: null };
  }
}

/** Mensagem da recusa: diz o que abre o aluno, sem revelar nada dele. */
export const PLANNER_ACCESS_DENIED_MESSAGE =
  "Você planeja para os alunos da sua agenda, para o aluno de que é segundo professor e, do dia anterior ao seguinte da aula, para o aluno da cobertura confirmada ou da reposição marcada com você.";
