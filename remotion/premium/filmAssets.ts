import type { HubVideoSlug } from '../types';

export type FilmCapture = {
  file: string;
  label: string;
  detail: string;
  focus: string;
};

export const FILM_BACKDROPS: Record<HubVideoSlug, string> = {
  'hub-overview': 'hub-corridor.png',
  library: 'library-curation.png',
  'educator-ai': 'educator-structure.png',
  wolfie: 'wolfie-real-world.png',
  'school-os': 'school-living-system.png',
};

export const FILM_CAPTURES: Record<HubVideoSlug, FilmCapture[]> = {
  'hub-overview': [
    { file: 'library-native.png', label: 'Biblioteca', detail: 'curadoria para ensinar', focus: 'BUSCAR E ABRIR' },
    { file: 'planner-native.png', label: 'Educador IA', detail: 'contexto vira sequência', focus: 'PLANEJAR' },
    { file: 'wolfie-interview.png', label: 'Wolfie', detail: 'prática em situação real', focus: 'ENGAJAR' },
    { file: 'director-dashboard.png', label: 'School OS', detail: 'operação conectada', focus: 'OPERAR' },
  ],
  library: [
    { file: 'library-native.png', label: 'Biblioteca do professor', detail: 'pastas, nível e nicho na estrutura nativa', focus: 'ORGANIZAR' },
    { file: 'student-materials.png', label: 'Visão do aluno', detail: 'somente materiais atribuídos pelo professor', focus: 'ISOLAR' },
  ],
  'educator-ai': [
    { file: 'planner-native.png', label: 'Planejador nativo', detail: 'aluno, prompt e memória no mesmo fluxo', focus: 'CONTEXTUALIZAR' },
  ],
  wolfie: [
    { file: 'wolfie-interview.png', label: 'Entrevista profissional', detail: 'prática privada e contextual', focus: 'RESPONDER' },
    { file: 'wolfie-business.png', label: 'Reunião internacional', detail: 'clareza para situações reais', focus: 'REPETIR' },
    { file: 'wolfie-medical.png', label: 'Congresso médico', detail: 'prática contextual sob pressão adaptativa', focus: 'EVOLUIR' },
  ],
  'school-os': [
    { file: 'director-dashboard.png', label: 'Visão da direção', detail: 'operação em uma leitura', focus: 'ACOMPANHAR' },
    { file: 'school-crm.png', label: 'Comercial', detail: 'do novo contato à matrícula', focus: 'CONVERTER' },
    { file: 'school-agenda.png', label: 'Agenda', detail: 'rotina diária coordenada', focus: 'ORGANIZAR' },
    { file: 'school-branding.png', label: 'Branding por escola', detail: 'cores e experiência próprias do tenant', focus: 'PERSONALIZAR' },
  ],
};

export const FILM_URLS: Record<HubVideoSlug, string> = {
  'hub-overview': 'hub.wisewolflanguage.com.br',
  library: 'hub.wisewolflanguage.com.br/biblioteca',
  'educator-ai': 'hub.wisewolflanguage.com.br/educador-ia',
  wolfie: 'hub.wisewolflanguage.com.br/wolfie',
  'school-os': 'hub.wisewolflanguage.com.br/saas-escolar',
};
