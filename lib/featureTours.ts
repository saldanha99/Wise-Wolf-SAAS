import type { FlatStep, TourRole, TourStep } from './tours';

/**
 * Como a escola autoriza o registro das aulas (migration 20260929100000):
 * SCHOOL_DEFAULT (a escola autoriza; cada pessoa pode pedir para não ser
 * registrada) ou INDIVIDUAL_CONSENT (aceite individual pelo termo).
 */
export type RecordingAuthorizationMode = 'SCHOOL_DEFAULT' | 'INDIVIDUAL_CONSENT';

/** Resposta de `my_lesson_recording_authorization_mode`; o resto é desconhecido. */
export function asRecordingAuthorizationMode(value: unknown): RecordingAuthorizationMode | null {
  return value === 'SCHOOL_DEFAULT' || value === 'INDIVIDUAL_CONSENT' ? value : null;
}

/** O que a tela sabe da escola de quem está logado para escolher os tours. */
export interface FeatureTourContext {
  /**
   * Modo da escola; nulo = desconhecido (a leitura falhou ou o servidor é
   * antigo): o tour que depende do modo não abre — mostrar o do termo a quem
   * está no modo da escola (ou o contrário) é pior do que não mostrar.
   */
  recordingMode: RecordingAuthorizationMode | null;
  linkedAffiliate?: boolean;
}

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
  roles: (TourRole | 'SALESPERSON')[];
  steps: TourStep[];
  /**
   * Só para escolas neste modo de autorização do registro das aulas. Os tours
   * do termo (link, código, "Li e autorizo", envio em lote) não valem para quem
   * está no modo da escola, e os do modo da escola não valem para quem segue no
   * aceite individual (migration 20260929100000).
   */
  recordingMode?: RecordingAuthorizationMode;
  linkedAffiliateOnly?: boolean;
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
    // Ordem alfabética dentro do mesmo dia (o teste exige a lista ordenada).
    id: '2026-09-26-cartao-do-aluno',
    title: 'Cartão do aluno',
    roles: ['SCHOOL_ADMIN', 'TEACHER'],
    steps: [
      {
        target: null,
        view: 'students',
        title: 'Novidade: o cartão do aluno 🗂️',
        text: 'Abra a ficha de um aluno e vá em "Continuidade pedagógica": o cartão guarda o objetivo real, os temas que engajam, como ele prefere ser corrigido, o que evitar e observações para quem der a aula. Quem escreve é o professor (ou a coordenação e a direção), sem IA — e o Planner passa a usar o cartão antes do que o Wolfie deduziu. Aluno menor de idade, com responsável cadastrado ou sem idade comprovada guarda só objetivo e temas. Não registre saúde, religião, política, família ou dinheiro.',
      },
    ],
  },
  {
    id: '2026-09-26-registro-das-aulas',
    title: 'Autorização do registro das aulas',
    roles: ['SCHOOL_ADMIN'],
    recordingMode: 'INDIVIDUAL_CONSENT',
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
    recordingMode: 'INDIVIDUAL_CONSENT',
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
    recordingMode: 'INDIVIDUAL_CONSENT',
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
    recordingMode: 'INDIVIDUAL_CONSENT',
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
    recordingMode: 'INDIVIDUAL_CONSENT',
    steps: [
      {
        target: 'recording-teacher-google',
        view: 'lesson-sessions',
        title: 'Confirme sua conta Google 🔑',
        text: 'Antes de autorizar o registro das aulas, entre com a conta Google que você usa nas aulas. É ela que a escola coloca como coanfitriã da sala — sem essa confirmação o botão de autorizar fica desligado.',
      },
    ],
  },
  {
    // O tour do cartão (2026-09-26) só explicava o cartão, sem apontar onde
    // ele fica para o professor: aqui o holofote vai no "Dossiê do aluno".
    id: '2026-09-27-cartao-no-dossie',
    title: 'Cartão do aluno no dossiê',
    roles: ['TEACHER'],
    steps: [
      {
        target: 'lesson-session-handover',
        view: 'lesson-sessions',
        title: 'O cartão do aluno fica no dossiê 🗂️',
        text: 'Em cada aula desta lista, "Dossiê do aluno" abre o cartão que você escreve: objetivo real, temas que engajam, como o aluno prefere ser corrigido, o que evitar e observações para quem der a próxima aula. O Planner IA usa o cartão antes do que o Wolfie deduziu.',
      },
      {
        target: null,
        view: 'lesson-sessions',
        title: 'Onde achar o cartão',
        // Mesma regra do tour 2026-09-26-cartao-do-aluno: o servidor só limita
        // tamanho (não filtra assunto) e trata responsável cadastrado como menor.
        text: 'Pelo "Dossiê do aluno" de qualquer aula dos últimos ou dos próximos 7 dias, aqui em "Salas e continuidade", ou pela ficha do aluno em "Alunos" → "Continuidade pedagógica". Aluno menor de idade, com responsável cadastrado ou sem idade comprovada guarda só objetivo e temas. Não registre saúde, religião, política, família ou dinheiro.',
      },
    ],
  },
  {
    id: '2026-09-27-identidade-e-previas-dos-links',
    title: 'A identidade da escola nos seus links',
    roles: ['SCHOOL_ADMIN', 'TEACHER', 'STUDENT'],
    steps: [{
      target: 'user-menu',
      view: 'dashboard',
      title: 'Os links agora têm a marca da escola',
      text: 'A marca Wise Wolf aparece na aba do navegador, no aplicativo instalado e nas prévias dos links. Cada prévia indica se o acesso é para uma aula, matrícula ou contrato. Seus dados pessoais continuam disponíveis somente pelo acesso apropriado.',
    }],
  },
  {
    id: '2026-09-27-minhas-aulas-registradas',
    title: 'Minhas aulas registradas',
    roles: ['STUDENT'],
    steps: [
      {
        target: 'student-lesson-records',
        view: 'lesson-records',
        title: 'Novidade: o registro das suas aulas 📒',
        text: 'Aqui aparece o que o seu professor aprovou de cada aula na sala da escola no Google Meet: objetivo, o que foi praticado, próximo passo e lição. A transcrição completa não aparece — ela é vista só pelo professor da aula, pela coordenação e pela direção. Nesta tela você também vê o que é guardado e por quanto tempo, a situação do registro das suas aulas, como pedir para não ser registrado (ou revogar a autorização) e como pedir a exclusão pelo WhatsApp da escola.',
      },
    ],
  },
  {
    id: '2026-09-27-planner-aulas-aprovadas',
    title: 'Planner a partir das aulas aprovadas',
    roles: ['TEACHER'],
    steps: [
      {
        target: 'planner-student-select',
        view: 'lesson-planner-ai',
        title: 'O aluno da cobertura também está aqui 🐺',
        text: 'Além dos seus alunos, a lista traz o aluno de quem você é segundo professor e, do dia anterior ao dia seguinte da aula, o aluno da cobertura confirmada ou da reposição marcada com você — com "cobertura até dd/mm" ao lado do nome. Depois disso ele sai da lista. O botão de planejar em Aulas de Hoje já abre o Planner com ele escolhido.',
      },
      {
        target: 'planner-lesson-basis',
        view: 'lesson-planner-ai',
        title: 'O plano diz de quais aulas saiu',
        text: 'Ao gerar, o Planner lê os resumos das aulas no Meet que o professor aprovou — até as 6 mais recentes — e mostra neste quadro: "Baseado nas aulas de 20/09 e 23/09". O plano continua do próximo passo aprovado, e a tarefa de casa ataca os erros recorrentes confirmados. Resumo que ninguém aprovou (ou que foi rejeitado depois) não entra, e se houve aula lançada depois da última aprovada, o plano parte dos lançamentos.',
      },
    ],
  },
  {
    id: '2026-09-27-resumo-automatico',
    title: 'Resumo da aula por IA',
    roles: ['SCHOOL_ADMIN'],
    steps: [
      {
        target: 'meet-summary-budget',
        view: 'google-meet',
        title: 'O rascunho da aula sai sozinho 🤖',
        text: 'Depois de cada aula documentada, a IA escreve o rascunho — objetivo, o que foi praticado, dificuldades e próximo passo, citando a transcrição — num fornecedor pago que não usa o conteúdo para treinar. Aqui você vê o gasto do mês e define o teto (padrão: US$ 20). Atingido o teto, o automático para; o botão manual da aula continua, com aviso de custo.',
      },
      {
        target: 'meet-review-queue',
        view: 'lesson-sessions',
        title: 'Aulas para revisar',
        text: 'Os rascunhos esperam o professor revisar e aprovar: só o aprovado vai para a memória do aluno. A lista mostra até quando cada um pode ser aprovado (depois disso as fontes são apagadas), e rascunho parado há 3 dias ou mais aparece nas suas pendências.',
      },
    ],
  },
  {
    id: '2026-09-27-resumo-automatico-professor',
    title: 'Aulas para revisar',
    roles: ['TEACHER'],
    steps: [
      {
        target: 'meet-review-queue',
        view: 'lesson-sessions',
        title: 'Revise o rascunho das suas aulas 📝',
        text: 'Depois de cada aula documentada chegam as notas do Gemini (com o próximo passo e a lição já preenchidos) e um rascunho da IA com trechos da transcrição. Confira, complete o objetivo e aprove: só o que você aprova vai para a memória do aluno. Cada aula mostra até quando dá para aprovar.',
      },
    ],
  },
  {
    // "retencao" vem depois de "resumo" na ordem alfabética do mesmo dia.
    id: '2026-09-27-retencao-dos-originais',
    title: 'Originais na lixeira do Drive',
    roles: ['SCHOOL_ADMIN'],
    steps: [
      {
        target: 'meet-originals-retention',
        view: 'google-meet',
        // O tour sobe com o deploy, com a lixeira ainda desligada (padrão): o
        // texto não promete a lixeira nem manda reconectar — o cartão é que diz,
        // pela configuração de cada instalação, se ela está ligada e o que falta.
        title: 'Os originais das aulas no Drive 🗑️',
        text: 'O documento da transcrição, o das anotações do Gemini e a planilha de presença de cada aula ficam no Drive da conta central. Quando a lixeira automática está ligada, eles vão para a lixeira do Drive 90 dias depois da aula (ainda recuperáveis por 30 dias). Só vão os arquivos que o próprio Meet indicou e as planilhas que o sistema identificou pelo código da sala — nada é procurado por nome. Este cartão mostra se a lixeira está ligada, o que já foi, o que espera o prazo e o que precisa ser conferido à mão.',
      },
      {
        target: null,
        view: 'students',
        title: 'Aluno pediu para apagar? ✋',
        text: 'Abra a ficha do aluno e vá em "Continuidade pedagógica" → "Apagar registros das aulas deste aluno". A tela mostra antes o que será apagado — cópias da transcrição e das anotações, relatórios de presença, rascunhos e resumos, memória das aulas no Meet e o cartão do aluno — e o que acontece com os originais no Drive: com a lixeira ligada eles vão para ela na hora; o que ela não alcança, a tela manda apagar à mão. Presença lançada, pagamento e o aceite do termo não mudam. Só a direção vê o botão.',
      },
    ],
  },
  {
    id: '2026-09-27-termo-v3',
    title: 'Termo das aulas, versão 3',
    roles: ['SCHOOL_ADMIN'],
    recordingMode: 'INDIVIDUAL_CONSENT',
    steps: [
      {
        target: 'recording-term-identity',
        view: 'recording-consents',
        title: 'O termo das aulas mudou 📄',
        text: 'A versão 3 conta tudo o que o sistema faz com o registro: resumo por IA que o professor aprova, planejamento, dossiê por link com login na troca de professor, cartão do aluno, quem vê (inclusive o suporte técnico do sistema), prazos de 90 dias e direitos. A escola aparece no termo como responsável pelos dados — confira aqui como ela aparece; se faltar razão social, CNPJ ou contato de privacidade, complete em Configurações → Escola e legal.',
      },
      {
        target: 'recording-consents',
        view: 'recording-consents',
        title: 'Aceite antigo não vale mais',
        text: 'Quem autorizou uma versão anterior precisa aceitar o texto novo: até lá as próximas aulas dessa pessoa não são transcritas e são desmarcadas sozinhas (aula que já aconteceu segue o aceite que valia nela). O envio em lote já conta esses alunos como pendentes; os professores respondem de novo na tela deles.',
      },
    ],
  },
  {
    id: '2026-09-27-termo-v3-professor',
    title: 'Termo das aulas, versão 3',
    roles: ['TEACHER'],
    recordingMode: 'INDIVIDUAL_CONSENT',
    steps: [
      {
        target: 'recording-teacher-consent',
        view: 'lesson-sessions',
        title: 'O termo do registro das aulas mudou 📄',
        text: 'A versão 3 explica o resumo por IA que você revisa antes de entrar na ficha, o planejamento com IA, o dossiê por link na troca de professor, o cartão do aluno e o extrato de pontualidade — sem nota, sem ranking e sem mexer no seu pagamento. Quem autorizou a versão anterior precisa ler e autorizar de novo: até lá suas aulas não são transcritas.',
      },
    ],
  },
  {
    // "versao" vem depois de "termo" na ordem alfabética do mesmo dia.
    id: '2026-09-27-versao-do-contrato-com-registro',
    title: 'Registro das aulas no contrato',
    roles: ['SCHOOL_ADMIN'],
    steps: [
      {
        target: 'contracts-recording-clause',
        view: 'contracts',
        title: 'Os contratos novos já trazem o registro das aulas 📄',
        text: 'Na escola que decidiu registrar as aulas, o contrato novo do aluno traz a Cláusula 8 — Do Registro das Aulas, e o do professor, a Cláusula 11ª: transcrição e anotações automáticas do Google Meet (sem vídeo), resumo com IA aprovado pelo professor, relatório de presença, quem processa, prazos de 90 dias e direitos. O registro faz parte do contrato, e quem assina fica ciente e pode pedir, pelo WhatsApp da escola, para não ser registrado — o mesmo que diz o aviso do registro no app. Contrato assinado antes continua com o texto que foi assinado — a coluna "Contrato" mostra a versão de cada aluno, e o aviso aqui diz o que os contratos novos desta escola trazem.',
      },
    ],
  },
  {
    id: '2026-09-28-dossie-do-substituto',
    title: 'Dossiê na cobertura e na transferência',
    roles: ['TEACHER'],
    steps: [
      {
        target: 'lesson-session-handover',
        view: 'lesson-sessions',
        title: 'Vai cobrir uma aula? O dossiê chega por link 🗂️',
        text: 'Ao aceitar uma cobertura, o WhatsApp da escola manda o contato do aluno, as últimas aulas lançadas, a data da última aula com resumo aprovado, a sala da escola no Meet quando a aula tiver uma (se ela ainda não existir, o link chega depois, por aqui — não mande outro) e o link do dossiê. Abra com o seu login: ele vale do dia anterior ao dia seguinte da aula (também numa reposição marcada com você) e é lá que estão o próximo passo, os erros recorrentes e a lição do resumo aprovado, o histórico e o cartão do aluno. A transcrição completa fica só com quem deu cada aula.',
      },
      {
        target: null,
        view: 'lesson-sessions',
        title: 'Aluno novo por transferência',
        text: 'Quando a escola passa um aluno para você de vez, o link do dossiê dele chega pelo WhatsApp da escola — leia antes da primeira aula. Na transferência o cartão do aluno passa a ser seu também; quem só cobre uma aula lê o cartão, mas não o reescreve. Nada pessoal do aluno vai em texto no WhatsApp: fica tudo atrás do login.',
      },
    ],
  },
  {
    // Migration 20260928110000: a sessão congelada passa para quem dá a aula.
    id: '2026-09-28-sala-da-troca',
    title: 'A sala acompanha a troca de professor',
    roles: ['SCHOOL_ADMIN', 'TEACHER'],
    steps: [
      {
        target: 'meet-review-queue',
        view: 'lesson-sessions',
        title: 'Cobriu a aula? A sala da escola vai junto 🔁',
        text: 'Quando a cobertura de uma aula que tem sala da escola é confirmada, a aula passa para quem vai dá-la: a conta Google que o substituto confirmou vira a coanfitriã da sala e a do titular sai, o lançamento dele fecha a aula e é ele quem revisa o resumo — que aparece nesta lista. Enquanto a conta dele não entra, o link da sala não é mandado a ninguém; quando ela entra, o WhatsApp da escola manda o link a ele e à família (se não chegar até 30 min antes da aula, vale o link de sempre). Substituto sem conta Google confirmada ou sem o termo de registro autorizado: a aula passa para ele do mesmo jeito, mas a transcrição daquela sala fica desligada.',
      },
      {
        target: null,
        view: 'lesson-sessions',
        title: 'Remarcou ou cancelou? A sala antiga sai',
        text: 'Aula com sala da escola que sai da agenda antes de acontecer — reposição remarcada ou encerrada, antecipação, aula cancelada — é arquivada sozinha: o link antigo deixa de valer, a transcrição da sala é desligada e o novo horário ganha sessão própria. Não sobra pendência de lançamento de uma aula que não existe mais. Agendamento transferido de vez para outro professor continua pedindo que a escola replaneje a sessão futura; até lá, a sala antiga não é entregue.',
      },
    ],
  },
  {
    // Sugestões da IA para o cartão (migration 20260928130000). O painel só
    // existe com o dossiê aberto: o primeiro passo aponta o botão do dossiê e o
    // segundo se sustenta sem alvo; o terceiro é pulado se o dossiê estiver fechado.
    id: '2026-09-28-sugestoes-do-cartao',
    title: 'Sugestões da IA no cartão do aluno',
    roles: ['TEACHER'],
    steps: [
      {
        target: 'lesson-session-handover',
        view: 'lesson-sessions',
        title: 'A IA sugere, você decide ✍️',
        text: 'Com o recurso ligado na escola, depois que você aprova o resumo de uma aula a IA lê a aula e sugere itens para o cartão do aluno: objetivo real, temas que engajam, como ele prefere ser corrigido e o que evitar. Abra o "Dossiê do aluno": as sugestões ficam logo abaixo do cartão, cada uma com a frase da aula que a sustenta.',
      },
      {
        target: null,
        view: 'lesson-sessions',
        title: 'Nada entra no cartão sem você',
        text: '"Aceitar" grava no cartão (objetivo e estilo de correção substituem; temas e "o que evitar" entram na lista) e "Descartar" tira a sugestão (a IA não a repete por 90 dias). Você vê as sugestões das aulas que VOCÊ deu — as frases são da transcrição; as de aula dada por outro professor ficam com ele, a coordenação e a direção. A IA não sugere saúde, religião, política, família, dinheiro nem dados de outras pessoas — o que escapar é descartado antes de chegar a você. Aluno menor de idade, com responsável cadastrado ou sem idade comprovada ganha só sugestões de objetivo e temas. E só vale para aula em que o aluno (ou o responsável) e o professor aceitaram o termo versão 3.',
      },
      {
        target: 'learning-card-suggestions',
        view: 'lesson-sessions',
        title: 'Aqui ficam as sugestões',
        text: 'Se não houver nenhuma, o botão pede à IA que leia a aula aprovada mais recente que você deu a este aluno — dentro do teto mensal de IA da escola. Sem o botão, a frase embaixo diz o motivo (recurso desligado, termo sem aceite, aula já lida). A frase da aula fica guardada no máximo 90 dias depois da aula.',
      },
    ],
  },
  {
    // Migration 20260928120000: extrato construído e DESLIGADO por escola até o
    // jurídico liberar. O professor não vê nada enquanto estiver desligado (o
    // tour dele sai quando o extrato for ligado); a direção vê o aviso na aba.
    id: '2026-09-28-tempo-na-sala',
    title: 'Extrato de pontualidade (desligado)',
    roles: ['SCHOOL_ADMIN'],
    steps: [
      {
        target: 'quality-punctuality-tab',
        view: 'lesson-quality',
        title: 'Extrato de pontualidade, pronto e desligado ⏱️',
        text: 'Esta aba traz o extrato de pontualidade de cada professor, mês a mês: o horário em que ele entrou na sala da escola em cada aula, pelo relatório de presença do Google Meet, e o motivo das aulas sem medição. Um professor por vez — sem nota, sem ranking, sem comparação entre professores e sem mexer no pagamento; o próprio professor vê o dele. Ele depende da liberação do jurídico: até lá está desligado, e nada é calculado nem mostrado a ninguém.',
      },
      {
        target: null,
        view: 'lesson-quality',
        title: 'Atraso do Meet não é relato da família',
        text: 'Na fila de casos, o atraso que o relatório de presença do Meet detecta passa a aparecer como "Atraso detectado pelo Meet"; "Atraso relatado" continua sendo o que a família contou. Os dois são aviso para conversar com o professor — nenhum altera o pagamento.',
      },
    ],
  },
  {
    id: '2026-09-28-tempo-na-sala-professor',
    title: 'Seu extrato de pontualidade',
    roles: ['TEACHER'],
    steps: [{
      target: 'teacher-punctuality',
      view: 'dashboard',
      title: 'Confira seu extrato mensal ⏱️',
      text: 'Quando a escola ativa o extrato após aprovação jurídica, este cartão mostra seus horários e minutos nas salas oficiais, pelo relatório de presença do Google Meet. A medição começa nas aulas posteriores à ativação, sem retroativo. Você vê apenas o seu extrato; direção e coordenação consultam um professor por vez. Não há nota, ranking, comparação entre professores nem alteração de pagamento.',
    }, {
      target: null,
      view: 'dashboard',
      title: 'Sem medição não significa falta',
      text: 'Aulas sem relatório ou sem identificação confiável mostram o motivo, não uma conclusão de falta ou atraso. Os registros ficam por até 90 dias depois da aula. Se encontrar uma divergência, peça à direção que confira a aula; o extrato não substitui seu lançamento de presença.',
    }],
  },
  {
    // Migration 20260929100000 — decisão da direção de 27/09/2026: a escola
    // autoriza o registro das aulas; cada pessoa pode pedir para não ser
    // registrada. A Wise Wolf entrou nesse modo pela própria migration.
    id: '2026-09-29-registro-autorizado-pela-escola',
    title: 'Registro das aulas autorizado pela escola',
    roles: ['SCHOOL_ADMIN'],
    recordingMode: 'SCHOOL_DEFAULT',
    steps: [
      {
        target: 'recording-authorization-mode',
        view: 'recording-consents',
        title: 'A escola autoriza o registro das aulas 🎙️',
        text: 'Quando a escola autoriza o registro (contrato ou decisão da direção), alunos e professores ativos — inclusive os menores de idade — têm as aulas registradas sem link, sem código e sem aceite. Este quadro mostra como a escola autoriza, quem decidiu, quando e por quê. Só a direção troca o modo, com confirmação na tela e motivo registrado.',
      },
      {
        target: 'recording-objection',
        view: 'recording-consents',
        title: 'Quem não quiser, pede',
        text: 'Chegou pelo WhatsApp um pedido para não registrar? Toque em "Registrar pedido para não registrar" no aluno (ou no professor) e escreva como o pedido chegou. Vale na hora: a sala da escola tem a transcrição desligada, nada da aula é importado e a IA não lê. "Desfazer pedido" devolve, também com motivo. No modo da escola não há envio do termo nem link por aluno.',
      },
      {
        target: 'recording-term-identity',
        view: 'recording-consents',
        title: 'A escola no aviso',
        text: 'O aviso do registro das aulas (o texto que alunos, famílias e professores leem no app) identifica a escola como responsável pelos dados. Confira aqui como ela aparece; se faltar razão social, CNPJ ou contato de privacidade, complete em Configurações → Escola e legal.',
      },
      {
        target: null,
        view: 'recording-consents',
        title: 'A conta Google continua obrigatória',
        text: 'A sala da escola só nasce para o professor que confirmou por login a conta Google com que entra nas aulas (em "Salas e continuidade"). Sem isso, a aula dele segue pelo link de sempre — a Central de Pendências mostra quem ainda não confirmou.',
      },
    ],
  },
  {
    id: '2026-09-29-registro-autorizado-pela-escola-professor',
    title: 'Registro das suas aulas pela escola',
    roles: ['TEACHER'],
    recordingMode: 'SCHOOL_DEFAULT',
    steps: [
      {
        target: 'recording-teacher-consent',
        view: 'lesson-sessions',
        title: 'Suas aulas são registradas pela escola 🎙️',
        text: 'Quando a escola autoriza o registro das aulas, você não precisa mais tocar em "Li e autorizo": as aulas na sala da escola são transcritas pelo Google Meet (sem vídeo). O aviso completo — para que serve, quem vê, prazos e direitos — está em "Ler o aviso".',
      },
      {
        target: 'recording-teacher-google',
        view: 'lesson-sessions',
        title: 'Confirme a sua conta Google',
        text: 'A sala da escola só nasce para as suas aulas depois que você confirma, por login, a conta Google com que entra nas aulas. Sem isso, a aula segue pelo link de sempre.',
      },
      {
        target: 'recording-teacher-objection',
        view: 'lesson-sessions',
        title: 'Se não quiser ser registrado',
        text: '"Não quero que minhas aulas sejam registradas" vale na hora: as suas aulas seguintes acontecem normalmente, sem transcrição, e nada muda no seu pagamento. Dá para voltar atrás no mesmo lugar.',
      },
    ],
  },
  {
    id: '2026-09-30-aluno-e-afiliado',
    title: 'Seu perfil de afiliada na conta de aluna',
    roles: ['STUDENT'],
    linkedAffiliateOnly: true,
    steps: [{
      target: 'linked-affiliate-panel',
      view: 'referral',
      title: 'Dois programas, um só acesso',
      text: 'Nesta aba você acompanha primeiro seu cupom, comissões e saques como afiliada. Mais abaixo ficam as indicações feitas como aluna; são programas diferentes. Sua agenda e suas aulas continuam na mesma conta.',
    }],
  },
  {
    id: '2026-09-30-conta-google-na-contratacao',
    title: 'Conta Google confirmada na contratação',
    roles: ['TEACHER'],
    recordingMode: 'SCHOOL_DEFAULT',
    steps: [{
      target: 'recording-teacher-google',
      view: 'lesson-sessions',
      title: 'Sua conta Google para as salas oficiais',
      text: 'O cadastro de novos professores agora confirma a conta Google antes da assinatura. Confira aqui qual conta entrará como coanfitriã nas suas aulas; se você mudar de conta, confirme a nova neste cartão.',
    }],
  },
  {
    id: '2026-09-30-google-e-contrato-do-professor',
    title: 'Google e contrato mais claros',
    roles: ['TEACHER'],
    recordingMode: 'SCHOOL_DEFAULT',
    steps: [{
      target: 'recording-teacher-google',
      view: 'lesson-sessions',
      title: 'O botão abre o login do Google',
      text: 'Toque em Confirmar conta Google para abrir o login em outra aba. Use a conta com que entrará nas aulas. Ao voltar, a plataforma confere a confirmação; se o navegador bloquear a aba, aparece um botão destacado para abrir o login.',
    }, {
      target: null,
      view: 'contract_teacher',
      title: 'Seu contrato no portal',
      text: 'Em Meu Contrato, quem ainda não assinou pode revisar os dados e assinar. Se o aceite já existe e a cópia não está arquivada, a tela explica como solicitar a via à escola.',
    }],
  },
  {
    id: '2026-09-30-meet-preenche-lancamento',
    title: 'Lançamento preenchido pelo Meet',
    roles: ['TEACHER'],
    steps: [{
      target: 'class-log-meet-prefill',
      view: 'lessons',
      title: 'Revise o resumo e registre a aula',
      text: 'Quando o resumo da sala oficial estiver disponível, objetivo, conteúdo, dificuldades, tarefa e próximo passo aparecem preenchidos. Confira o quadro, ajuste o que precisar e escolha o resultado da aula. Campos não identificados continuam em branco; Atualizar resumos busca o processamento mais recente. O motivo de um lançamento atrasado é informado por você.',
    }],
  },
  {
    id: '2026-09-30-portal-exige-google',
    title: 'Conta Google obrigatória para professores',
    roles: ['TEACHER'],
    recordingMode: 'SCHOOL_DEFAULT',
    steps: [{
      target: 'recording-teacher-google',
      view: 'lesson-sessions',
      title: 'Use a mesma conta Google nas aulas',
      text: 'Quem ainda não conectou a conta Google recebe uma configuração obrigatória ao entrar no portal. O botão abre o login, a confirmação é conferida ao voltar e a conta conectada aparece antes de continuar. Use essa mesma conta para entrar no link oficial de cada aula; você pode conferir ou trocar a conta neste cartão.',
    }],
  },
  {
    id: '2026-09-30-sala-oficial-para-os-dois',
    title: 'Professor e aluno na mesma sala oficial',
    roles: ['TEACHER'],
    steps: [{ target: 'teacher-official-meet-link', view: 'dashboard', title: 'Use o link oficial de cada aula',
      text: 'A sala oficial aparece no botão da aula no seu painel. Você também recebe no WhatsApp da escola um lembrete cerca de 30 minutos antes, com aluno, horário, link e conta Google confirmada. Professor e aluno devem usar o mesmo link; cada aula tem sua própria sala.' }],
  },
  {
    id: '2026-09-30-sala-oficial-para-os-dois-aluno',
    title: 'Seu link oficial para encontrar o professor',
    roles: ['STUDENT'],
    steps: [{ target: 'student-official-meet-link', view: 'dashboard', title: 'Entre na sala desta aula',
      text: 'Quando sua aula tem uma sala oficial, o botão Entrar na sala oficial abre o mesmo link enviado no lembrete e usado pelo professor. Cada aula tem seu próprio link; confira sempre o botão da aula ou a mensagem mais recente.' }],
  },
  {
    id: '2026-09-30-vincular-aluno-afiliado',
    title: 'Afiliado com conta de aluno',
    roles: ['SCHOOL_ADMIN'],
    steps: [{ target: 'affiliate-invite', view: 'vendors-mgmt', title: 'Escolha o tipo de acesso',
      text: 'No convite, escolha entre conta própria de afiliado e vincular uma conta de aluno existente pelo e-mail exato. No segundo caso, o aluno entra com o acesso que já usa e aceita as regras; comissões e créditos de indicação continuam separados na aba Indicações.' }],
  },
  {
    id: '2026-09-30-z-antecipacoes-ja-realizadas',
    title: 'Contabilizar antecipações já realizadas',
    roles: ['SCHOOL_ADMIN'],
    steps: [{ target: 'historical-lesson-advances', view: 'lesson-advances', title: 'A data realizada define o pagamento',
      text: 'Em Aulas → Antecipações, selecione as ocorrências futuras e informe as datas em que foram dadas. Marque que já foram realizadas somente com confirmação da direção: o registro entra no mês realizado e bloqueia as ocorrências originais, sem duplicar pagamento. Horário desconhecido permanece não informado. Aula futura deve continuar no modo de agendamento.' }],
  },
  {
    id: '2026-09-30-z-atendimento-humano',
    title: 'Encaminhamento à coordenação',
    roles: ['SCHOOL_ADMIN'],
    steps: [{ target: 'whatsapp-human-handoff', view: 'whatsapp', title: 'Conversa com a equipe', text: 'Quando o acompanhamento encaminha um assunto à coordenação, a IA pausa a conversa. Use Devolver para IA apenas quando a equipe decidir retomar o atendimento automático.' }],
  },
  {
    id: '2026-10-01-rateio-liquido-e-saques',
    title: 'Comissão, Turbo e avisos de saque',
    roles: ['SCHOOL_ADMIN'],
    steps: [
      { target: 'net-payment-split', view: 'dre', title: 'Rateio sobre a sobra operacional', text: 'O rateio desconta o salário previsto do professor, incluindo a tarifa Turbo, e a comissão do afiliado na primeira mensalidade vinculada. Sem sobra positiva, o dízimo é zero. Essa conta é uma prévia: confira as aulas lançadas e as demais despesas no DRE para apurar o lucro final.' },
      { target: 'affiliate-withdrawal-notice', view: 'vendors-mgmt', title: 'Pedido de saque avisa o Financeiro', text: 'Novos pedidos de saque entram na fila de avisos do canal Financeiro, com alternativa na Direção/Gestão. Abra a ficha do afiliado, confira o PIX e aprove. Aprovar não envia dinheiro: faça o repasse e depois marque pago.' },
    ],
  },
  {
    id: '2026-10-01-z-confirmacao-de-repasses', title: 'Pagamento confirmado avisa quem recebe', roles: ['SCHOOL_ADMIN'],
    steps: [
      { target: 'payout-confirmation', view: 'payments', title: 'Confirme o PIX já realizado', text: 'Depois de fazer o PIX do professor, use Confirmar PIX feito. A baixa registra a data e prepara o WhatsApp com valor e competência. No pagamento integrado, a confirmação depende da transferência concluída.' },
      { target: 'affiliate-withdrawal-notice', view: 'vendors-mgmt', title: 'O afiliado recebe a confirmação', text: 'Após efetuar o PIX do saque, abra a ficha do afiliado e marque pago. Essa baixa prepara o aviso privado no WhatsApp dele. Aprovar o pedido sozinho continua sem registrar pagamento.' },
    ],
  },
  {
    id: '2026-10-01-z-confirmacao-de-repasses-afiliado', title: 'Confirmação do saque no WhatsApp', roles: ['SALESPERSON'],
    steps: [{ target: 'affiliate-payout-confirmation', view: 'vendor_dashboard', title: 'Sua confirmação de saque', text: 'Quando a escola registrar o saque como pago, a confirmação será preparada para o seu WhatsApp cadastrado. O pedido também aparecerá como pago neste histórico.' }],
  },
  {
    id: '2026-10-01-z-confirmacao-de-repasses-aluno-afiliado', title: 'Seu saque confirmado no WhatsApp', roles: ['STUDENT'], linkedAffiliateOnly: true,
    steps: [{ target: 'affiliate-payout-confirmation', view: 'referral', title: 'Confirmação do pagamento do saque', text: 'Quando a escola registrar seu saque como pago, a confirmação será preparada para o WhatsApp cadastrado na sua conta de afiliado. O pedido também permanece no histórico do painel.' }],
  },
  {
    id: '2026-10-01-z-confirmacao-de-repasses-professor', title: 'Seu repasse confirmado no WhatsApp', roles: ['TEACHER'],
    steps: [{ target: 'teacher-payout-confirmation', view: 'teacher-financials', title: 'Confirmação do seu pagamento', text: 'Quando a direção registrar seu repasse como pago, você recebe no WhatsApp cadastrado a confirmação com valor e competência. O fechamento mensal e a revisão da nota fiscal continuam disponíveis no Financeiro.' }],
  },
  {
    id: '2026-10-02-cobranca-diaria', title: 'Cobrança diária nos dois canais', roles: ['SCHOOL_ADMIN'],
    steps: [{ target: 'daily-collection', view: 'cashflow', title: 'Lembrete diário de mensalidade vencida', text: 'Com a rotina habilitada pela direção, a escola confere o Asaas antes de cobrar por WhatsApp e e-mail às 9h, todos os dias. Cada canal tem registro próprio; quem pagou ou teve a cobrança excluída não recebe. Dependentes são cobrados pelo responsável financeiro cadastrado.' }],
  },
  {
    id: '2026-10-02-teste-oral-com-agenda', title: 'Teste oral com reserva e avisos', roles: ['SCHOOL_ADMIN', 'TEACHER'],
    steps: [{ target: 'oral-test-scheduling', view: 'oral-tests', title: 'O teste ocupa um horário do examinador', text: 'O agendamento reserva 30 minutos somente na data escolhida e prepara avisos para aluno e examinador, com lembretes antes da prova. Confira a situação dos avisos no painel. Remarcar cancela mensagens pendentes antigas; desmarcar libera o horário. O examinador registra o resultado em Testes Orais.' }],
  },
  {
    id: '2026-10-02-teste-oral-na-agenda-aluno', title: 'Seu teste oral na agenda', roles: ['STUDENT'],
    steps: [{ target: 'student-oral-test-agenda', view: 'schedule', title: 'Confira a data do seu teste oral', text: 'Seu teste oral aparece na Agenda com data, horário e examinador. A escola prepara o aviso e o lembrete pelo WhatsApp cadastrado. Quando houver link, use Entrar no teste oral para conversar com o examinador.' }],
  },
  {
    id: '2026-10-02-z-matricula-com-acesso', title: 'Matrícula concluída entrega o acesso', roles: ['SCHOOL_ADMIN'],
    steps: [{ target: 'contracts-recording-clause', view: 'contracts', title: 'Acesso junto das boas-vindas', text: 'Quando a matrícula termina com os pagamentos exigidos confirmados, o servidor prepara as boas-vindas com e-mail de login, endereço do portal e orientação de senha. O envio fica registrado mesmo que o aluno feche a página. O feedback pedagógico da experimental continua pendente para o professor, sem bloquear a conclusão financeira da matrícula.' }],
  },
];

