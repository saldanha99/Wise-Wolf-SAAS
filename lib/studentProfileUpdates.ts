export type StudentProfileFormData = Record<string, any>;

export const STUDENT_DIRECTOR_PROFILE_COLS = [
  'id', 'tenant_id', 'full_name', 'email', 'module', 'occupation', 'phone',
  'meeting_link', 'cpf', 'address', 'address_number', 'postal_code', 'interests',
  'private_notes', 'fixed_schedule', 'professor_id', 'monthly_fee',
  'monthly_tuition', 'due_day', 'status_financial', 'fidelity_plan', 'accepted_at',
  'documentation_status',
].join(', ');

export const STUDENT_TEACHER_PROFILE_COLS = [
  'id', 'tenant_id', 'full_name', 'module', 'occupation', 'phone', 'meeting_link',
  'interests', 'fixed_schedule', 'professor_id',
].join(', ');

export function mapStudentProfileToForm(
  profile: Record<string, any> | null | undefined,
  fallback: { name?: string; levelBadge?: string } = {},
) {
  const safeProfile = profile || {};
  return {
    ...safeProfile,
    name: safeProfile.full_name || fallback.name || '',
    levelBadge: safeProfile.module || fallback.levelBadge || 'B1',
    postalCode: safeProfile.postal_code || '',
    addressNumber: safeProfile.address_number || '',
    monthly_fee: safeProfile.monthly_tuition ?? safeProfile.monthly_fee ?? 0,
    planDuration: safeProfile.fidelity_plan || 'RECURRENT',
    professor_id: safeProfile.professor_id || null,
  };
}

/**
 * Converte os nomes usados pelo formulário para as colunas que existem em
 * profiles. Não inclua aqui preferências que ainda não possuem migration no
 * banco hospedado: o PostgREST rejeita o UPDATE inteiro quando recebe uma
 * coluna desconhecida.
 */
export function buildStudentProfileUpdates(profileData: StudentProfileFormData) {
  const updates: Record<string, any> = {
    occupation: profileData.occupation,
    phone: profileData.phone,
    meeting_link: profileData.meeting_link,
    cpf: profileData.cpf?.trim() || null,
    address: profileData.address,
    address_number: profileData.addressNumber,
    postal_code: profileData.postalCode,
    interests: profileData.interests,
    private_notes: profileData.private_notes,
    fixed_schedule: profileData.fixed_schedule,
    professor_id: profileData.professor_id || null,
  };

  if (typeof profileData.name === 'string' && profileData.name.trim()) {
    updates.full_name = profileData.name.trim();
  }
  if (typeof profileData.levelBadge === 'string' && profileData.levelBadge.trim()) {
    updates.module = profileData.levelBadge.trim();
  }

  if (profileData.monthly_fee !== undefined) updates.monthly_tuition = profileData.monthly_fee;
  if (profileData.due_day !== undefined) updates.due_day = profileData.due_day;
  if (profileData.status_financial !== undefined) updates.status_financial = profileData.status_financial;
  if (profileData.planDuration !== undefined) updates.fidelity_plan = profileData.planDuration;

  return updates;
}
