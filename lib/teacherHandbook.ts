/**
 * Manual do Professor — o treinamento obrigatório da escola, sempre à mão.
 *
 * Pedido da direção (28/10/2026): "todos os pilares que um novo professor
 * precisa para usar a plataforma, lidar com o aluno e saber lidar com a escola,
 * como treinamento obrigatório no portal, para consultar quando esquecer algo".
 *
 * Conteúdo puro (sem React) para ser testado e buscado. A leitura confirmada
 * fica em `feature_tour_views` com o id `TEACHER_HANDBOOK_ACK_ID` — por usuário,
 * vale em qualquer aparelho. Mudou uma REGRA (não um ajuste de texto)? Suba a
 * versão do id: todo professor volta a ver o manual como pendente.
 *
 * ⚠️ Os números (R$ 8 por aula, 7º aluno do turbo, 4 reposições, 24 h de aviso)
 * são regra do produto e do contrato — mudou no banco, mude aqui junto.
 */

export const TEACHER_HANDBOOK_ACK_ID = 'manual-do-professor-v1-lido';

export type HandbookTone = 'rule' | 'tip' | 'warning';

export interface HandbookPoint {
  text: string;
  /** rule = obrigatório · tip = boa prática · warning = o que não fazer. */
  tone?: HandbookTone;
}

export interface HandbookSection {
  id: string;
  /** Número do pilar, na ordem do treinamento. */
  order: number;
  title: string;
  /** Uma frase que resume o pilar — é o que fica na memória. */
  headline: string;
  icon: 'school' | 'contract' | 'exchange' | 'record' | 'money' | 'calendar' | 'cover' | 'holiday' | 'repeat' | 'trial' | 'student' | 'platform' | 'demo';
  points: HandbookPoint[];
  /** Telas do portal que resolvem o assunto (ids do menu do professor). */
  links?: { tab: string; label: string }[];
  keywords: string[];
}

