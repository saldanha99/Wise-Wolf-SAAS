# Integridade das automações Asaas

Este runbook descreve a fronteira segura entre o banco Wise Wolf e o Asaas.
Ele cobre mensalidades escolares, webhook, caixa, estornos, conciliação e
repasse de professores. Não autoriza criar cobranças, transferências ou
subcontas reais durante uma investigação.

## Regras que nunca podem divergir

- Toda operação escolar resolve primeiro um `tenant_id` explícito e depois a
  conexão Asaas daquele tenant.
- A conta raiz gerenciada pela plataforma atende somente
  `school-wise-wolf`. Todo outro tenant nasce com Asaas `DISABLED`.
- Enquanto os IDs de cliente/assinatura do aluno ainda forem globais em
  `profiles`, BYOK e subconta também permanecem bloqueados. A liberação exige
  antes um vínculo financeiro por `(tenant_id, student_id, provider)`.
- A conta raiz nasce como `configured`; `healthy` e `last_verified_at` só são
  gravados depois de uma auditoria autenticada concluir leituras reais no
  provedor com a mesma versão da conexão.
- `PAYMENT_CONFIRMED`/`CONFIRMED` confirma a cobrança, mas não é dinheiro
  disponível nem concede acesso. Somente `RECEIVED`, `RECEIVED_IN_CASH` e a
  classificação local `NAO_RECEITA` entram no caixa; os dois primeiros podem
  concluir matrícula e provisionamento.
- `NAO_RECEITA` mantém exatamente um lançamento, com categoria
  `aporte_ou_movimentacao`; ela não apaga a entrada bancária.
- O valor bruto fica em `student_payments.value` e na `ENTRADA` original do
  caixa. Cada aumento confirmado de `refunded_amount` gera uma `SAIDA`
  separada, idempotente pelo evento do provedor e datada pelo horário real do
  estorno. Assim, um estorno posterior nunca reescreve o mês do recebimento.
- `credited_at` recebe apenas `creditDate` real do Asaas. Uma data estimada
  fica em `estimated_credit_at` e não define competência do caixa.
- Existe exatamente uma entrada bruta por `student_payment_id`. Estornos usam
  `refund_student_payment_id` e `provider_event_id`; o trigger do banco é o
  único escritor desses lançamentos derivados.
- Se um aumento de estorno chegar sem ID e horário do evento, o sistema abre
  ocorrência de reconciliação e não inventa uma saída nem uma data.
- Um estorno depois de um fechamento docente já pago abre revisão humana. O
  sistema nunca debita professor nem altera repasse pago automaticamente.

## Webhook durável

1. O endpoint valida `asaas-access-token`, limite do corpo e formato mínimo.
2. O evento é persistido por `body.id`, com o payload original e hash.
3. Só depois da confirmação do banco o endpoint responde HTTP 200.
4. O worker preserva a ordem por cobrança/entidade, com lease, retry
   exponencial e limite de tentativas. Um evento em backoff não bloqueia
   cobranças nem tenants independentes.
5. Mesmo ID com payload diferente, vínculo ambíguo ou conflito de tenant vai
   para triagem; nunca recebe um tenant padrão.
6. A confirmação de pagamento entra na `notification_queue` com chave
   idempotente. A chamada de analytics é apenas best-effort.

Estados operacionais:

- `RECEIVED`, `PROCESSING`, `RETRY`: ainda processável;
- `PROCESSED`: concluído;
- `TRIAGE`: conflito determinístico que exige decisão humana;
- `DEAD_LETTER`: falha transitória excedeu o limite.

## Comunicações financeiras e provisionamento

Mensagens derivadas de pagamento, lembretes, rateio, DRE, resumo financeiro,
fechamento docente e ativação do proprietário SaaS cruzam uma tentativa
durável antes do POST externo:

- `CLAIMED` ainda pode ser recuperado ou suprimido sem envio;
- `SUBMITTING` é o último limite persistido imediatamente antes do POST;
- `SENT`, `FAILED`, `UNKNOWN` e `SUPPRESSED` são terminais para reenvio
  automático;
- timeout, queda de processo ou resposta ambígua vira `UNKNOWN`; nunca se
  conclui que o provedor não recebeu apenas porque a resposta se perdeu;
- desligamento do WhatsApp, opt-out de notificações, mudança de pagamento ou
  início de offboarding são revalidados no limite `SUBMITTING`;
- offboarding e exclusão podem suprimir somente `CLAIMED`; `SUBMITTING` ou
  `UNKNOWN` bloqueiam a operação e exigem revisão para não enviar depois da
  saída do aluno.

A ativação SaaS prepara configuração e link de recuperação antes de
`SUBMITTING`, conclui o checkout e autoriza o envio na mesma transação e usa
uma chave de idempotência estável por checkout no Resend. Provisionamentos
anteriores à outbox ficam marcados como legados e não disparam e-mail
retroativo.

