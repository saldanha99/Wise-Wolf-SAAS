import type { FlatStep, TourRole, TourStep } from './tours';

/**
 * Tours de novidade — TODA funcionalidade nova sobe com um tutorial guiado.
 *
 * Regra da direção (16/09/2026): quem abre a plataforma depois de uma
 * atualização é levado pela mão até a novidade, uma vez, e pode rever depois
 * em "Novidades" no menu do avatar. O motor é o mesmo do tour de boas-vindas
 * (`components/tour/GuidedTour`), e o "já vi" fica em `feature_tour_views`
 * (por usuário, vale em qualquer aparelho).
 *
 * Como adicionar o tour de uma release:
 *   1. Marque na tela o que o tour aponta com `data-tour="<alvo>"`.
 *   2. Acrescente uma entrada AO FIM desta lista, com id `AAAA-MM-DD-slug`
 *      (a data da release) e os papéis que ganham a novidade.
 *   3. `lib/featureTours.test.ts` recusa id repetido, fora de ordem e alvo que
 *      não existe no código — o tour nasce amarrado à tela.
 *
 * ⚠️ O motor pula passo cujo alvo não está na tela (celular, papel sem o
 * recurso, layout diferente). Escreva cada passo para se sustentar sozinho.
 */

export interface FeatureTour {
  /** `AAAA-MM-DD-slug` — a data é a da release; a lista fica em ordem cronológica. */
  id: string;
  /** Título curto, aparece no cabeçalho do balão e no menu "Novidades". */
  title: string;
  roles: TourRole[];
  steps: TourStep[];
}

