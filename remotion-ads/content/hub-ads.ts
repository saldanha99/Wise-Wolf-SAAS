import type { AdScript } from '../types';

// FRENTE B — vender o Wise Wolf School OS para escolas de idiomas e professores com carteira.
//
// ⚠️ DESTINO: só `/new-saas` (escola) e `/seja-professor` (professor). NÃO mandar tráfego para
// /biblioteca nem /educador-ia: em produção `hub_get_public_settings` devolve
// `catalogReady: false`, o catálogo público tem zero itens ativos, o botão de trial fica
// DESABILITADO ("Abertura em breve") e `create-hub-checkout` responde 503
// HUB_CATALOG_NOT_READY. Anúncio para lá queima verba numa página sem ação possível.
//
// ⚠️ PROVA SOCIAL: não existe. Medido na produção — 6 tenants, nenhum com plano, zero
// saas_leads, zero hub_checkout_sessions, zero faturas. Nenhuma frase do tipo "X escolas
// usam", nenhum depoimento, nenhuma nota. O que existe e é honesto é outra coisa: a escola
// que construiu o sistema opera nele todo dia. Isso sustenta anúncio de CAPACIDADE
// (o sistema faz isto, de verdade, há tempo), não de RESULTADO DE CLIENTE.
//
// Números conferidos direto no banco de produção em 25/08/2026:
//   class_logs = 1751 · pagamentos recebidos = 186 · contratos aceitos = 41
//   confirmações de presença = 1028 · experimentais = 126 · alunos = 57 · professores = 9
// Os anúncios citam esses valores ARREDONDADOS PARA BAIXO ("mais de mil e setecentas").
// Número exato em anúncio envelhece e vira mentira na semana seguinte; arredondado para
// baixo continua verdadeiro enquanto a operação cresce.

const DESTINO_ESCOLA = 'wisewolflanguage.com.br/new-saas';