/**
 * O tour vale para a escola de quem está logado? Sem contexto (marcar tudo
 * como visto no fim do tour de boas-vindas), vale tudo.
 */
function fitsContext(tour: FeatureTour, context?: FeatureTourContext): boolean {
  if (!context) return true;
  if (tour.linkedAffiliateOnly && context.linkedAffiliate !== true) return false;
  return !tour.recordingMode || context.recordingMode === tour.recordingMode;
}

/** Tours do papel que a pessoa ainda não viu, na ordem em que saíram. */
export function pendingFeatureTours(
  role: string,
  seenIds: Iterable<string>,
  context?: FeatureTourContext,
): FeatureTour[] {
  const seen = new Set(seenIds);
  return FEATURE_TOURS.filter(t => t.roles.includes(role as TourRole | 'SALESPERSON') && !seen.has(t.id) && fitsContext(t, context));
}

/** Tour mais recente do papel — é o que "Novidades" reabre. */
export function latestFeatureTourFor(role: string, context?: FeatureTourContext): FeatureTour | undefined {
  return [...FEATURE_TOURS].reverse().find(t => t.roles.includes(role as TourRole | 'SALESPERSON') && fitsContext(t, context));
}

/** Passos achatados para o motor, todos sob o capítulo "Novidade". */
export const flattenFeatureTour = (tour: FeatureTour): FlatStep[] =>
  tour.steps.map(s => ({ ...s, chapterTitle: 'Novidade' }));
