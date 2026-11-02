// A mesma validação é usada no cadastro público e na edge, antes de criar conta.
export {
  isValidProviderCnpj,
  normalizeProviderCnpj,
  parseTeacherProviderIdentity,
  type TeacherProviderIdentity,
} from '../supabase/functions/register-teacher/provider-identity';
