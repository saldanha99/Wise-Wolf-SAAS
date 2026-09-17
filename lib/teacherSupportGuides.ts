/**
 * Central de Ajuda do professor — o que fazer em cada situação, na plataforma e
 * no WhatsApp da escola.
 *
 * Pedido da direção (17/09/2026): "um ícone de suporte com dicas rápidas — como
 * avisar que não vai dar a aula, como mandar na instância do WhatsApp, como
 * mandar no WhatsApp da escola para ter alguma ação". Cada guia descreve um
 * mecanismo que EXISTE (bot de ausência, convite de cobertura, briefing da
 * experimental, lançamento, Smart, Planner IA…), com o caminho e a mensagem
 * exata quando a ação é por WhatsApp.
 *
 * ⚠️ Os números (limite de reposições, prazo de lançamento, R$ do treinamento)
 * são os do produto — se a regra mudar no banco, mude aqui junto.
 */

export type TeacherSupportAction =
  | { kind: 'navigate'; tab: string; label: string }
  | { kind: 'whatsapp-school'; text: string; label: string }
  | { kind: 'whatsapp-coordination'; text?: string; label: string };

export interface TeacherSupportGuide {
  id: string;
  title: string;
  /** Uma linha, aparece fechado na lista. */
  summary: string;
  /** Passos curtos, um por linha. */
  steps: string[];
  /** Palavras que a busca reconhece além do título. */
  keywords: string[];
  actions?: TeacherSupportAction[];
}

