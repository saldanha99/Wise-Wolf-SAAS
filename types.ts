
export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  SCHOOL_ADMIN = 'SCHOOL_ADMIN',
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
  tenantId: string;
  name: string;
  email: string;
  role: UserRole;
  avatar?: string;
  module?: string;
  currentBookPart?: string;
  evaluationUnlocked?: boolean;
  hourlyRate?: number;
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
  module: string;
  nextPaymentDate: string;
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

export interface Reschedule {
  id: string | number;
  date: string;
  teacherName: string;
  studentName: string;
  repoId: number;
  originalLessonId: number;
  teacherId: number;
}
