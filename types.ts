
export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  SCHOOL_ADMIN = 'SCHOOL_ADMIN',
  COMMERCIAL = 'COMMERCIAL',
  TEACHER = 'TEACHER',
  STUDENT = 'STUDENT'
}

export enum PresenceStatus {
  PRESENT = 'PRESENÇA',
  ABSENT_JUSTIFIED = 'FALTA_JUSTIFICADA',
  ABSENT = 'FALTA_NÃO_JUSTIFICADA'
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  PAID = 'PAID',
  REJECTED = 'REJECTED'
}

export interface BrandingSettings {
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string;
  faviconUrl: string;
}

export interface Tenant {
  id: string;
  name: string;
  domain: string;
  branding: BrandingSettings;
  studentLimit: number;
  teacherLimit: number;
  whatsapp_api_url?: string;
  whatsapp_api_key?: string;
  whatsapp_enabled?: boolean;
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
  interval: 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';
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
  hourlyRate: number;
  pixKey: string;
  phone: string;
  studentsCount: number;
  classesCount: number;
  retention: string;
  tpi: number;
  status: 'Ativo' | 'Férias' | 'Inativo';
  occupancy: number;
}

export type ClosingStatus =
  | 'PENDENTE' // Legacy/Initial
  | 'WAITING_PAYMENT'
  | 'PAID_WAITING_NF'
  | 'UNDER_REVIEW'
  | 'COMPLETED'
  | 'REJECTED';

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
  teacherName: string;
  studentName: string;
  repoId: number;
  originalLessonId: number;
  teacherId: number;
}

export type JobStatus = 'Novo' | 'Em Análise' | 'Entrevistado' | 'Contratado' | 'Rejeitado';

export interface JobApplication {
  id: string;
  tenant_id: string;
  name: string;
  whatsapp: string;
  resume_url?: string;
  status: JobStatus;
  created_at: string;
}
