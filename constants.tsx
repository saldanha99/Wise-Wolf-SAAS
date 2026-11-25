
import { Tenant, User, UserRole } from './types';

// URL Base do App
export const APP_BASE_URL = window.location.origin;

export const LESSON_RATE = 8.00;
export const MAX_REPLACEMENTS = 5;

// Categorias de especialização de professores
export const TEACHER_SPECIALIZATIONS = [
  'Inglês Geral / Conversação',
  'Business English',
  'TOEFL / IELTS',
  'Inglês para Crianças',
  'Inglês para Viagens',
  'Inglês Acadêmico',
  'Inglês para Tecnologia',
  'Inglês para Saúde / Medicina',
] as const;

export type TeacherSpecialization = typeof TEACHER_SPECIALIZATIONS[number];

// Comissão padrão por matrícula (em centavos)
export const DEFAULT_COMMISSION_RATE_CENTS = 3000; // R$30,00

// Mock de agendamentos fixos - ZERADO para início limpo
export const MOCK_BOOKINGS: Record<string, { student: string; module: string }> = {};

export const MOCK_TENANTS: Record<string, Tenant> = {
  'royal-british': {
    id: 'royal-british',
    name: 'Royal British School',
    domain: 'royal.school.com',
    branding: {
      primaryColor: '#002366',
      secondaryColor: '#D32F2F',
      logoUrl: 'https://cdn-icons-png.flaticon.com/512/3601/3601639.png',
      faviconUrl: 'https://cdn-icons-png.flaticon.com/512/3601/3601639.png',
    },
    studentLimit: 500,
    teacherLimit: 20
  },
  'future-sights': {
    id: 'future-sights',
    name: 'Future Sights Academy',
    domain: 'future.academy.tw',
    branding: {
      primaryColor: '#7C3AED',
      secondaryColor: '#10B981',
      logoUrl: 'https://cdn-icons-png.flaticon.com/512/2997/2997235.png',
      faviconUrl: 'https://cdn-icons-png.flaticon.com/512/2997/2997235.png',
    },
    studentLimit: 1200,
    teacherLimit: 80
  },
  'wise-wolf-school': {
    id: 'wise-wolf-school',
    name: 'Wise Wolf School',
    domain: 'escola.wisewolf.io',
    branding: {
      primaryColor: '#0f172a',
      secondaryColor: '#f59e0b',
      logoUrl: 'https://ui-avatars.com/api/?name=WW+School&background=0f172a&color=fff',
      faviconUrl: '',
    },
    studentLimit: 1000,
    teacherLimit: 50
  },
  'master': {
    id: 'master',
    name: 'Wise Wolf Platform (SaaS)',
    domain: 'wisewolf.io',
    branding: {
      primaryColor: '#002366',
      secondaryColor: '#D32F2F',
      logoUrl: 'https://ui-avatars.com/api/?name=Wise+Wolf',
      faviconUrl: '',
    },
    studentLimit: 999999,
    teacherLimit: 999999
  }
};

export const MOCK_STUDENTS_LIST = [];

// Projeção operacional de profiles. Identidade civil, endereço, responsáveis,
// dados bancários, cobrança, Asaas, notas privadas e artefatos de assinatura só
// podem ser lidos pela RPC get_authorized_profile_private. O banco aplica a
// mesma allow-list com grants por coluna; isto evita que um filtro adulterado no
// cliente transforme o diretório pedagógico em exportação de PII.
export const PROFILE_SAFE_COLS = 'id, email, full_name, role, tenant_id, avatar_url, module, occupancy, created_at, phone, study_days, occupation, interests, meeting_link, whatsapp_instance, status, xp, level, streak_count, last_activity, current_book_part, evaluation_unlocked, whatsapp_instance_id, current_topic_id, unlocked_tests, fixed_schedule, lifecycle_status, contract_accepted, accepted_at, class_frequency, documentation_status, audit_status, validated_by, validation_date, rejection_reason, whatsapp_instance_name, whatsapp_status, contract_sent_at, welcome_sent_at, wa_welcome_sent, welcome_wa_sent, teachers_group_id, directors_group_id, date_automation_enabled, professor_id, wolfie_settings, referrer_teacher_id, hr_group_id, referrer_student_id, start_date, gamification_consent_by_guardian, league_opt_in, league_display_name, notification_preference, professor_id2, specializations, english_for, student_category, learning_objective, personality, preferred_topics, avoided_topics, short_term_goal, long_term_goal, lesson_reminder_template, suspended_at, suspended_reason, offboarding_status, offboarding_requested_at, offboarding_reason, offboarding_last_day, offboarding_completed_at, hearts, hearts_updated_at, last_streak_date, daily_xp, daily_xp_date, daily_xp_goal, hearts_full_notified, onboarded, attendance_phone, is_kids, is_test_account, is_trainer';