export const HUB_ADS: AdScript[] = [
  {
    id: 'EscolaOperacao',
    slug: 'escola-operacao',
    front: 'escola',
    angle: 'A operação espalhada em dez lugares',
    accent: '#258e79',
    secondaryAccent: '#8ad9b7',

    hookKicker: 'Para donos de escola de idiomas',
    hookLine: 'Quanto sua escola',
    hookEmphasis: 'lucrou mês passado?',

    turnHeadline: 'A resposta está em oito lugares diferentes.',
    turnPoints: [
      'Agenda numa planilha',
      'Cobrança no WhatsApp',
      'Contrato no e-mail',
      'O lucro, no chute',
    ],

    proofHeadline: 'Uma operação só, do primeiro contato à renovação.',
    evidence: [
      { panel: 'finance', reads: 'Resumo financeiro do mês' },
      { panel: 'crm', reads: 'Funil comercial' },
    ],
    backdrop: 'assets/ambientes/school-living-system.png',

    ctaHeadline: 'Peça um diagnóstico da sua escola.',
    ctaButton: 'Quero o diagnóstico',
    ctaSupport: 'Sem custo e sem compromisso.',
    destination: DESTINO_ESCOLA,

    narration: [
      { beat: 'hook', text: 'Quanto a sua escola lucrou no mês passado?' },
      { beat: 'turn', text: 'Se a resposta está numa planilha, num contrato por e-mail e numa cobrança no WhatsApp, ela não existe. Ela é um palpite.' },
      { beat: 'proof', text: 'O Wise Wolf School OS junta comercial, agenda, contrato, cobrança e financeiro numa operação só, e fecha o resultado do mês por competência.' },
      { beat: 'cta', text: 'Peça um diagnóstico da sua escola. Sem custo.' },
    ],

    claims: [
      { claim: 'O sistema reúne comercial, agenda, contrato, cobrança e financeiro', source: 'Em produção: LeadsKanban/CRM, bookings, ContractManagement, integração Asaas, CashflowPanel' },
      { claim: 'O resultado do mês é apurado por competência', source: 'RPC dre_gerencial + plano de contas dre_accounts — migrations 20260802120000 a 20260802160000' },
      { claim: 'O diagnóstico é sem custo', source: 'Rota /new-saas: formulário de diagnóstico que grava em saas_leads, sem cobrança' },
    ],
  },

  {
    id: 'EscolaPresenca',
    slug: 'escola-presenca',
    front: 'escola',
    angle: 'A aula que você paga aconteceu mesmo?',
    accent: '#ff785f',
    secondaryAccent: '#7652ed',

    hookKicker: 'Folha de professor',
    hookLine: 'Você vai pagar a aula.',
    hookEmphasis: 'Ela aconteceu mesmo?',

    turnHeadline: 'Uma fonte só é confiança. Duas são prova.',
    turnPoints: [
      'O professor lança a aula',
      'O aluno confirma por um link',
      'Divergiu, o pagamento segura',
    ],

    proofHeadline: 'A dúvida vira uma decisão da direção, não um prejuízo.',
    evidence: [
      { panel: 'attendance', reads: 'Verificação de presença' },
    ],
    backdrop: 'assets/ambientes/hub-corridor.png',

    ctaHeadline: 'Veja rodando na sua escola.',
    ctaButton: 'Quero o diagnóstico',
    ctaSupport: 'Diagnóstico sem custo.',
    destination: DESTINO_ESCOLA,

    narration: [
      { beat: 'hook', text: 'Você vai pagar aquela aula. Ela aconteceu mesmo?' },
      { beat: 'turn', text: 'No School OS, o professor lança a aula e o aluno confirma por um link no WhatsApp. Duas fontes independentes, não uma.' },
      { beat: 'proof', text: 'Quando as duas discordam, o pagamento fica retido até a direção decidir. O professor honesto recebe. A dúvida não vira prejuízo.' },
      { beat: 'cta', text: 'Peça um diagnóstico e veja isso rodando na sua escola.' },
    ],

    claims: [
      { claim: 'O aluno confirma a aula por link no WhatsApp', source: 'Edge send-attendance-confirmations + rota pública /confirmar-presenca (components/ConfirmAttendance.tsx)' },
      { claim: 'Divergência retém o pagamento até a direção resolver', source: 'reconcile_attendance_confirmation → status CONFLICT + class_logs.payment_hold=true; resolução em components/AttendanceDisputes.tsx via RPC resolve_attendance_conflict' },
      { claim: 'O aluno que não responde não penaliza o professor', source: 'Confirmação fica PENDING e a aula é paga pela confiança — documentado no CLAUDE.md e implementado em enqueue_attendance_confirmations' },
    ],
  },

  {
    id: 'EscolaFeitoPorEscola',
    slug: 'escola-feito-por-escola',
    front: 'escola',
    angle: 'Feito dentro de uma escola, não numa software house',
    accent: '#7652ed',
    secondaryAccent: '#20a9cc',

    hookKicker: 'Wise Wolf School OS',
    hookLine: 'Não foi feito',
    hookEmphasis: 'por uma software house.',

    turnHeadline: 'Foi feito dentro de uma escola que precisava dele.',
    turnPoints: [
      'Mais de 1.700 aulas lançadas',
      'Mais de mil presenças confirmadas',
      'Mais de 180 pagamentos conciliados',
    ],

    proofHeadline: 'Na operação real, todo dia. Não numa demonstração.',
    evidence: [
      { panel: 'finance', reads: 'Resumo financeiro do mês' },
      { panel: 'attendance', reads: 'Verificação de presença' },
      { panel: 'crm', reads: 'Funil comercial' },
    ],
    backdrop: 'assets/ambientes/educator-structure.png',

    ctaHeadline: 'Peça um diagnóstico da sua escola.',
    ctaButton: 'Quero o diagnóstico',
    ctaSupport: 'Sem custo e sem compromisso.',
    destination: DESTINO_ESCOLA,

    narration: [
      { beat: 'hook', text: 'Este sistema não foi feito por uma software house.' },
      { beat: 'turn', text: 'Ele foi feito dentro de uma escola de inglês que precisava dele, e é lá que ele roda todo dia.' },
      { beat: 'proof', text: 'Mais de mil e setecentas aulas lançadas. Mais de mil presenças confirmadas pelos alunos. Mais de cento e oitenta pagamentos conciliados. Na operação real, não numa demonstração.' },
      { beat: 'cta', text: 'Peça um diagnóstico e veja o que ele faz pela sua escola.' },
    ],

    claims: [
      { claim: 'Mais de 1.700 aulas lançadas', source: 'select count(*) from class_logs na produção em 25/08/2026 = 1751' },
      { claim: 'Mais de mil presenças confirmadas', source: 'select count(*) from attendance_confirmations = 1028' },
      { claim: 'Mais de 180 pagamentos conciliados', source: 'select count(*) from student_payments where status in (RECEIVED, RECEIVED_IN_CASH) = 186' },
      { claim: 'O sistema roda na operação da própria escola que o construiu', source: 'tenant school-wise-wolf: 57 alunos e 9 professores em produção' },
    ],
  },
];
