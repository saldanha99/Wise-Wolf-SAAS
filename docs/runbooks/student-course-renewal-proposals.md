# Condições comerciais de renovação

> **Desde 06/11/2026 a direção conduz a renovação pela ficha do aluno** (botão
> Renovar): 6 ou 12 meses, parcelada ou com pagamento integral adiantado. Fluxo
> na seção "Renovação pela ficha", no fim deste arquivo. O comando de operador
> abaixo continua existindo só para 6 meses.

Este registro prepara uma condição de **6 meses**, mantendo mensalidade e
frequência existentes. Ele é um rascunho auditável, não um contrato assinado.

- A função de escrita é privada e exclusiva do operador; não é exposta ao navegador nem ao service role.
- O preço esperado deve coincidir com o cadastro atual. Frequência e vencimento preenchidos não podem ser alterados por esse comando.
- Campos legados ausentes exigem referência documental ou autorização explícita registrada em `source_note`.
- A referência de aprovação é um SHA-256. Repetição idêntica retorna a mesma proposta; conteúdo divergente falha.
- A proposta e o retrato da origem são imutáveis. Nenhum perfil, acesso, pagamento ou assinatura é atualizado.
- A leitura é permitida apenas à direção/coordenação autenticada na escola corrente.
- A tela **Reconciliação Financeira → Condições de renovação** informa explicitamente que assinatura e cobrança não estão autorizadas.

## Fluxo de assinatura e disparo

### Decisão operacional — Bianca, 14/09/2026

O proprietário autorizou que a renovação da Bianca Crepaldi Rodrigues comece
em **15/09/2026**, após informar que ela já teve uma aula em 14/09. Manter a
condição aprovada de **6 meses, R$ 377 mensais e 5 aulas por semana**.

- Não retroagir o início para 12/09, término do período anterior.
- Preservar o lançamento da aula de 14/09; esta decisão não autoriza apagar,
  mover ou gerar cobrança avulsa por essa aula.
- O início autorizado é uma decisão comercial, não prova de assinatura ou
  pagamento. Não reativar acesso somente por este registro.
- Congelar início, vencimentos e término na proposta assinável antes do envio.
  O dia 12 sugerido no rascunho anterior não pode produzir uma primeira
  cobrança anterior ao início autorizado.
- Calcular o término do período pago a partir da competência da última
  parcela mais um mês civil, nunca da data de recebimento antecipado.

Este registro documenta a autorização; não altera o rascunho imutável no banco,
não emite cobrança e não envia mensagem.

Cada rascunho aprovado pode originar uma única oferta com token individual,
vigência e seis competências congeladas. A página `/renovar-curso` exige aceite
expresso e assinatura pelo nome completo. Repetir o clique é idempotente.

O envio por WhatsApp valida o mesmo RPC público que a aluna abrirá, compara
todos os campos congelados e só então faz uma tentativa no provedor. Timeout
ou resposta sem identificador fica como resultado desconhecido e não é
reenviado automaticamente. Recibos autenticados distinguem aceitação, entrega
e leitura. Os lembretes são materializados para 15 dias antes e para o dia do
início do novo período, às 06:00 em `America/Sao_Paulo`, e são suprimidos assim
que a renovação é assinada.

Após a assinatura, o faturamento roda em fila separada. Assinaturas encerradas
geram uma nova recorrência com referência externa única; assinatura ativa é
reconciliada e reutilizada. Antes de qualquer criação são lidas todas as páginas
do Asaas. Resultado de rede ambíguo vai para revisão, sem uma segunda criação.
Somente uma confirmação do provedor atualiza o vínculo no perfil. Assinar ou
receber a proposta não reativa uma conta suspensa.

### Assinatura depois do primeiro vencimento previsto

Se as aulas já começaram e a oferta ainda não foi assinada, o início do
serviço permanece registrado, mas o primeiro vencimento nunca é enviado ao
Asaas no passado. A página mostra, antes do aceite, o próximo dia civil como
primeiro vencimento e recalcula as seis parcelas e o fim do serviço. O fim
continua sendo um mês civil depois da sexta parcela.

A assinatura envia de volta a primeira data exibida. Se a página atravessar a
meia-noite, a operação falha fechada e exige recarregamento; ela nunca altera
as datas silenciosamente. O ajuste fica registrado no evento imutável
`DUE_DATES_ROLLED_FORWARD`. Clientes antigos com JavaScript em cache também
falham fechados até recarregarem a página.

