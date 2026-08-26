import type { AdScript } from '../types';

// FRENTE A — captar alunos para a Wise Wolf Language School (aulas online).
//
// Cada afirmação destes roteiros está em `claims`, com a origem. Nada entra no anúncio
// sem constar ali. O que ficou DE FORA, de propósito:
//
// - Depoimento de aluno: não existe nenhum real no repositório. Inventar um é fraude.
// - "800+ escolas", "94% de retenção", "3,2x de crescimento" e os logos Ambev / Petrobras /
//   Embraer / Lilly / Novo Nordisk / Tupy que estão em `components/landing/WiseWolfLanding.tsx`
//   (linhas 25-32 e 154-158). Nada disso tem lastro: a base tem 6 tenants, nenhum pagante,
//   e uma escola com operação real. Usar marca de terceiro sem autorização também é risco
//   de marca, não só de política de anúncio.
// - Promessa de prazo ("fale inglês em 6 meses"). Não é mensurável e é o tipo de promessa
//   que o CDC e o CONAR tratam como enganosa.
//
// Preços: `supabase/migrations/20260804191000_catalogo_precos_2026_08.sql` — tabela definida
// pela direção em 04/08/2026 para o tenant `school-wise-wolf`. O piso real é R$ 169,00/mês
// (2 aulas por semana, fidelidade de 12 meses). A fidelidade é dita no anúncio: preço com
// carência apresentado sem a carência é o clássico problema de publicidade enganosa.

const DESTINO = 'wisewolflanguage.com.br/new-student';