export const TEACHER_SUPPORT_GUIDES: TeacherSupportGuide[] = [
  {
    id: 'ausencia',
    title: 'Não vou conseguir dar aula (hoje ou em outro dia)',
    summary: 'Avise o WhatsApp da escola; o bot lista suas aulas e chama os professores livres.',
    steps: [
      'Mande para o WhatsApp da escola: "Não vou conseguir dar aula hoje" (vale "amanhã" ou "dia 18").',
      'O bot responde com a lista das suas aulas daquele dia e pergunta "confirma?". Responda SIM.',
      'Cada aula vira um convite para os professores livres naquele horário: o primeiro que aceita fica com ela.',
      'A aula coberta sai do seu pagamento e entra no de quem deu. Você e a Gestão recebem o resumo.',
      'Vai faltar vários dias (doença, viagem)? Registre também em Saída / Ausência, com as datas.',
    ],
    keywords: ['falta', 'faltar', 'doente', 'doença', 'ausência', 'não vou', 'cobertura', 'substituto', 'avisar'],
    actions: [
      { kind: 'whatsapp-school', text: 'Não vou conseguir dar aula hoje', label: 'Avisar a escola agora' },
      { kind: 'navigate', tab: 'teacher_workflows', label: 'Registrar ausência de vários dias' },
    ],
  },
  {
    id: 'cobertura',
    title: 'Assumir a aula de um colega (cobertura)',
    summary: 'O convite chega por WhatsApp; aceitou, a aula entra no seu Lançar Aula e conta para você.',
    steps: [
      'Você recebe um link no WhatsApp quando um colega não pode dar uma aula no seu horário livre. Abra e aceite — o primeiro que aceita fica com a aula.',
      'No dia, a aula aparece em Lançar Aula como sua. Lance normalmente: ela entra no seu pagamento, na sua tarifa.',
      'Cobriu uma aula combinada na hora (sem convite)? A coordenação registra pelo grupo da Gestão e a aula aparece para você lançar.',
    ],
    keywords: ['cobrir', 'cobertura', 'colega', 'substituir', 'convite', 'assumir'],
    actions: [{ kind: 'navigate', tab: 'lessons', label: 'Abrir Lançar Aula' }],
  },
  {
    id: 'lancar-aula',
    title: 'Lançar aulas (é o que gera o seu pagamento)',
    summary: 'Aula por aula, no dia ou nos dias seguintes. Aula não lançada não é paga.',
    steps: [
      'Em Lançar Aula, cada aula do dia aparece com o aluno e o horário. Marque o que aconteceu e o conteúdo.',
      'Aula dada: paga. Falta do aluno: paga e gera uma reposição para ele (4 por mês por direito; da 5ª em diante é combinação, sem obrigação). Falta sua: não paga, e a reposição paga quando você a der.',
      'A janela para lançar é curta (os últimos dias). Aula esquecida vira pendência em Pendentes — resolva na semana.',
      'Cerca de 40 min depois da aula o aluno recebe uma confirmação de presença. Se ele disser que não teve aula, o pagamento dela fica em espera até a coordenação resolver.',
    ],
    keywords: ['lançar', 'lancar', 'lançamento', 'presença', 'falta do aluno', 'pendente', 'pagar', 'pagamento'],
    actions: [
      { kind: 'navigate', tab: 'lessons', label: 'Lançar Aula' },
      { kind: 'navigate', tab: 'pending', label: 'Ver pendentes' },
    ],
  },
  {
    id: 'experimental',
    title: 'Aula experimental: do aceite ao fechamento',
    summary: 'Aceite pelo link, receba o briefing, apresente-se ao aluno e responda ao bot depois da aula.',
    steps: [
      'O convite chega por WhatsApp; o primeiro professor que aceita fica com a aula.',
      'Até 2h30 antes você recebe o briefing: nome, WhatsApp, objetivo e nível do aluno.',
      'Antes da aula, mande uma mensagem ao aluno se apresentando e confirmando horário e link. Use o material Trial Class e o fundo oficial da escola.',
      '40 min depois da aula o bot pergunta se ela aconteceu. Responda com nível, interesse (1 a 5) e frequência sugerida, ex.: "SIM A2 4 2x" — ou "faltou".',
      'É essa resposta que lança a aula (paga a experimental) e libera a proposta de matrícula para o aluno.',
    ],
    keywords: ['experimental', 'trial', 'lead', 'aceite', 'briefing', 'SIM A2', 'matrícula'],
    actions: [{ kind: 'navigate', tab: 'pedagogical', label: 'Abrir materiais (Trial Class)' }],
  },
  {
    id: 'smart',
    title: 'Seu WhatsApp automático (Smart) e os lembretes',
    summary: 'Conecte seu número; o lembrete de 30 min sai sozinho ou pelo botão Disparar.',
    steps: [
      'Em Comunicação → Smart, conecte seu WhatsApp lendo o QR. É por ele que os lembretes chegam aos seus alunos.',
      'AUTO ligado: o lembrete sai 30 minutos antes de cada aula, sem você fazer nada.',
      'MANUAL: em Aulas de Hoje (Início), clique em Disparar na aula. O botão some no modo AUTO para não mandar em dobro.',
      'O texto do lembrete é seu: personalize em Comunicação → Mensagens.',
    ],
    keywords: ['smart', 'qr', 'conectar', 'lembrete', 'disparar', 'automático', 'instância', 'whatsapp'],
    actions: [
      { kind: 'navigate', tab: 'automation', label: 'Abrir Smart' },
      { kind: 'navigate', tab: 'msg_settings', label: 'Personalizar mensagens' },
    ],
  },
  {
    id: 'pagamento',
    title: 'Quanto vou receber e quando',
    summary: 'Aulas lançadas × sua tarifa; fechamento no dia 1º; PIX no seu cadastro.',
    steps: [
      'Financeiro mostra o "a receber" do mês: só aulas LANÇADAS entram, na tarifa da faixa de cada aluno.',
      'O turbo sobe a tarifa no mês inteiro quando você fecha o mês sem falta sua (a régua é o mês fechado).',
      'O fechamento sai no dia 1º com o relatório do mês; conflito de presença segura só a aula em conflito.',
      'Confira sua chave PIX em Financeiro — é para ela que o repasse vai.',
    ],
    keywords: ['financeiro', 'receber', 'salário', 'repasse', 'pix', 'turbo', 'fechamento', 'tarifa', 'valor'],
    actions: [{ kind: 'navigate', tab: 'teacher-financials', label: 'Abrir Financeiro' }],
  },
  {
    id: 'planner',
    title: 'Planejar a aula com a IA',
    summary: 'Escolha o aluno, diga o objetivo em uma frase e receba o plano de 30 min em blocos.',
    steps: [
      'Em Início → Aulas de Hoje, clique em Planejar na aula; ou vá em Pedagógico → Planner IA e escolha o aluno.',
      'Escreva o objetivo em uma frase (ex.: "rotina e hábitos, Simple Present, ele trava ao responder"). Quanto mais específico, melhor o plano.',
      'O plano vem em blocos com minutos, orientação para você, tarefa do aluno, exemplos bilíngues, vocabulário e perguntas.',
      'Salve: o plano entra na memória do aluno e a próxima aula continua de onde parou. Também gera feedback, teste oral, tarefa de casa, roteiro e relatório de progresso.',
    ],
    keywords: ['planner', 'planejar', 'ia', 'inteligência artificial', 'plano de aula', 'roteiro', 'tarefa', 'feedback'],
    actions: [{ kind: 'navigate', tab: 'lesson-planner-ai', label: 'Abrir Planner IA' }],
  },
  {
    id: 'reposicoes',
    title: 'Reposições',
    summary: 'Falta gera reposição; agende data e hora para ela aparecer em Lançar Aula.',
    steps: [
      'Falta do aluno gera reposição para ele (4 por mês por direito; da 5ª em diante depende de combinar com você, sem obrigação); falta sua gera reposição que paga quando você a der.',
      'Em Reposições, marque a data e a hora combinadas. Sem data ela não aparece para lançar — e é uma aula devida ao aluno.',
      'No dia, a reposição aparece em Lançar Aula como REPOSIÇÃO.',
    ],
    keywords: ['reposição', 'reposicao', 'repor', 'falta', 'remarcar'],
    actions: [{ kind: 'navigate', tab: 'reschedules', label: 'Abrir Reposições' }],
  },
  {
    id: 'agenda',
    title: 'Minha disponibilidade e novos alunos',
    summary: 'Horário livre marcado na Agenda é o que recebe experimental, cobertura e aluno novo.',
    steps: [
      'Em Agenda, marque cada horário livre (blocos de 30 min). A escola só oferece o que está marcado.',
      'Experimentais, coberturas e alunos novos chegam pelos seus horários livres — grade desatualizada é convite que não chega.',
      'Mudou a rotina? Atualize a grade no mesmo dia.',
    ],
    keywords: ['agenda', 'disponibilidade', 'horário livre', 'grade', 'aluno novo'],
    actions: [{ kind: 'navigate', tab: 'schedule', label: 'Abrir Agenda' }],
  },
  {
    id: 'materiais',
    title: 'Materiais pedagógicos',
    summary: 'Use o banco aprovado (nicho › nível › livro); o que você enviar passa por aprovação.',
    steps: [
      'Em Materiais, navegue por nicho, nível e livro. As partes de um livro ficam agrupadas.',
      'Material seu: envie pela mesma tela; ele entra como "em aprovação" e só aparece para os outros depois do OK da direção.',
    ],
    keywords: ['material', 'materiais', 'livro', 'pdf', 'aprovação', 'trial class'],
    actions: [{ kind: 'navigate', tab: 'pedagogical', label: 'Abrir Materiais' }],
  },
  {
    id: 'treinamento',
    title: 'Treinamento',
    summary: 'O convite chega por WhatsApp; aceite pelo link. Quem ministra recebe após lançar.',
    steps: [
      'O convite de treinamento chega no seu WhatsApp com data e hora; abra o link e aceite.',
      'Dura 30 minutos. Quem MINISTRA recebe R$ 16 depois de lançar o treinamento realizado em Lançar Aula.',
    ],
    keywords: ['treinamento', 'treino', 'onboarding', 'ministrar'],
    actions: [{ kind: 'navigate', tab: 'training', label: 'Abrir Treinamentos' }],
  },
  {
    id: 'politica-remarcacao',
    title: 'Política de remarcação e conduta com o aluno',
    summary: 'Cobertura primeiro, aviso cedo; remarcar só se o aluno topar; o aluno não está fazendo favor.',
    steps: [
      'Não vai conseguir dar a aula? A PRIMEIRA opção é a cobertura, não a remarcação: avise a escola cedo ("Não vou conseguir dar aula dia X") e outro professor dá a aula no horário do aluno.',
      'Remarcar com o aluno só se ELE topar — o horário é contratado e muita gente tem rotina que não flexibiliza. Aula remarcada por você não conta como falta do aluno.',
      'Emergência acontece (saúde, família, trânsito) e a escola dá todo o suporte. O que se pede é responsabilidade: aviso o mais cedo possível, e sair para a aula contando com imprevisto.',
      'Cobre o comparecimento do seu aluno: faltou, mande mensagem puxando a reposição (ele tem 4 por mês por direito). Quem cobra reposição fideliza; reposição sem data não acontece.',
      'Conduta: o aluno está ali pelo aprendizado, não fazendo favor. Não descarregue problema pessoal no aluno nem peça compreensão para faltar — a relação é profissional e é uma troca.',
    ],
    keywords: ['remarcar', 'remarcação', 'política', 'conduta', 'profissional', 'emergência', 'responsabilidade', 'comparecimento', 'cobrar'],
    actions: [
      { kind: 'whatsapp-school', text: 'Não vou conseguir dar aula hoje', label: 'Avisar a escola agora' },
    ],
  },
  {
    id: 'coordenacao',
    title: 'Falar com a coordenação',
    summary: 'Troca de horário de aluno, transferência, dúvida de aluno: a coordenação registra pelo grupo da Gestão.',
    steps: [
      'Mudança de horário fixo de um aluno, transferência para outro professor ou mudança de plano são registradas pela coordenação — mande a mensagem com aluno, dia e horário.',
      'Dúvida sobre um aluno específico (conteúdo, comportamento, cobrança): fale com a coordenação, não com a família.',
    ],
    keywords: ['coordenação', 'coordenacao', 'débora', 'falar', 'ajuda', 'humano', 'transferência', 'trocar horário'],
    actions: [{ kind: 'whatsapp-coordination', label: 'Abrir WhatsApp da coordenação' }],
  },
];

const fold = (value: string): string =>
  String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Busca tolerante a acento: título, resumo, passos e palavras-chave. */
export function searchTeacherSupportGuides(query: string, guides = TEACHER_SUPPORT_GUIDES): TeacherSupportGuide[] {
  const terms = fold(query).split(/\s+/).filter(t => t.length >= 2);
  if (!terms.length) return guides;
  return guides.filter(guide => {
    const haystack = fold([guide.title, guide.summary, ...guide.steps, ...guide.keywords].join(' '));
    return terms.every(term => haystack.includes(term));
  });
}

/** Link "clique para conversar" do WhatsApp, com o texto já preenchido. */
export function whatsappLink(phoneDigits: string, text?: string): string | null {
  let digits = String(phoneDigits || '').replace(/\D/g, '');
  // Cadastro sem o 55 (a coordenação está como "(11) 97168-1451"): é Brasil.
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (digits.length < 12 || digits.length > 13) return null;
  const base = `https://wa.me/${digits}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}