Os testes SQL rodam exclusivamente no ambiente de QA vazio e sem rede,
com rollback, pelo `deploy/vps/finance-qa-test.mjs`. Nunca inserir fixtures
deste teste em produção.

## Renovação pela ficha do aluno (06/11/2026)

Ficha → **Renovar** (`StudentRenewalModal`), só `SCHOOL_ADMIN`/`SUPER_ADMIN`; o
servidor confere de novo (`private.prepayment_caller_can_write`). Migration
`20261106210000`, teste `supabase/tests/renovacao_pela_ficha_e_pagamento_integral.sql`.

RPCs: `get_student_renewal_context`, `create_student_renewal_offer`,
`cancel_student_renewal_offer`, `retry_student_renewal_billing`. A oferta, o link
`/renovar-curso`, a assinatura e a fila são os mesmos do fluxo antigo.

| Forma de pagamento | Estratégia | Cobrança | Cobertura dos meses |
|---|---|---|---|
| Parcelado | `CREATE_NEW` / `REUSE_EXISTING` | assinatura mensal, `maxPayments` = prazo | os meses são cobrados normalmente |
| Integral: cobrar no Asaas | `UPFRONT_CHARGE` | depois da assinatura, cobrança única pelo total, `externalReference` = id do aluno | no `RECEIVED`, em `MENSAL` |
| Integral: recebido por fora | `UPFRONT_EXTERNAL` | nenhuma | na assinatura, em `LEGADO`, sem caixa nem rateio |

**Regras que o servidor recusa:**

- Sem `contract_accepted`, a direção precisa dizer qual documento é prorrogado
  (`contract_reference`). A renovação não marca `contract_accepted`: a flag quer
  dizer "aceitou o contrato no sistema", e esse aceite não houve. Se não existe
  documento, a renovação não tem o que prorrogar; o aluno precisa assinar o
  contrato completo, e esse caminho não existe na ficha.
- Valor diferente do catálogo (`student_pricing_plans`, prazo × frequência) exige
  o motivo por escrito. O preço do catálogo fica congelado na oferta.
- Início antes do fim do período pago (`paid_through`), mês já coberto, renovação
  assinada no mesmo período, oferta em aberto ou negociação em aberto: recusado.
- Pagamento integral com assinatura ativa no período: recusado. Ela cobraria os
  mesmos meses, e o registro de cobertura não cancela nada no Asaas.
- Cobrança única exige aluno ativo: o caixa recusa evento de cadastro suspenso.

**Datas:** `first_due_date` é o dia de vencimento no início ou depois dele, nunca
antes de amanhã. `last_due_date` = `private.renewal_last_due_date` (`fim_do_servico`
mês a mês, igual à conta antiga). Fim do serviço = um mês depois da última parcela.
Na cobrança única, `upfront_due_date` é o vencimento do pagamento e não muda a
competência dos meses.

**Rateio da renovação antecipada:** `register_prepayment` recusa `MENSAL` que comece
depois do mês do recebimento, então a cobertura entra direto por
`private.renewal_register_coverage`. A 1ª parcela sai no aviso do recebimento,
marcada com a competência dela, mesmo meses antes; as parcelas 2..N saem mês a mês
(`monthly-reserve-notify`, que depende do opt-in da escola) e entram no relatório do
mês. Cada parcela é rateada uma vez, e o custo do professor é o previsto pela agenda
do mês de cada parcela. Quem quiser adiar também a 1ª parcela precisa de um
agendador novo, que não existe.

**Efeitos no perfil:** a assinatura aplica mensalidade, frequência e vencimento. A
cobertura registrada avança `paid_through` e `prepaid_months`, que é o que a tela do
aluno lê. Estorno leva as parcelas para revisão pelo trilho de sempre; `paid_through`
não volta sozinho e precisa de conferência.

**Bot da renovação:** só negocia oferta de 6 meses com assinatura mensal, porque
`approve_renewal_negotiation` remonta a oferta assim. Prazo de 12 meses e pagamento
integral ficam fora dele.

**Falha na cobrança única:** vira `REVIEW` ou `FAILED`, com aviso no grupo e motivo
na ficha. "Tentar de novo" é seguro: `claim_asaas_provider_creation` reconcilia antes
de qualquer POST e resultado incerto nunca gera um segundo POST. Assinatura mensal em
revisão continua sendo conferência no Asaas.