export const STUDENT_ADS: AdScript[] = [
  {
    id: 'AlunoIntervalo',
    slug: 'aluno-intervalo',
    front: 'aluno',
    angle: 'O intervalo entre as aulas',
    accent: '#20a9cc',
    secondaryAccent: '#5de1cf',

    hookKicker: 'Aula de inglês online',
    hookLine: 'Você tem aula na terça.',
    hookEmphasis: 'E até a próxima, o inglês some.',

    turnHeadline: 'A aula não termina quando a chamada cai.',
    turnPoints: [
      'Conversa quando der na sua semana',
      'O assunto é o seu, não o do livro',
      'Errar aqui não custa nada',
    ],

    proofHeadline: 'Você pratica a situação antes de ela acontecer.',
    evidence: [
      { panel: 'wolfie', reads: 'Prática de conversa com o Wolfie' },
      { file: 'assets/wolfie/meetings-business.webp', reads: 'Cenário de reunião internacional' },
      { file: 'assets/wolfie/meetings-tourism.webp', reads: 'Cenário de viagem' },
    ],
    backdrop: 'assets/wolfie/job-interviews.webp',

    ctaHeadline: 'A primeira aula é gratuita.',
    ctaButton: 'Agendar aula experimental',
    ctaSupport: 'Aulas individuais e online, com professor.',
    destination: DESTINO,

    narration: [
      { beat: 'hook', text: 'Você faz a sua aula de inglês na terça. E até a terça seguinte, o inglês some.' },
      { beat: 'turn', text: 'Na Wise Wolf, a aula não termina quando a chamada cai. Entre uma aula e outra, você conversa em inglês com o Wolfie.' },
      { beat: 'proof', text: 'Uma entrevista de emprego, uma reunião, uma viagem. Você repete a situação num lugar privado, até ela ficar fácil.' },
      { beat: 'cta', text: 'A primeira aula é gratuita. Agende a sua.' },
    ],

    claims: [
      { claim: 'A escola oferece aula experimental gratuita', source: 'Funil de experimental em produção: opportunities.kind=TRIAL, componentes TrialsToContracts e LeadsKanban (etapa SCHEDULED = AULA EXPERIMENTAL)' },
      { claim: 'O aluno pratica conversa em inglês com uma IA entre as aulas', source: 'Wolfie AI Tutor em produção — components/WolfieTutor.tsx, supabase/functions/wolfie-tts, wolfie-realtime-session' },
      { claim: 'Os cenários de prática incluem entrevista, reunião e viagem', source: 'design-assets/wolfie/generated-sources/ e public/assets/wolfie/scenes/ (job-interviews, meetings-business, meetings-tourism)' },
      { claim: 'As aulas são individuais', source: 'bookings tem um student_id por horário; dois alunos no mesmo horário são tratados como CONFLITO em TeacherScheduleExplorer' },
    ],
  },

  {
    id: 'AlunoTrava',
    slug: 'aluno-trava',
    front: 'aluno',
    angle: 'Entende, lê, mas trava para falar',
    accent: '#ff785f',
    secondaryAccent: '#ffad70',

    hookKicker: 'Para quem já estudou inglês',
    hookLine: 'Você entende. Você lê.',
    hookEmphasis: 'Na hora de falar, trava.',

    turnHeadline: 'Não falta conteúdo. Falta quilometragem.',
    turnPoints: [
      'Falar mais vezes, não estudar mais teoria',
      'Um lugar onde errar não tem plateia',
      'Repetir a mesma cena até ficar fácil',
    ],

    proofHeadline: 'Aula com professor. Prática quando você quiser.',
    evidence: [
      { panel: 'wolfie', reads: 'Prática de conversa com o Wolfie' },
      { file: 'assets/wolfie/pronunciation-lab.webp', reads: 'Laboratório de pronúncia' },
    ],
    backdrop: 'assets/wolfie/pronunciation-lab.webp',

    ctaHeadline: 'Comece pela aula gratuita.',
    ctaButton: 'Agendar aula experimental',
    ctaSupport: 'Online, com professor, no seu horário.',
    destination: DESTINO,

    narration: [
      { beat: 'hook', text: 'Você entende inglês. Você lê inglês. Mas na hora de falar, trava.' },
      { beat: 'turn', text: 'Não é falta de conteúdo. É falta de quilometragem. Você precisa falar mais vezes, num lugar onde errar não tem plateia.' },
      { beat: 'proof', text: 'Aula individual com professor, e prática de conversa entre as aulas. Você repete a mesma situação até ela ficar fácil.' },
      { beat: 'cta', text: 'A primeira aula é gratuita. Agende a sua.' },
    ],

    claims: [
      { claim: 'A escola oferece aula experimental gratuita', source: 'Funil de experimental em produção (opportunities.kind=TRIAL)' },
      { claim: 'Existe laboratório de pronúncia', source: 'public/assets/wolfie/scenes/skill-labs/pronunciation-lab/ e design-assets/wolfie/generated-sources/pronunciation-lab-desktop-source-v4.png' },
      { claim: 'A prática de conversa fica disponível fora do horário da aula', source: 'Wolfie AI Tutor — prática assíncrona, components/WolfieTutor.tsx' },
    ],
  },

  {
    id: 'AlunoPreco',
    slug: 'aluno-preco',
    front: 'aluno',
    angle: 'Preço de entrada e acesso',
    accent: '#7652ed',
    secondaryAccent: '#b89cff',

    hookKicker: 'Inglês online, aula individual',
    hookLine: 'Professor só para você,',
    hookEmphasis: 'duas vezes por semana.',

    turnHeadline: 'R$ 169 por mês, no plano de 12 meses.',
    turnPoints: [
      'Aula individual, não turma',
      'Material e plano feitos para o seu objetivo',
      'Prática de conversa entre as aulas',
    ],

    proofHeadline: 'E a primeira aula não custa nada.',
    evidence: [
      { panel: 'wolfie', reads: 'Prática de conversa com o Wolfie' },
      { file: 'assets/wolfie/meetings-tourism.webp', reads: 'Cenário de viagem' },
    ],
    backdrop: 'assets/wolfie/meetings-tourism.webp',

    ctaHeadline: 'Agende sua aula experimental.',
    ctaButton: 'Quero a aula gratuita',
    ctaSupport: 'A partir de R$ 169/mês no plano de 12 meses.',
    destination: DESTINO,

    narration: [
      { beat: 'hook', text: 'Aula de inglês individual, online, com professor só para você, duas vezes por semana.' },
      { beat: 'turn', text: 'Cento e sessenta e nove reais por mês, no plano de doze meses.' },
      { beat: 'proof', text: 'Com material e plano de aula feitos para o seu objetivo, e prática de conversa entre as aulas.' },
      { beat: 'cta', text: 'E a primeira aula é gratuita. Agende a sua.' },
    ],

    claims: [
      { claim: 'R$ 169,00 por mês, 2 aulas por semana, fidelidade de 12 meses', source: 'supabase/migrations/20260804191000_catalogo_precos_2026_08.sql — linha 12m-2x, monthly_price 169.00, tenant school-wise-wolf' },
      { claim: 'As aulas são individuais', source: 'bookings: um student_id por horário' },
      { claim: 'O plano de aula é personalizado por aluno', source: 'LessonPlannerAI + edge function lesson-planner, que lê nível, objetivo, histórico e pontos fracos do aluno' },
      { claim: 'A primeira aula é gratuita', source: 'Aula experimental — funil em produção' },
    ],
  },
];
