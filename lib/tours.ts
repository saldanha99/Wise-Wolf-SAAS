/**
 * Roteiro do tour guiado.
 *
 * Cada passo aponta para um elemento marcado com `data-tour="<target>"` na tela.
 * `target: null` = cartão centralizado, sem holofote (boas-vindas, encerramento).
 * `view` diz em que aba o passo acontece — o motor navega sozinho até lá.
 *
 * ⚠️ Passo cujo elemento NÃO existir é pulado em silêncio. É de propósito: a tela
 * muda conforme o papel, o plano e o que já foi cadastrado (lista vazia não
 * renderiza card nenhum). Um tour que trava porque o alvo sumiu é pior do que um
 * tour com um passo a menos.
 *
 * Por isso também: escreva o texto de forma que pular o passo não deixe buraco
 * na narrativa — nada de "como vimos no passo anterior".
 */

export interface TourStep {
  /** Valor do data-tour do alvo; null = passo centralizado. */
  target: string | null;
  title: string;
  text: string;
  /** Aba onde o passo acontece. O motor troca de aba antes de procurar o alvo. */
  view?: string;
}

export interface TourChapter {
  id: string;
  title: string;
  steps: TourStep[];
}

/** Papéis com roteiro próprio. */
export type TourRole = 'SCHOOL_ADMIN' | 'TEACHER' | 'STUDENT';

const DIRETOR: TourChapter[] = [
  {
    id: 'boas-vindas',
    title: 'Primeiros passos',
    steps: [
      {
        target: null,
        view: 'dashboard',
        title: 'Bem-vindo à direção da escola 🐺',
        text: 'Este tour mostra onde fica cada coisa. Leva menos de dois minutos, dá para sair quando quiser e rever depois pelo botão "Tour guiado" no rodapé do menu.',
      },
      {
        target: 'sidebar-nav',
        view: 'dashboard',
        title: 'Seu menu',
        text: 'Organizado pelo que você faz: no topo o dia a dia (Início, Mapa de Aulas, Alunos, Professores), depois Financeiro, Aulas, Pedagógico, Crescimento e Configurações. Telas parecidas viram abas dentro de uma entrada só.',
      },
      {
        target: 'pending-center',
        view: 'dashboard',
        title: 'O que precisa de você hoje',
        text: 'A Central de Pendências junta tudo que está esperando ação — documento para aprovar, presença para verificar, experimental para liquidar — com link direto. Quando está vazia, está tudo em dia.',
      },
    ],
  },
  {
    id: 'financeiro',
    title: 'Dinheiro',
    steps: [
      {
        target: null,
        view: 'student-payments',
        title: 'Dinheiro entrando e saindo',
        text: 'Aqui ficam as mensalidades dos alunos, o repasse aos professores e os lançamentos do caixa — cada um numa aba.',
      },
      {
        target: null,
        view: 'dre',
        title: 'Resultado do mês (DRE)',
        text: 'O DRE responde "quanto sobrou". Ele conta o custo da aula no mês em que ela aconteceu, então mostra o resultado real mesmo antes de o repasse ser pago. Se algo estiver faltando, ele avisa no topo em vez de mostrar lucro irreal.',
      },
      {
        target: null,
        view: 'balancete',
        title: 'Lucro por professor',
        text: 'O balancete abre o custo por natureza — valor base, comissão de turbo, bônus de treinamento e ajustes — e mostra quanto cada professor deu de lucro, com a receita rateada pelas aulas.',
      },
    ],
  },
  {
    id: 'aulas',
    title: 'Aulas e pessoas',
    steps: [
      {
        target: null,
        view: 'schedule_explorer',
        title: 'Mapa de Aulas',
        text: 'A grade inteira da escola: ocupação por professor, busca por aluno e alerta quando dois alunos caem no mesmo horário.',
      },
      {
        target: null,
        view: 'attendance-disputes',
        title: 'Verificar Presença',
        text: 'Quando o aluno diz que a aula não aconteceu e o professor lançou, a divergência para aqui e o pagamento fica retido até você decidir.',
      },
      {
        target: null,
        view: 'dashboard',
        title: 'Pronto! 🎉',
        text: 'É isso. O que não estiver no menu principal está dentro de uma aba — e o botão "Tour guiado" no rodapé traz este passeio de volta quando precisar.',
      },
    ],
  },
];

