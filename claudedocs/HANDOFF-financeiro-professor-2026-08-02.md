# Handoff — Financeiro do professor + fechamento de julho/2026

Sessão de 01–02/08/2026. Tudo abaixo está **em produção** (VPS self-hosted).
Último release: `20260802T111628Z-e745bd5bfcc7`. Branch de deploy:
`codex/vps-automation-hardening` = `3517050`. Branch de trabalho:
`claude/teacher-financeiro-vps`.

---

## 0. Coisas que você PRECISA saber antes de tocar em qualquer coisa

**Produção é a VPS, não o Supabase hospedado.** `ssh wisewolf-vps` →
`docker exec supabase-db psql -U supabase_admin`. O projeto hospedado
`dvalxbtngopxopzcbfdm` está congelado desde 17/07 — auditar salário lá dá números
errados (caí nessa no começo desta sessão).

**Deploy:** rode do checkout principal OU de um worktree limpo com
`DEPLOY_ENV_FILE=/…/Wise-Wolf-SAAS-main/.env.deploy.local bash deploy/vps/release.sh`.
⚠️ **Nunca** encadeie `git merge … | tail -N && npm run deploy:vps` — o status do
pipeline é o do `tail`, o merge aborta em silêncio e o deploy sobe a árvore
ERRADA. Isso derrubou as telas por 3 minutos nesta sessão.

**Migration nova só roda se estiver na lista `DATABASE_MIGRATION_RELATIVES` do
`release.sh`.** Edge function nova idem (lista curada separada) — `accept-coverage`
e `coverage-admin` ficavam de fora e a correção não subia.

⚠️ **Armadilha de SQL que já custou caro DUAS vezes:** `cl.subtype = 'X'` e
`cl.subtype IN (...)` devolvem **NULL** quando o subtype é nulo — e a MAIORIA das
aulas tem subtype nulo. Sem `COALESCE(..., false)` em volta, o `NOT` vira NULL e a
aula normal **some da folha**. Derrubou o Mateus de R$ 1.024 para R$ 373 na
primeira vez e sumiu com 16 aulas na segunda. **Sempre** rode a migration em
transação com ROLLBACK e confira os totais antes de subir.

---

## 1. Regra de pagamento vigente

Base **R$ 8,00 por aula**, para todos.

**Turbo (progressiva):** R$ 10,50 do 10º aluno em diante, por antiguidade de
matrícula. A faixa de R$ 9,50 (5º ao 9º) **foi removida** em 02/08 — era
inalcançável, já que a progressiva só liga com 10+ alunos. Requisitos, todos
simultâneos e apurados por **MÊS FECHADO** (não janela móvel):
1. 10+ alunos na carteira, contada pela **AGENDA** (`teacher_carteira`), nunca por
   `profiles.professor_id` — esse campo está vazio em 20 de 39 alunos ativos e
   por isso o turbo ficou de 16/06 a 01/08 sem destravar para ninguém;
2. zero falta do professor no mês e no mês anterior;
3. zero conflito de lançamento (`payment_hold` / divergência com o aluno).

**Treinamento:** quem MINISTRA (`profiles.is_trainer`, hoje só o Mateus) recebe
**R$ 16,00**; quem RECEBE ganha os R$ 8,00 normais. A distinção sai de
`opportunities.winner_teacher_id` (o participante é quem aceitou o convite).

**Falta e reposição:** falta do ALUNO paga (o professor compareceu); falta do
PROFESSOR não paga e só vira dinheiro pela reposição; **reposição de falta do
aluno NÃO paga** (a aula de origem já foi remunerada).

**Experimental:** só paga com comparecimento registrado
(`appointments.status='completed'` OU `opportunities.trial_status='DONE'`) e
nunca com falta registrada. Sem confirmação, fica pendente para a direção
liquidar — não some.

**Teste oral:** paga R$ 8,00 como aula, com trava de não empilhar sobre outra
aula do mesmo aluno no mesmo dia.

⚠️ Aluno com dois slots seguidos (19:00 + 19:30) é **aula de 1 hora partida**,
não duplicata: paga os dois.

**Fonte ÚNICA:** view `v_payable_class_logs`. Lida por
`get_teacher_closing_report`, `run_monthly_teacher_closing` e
`director_teacher_margin`. **Não reescreva a regra fora dela** — ela já esteve
espalhada em 4 lugares e divergiu.

---

## 2. O que foi entregue (tudo no ar)

