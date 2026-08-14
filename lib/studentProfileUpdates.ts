export type StudentProfileFormData = Record<string, any>;

/**
 * Converte os nomes usados pelo formulário para as colunas que existem em
 * profiles. Não inclua aqui preferências que ainda não possuem migration no
 * banco hospedado: o PostgREST rejeita o UPDATE inteiro quando recebe uma
 * coluna desconhecida.
 */
export function buildStudentProfileUpdates(profileData: StudentProfileFormData) {
  const updates: Record<string, any> = {
    full_name: profileData.name,
    module: profileData.levelBadge,
    occupation: profileData.occupation,
    phone: profileData.phone,
    meeting_link: profileData.meeting_link,
    cpf: profileData.cpf,
    address: profileData.address,
    address_number: profileData.addressNumber,
    postal_code: profileData.postalCode,
    interests: profileData.interests,
    private_notes: profileData.private_notes,
    fixed_schedule: profileData.fixed_schedule,
    professor_id: profileData.professor_id,
  };

  if (profileData.monthly_fee !== undefined) updates.monthly_tuition = profileData.monthly_fee;
  if (profileData.due_day !== undefined) updates.due_day = profileData.due_day;
  if (profileData.status_financial !== undefined) updates.status_financial = profileData.status_financial;
  if (profileData.planDuration !== undefined) updates.fidelity_plan = profileData.planDuration;

  return updates;
}