const PROFESSOR: TourChapter[] = [
  {
    id: 'boas-vindas',
    title: 'Boas-vindas',
    steps: [
      {
        target: null,
        view: 'dashboard',
        title: 'Bem-vindo à Wise Wolf 🐺',
        text: 'Este tour rápido mostra o essencial do seu dia: lançar aula, ver a agenda e acompanhar o que você tem a receber. Dá para sair quando quiser.',
      },
      {
        target: 'sidebar-nav',
        view: 'dashboard',
        title: 'Seu menu',
        text: 'Tudo que você usa está aqui: Lançar Aula, Pendentes, Links de Aula, Alunos, Agenda e Financeiro.',
      },
    ],
  },
  {
    id: 'aula',
    title: 'Lançar aula',
    steps: [
      {
        target: null,
        view: 'lessons',
        title: 'Lançar aula é o que gera seu pagamento',
        text: 'Toda aula dada precisa ser lançada aqui. O sistema calcula seu valor a partir desses lançamentos — aula não lançada não entra no fechamento do mês.',
      },
      {
        target: null,
        view: 'pending',
        title: 'Pendentes',
        text: 'Aulas que aconteceram e ainda não foram lançadas ficam nesta lista. Vale passar por aqui no fim do dia.',
      },
    ],
  },
  {
    id: 'financeiro',
    title: 'Seu dinheiro',
    steps: [
      {
        target: null,
        view: 'teacher-financials',
        title: 'Quanto você tem a receber',
        text: 'Aqui aparece o resumo por aluno: quantas aulas, o valor de cada uma e o total do mês. É a mesma conta que o fechamento usa — sem surpresa no fim do mês.',
      },
      {
        target: null,
        view: 'dashboard',
        title: 'Bom trabalho! 🎉',
        text: 'Qualquer dúvida, o botão "Tour guiado" no rodapé do menu repete este passeio.',
      },
    ],
  },
];

const ALUNO: TourChapter[] = [
  {
    id: 'boas-vindas',
    title: 'Boas-vindas',
    steps: [
      {
        target: null,
        view: 'dashboard',
        title: 'Bem-vindo à Wise Wolf 🐺',
        text: 'Em menos de um minuto você vê onde ficam suas aulas, seus materiais e como praticar sozinho. Dá para sair quando quiser.',
      },
      {
        target: 'sidebar-nav',
        view: 'dashboard',
        title: 'Seu menu',
        text: 'Aqui estão suas aulas, trilhas, materiais, evolução e a parte financeira.',
      },
    ],
  },
  {
    id: 'estudar',
    title: 'Estudar',
    steps: [
      {
        target: null,
        view: 'ai-tutor',
        title: 'Praticar com o Wolfie',
        text: 'O Wolfie é seu tutor de conversação: você fala, ele responde e corrige. É prática livre — use quantas vezes quiser, sem hora marcada.',
      },
      {
        target: null,
        view: 'practice',
        title: 'Minhas Trilhas',
        text: 'As trilhas são o caminho que seu professor montou para você: atividades na ordem certa, do seu nível.',
      },
      {
        target: null,
        view: 'schedule',
        title: 'Suas aulas',
        text: 'Seus horários e o link para entrar na aula. Vale conferir aqui antes de cada encontro.',
      },
      {
        target: null,
        view: 'evolution',
        title: 'Sua evolução',
        text: 'Acompanhe o que já melhorou e onde ainda tropeça — o sistema registra isso a cada aula e a cada prática com o Wolfie.',
      },
      {
        target: null,
        view: 'dashboard',
        title: 'Bons estudos! 🎉',
        text: 'É só isso mesmo. O botão "Tour guiado" no rodapé do menu traz este passeio de volta quando quiser.',
      },
    ],
  },
];

export const TOURS: Record<TourRole, TourChapter[]> = {
  SCHOOL_ADMIN: DIRETOR,
  TEACHER: PROFESSOR,
  STUDENT: ALUNO,
};

/** Passo com o capítulo a que pertence, já achatado na ordem de execução. */
export interface FlatStep extends TourStep {
  chapterTitle: string;
}

export const flattenTour = (role: TourRole): FlatStep[] =>
  (TOURS[role] ?? []).flatMap(c => c.steps.map(s => ({ ...s, chapterTitle: c.title })));
