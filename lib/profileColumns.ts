// Colunas REAIS de `public.profiles`, tiradas do banco de produção em 09/08/2026:
//   select column_name from information_schema.columns where table_name='profiles';
//
// Existe para uma classe de bug que já mordeu CINCO vezes: a tela manda no
// UPDATE um campo que não é coluna, o PostgREST derruba o comando INTEIRO e
// NADA é salvo — mas a mensagem fala de um campo que o usuário nem editou, então
// ninguém liga uma coisa à outra.
//
// Casos reais encontrados em 09/08/2026:
//   • `correction_preference` (Mapa de Aulas e Agenda do professor) — o diretor
//     não conseguia trocar o TELEFONE do aluno;
//   • `updated_at` (PIX e dados bancários) — o professor não conseguia salvar a
//     chave PIX, que é por onde ele recebe.
//
// ⚠️ Ao adicionar coluna em `profiles`, acrescente aqui também, senão o teste
// `profileColumns.test.ts` acusa falso positivo na tela que já está certa.
export const PROFILE_COLUMNS: readonly string[] = [
  'accepted_at', 'account_number', 'address', 'address_number', 'agency', 'asaas_customer_id',
  'asaas_subscription_end_date', 'asaas_subscription_status', 'asaas_subscription_synced_at',
  'attendance_phone', 'audit_status', 'avatar_url', 'avoided_topics', 'bank_name',
  'birth_date', 'can_oral_test', 'class_frequency', 'cnpj', 'cnpj_company_name',
  'commission_rate', 'contract_accepted', 'contract_sent_at', 'contract_url', 'cpf',
  'created_at', 'current_book_part', 'current_topic_id', 'daily_xp', 'daily_xp_date',
  'daily_xp_goal', 'date_automation_enabled', 'directors_group_id', 'documentation_status',
  'due_day', 'email', 'english_for', 'enrollment_fee', 'enrollment_fee_paid',
  'enrollment_payment_id', 'evaluation_unlocked', 'fidelity_plan', 'first_overdue_at',
  'fixed_schedule', 'full_name', 'gamification_consent_by_guardian', 'guardian_cpf',
  'guardian_email', 'guardian_id', 'guardian_name', 'guardian_phone', 'hearts',
  'hearts_full_notified', 'hearts_updated_at', 'hourly_rate', 'hr_group_id', 'id', 'interests',
  'is_kids', 'is_test_account', 'is_trainer', 'last_activity', 'last_streak_date',
  'league_display_name', 'league_opt_in', 'learning_objective', 'lesson_duration_minutes',
  'lesson_reminder_template', 'level', 'lifecycle_status', 'long_term_goal', 'meeting_link',
  'meeting_link_verified_at', 'meeting_link_verified_by', 'module', 'monthly_fee',
  'monthly_tuition', 'nf_exempt', 'notification_preference', 'occupancy', 'occupation',
  'offboarding_completed_at', 'offboarding_last_day', 'offboarding_reason',
  'offboarding_requested_at', 'offboarding_status', 'onboarded', 'paid_through', 'personality',
  'phone', 'pix_key', 'pix_key_type', 'postal_code', 'preferred_topics', 'prepaid_months',
  'private_notes', 'professor_id', 'professor_id2', 'referrer_student_id',
  'referrer_teacher_id', 'rejection_email_claimed_at', 'rejection_email_reason_hash',
  'rejection_email_sent_at', 'rejection_reason', 'rg', 'role', 'short_term_goal',
  'signature_hash', 'signature_ip', 'signature_url', 'signed_document_url', 'specializations',
  'start_date', 'status', 'status_financial', 'streak_count', 'student_category',
  'student_signature_url', 'study_days', 'subscription_id', 'suspended_at', 'suspended_reason',
  'teachers_group_id', 'tenant_id', 'test_fixture_key', 'typed_signature', 'unlocked_tests',
  'user_ip', 'validated_by', 'validation_date', 'wa_welcome_sent', 'welcome_sent_at',
  'welcome_wa_sent', 'whatsapp_instance', 'whatsapp_instance_id', 'whatsapp_instance_name',
  'whatsapp_status', 'whatsapp_token', 'wise_wolf_signature_token', 'wolfie_settings', 'xp'
] as const;

export const isProfileColumn = (name: string): boolean =>
  (PROFILE_COLUMNS as readonly string[]).includes(name);
