export enum UserRole {
  SUPER_ADMIN = "SUPER_ADMIN",
  SCHOOL_ADMIN = "SCHOOL_ADMIN",
  TEACHER = "TEACHER",
  STUDENT = "STUDENT",
  SALESPERSON = "SALESPERSON",
  NON_STUDENT = "NON_STUDENT",
}

export enum PresenceStatus {
  PRESENT = "PRESENÇA",
  ABSENT_JUSTIFIED = "FALTA_JUSTIFICADA",
  ABSENT = "FALTA_NÃO_JUSTIFICADA",
}

export enum PaymentStatus {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  PAID = "PAID",
  REJECTED = "REJECTED",
}

export interface BrandingSettings {
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string;
  faviconUrl: string;
  logoPath?: string;
  faviconPath?: string;
}

export interface Tenant {
  id: string;
  name: string;
  domain: string;
  branding: BrandingSettings;
  studentLimit: number;
  teacherLimit: number;
  whatsapp_enabled?: boolean;
  financial_cutoff_day?: number;
  slug?: string | null;
  custom_domain?: string | null;
  custom_domain_verified?: boolean;
  /** Identidade jurídica do próprio tenant; nunca herda PII da plataforma. */
  school_info?: {
    name?: string;
    legalName?: string;
    cnpj?: string;
    address?: string;
    email?: string;
    phone?: string;
    city?: string;
    state?: string;
    directorName?: string;
    legalRepresentativeName?: string;
    legalRepresentativeSignaturePath?: string;
    legalRepresentativeSignatureUrl?: string;
    privacyContactEmail?: string;
  } | null;
}

export interface TenantMembershipOption {
  tenant_id: string;
  tenant_name: string;
  domain?: string | null;
  branding?: Partial<BrandingSettings> | null;
  role: UserRole;
  is_primary: boolean;
  is_active: boolean;
}

export type CefrLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";

export interface WolfieSettings {
  goal?: string;
  level?: CefrLevel;
  correctionStrictness?: 1 | 2 | 3;
  preferredCorrectionMode?: "immediate" | "end" | "selective" | "examiner";
  preferredLanguageMode?:
    | "pt_support"
    | "bilingual"
    | "immersive"
    | "english_rescue";
  dailyGoalMinutes?: number;
  completedAt?: string;
}

export interface User {
  id: string;
  tenantId: string; // Made strict (NOT NULL in DB)
  name: string;
  email: string;
  role: UserRole;
  avatar?: string;
  professor_id?: string; // Link to responsible teacher
  module?: string;
  currentBookPart?: string;
  evaluationUnlocked?: boolean;
  hourlyRate?: number;
  status_financial?: string;
  due_day?: number;
  contract_accepted?: boolean;
  accepted_at?: string;
  is_trainer?: boolean;
  wolfieSettings?: WolfieSettings;
  englishFor?: string;
  occupation?: string;
  studentCategory?: string;
  isKids?: boolean;
  interests?: string[];
  preferredTopics?: string[];
  shortTermGoal?: string;
}

export interface Lesson {
  id: string;
  studentName: string;
  date: string;
  status: PresenceStatus;
  value: number;
  isPaid: boolean;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  price: number;
  interval: "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL";
  features: string[];
}

export interface Student extends User {
  subscriptionId?: string;
  planId?: string;
  paymentStatus: PaymentStatus;
  module: string; // Required for students
  nextPaymentDate: string;
  private_notes?: string;
  fixed_schedule?: string;
}

export interface Teacher {
  id: string;
  tenantId?: string;
  name: string;
  email: string;
  role: UserRole.TEACHER;
  avatar: string;
  module: string;
  modules: string[];
  specializations: string[]; // ex: ['TOEFL / IELTS', 'Business English']
  hourlyRate: number;
  pixKey: string;
  phone: string;
  studentsCount: number;
  classesCount: number;
  retention: string;
  tpi: number;
  status: "Ativo" | "Férias" | "Inativo";
  lifecycle_status?: "active" | "suspended" | "offboarded";
  createdAt?: string;
  lastTeacherAbsenceAt?: string | null;
  daysWithoutAbsence?: number | null;
  turboActive?: boolean | null;
  turboBlockedBy?: string | null;
  occupancy: number;
}

export interface Vendor {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  role: UserRole.SALESPERSON;
  avatar?: string;
  commission_rate: number; // valor em centavos por matrícula
}

export type ClosingStatus =
  | "PENDENTE" // Legacy/Initial
  | "WAITING_PAYMENT"
  | "PAID_WAITING_NF"
  | "UNDER_REVIEW"
  | "COMPLETED"
  | "REJECTED";

export interface TeacherClosing {
  id: string;
  teacher_id: string;
  month_year: string;
  status: ClosingStatus;
  total_lessons: number;
  total_amount: number;
  invoice_url?: string;
  rejection_reason?: string;
  updated_at: string;
}

export interface Reschedule {
  id: string | number;
  date: string;
  time?: string;
  teacherName: string;
  studentName: string;
  repoId: number;
  originalLessonId: number;
  // uuid do professor DONO da reposição — não é number (era, e o `as any` que
  // escondia isso deixou a grade do Explorador pintar reposição de um professor
  // na agenda de outro sem ninguém tropeçar no tipo).
  teacherId: string;
  studentId?: string;
}

export type JobStatus =
  | "Novo"
  | "Em Análise"
  | "Entrevistado"
  | "Contratado"
  | "Rejeitado";

export interface JobApplication {
  id: string;
  tenant_id: string;
  name: string;
  whatsapp: string;
  resume_url?: string;
  status: JobStatus;
  created_at: string;
  // Triagem da Rita (IA de RH) — preenchidos pela edge hr-ai-screening
  ai_score?: number | null;
  ai_summary?: string | null;
  ai_flags?: { red_flags?: string[]; pontos_fortes?: string[] } | null;
  ai_recommendation?: "ENTREVISTAR" | "TALVEZ" | "RECUSAR" | null;
  ai_screened_at?: string | null;
  preinterview_status?: "SENT" | "IN_PROGRESS" | "DONE" | null;
  preinterview_answers?: Record<string, string | number> | null;
  interview_slot?: string | null;
  // Handoff humano: `ai_handoff` sozinho era permanente e calou 26 de 67
  // candidaturas. O carimbo é o que dá validade (72h) e permite devolver à IA.
  ai_handoff?: boolean | null;
  ai_handoff_at?: string | null;
}