O sistema escolhe segurança `at-most-once` quando Evolution, Meta ou outro
provedor não oferece reconciliação idempotente suficiente. Isso evita
duplicata cega, mas não promete entrega eventual: `SUBMITTING`, `UNKNOWN` e
`FAILED` precisam de fila operacional e decisão humana antes de qualquer nova
tentativa.

## Conciliação

`asaas-reconcile` usa somente GET no provedor. Ele pagina cobranças, extrato e
transferências, restringe todas as leituras locais ao tenant de referência e
grava diferenças em `asaas_reconciliation_issues`. Ele não importa, exclui,
estorna nem corrige dinheiro automaticamente.

Criações de cliente, cobrança, pró-rata e assinatura usam um claim persistente
antes do POST. Uma chave lógica admite no máximo um envio ao provedor; timeout,
resposta ambígua ou duplicidade exigem consulta GET e triagem, nunca um segundo
POST baseado apenas em `externalReference`.

O cron diário audita uma janela móvel de 45 dias. Para uma auditoria histórica,
um operador autenticado como `SUPER_ADMIN` pode informar `windowStart` e
`windowEnd`, com no máximo 366 dias. Divida períodos maiores em janelas
adjacentes.

Antes de corrigir uma divergência, confirme conjuntamente:

- ID da cobrança e do cliente no Asaas;
- vínculo único do cliente com aluno e tenant ativos;
- valor bruto, estorno concluído e datas de pagamento/crédito;
- ausência de outro pagamento ou lançamento que represente o mesmo dinheiro.

Uma cobrança do extrato sem linha local é evidência para triagem, não permissão
para importar. A correção precisa preservar o payload/proveniência e passar
novamente pela conciliação.

## Repasse de professor

O envio PIX permanece bloqueado por padrão. Para habilitá-lo no futuro são
obrigatórios, antes de produção:

- homologação em sandbox;
- aprovação operacional explícita;
- destino validado e fechamento elegível;
- tentativa durável única por fechamento;
- consulta do estado da transferência após timeout ou resposta ambígua.

Uma tentativa `SUBMITTED` ou `UNKNOWN` nunca é reenviada. Primeiro consulte o
Asaas pelo ID/referência externa. O fechamento só vira pago após estado final
confirmado pelo provedor.

## Subcontas

`create-asaas-subaccount` está intencionalmente bloqueada. A chave devolvida na
criação existe uma única vez e o fluxo antigo podia perdê-la entre a resposta
do Asaas e a gravação local. A rota só poderá ser reativada após homologação
regulatória/BaaS, dados cadastrais completos, webhook criado junto da conta,
recuperação de POST ambíguo e gravação imediata da chave no Vault antes de
marcar a conexão como saudável.

## Operações intencionalmente bloqueadas

- Negativação está desativada até existir outbox/claim transacional, payload
  cadastral homologado e retomada idempotente.
- BYOK/subconta permanece desativado enquanto os IDs financeiros do aluno não
  forem tenant-scoped.
- Repasse PIX permanece desativado por configuração; quando habilitado, usa o
  snapshot imutável do claim e nunca reenvia resultado ambíguo.

## Alertas e resposta

O monitor roda a cada 15 minutos e alerta um administrador ativo quando há:

- webhook em `TRIAGE`, `DEAD_LETTER` ou parado;
- conciliação falha ou travada;
- divergência recente `HIGH`/`CRITICAL`;
- cron Asaas ausente, inativo ou falhando.

Ao receber o alerta:

1. não reenvie webhook, transferência ou cobrança às cegas;
2. preserve IDs, horários e o payload já armazenado;
3. consulte primeiro o estado atual no Asaas;
4. corrija apenas o lado comprovadamente divergente;
5. execute novamente a conciliação GET-only;
6. registre a resolução da ocorrência sem incluir tokens, CPF ou payload com
   dados pessoais em logs ou commits.

## Verificação de release

Uma publicação só é válida quando, na mesma release:

- migrations e testes SQL passam dentro de uma transação;
- testes de contrato, idempotência, tenant e transferência passam;
- todas as Edge Functions modificadas passam formatação e checagem de tipos;
- o banco confirma cardinalidade/valor/categoria do ledger, ACLs fail-closed,
  conexão Asaas explícita por tenant e os três crons ativos;
- os smokes autenticam o worker, reconciliam o ledger e executam uma leitura
  real de um dia no Asaas sem criar qualquer objeto no provedor.

Os crons obrigatórios incluem worker de webhook, conciliação diária do Asaas,
saúde, atualização de aditivos, reconciliação horária do ledger, sincronização
diária das assinaturas e varredura de rateio. Ausência, duplicidade ou falha
recente entra no alerta operacional.

Nunca declare “100% garantido” com base apenas em deploy ou ausência de erro.
O que se garante internamente são invariantes, idempotência, isolamento,
persistência e alerta; disponibilidade e entrega do provedor continuam externas.