| Entrega | Onde |
|---|---|
| Resumo por aluno (Aluno · Tempo · Qtd · Valor base · Cálculo · Valor total) | `TeacherFinancials` |
| Dados bancários editáveis + envio de NF na mesma tela | `TeacherPayoutDetails` |
| Diretor edita valor base e duração por aluno/mês | `set_student_month_pay` |
| Transferir aula (e pagamento) para quem cobriu | `transfer_class_coverage` |
| Ajustes do fechamento (reserva de agenda, bônus, desconto) | `closing_adjustments` + `set_closing_adjustment` |
| Painel Custo × Receita × Margem | `DirectorMarginPanel` / `director_teacher_margin` |
| Alerta agenda × lançamento | `closing_divergences` (bloco âmbar no painel) |
| Cobertura ponta a ponta | `apply_coverage_acceptance`, `coverages_for_teacher` |
| Reposições destravadas (botão criar + seletor de aluno) | `TeacherReschedules` |
| Aluno com início futuro visível mas sem lançar | `LessonLauncher` |
| Seletor Experimental/Treinamento no disparo | `SmartFinder` |
| Carryover de aula lançada após fechamento congelado | `closing_carryovers` |

**12 objetos novos no banco**, todos verificados em produção.

---

## 3. Folha de julho/2026 — FECHADA

| Professor | Aulas | Aulas R$ | Ajustes | Total |
|---|---:|---:|---:|---:|
| Mateus Ebenezer | 130 | 1.048,00 | — | **1.048,00** |
| Flávio Henrique | 76 | 608,00 | — | **608,00** |
| Lais Sampaio | 29 | 232,00 | 30,00 | **262,00** |
| Maycon Guilherme | 28 | 224,00 | — | **224,00** |
| Debora Alves | 1 | 8,00 | — | **8,00** |
| | | | | **R$ 2.150,00** |

Bate com a conferência manual do diretor nos cinco. Status `PENDENTE`.

---

## 4. Pendências abertas

**Decisão do diretor:**
- **Agenda da Debora:** 8 alunos, ~80 aulas previstas/mês, nenhum lançamento
  desde abril. Maior ruído da base — vai poluir todo alerta de divergência.
- **Contrato não assinado:** Mateus (130 aulas, R$ 1.048 a receber!), Lucas
  Moraes, e **Debora — que é a CONTRATANTE** e está sendo convidada a assinar
  consigo mesma (o fluxo não distingue dono de professor).
- **Horário definitivo da quarta do Arthur** (hoje 17:30, provisório).

**Técnico:**
- Isentar dono/admin do prompt de contrato de professor.
- Testar na tela as 4 ferramentas novas (transferir, ajuste, valor base,
  cobertura) — quase todas as correções de julho foram feitas direto no banco;
  a cobertura **nunca rodou com dois professores reais**.

---

## 5. PRÓXIMO PROJETO — DRE / balancete + agentes de IA

Pedido: grupo de gestão para o diretor, com relatório diário/semanal/mensal
(cadência escolhida por ele), DRE e balancete, administrável pelo grupo.

**Achado que define o projeto:** o caixa tem **159 lançamentos, TODOS `ENTRADA`**,
R$ 37.060,19, em duas categorias que são a mesma coisa (`student_tuition` e
`MENSALIDADE`). **Zero despesa lançada** — nem repasse a professor, nem
ferramentas, nem impostos. Sem o lado do custo não existe DRE; o que dá para
produzir hoje é relatório de faturamento.

**Decisões já tomadas pelo diretor (02/08):**
1. Resultado **gerencial** primeiro (não contábil formal) — atuar como contador
   especialista.
2. **Categorização automática por IA** do que entrar como despesa, mais cadastro
   de **despesas mensais recorrentes** (internet, assinaturas de ferramentas etc.).
3. Padrão de referência: **MotoFix** (`~/DOCUMENTOS/PROJETOS/MotoFix/`) —
   componentes `AiTeamPanel.tsx`, `FinanceBotPanel.tsx`, `FinanceReports.tsx`,
   `Finance.tsx`. Ler `AGENTS.md` de lá antes (o deploy do MotoFix é outro:
   `./deploy/deploy.sh vps-vX.Y.Z`, stack Docker Swarm, GHCR privado).

**Já existe na Wise Wolf e deve ser reaproveitado:**
- Crons ativos: `wisewolf-school-ai-team` (diário 10h UTC) e
  `wisewolf-weekly-digest` (segundas 11h UTC).
- Edges: `school-ai-digest`, `school-ai-team`, `weekly-director-digest`.
- `get_cashflow`, `CashflowPanel`, e o **`director_teacher_margin`** — este já
  calcula o custo real com professor por aluno, que é a maior linha de despesa e
  hoje **não está no caixa**. É o primeiro lançamento de saída a automatizar.
- Envio por grupo de WhatsApp: padrão em `automation_sent` (dedupe por
  `kind`+`subject_id`+`ref_date`), instância central resolvida pelo
  `whatsapp_instance` do SCHOOL_ADMIN, payload Evolution v2.

**Primeiros passos sugeridos:** plano de contas gerencial → tabela de despesas
recorrentes → lançamento automático do repasse a professores como SAÍDA →
categorizador por IA → DRE gerencial → agente de relatório no grupo.