export const TEACHER_HANDBOOK_SECTIONS: HandbookSection[] = [
  {
    id: 'nosso-papel',
    order: 1,
    title: 'Seu papel na Wise Wolf',
    headline: 'Você ensina. A escola cuida do resto.',
    icon: 'school',
    points: [
      { text: 'Sua missão é uma só: ensinar inglês ao aluno com o material e a plataforma da escola.', tone: 'rule' },
      { text: 'Use somente o material didático e a plataforma da Wise Wolf. Material próprio só com aprovação da escola (envie em Materiais — ele passa pela aprovação da direção).', tone: 'rule' },
      { text: 'Matrícula, contrato, cobrança, mensalidade e negociação são do time da escola — nunca do professor.', tone: 'rule' },
      { text: 'Em dúvida sobre qualquer situação com o aluno, acione a coordenação pelo WhatsApp da escola antes de decidir sozinho.', tone: 'tip' },
    ],
    links: [{ tab: 'pedagogical', label: 'Materiais da escola' }],
    keywords: ['papel', 'missão', 'material', 'plataforma', 'escola', 'função'],
  },
  {
    id: 'prestacao-de-servico',
    order: 2,
    title: 'Você é prestador de serviço (PJ)',
    headline: 'Contrato de prestação de serviços, não CLT.',
    icon: 'contract',
    points: [
      { text: 'A relação com a escola é de prestação de serviços (com CNPJ/MEI ou como autônomo com CPF). Não é vínculo CLT.', tone: 'rule' },
      { text: 'Seu contrato geral e os termos por aluno ficam em Meu Contrato. Leia e assine antes de assumir atendimentos.', tone: 'rule' },
      { text: 'Emita e envie a nota fiscal do mês em Enviar NFS-e.', tone: 'rule' },
      { text: 'Quer encerrar a parceria? O contrato prevê aviso prévio e transição — combine com a direção, nunca só com o aluno.', tone: 'tip' },
    ],
    links: [
      { tab: 'contract_teacher', label: 'Meu Contrato' },
      { tab: 'invoices', label: 'Enviar NFS-e' },
    ],
    keywords: ['pj', 'cnpj', 'mei', 'autônomo', 'clt', 'contrato', 'nota fiscal', 'nfs-e', 'prestação'],
  },
  {
    id: 'pagamento-e-turbo',
    order: 3,
    title: 'Pagamento por aula e Turbo',
    headline: 'Aula lançada é aula paga. Frequência impecável destrava o Turbo.',
    icon: 'money',
    points: [
      { text: 'A base é R$ 8,00 por aula de 30 minutos dada e lançada. Aula não lançada não entra no pagamento.', tone: 'rule' },
      { text: 'A partir do 7º aluno da sua carteira entra o Turbo: as aulas desses alunos passam a valer mais (R$ 10,50) — veja o cartão Turbo no seu Início.', tone: 'rule' },
      { text: 'O Turbo depende da SUA frequência: não faltar, não atrasar e não ficar remarcando aula. Falta do professor ou contestação aberta tira o Turbo.', tone: 'warning' },
      { text: 'Falta do aluno é paga normalmente e gera uma reposição para ele.', tone: 'tip' },
      { text: 'Você recebe independentemente do aluno estar em dia com a mensalidade — inadimplência é assunto do financeiro, não seu.', tone: 'tip' },
    ],
    links: [
      { tab: 'lessons', label: 'Lançar Aula' },
      { tab: 'teacher-financials', label: 'Financeiro' },
    ],
    keywords: ['pagamento', 'valor', 'r$ 8', 'turbo', '10,50', 'carteira', 'sete alunos', '7 alunos', 'receber', 'salário'],
  },
  {
    id: 'teacher-exchange',
    order: 4,
    title: 'Teacher Exchange',
    headline: 'Uma vez por mês o aluno tem aula com outro professor — para provar que aprendeu.',
    icon: 'exchange',
    points: [
      { text: 'Teacher Exchange é a troca de professor: todo mês o aluno faz uma aula com outro teacher da escola.', tone: 'rule' },
      { text: 'Objetivo: ver se o aluno consegue USAR o conteúdo com outra pessoa, fora da zona de conforto do professor de sempre.', tone: 'rule' },
      { text: 'Você recebe a instrução com o tópico gramatical do nível do aluno (ex.: presente simples, passado, futuro) e um roteiro para trabalhar as 4 habilidades: ouvir, falar, ler e escrever.', tone: 'rule' },
      { text: 'Geralmente acontece como troca entre professores (você recebe um aluno de um colega e ele recebe um seu). Quando as agendas não batem, a escola pode pedir só o Teacher Exchange.', tone: 'tip' },
      { text: 'Ao final, registre o que o aluno domina e onde travou: é a devolutiva para o professor titular.', tone: 'rule' },
      { text: 'O Teacher Exchange é pago como uma aula (R$ 8,00). Lance normalmente.', tone: 'tip' },
    ],
    links: [{ tab: 'lessons', label: 'Lançar Aula' }],
    keywords: ['teacher exchange', 'exchange', 'troca', 'troca de professor', 'quatro habilidades', '4 habilidades', 'avaliação'],
  },
  {
    id: 'gravacao',
    order: 5,
    title: 'Gravação das aulas',
    headline: 'Opcional no dia a dia. No Teacher Exchange, importante gravar.',
    icon: 'record',
    points: [
      { text: 'Gravar as aulas regulares em vídeo NÃO é obrigatório. Grave se quiser.', tone: 'tip' },
      { text: 'No Teacher Exchange, a gravação é importante: ela é o registro que a inteligência artificial da escola usa para acompanhar a evolução do aluno.', tone: 'rule' },
      { text: 'Não quer aparecer em post? É só avisar: "não quero ser postada". O registro continua interno, só para o acompanhamento pedagógico.', tone: 'tip' },
      { text: 'Entre sempre pelo link oficial da aula (sala da escola no Meet), com a conta Google que você confirmou no portal.', tone: 'rule' },
    ],
    links: [{ tab: 'lesson-sessions', label: 'Salas e continuidade' }],
    keywords: ['gravação', 'gravar', 'vídeo', 'meet', 'postar', 'post', 'registro', 'ia', 'inteligência artificial'],
  },
  {
    id: 'frequencia-e-avisos',
    order: 6,
    title: 'Pontualidade, faltas e remarcações',
    headline: 'Avise com o máximo de antecedência — no mínimo 24 horas.',
    icon: 'calendar',
    points: [
      { text: 'Chegue no horário. Atraso e remarcação frequente afetam o aluno, a escola e o seu Turbo.', tone: 'rule' },
      { text: 'Não vai poder dar aula? Avise a escola com no mínimo 24 horas de antecedência.', tone: 'rule' },
      { text: 'Compromisso já sabido (aniversário, consulta médica, viagem)? Avise com semanas de antecedência, para a escola organizar a cobertura com calma.', tone: 'rule' },
      { text: 'Avise pelo WhatsApp da escola ("Não vou conseguir dar aula dia 18") — o bot lista suas aulas e chama os professores livres. Nunca combine só com o aluno.', tone: 'warning' },
      { text: 'Vários dias fora? Registre também em Saída / Ausência.', tone: 'tip' },
    ],
    links: [{ tab: 'teacher_workflows', label: 'Saída / Ausência' }],
    keywords: ['falta', 'atraso', 'remarcar', 'remarcação', 'aviso', '24 horas', 'antecedência', 'médico', 'aniversário', 'ausência'],
  },
  {
    id: 'cobertura',
    order: 7,
    title: 'Cobertura de aula',
    headline: 'Quem cobre recebe o roteiro — e devolve as anotações.',
    icon: 'cover',
    points: [
      { text: 'Quando um professor falta, a escola chama um colega livre para cobrir. O convite chega por WhatsApp; o primeiro que aceita fica com a aula.', tone: 'tip' },
      { text: 'A cobertura vem com o pacote do aluno: onde o professor parou, nível, últimas aulas e o próximo passo. Siga esse roteiro.', tone: 'rule' },
      { text: 'Fez uma cobertura? Anote tudo (o que trabalhou, dificuldades, lição) no lançamento: é o que o professor oficial vai ler para continuar.', tone: 'rule' },
      { text: 'A aula coberta entra no pagamento de quem deu a aula.', tone: 'tip' },
    ],
    links: [{ tab: 'lessons', label: 'Lançar Aula' }],
    keywords: ['cobertura', 'cobrir', 'substituto', 'colega', 'anotações', 'roteiro', 'script'],
  },
  {
    id: 'feriados',
    order: 8,
    title: 'Feriados',
    headline: 'Só não há aula nos feriados nacionais.',
    icon: 'holiday',
    points: [
      { text: 'Como prestador de serviço, você dá aula normalmente em feriados estaduais e municipais.', tone: 'rule' },
      { text: 'Feriado NACIONAL: não há aula e a aula não é reposta.', tone: 'rule' },
    ],
    links: [{ tab: 'schedule', label: 'Agenda' }],
    keywords: ['feriado', 'feriados', 'nacional', 'municipal', 'estadual', 'folga'],
  },
  {
    id: 'reposicoes',
    order: 9,
    title: 'Reposições',
    headline: 'Quatro reposições por mês são obrigatórias. O resto é flexibilidade.',
    icon: 'repeat',
    points: [
      { text: 'Todo aluno tem direito a 4 reposições por mês. Essas 4 são obrigatórias para o professor.', tone: 'rule' },
      { text: 'Da 5ª em diante não há obrigação — é combinação entre você e o aluno.', tone: 'tip' },
      { text: 'Ser flexível com reposição costuma voltar para você: os alunos também tendem a ser flexíveis quando VOCÊ precisa remarcar.', tone: 'tip' },
      { text: 'Marque a data da reposição no portal (em Reposições ou pelo WhatsApp da escola). Reposição sem data não aparece para lançar.', tone: 'rule' },
    ],
    links: [{ tab: 'reschedules', label: 'Reposições' }],
    keywords: ['reposição', 'reposições', 'repor', '4 reposições', 'quatro', 'flexível', 'flexibilidade'],
  },
  {
    id: 'aula-experimental',
    order: 10,
    title: 'Aula experimental',
    headline: 'Guia Gramatical, nome da escola e apresentação — sempre.',
    icon: 'trial',
    points: [
      { text: 'O Guia Gramatical é o material OBRIGATÓRIO da aula experimental.', tone: 'rule' },
      { text: 'Fale o nome da escola e apresente a Wise Wolf seguindo o roteiro/manual de apresentação da escola.', tone: 'rule' },
      { text: 'Antes da aula você recebe o resumo do aluno (objetivo, nível, contexto). Leia antes de entrar.', tone: 'tip' },
      { text: 'Valores, planos e matrícula NÃO são assunto da experimental: se o aluno perguntar, diga que o time da escola vai falar com ele logo depois da aula.', tone: 'warning' },
    ],
    links: [{ tab: 'pedagogical', label: 'Materiais (Guia Gramatical)' }],
    keywords: ['experimental', 'aula experimental', 'guia gramatical', 'trial', 'apresentar', 'apresentação', 'nome da escola'],
  },
  {
    id: 'aluno-e-dinheiro',
    order: 11,
    title: 'Aluno e dinheiro: não é com você',
    headline: 'Professor nunca cobra aluno.',
    icon: 'student',
    points: [
      { text: 'Nunca faça nenhum tipo de cobrança financeira ao aluno: mensalidade, atraso, PIX, boleto, multa.', tone: 'warning' },
      { text: 'Não se preocupe com quem está em dia ou não — você recebe pelas suas aulas de qualquer forma. Isso é função do time financeiro.', tone: 'rule' },
      { text: 'Aluno falou de pagamento, contrato ou cancelamento? Responda com gentileza que vai encaminhar e avise a escola.', tone: 'tip' },
    ],
    keywords: ['cobrança', 'cobrar', 'mensalidade', 'pix', 'boleto', 'inadimplência', 'financeiro', 'dinheiro', 'cancelamento'],
  },
  {
    id: 'plataforma',
    order: 12,
    title: 'A plataforma no dia a dia',
    headline: 'Início → Agenda → Aula pelo link oficial → Lançar Aula.',
    icon: 'platform',
    points: [
      { text: 'Início: suas aulas de hoje com o botão da sala oficial e o atalho para planejar a aula com IA.', tone: 'tip' },
      { text: 'Lançar Aula: marque o que aconteceu e o conteúdo, no dia. Esquecidas vão para Pendentes — resolva na semana.', tone: 'rule' },
      { text: 'Planner IA: monta o plano da aula com base no histórico e nas dificuldades do aluno.', tone: 'tip' },
      { text: 'Botão "Ajuda" (canto da tela): passo a passo de cada situação e mensagem pronta para o WhatsApp da escola.', tone: 'tip' },
    ],
    links: [
      { tab: 'dashboard', label: 'Início' },
      { tab: 'lesson-planner-ai', label: 'Planner IA' },
      { tab: 'pending', label: 'Pendentes' },
    ],
    keywords: ['plataforma', 'portal', 'lançar', 'planner', 'agenda', 'ajuda', 'pendentes', 'como usar'],
  },
  {
    id: 'aula-demonstrativa',
    order: 13,
    title: 'Sua aula demonstrativa (para novos professores)',
    headline: '5 minutos, um tema gramatical, nível A1/A2, interativa.',
    icon: 'demo',
    points: [
      { text: 'Para concluir o treinamento, apresente à direção uma aula demonstrativa de 5 minutos sobre um tema gramatical, para nível A1/A2.', tone: 'rule' },
      { text: 'Ela precisa ser interativa: o "aluno" fala e pratica, não só escuta. Use exemplos do dia a dia.', tone: 'rule' },
      { text: 'Aprovada a demonstração, a direção libera sua agenda e você começa a receber oportunidades de aulas experimentais. Bem-vindo(a) ao time!', tone: 'tip' },
    ],
    links: [{ tab: 'schedule', label: 'Minha agenda' }],
    keywords: ['demonstrativa', 'aula demo', 'demo', 'teste', 'a1', 'a2', 'novo professor', 'onboarding', 'aprovação'],
  },
];

/** Texto sem acento e em minúsculas — a busca acha "reposicao" e "Reposição". */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Pilares que falam do termo buscado (título, frase, pontos ou palavras-chave). */
export function searchTeacherHandbook(query: string): HandbookSection[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return TEACHER_HANDBOOK_SECTIONS;
  return TEACHER_HANDBOOK_SECTIONS.filter(section => {
    const haystack = fold([
      section.title,
      section.headline,
      ...section.keywords,
      ...section.points.map(p => p.text),
    ].join(' '));
    return terms.every(term => haystack.includes(term));
  });
}
