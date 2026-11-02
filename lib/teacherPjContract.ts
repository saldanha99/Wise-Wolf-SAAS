/** Texto exclusivo da v3. As versões 1 e 2 permanecem no componente legado. */
export const TEACHER_PJ_CONTRACT_SINCE = 3;
export const TEACHER_CONTRACT_NOTICE_DAYS = 30;

export interface TeacherPjClause { title: string; paragraphs: string[] }

export function teacherPjClauses(lessonRate: number): TeacherPjClause[] {
  const amount = lessonRate.toFixed(2).replace('.', ',');
  return [
    { title: 'CLÁUSULA 1ª – OBJETO E ATENDIMENTOS ACEITOS', paragraphs: [
      '1.1 A CONTRATADA prestará serviços de ensino de inglês nos atendimentos que aceitar expressamente, com aluno beneficiário, vigência, duração e agenda identificados em registro próprio. O aluno mantém seu contrato educacional com a CONTRATANTE; não contrata nem remunera diretamente a CONTRATADA.',
      '1.2 A proposta de aluno, cobertura ou novo horário poderá ser recusada antes do aceite, sem multa pela recusa. A assinatura deste contrato geral não presume aceite de toda a carteira ou de propostas futuras. O compromisso individual será formalizado pelo canal oficial antes da confirmação do atendimento, sem autorizar abandono de aulas anteriormente assumidas.',
    ] },
    { title: 'CLÁUSULA 2ª – AUTONOMIA E REPRESENTAÇÃO', paragraphs: [
      '2.1 A contratação é proposta como prestação civil entre empresas, sujeita à legislação efetivamente aplicável. A denominação PJ, a nota fiscal e esta assinatura não afastam direitos indisponíveis nem determinam, por si, a natureza jurídica da relação, que depende da execução concreta.',
      '2.2 A CONTRATADA informa sua disponibilidade e negocia as agendas antes de aceitá-las, podendo atender outros clientes. Não há obrigação de disponibilidade permanente, jornada mínima ou aceitação de novos alunos. Depois do aceite, cumprirá as aulas combinadas ou comunicará o impedimento para a organização da solução.',
      '2.3 A CONTRATADA conserva autonomia técnica na condução das aulas, respeitados o objeto educacional, a adequação do conteúdo ao aluno, a segurança e os materiais licenciados. Reuniões e capacitações adicionais dependem de ajuste prévio de objeto, disponibilidade e remuneração; não são disponibilidade gratuita presumida.',
      '2.4 Quem assina declara representar a empresa identificada, inclusive como empresário individual, e possuir poderes para obrigá-la. O professor executor será identificado. Substituição poderá ser proposta e depende de concordância prévia da CONTRATANTE, qualificação e acesso autorizado; não haverá compartilhamento de credenciais. A indicação do executor não constitui fiança ou garantia pessoal automática do representante.',
    ] },
    { title: 'CLÁUSULA 3ª – HONORÁRIOS E APURAÇÃO', paragraphs: [
      `3.1 Cada aula de 30 (trinta) minutos terá honorários de R$ ${amount}, sem redução do piso expressamente contratado. Atividades adicionais e eventuais bonificações dependem de condições previamente formalizadas e aceitas. Mudanças de preço não retroagem.`,
      '3.2 O fechamento identifica serviços prestados e demais itens ajustados no mês anterior, com pagamento até o dia 10 do mês seguinte. A CONTRATADA poderá contestar divergências e receberá demonstrativo das correções. O tratamento tributário segue a legislação, inclusive retenções legalmente exigidas.',
      '3.3 O comparecimento do professor à aula em que o aluno falta gera os honorários da ocorrência, conforme o atendimento contratado; sua reposição não gera pagamento duplicado da mesma obrigação. Aula não executada por impedimento da CONTRATADA terá sua origem registrada e será remunerada quando efetivamente prestada, observadas as normas obrigatórias aplicáveis.',
      '3.4 Confirmações do aluno e registros do professor são elementos de prova sujeitos a apuração. Silêncio, expiração de link, resultado de IA ou ausência isolada de registro técnico não provam a prestação nem a culpa. Parcela incontroversa não será retida em razão de discussão sobre outra ocorrência.',
    ] },
    { title: 'CLÁUSULA 4ª – EXECUÇÃO, IMPEDIMENTOS E CONTINUIDADE', paragraphs: [
      '4.1 A CONTRATADA cumprirá a duração e os horários livremente assumidos, usará a sala oficial e registrará a execução com veracidade até o fim do dia útil seguinte. Impedimento previsível será comunicado imediatamente e, sempre que possível, com 24 horas de antecedência; urgências serão comunicadas tão logo possível.',
      '4.2 Alterações serão propostas pelo canal oficial e dependerão das confirmações pertinentes. A CONTRATANTE organizará a cobertura, reposição ou transição e o atendimento da família. A CONTRATADA colaborará com informação pedagógica suficiente, sem expor dados desnecessários. Falta do professor não consumirá a franquia de reposições por faltas do aluno.',
      '4.3 A CONTRATADA custeará os recursos próprios ordinários expressamente assumidos, como conexão e equipamento, sem transferência genérica de riscos ou obrigações legais da CONTRATANTE. Falhas da escola, do provedor ou do aluno serão apuradas separadamente.',
      '4.4 Ausência injustificada em ocorrência expressamente assumida poderá gerar multa moratória equivalente a 100% dos honorários daquela ocorrência não prestada, apenas pelas unidades de tempo cujo descumprimento tenha sido comprovado. A base não é a mensalidade do aluno. Aplicam-se a comunicação, o prazo de manifestação, a proporcionalidade e a vedação de duplicidade da Cláusula 6ª, inclusive quando o fato também se relacionar à saída.',
    ] },
    { title: 'CLÁUSULA 5ª – OBRIGAÇÕES DA CONTRATANTE', paragraphs: [
      '5.1 A CONTRATANTE fornecerá acesso autorizado, materiais licenciados e informação necessária ao atendimento; apresentará somente propostas compatíveis com a disponibilidade informada; conduzirá reclamações e continuidade do serviço; e efetuará os pagamentos devidos.',
      '5.2 A CONTRATANTE não imporá novos alunos ou horários por silêncio e manterá canal acessível para propostas, recusas, impedimentos e comunicações de encerramento. A organização do serviço deverá respeitar a autonomia acordada e as normas obrigatórias.',
    ] },
    { title: 'CLÁUSULA 6ª – ENCERRAMENTO E TRANSIÇÃO DE 30 DIAS', paragraphs: [
      '6.1 O contrato é de execução continuada, sem obrigação de permanência ou aceitação de novos serviços. Sua duração observará os limites legais aplicáveis, inclusive o art. 598 do Código Civil; eventual continuidade após o limite dependerá de nova formalização. O termo individual não cria fidelidade do professor pelo prazo do plano do aluno.',
      '6.2 Qualquer parte poderá encerrar imotivadamente o contrato mediante comunicação escrita com 30 (trinta) dias corridos de antecedência, contados do dia seguinte ao recebimento comprovado no canal oficial. Este é prazo contratual bilateral de transição; não é afirmação de que o art. 599 do Código Civil imponha 30 dias a toda prestação PJ. A eficácia da comunicação não depende de autorização da outra parte.',
      '6.3 Durante a transição serão mantidos apenas os atendimentos já aceitos e ainda vigentes até a data de encerramento, com remuneração normal. Não há obrigação de aceitar novos alunos, ampliar a agenda, trabalhar gratuitamente ou permanecer até a escola conseguir substituto. A CONTRATANTE organizará a continuidade e liberará o prestador na data comunicada.',
      '6.4 As partes poderão reduzir ou dispensar o prazo por acordo escrito, discriminando aulas e valores. Quem receber o aviso poderá liberar a outra parte antes, sem penalidade para quem ofereceu cumprir a transição. Inadimplemento relevante da outra parte, risco à segurança ou impossibilidade justificada poderão fundamentar encerramento antecipado, conforme a lei e a prova, sem multa automática. Impedimentos de saúde não exigem divulgação de diagnóstico ao aluno.',
      '6.5 A supressão injustificada de parte do prazo poderá gerar cláusula penal bilateral: média mensal dos honorários de aulas dos até três últimos meses completos de prestação, multiplicada pelos dias de aviso injustificadamente suprimidos e dividida por 30. Se ainda não houver mês completo, usa-se o valor dos atendimentos já aceitos para os 30 dias seguintes à comunicação. Sem base demonstrável, não haverá valor arbitrado. O resultado observará os limites da obrigação principal e a redução legal por cumprimento parcial ou excesso.',
      '6.6 A parte apontada receberá os fatos e o cálculo, com cinco dias úteis para manifestação, prorrogáveis justificadamente. Multa e eventual dano adicional exigirão fundamento e apuração; não haverá retenção automática de honorários, negativação ou cobrança por mera comunicação de saída. Não se acumulam penalidades ou indenizações que reparem o mesmo dano. Indenização suplementar somente será exigida, quando juridicamente cabível, pelo prejuízo excedente comprovado.',
      '6.7 O encerramento preserva honorários devidos e registros anteriores. A escola entregará demonstrativo final e declaração da data de término. Não há quitação geral por silêncio.',
      '6.8 Mantém-se o bônus de transição de 10% sobre os honorários do último fechamento mensal quando a CONTRATADA cumprir integralmente a transição de 30 dias e colaborar com o repasse pedagógico e os registros pertinentes. A redução ou dispensa do prazo deve discriminar por escrito o tratamento desse bônus; a liberação antecipada por iniciativa da CONTRATANTE não prejudica o bônus de quem ofereceu cumprir o prazo e colaborou na transição possível. Benefício de instrumento anterior continua regido pela versão efetivamente aceita.',
    ] },
    { title: 'CLÁUSULA 7ª – CADASTRO FISCAL E NOTA', paragraphs: [
      '7.1 A CONTRATADA manterá sua inscrição e atividade regulares, observando o regime tributário legalmente cabível. Não se presume enquadramento como MEI. Cada parte cumprirá suas obrigações tributárias e previdenciárias, inclusive as retenções que a lei atribuir à CONTRATANTE.',
      '7.2 A CONTRATADA emitirá e entregará a nota fiscal na forma e no prazo exigidos pela legislação aplicável e pelo procedimento de fechamento comunicado, identificando serviços e valores. A escola solicitará a regularização de pendências documentais; a ausência de nota não autoriza, por si, retenção global ou indefinida de honorários incontroversos já devidos.',
    ] },
    { title: 'CLÁUSULA 8ª – DADOS E CONFIDENCIALIDADE', paragraphs: [
      '8.1 As partes tratarão apenas os dados necessários à execução, ao cumprimento legal e ao exercício regular de direitos, com acesso restrito e medidas de segurança. A CONTRATADA manterá sigilo de dados de alunos e informações reservadas, inclusive após o encerramento. O término não autoriza cópia da carteira ou uso de dados para finalidade própria incompatível.',
      '8.2 Os tratamentos específicos de registro de aulas seguem a Cláusula 11ª e o aviso aplicável, sem converter este contrato em consentimento genérico para finalidades distintas.',
    ] },
    { title: 'CLÁUSULA 9ª – NÃO EXCLUSIVIDADE E DIREITOS', paragraphs: [
      '9.1 A CONTRATADA poderá prestar serviços a terceiros. Durante a vigência e nos seis meses posteriores, não usará dados ou informação confidencial obtidos nesta relação para aliciamento ativo e desleal de alunos da CONTRATANTE. A regra não proíbe publicidade geral, outros clientes ou atividade profissional lícita e não cria proibição genérica de concorrência.',
      '9.2 Para questões civis, e quando a eleição for legalmente válida, fica escolhido o foro da sede da CONTRATANTE, identificado neste documento, sem afastar competência obrigatória ou dificultar acesso à Justiça. Nenhuma declaração de natureza civil contém renúncia a direitos indisponíveis.',
      '9.3 Este texto aplica-se a partir de sua assinatura válida. Instrumentos anteriores não são reescritos. Não cria multa retroativa, garantia de ausência de emprego ou obrigação do aluno de pagar ou cobrar a dívida do prestador.',
    ] },
    { title: 'CLÁUSULA 10ª – MATERIAL E PROPRIEDADE INTELECTUAL', paragraphs: [
      '10.1 Materiais preexistentes da CONTRATANTE ou de terceiros permanecem com seus respectivos titulares e são licenciados à CONTRATADA apenas para os atendimentos autorizados. Materiais próprios preexistentes e conhecimento geral da CONTRATADA não se transferem automaticamente à CONTRATANTE.',
      '10.2 Encomenda de conteúdo novo, cessão ou licença adicional dependerá de ajuste específico de objeto, direitos, prazo e remuneração, respeitados os direitos autorais indisponíveis. Dados e registros do aluno permanecerão sujeitos às regras de acesso e continuidade pedagógica.',
    ] },
  ];
}