export const FEATURE_TOURS: FeatureTour[] = [
  {
    id: '2026-09-16-menu-no-topo',
    title: 'Menu no topo e atalhos',
    roles: ['SCHOOL_ADMIN', 'TEACHER'],
    steps: [
      {
        target: null,
        view: 'dashboard',
        title: 'Novidade: o menu mudou de lugar ✨',
        text: 'As telas agora ficam em categorias no topo, e um trilho à esquerda guarda seus atalhos. Leva 30 segundos para conhecer — dá para sair quando quiser e rever em "Novidades" no menu do seu avatar.',
      },
      {
        target: 'sidebar-nav',
        view: 'dashboard',
        title: 'Categorias no topo',
        text: 'Passe o mouse ou clique numa categoria para ver as telas dela. O que não couber na largura da sua tela vai para "Mais". Número vermelho na categoria é pendência esperando você.',
      },
      {
        target: 'shortcut-rail',
        view: 'dashboard',
        title: 'Seus atalhos',
        text: 'Este trilho é seu: arraste qualquer tela de uma categoria para cá, arraste os ladrilhos para reordenar, passe o mouse e use o "×" para tirar. O "+" no fim lista todas as telas para marcar. Cabem 10.',
      },
      {
        target: 'nav-layout-toggle',
        view: 'dashboard',
        title: 'Prefere o menu na lateral?',
        text: 'Este botão alterna entre o menu no topo e a lateral clássica. A escolha é sua e fica salva — cada pessoa monta o próprio jeito de trabalhar.',
      },
      {
        target: null,
        view: 'dashboard',
        title: 'Pronto! 🎉',
        text: 'Perfil, tour guiado, novidades e sair ficam no menu do seu avatar, no canto superior direito.',
      },
    ],
  },
  {
    id: '2026-09-17-ajuda-e-planner',
    title: 'Central de Ajuda e Planner IA',
    roles: ['TEACHER'],
    steps: [
      {
        target: 'teacher-support',
        view: 'dashboard',
        title: 'Novidade: Ajuda sempre à mão 🛟',
        text: 'Este botão abre a Central de Ajuda: o que fazer em cada situação — avisar que não vai dar aula (o bot da escola cuida da cobertura), aceitar experimental, lançar aula, Smart, pagamento. Os botões de WhatsApp já abrem a conversa com a mensagem pronta.',
      },
      {
        target: 'lesson-plan-ai',
        view: 'dashboard',
        title: 'Planejar a aula com a IA ✨',
        text: 'Em cada aula de hoje há um botão de planejamento: ele abre o Planner IA já com o aluno escolhido. Diga o objetivo em uma frase e receba o plano de 30 minutos em blocos, com exemplos, vocabulário e perguntas. Salvar alimenta a memória do aluno para a próxima aula.',
      },
    ],
  },
  {
    id: '2026-09-17-faltas-e-reposicoes',
    title: 'Faltas e reposições',
    roles: ['STUDENT'],
    steps: [
      {
        target: 'student-reposicoes',
        view: 'schedule',
        title: 'Faltou? Você tem direito a repor 🐺',
        text: 'São 4 reposições por mês por direito. Quando você falta, a escola te chama no WhatsApp no dia seguinte com horários livres do seu professor — é só escolher. Reposição sem data não acontece, então marque logo. Se o professor precisar remarcar, não conta como falta sua.',
      },
    ],
  },
  {
    id: '2026-09-18-canais-de-aviso',
    title: 'Um grupo de WhatsApp por assunto',
    roles: ['SCHOOL_ADMIN'],
    steps: [
      {
        target: 'notice-channels',
        view: 'automation',
        title: 'Os avisos da gestão ganham endereço 📮',
        text: 'Dinheiro vai para Direção, agenda (cobertura, ausência, reposição, troca de horário) para Coordenação, funil (lead, experimental) para Comercial. Escolha o grupo de cada canal aqui, na conexão do WhatsApp. Canal sem grupo continua caindo no grupo da Gestão — nada se perde enquanto você cria os grupos.',
      },
    ],
  },
  {
    id: '2026-09-18-coberturas-na-agenda',
    title: 'Coberturas e reposições na sua agenda',
    roles: ['TEACHER'],
    steps: [
      {
        target: 'today-lessons',
        view: 'dashboard',
        title: 'Aula que você cobre aparece aqui 🐺',
        text: 'Quando a direção registra que você vai cobrir a aula de outro professor, ela entra em "Aulas de Hoje" com o nome do aluno, o telefone e a sala — marcada como Cobertura, com o horário combinado. Reposição marcada com você também entra. Depois da aula, é só lançar em "Lançar Aula": ela conta no seu pagamento.',
      },
      {
        target: 'agenda-coverage-legend',
        view: 'schedule',
        title: 'Na Agenda, com a data',
        text: 'Cobertura e reposição dos próximos 7 dias aparecem na grade em âmbar, com a data ao lado do nome (COB / REPO). Elas não são horário fixo seu — por isso não abrem o cadastro do aluno e não mexem na sua disponibilidade.',
      },
    ],
  },
  {
    id: '2026-09-18-reposicao-com-trilha',
    title: 'Reposição: marque no sistema',
    roles: ['TEACHER', 'SCHOOL_ADMIN'],
    steps: [
      {
        target: 'reschedule-history',
        view: 'reschedules',
        title: 'Reposição só existe com data marcada aqui 🔁',
        text: 'Combinou com o aluno? Marque a data e a hora nesta tela. Remarcar pede um motivo, e cada mudança fica no histórico (este botão). A coordenação e a família recebem o aviso na hora — ninguém mais precisa perguntar "que horas ficou?". Em cima da hora pode, mas sai destacado. Reposição sem data não aparece para lançar e não conta.',
      },
    ],
  },
  {
    id: '2026-09-19-canal-financeiro-e-previa-da-folha',
    title: 'Grupo Financeiro e prévia da folha',
    roles: ['SCHOOL_ADMIN'],
    steps: [
      {
        target: 'notice-channel-financeiro',
        view: 'automation',
        title: 'Dinheiro tem grupo próprio 💸',
        text: 'Rateio de cada pagamento, DRE, folha do mês e caixinha vão para o grupo Financeiro — e o assistente lança despesa, ajuste de repasse e responde "folha de setembro" lá. Sem grupo escolhido, cai na Direção. Agenda (cobertura, reposição, troca de horário) continua na Coordenação.',
      },
      {
        target: 'payroll-preview',
        view: 'payments',
        title: 'O mês em aberto já aparece aqui 📊',
        text: 'Antes o mês corrente ficava em branco até o dia 1º. Agora cada professor sem fechamento mostra a prévia: aulas já lançadas (a mesma conta do Financeiro dele) + ajustes. Cobertura conta para quem deu a aula — e a que ainda não foi lançada fica sinalizada. O fechamento oficial continua nascendo no dia 1º.',
      },
    ],
  },
  {
    id: '2026-09-25-afiliados-por-cupom',
    title: 'Afiliados por cupom',
    roles: ['SCHOOL_ADMIN'],
    steps: [
      {
        target: 'affiliate-invite',
        view: 'vendors-mgmt',
        title: 'Cada afiliado tem o seu cupom 🎟️',
        text: 'Convide o afiliado já com o cupom (ex.: AFILIADA10) e a comissão por matrícula. O link de cadastro explica tudo a ele — cupom, liquidação e saque — e o painel dele mostra as indicações e o saldo. Os pedidos de saque você aprova na ficha do afiliado.',
      },
      {
        target: 'enrollment-link-tab',
        view: 'dashboard',
        title: 'Indicação no link de matrícula',
        text: 'Em "Link Matrícula", informe o cupom ou o nome de quem indicou: a taxa de matrícula sai isenta e a comissão fica vinculada ao afiliado. Ela só é liberada quando a 1ª mensalidade é liquidada — Pix na hora, boleto na compensação, cartão quando o valor cai.',
      },
    ],
  },
  {
    id: '2026-09-26-registro-das-aulas',
    title: 'Autorização do registro das aulas',
    roles: ['SCHOOL_ADMIN'],
    steps: [
      {
        target: 'recording-consents',
        view: 'recording-consents',
        title: 'Quem autorizou o registro das aulas 🎙️',
        text: 'A aula só é transcrita no Meet da escola quando o aluno (ou o responsável, se for menor) e o professor autorizaram — uma vez, até revogar. Aqui você gera o link do termo para cada aluno, manda pelo WhatsApp e acompanha quem já respondeu. Os professores respondem na própria tela de "Salas e continuidade".',
      },
    ],
  },
  {
    id: '2026-09-26-registro-das-aulas-professor',
    title: 'Registro das suas aulas',
    roles: ['TEACHER'],
    steps: [
      {
        target: 'recording-teacher-consent',
        view: 'lesson-sessions',
        title: 'Sua autorização para o registro das aulas 🎙️',
        text: 'Nas salas do Meet da escola, a aula pode ser transcrita para registrar o que foi trabalhado e dar continuidade ao aluno. Leia o termo e responda aqui — sem a sua autorização nenhuma aula sua é transcrita. Nada disso muda o seu pagamento automaticamente.',
      },
    ],
  },
  {
    id: '2026-09-26-termo-seguro',
    title: 'Termo das aulas com confirmação',
    roles: ['SCHOOL_ADMIN'],
    steps: [
      {
        target: 'recording-consents',
        view: 'recording-consents',
        title: 'A família confirma pelo WhatsApp 🔐',
        text: 'A página do termo agora manda um código de 6 dígitos para o WhatsApp do cadastro antes de gravar a resposta. Sem data de nascimento confirmada pela escola, quem responde é o responsável — por segurança, idade desconhecida conta como menor. O código do responsável só vai para telefone confirmado pela escola (ficha do aluno ou “Contatos verificados”); o painel avisa quando falta.',
      },
      {
        target: 'recording-age-check',
        view: 'recording-consents',
        title: 'Confirme a data de nascimento',
        text: 'Para o aluno maior de idade responder sozinho, a escola confirma a data de nascimento aqui ou na ficha do aluno. Data digitada em outro lugar (formulário, o próprio aluno) não vale como prova.',
      },
    ],
  },
  {
    id: '2026-09-26-termo-seguro-envio',
    title: 'Termo enviado pela escola',
    roles: ['SCHOOL_ADMIN'],
    steps: [
      {
        target: 'recording-consents-send',
        view: 'recording-consents',
        title: 'O termo sai pelo WhatsApp da escola 📨',
        text: 'Um clique em "Enviar termo aos alunos pendentes" mostra quantas mensagens saem e em que horário — uma a cada 3 minutos, de segunda a sábado, das 9h às 20h — e só envia depois que você confirma. Menor de idade ou idade não confirmada pela escola recebe pelo responsável. A lista mostra quem recebeu, abriu o link e respondeu; o reenvio libera 3 dias depois (na hora, se o telefone mudou).',
      },
    ],
  },
  {
    id: '2026-09-26-termo-seguro-professor',
    title: 'Conta Google da sala',
    roles: ['TEACHER'],
    steps: [
      {
        target: 'recording-teacher-google',
        view: 'lesson-sessions',
        title: 'Confirme sua conta Google 🔑',
        text: 'Antes de autorizar o registro das aulas, entre com a conta Google que você usa nas aulas. É ela que a escola coloca como coanfitriã da sala — sem essa confirmação o botão de autorizar fica desligado.',
      },
    ],
  },
];

/** Tours do papel que a pessoa ainda não viu, na ordem em que saíram. */
export function pendingFeatureTours(role: string, seenIds: Iterable<string>): FeatureTour[] {
  const seen = new Set(seenIds);
  return FEATURE_TOURS.filter(t => t.roles.includes(role as TourRole) && !seen.has(t.id));
}

/** Tour mais recente do papel — é o que "Novidades" reabre. */
export function latestFeatureTourFor(role: string): FeatureTour | undefined {
  return [...FEATURE_TOURS].reverse().find(t => t.roles.includes(role as TourRole));
}

/** Passos achatados para o motor, todos sob o capítulo "Novidade". */
export const flattenFeatureTour = (tour: FeatureTour): FlatStep[] =>
  tour.steps.map(s => ({ ...s, chapterTitle: 'Novidade' }));
