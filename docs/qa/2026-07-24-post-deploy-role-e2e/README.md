# QA pós-deploy — perfis, mobile e matrícula

Data: 2026-07-24

Ambiente: produção

URL: `https://system.wisewolflanguage.com.br/`

Release validada: `31b02c0`

Bundle público validado: `assets/index-CF5a1ejw.js`

## Resultado final

O ciclo foi concluído com sucesso. As correções foram versionadas, publicadas
na VPS e retestadas em produção.

| Fluxo | Cobertura final | Resultado |
|---|---|---|
| Diretor | 33 rotas do menu, Perfil, navegação por teclado e mobile 390×844 | Aprovado |
| Professor | 20 rotas do menu, Perfil, Financeiro/PDF e mobile 390×844 | Aprovado |
| Aluno | 10 rotas do menu, Perfil, onboarding, contrato, prática e evolução | Aprovado |
| Matrícula pública | Pix, cadastro, revisão, assinatura, último botão, sucesso e recarga | Aprovado |

Nas telas finais não houve estouro horizontal, alerta inesperado, exceção de
página ou erro relevante no console. Os fluxos de QA usaram tenant e contas
isoladas, todos marcados como teste.

## Melhorias entregues

- Sidebar responsiva com área rolável separada do rodapé, foco automático,
  navegação por `ArrowUp`, `ArrowDown`, `Home` e `End`, além de foco preso no
  drawer mobile.
- Geração do relatório PDF do Professor em iframe oculto, preservando a rota e
  o estado do portal.
- Onboarding do Aluno adaptado à viewport, acessível, persistente na sessão e
  com gerenciamento de foco.
- Diálogo de contrato com foco inicial e retorno do foco ao botão de origem.
- Prática do Aluno com parsing estrito, repetição controlada, estado de erro e
  fallback somente para fixture, sem chamar IA externa.
- Insights do Aluno corrigidos para o esquema real de registros de aula.
- Gráficos com dimensões iniciais e mínimas para evitar renderização inválida.
- Build de produção bloqueado quando as variáveis públicas obrigatórias do
  Supabase estão ausentes ou inválidas.
- Remoção de dados de agendamentos dos logs do navegador.
- Trigger de matrícula ajustado para não enfileirar mensagem de boas-vindas
  durante uma execução marcada como teste.

## Versionamento da entrega

| Commit | Entrega |
|---|---|
| `652407f` | Experiência de papéis e mobile |
| `1a9b46c` | Integrações e runtime de IA |
| `d395afc` | Workflows de banco e proteções de deploy |
| `076be47` | Navegação e runtime de matrícula |
| `ca351e3` | Onboarding e recuperação de atividades |
| `f9391e0` | Gráficos e insights do Aluno |
| `d23ebae` | Dimensões responsivas dos gráficos |
| `31b02c0` | Privacidade dos logs de agendamentos |

## Matrícula E2E

O CPF autorizado no runbook foi usado com e-mail, oportunidade, oferta e link
exclusivos. O fluxo chegou ao botão **FINALIZAR MATRÍCULA**, criou uma cobrança
Pix de R$ 5,00 e exibiu **Matrícula Confirmada!**. A recarga do link manteve
uma única conta, um único cliente, uma única assinatura e uma única cobrança.

As notificações permaneceram suprimidas:

- fila de notificações: 0;
- notificações internas: 0;
- log de mensagens WhatsApp: 0;
- outbox de WhatsApp: 0;
- log geral de WhatsApp: 0;
- cliente Asaas com notificações desativadas.

Após o teste, cobrança, assinatura e cliente foram excluídos no Asaas. Banco,
Auth, logs, oferta, link, oportunidade, perfil e pagamento local foram
removidos. A varredura final encontrou zero resíduos.

Detalhes: [enrollment-report.md](enrollment-report.md).

## Limpeza das fixtures

As contas isoladas de Diretor, Professor e Aluno, suas sessões, tokens,
atividades, tenant e logs também foram removidos. Uma varredura final em
colunas estruturais e payloads de log retornou zero ocorrências.

Backups restritos mantidos na VPS:

- `/opt/wisewolf/backups/e2e-enrollment-20260725/20260725T011056Z-31b02c0`
- `/opt/wisewolf/backups/qa-postdeploy-role-e2e-20260724/pre-cleanup-final`

Ambos têm permissões restritas e arquivos de checksum validados. Nenhuma
senha, token, chave ou cookie foi incluído nos relatórios ou commits.

## Índice de evidências finais

- Diretor: [director-report.md](director-report.md)
- Professor: [teacher-report.md](teacher-report.md)
- Aluno: [student-report.md](student-report.md)
- Matrícula: [enrollment-report.md](enrollment-report.md)

Os arquivos com `final`, `d23`, `31b` ou `enrollment-31b` no nome representam
o estado final. As subpastas preservam a cronologia de descoberta e reteste.

## Ação externa não incluída

A rotação da chave Evolution compartilhada com o projeto Forza exige
coordenação externa. Ela não bloqueou os fluxos validados e não foi alterada
neste ciclo para evitar interromper outro sistema.
