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
    id: '2026-09-27-minhas-aulas-registradas',
    title: 'Minhas aulas registradas',
    roles: ['STUDENT'],
    steps: [
      {
        target: 'student-lesson-records',
        view: 'lesson-records',
        title: 'Novidade: o registro das suas aulas 📒',
        text: 'Aqui aparece o que o seu professor aprovou de cada aula na sala da escola no Google Meet: objetivo, o que foi praticado, próximo passo e lição. A transcrição completa não aparece — ela é vista só pelo professor da aula, pela coordenação e pela direção. Nesta tela você também vê o que é guardado e por quanto tempo, a situação da sua autorização, como revogar e como pedir a exclusão pelo WhatsApp da escola.',
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
        text: 'Quando a cobertura de uma aula que tem sala da escola é confirmada, a aula passa para quem vai dá-la: a conta Google que o substituto confirmou vira a coanfitriã da sala e a do titular sai, o lançamento dele fecha a aula e é ele quem revisa o resumo — que aparece nesta lista. Enquanto a conta dele não entra, o link da sala não é mandado a ninguém e a aula usa o link de sempre. Substituto sem conta Google confirmada ou sem o termo de registro autorizado: a aula passa para ele do mesmo jeito, mas a transcrição daquela sala fica desligada.',
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
