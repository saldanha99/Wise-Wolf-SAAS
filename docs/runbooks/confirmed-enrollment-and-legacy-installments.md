# Confirmação de matrícula e parcelas legadas do Asaas

`CONFIRMED` libera o requisito financeiro da matrícula depois de validar cobrança,
cliente, aluno, oferta e assinatura exatos. A observação `APPROVED` exige que os
estados locais `status` e `provider_status` sejam ambos `CONFIRMED`. `AUTHORIZED`
e `PENDING` continuam aguardando. A matrícula ainda depende das validações de
agenda, contrato e ciclo de vida existentes; confirmação não contorna essas regras.

Caixa, data de crédito, rateio e aviso de recebimento continuam dependentes de
liquidação. O processamento da confirmação não deve criar `financial_transactions`
nem intenção financeira na outbox. O status financeiro agregado considera a
competência confirmada para acesso, preservando atraso na mesma competência,
estornos, classificação manual e cobertura pré-paga.

Uma parcela gerada pelo Asaas sem `externalReference` pode ser reconhecida quando
há exatamente um aluno com os mesmos ids locais de cliente E assinatura. A leitura
atual da cobrança e da assinatura deve corroborar ids, valor, vencimento, status,
ausência de exclusão e referências vazias. Não há descoberta por nome ou valor;
referências desconhecidas e assinaturas ausentes permanecem em triagem. Eventos
pendentes não viram recebimento e eventos atrasados não substituem um GET divergente.

Aplicar `20261026230135_confirmed_enrollment_access_without_cash.sql` antes dos
consumidores pelo release oficial. A migration é reexecutável e mantém os ACLs.

## Verificação

Deno: `_shared/enrollment-progress.test.ts`,
`asaas-webhook/enrollment-payment-completion.test.ts` e `event-contract.test.ts`.
SQL: `supabase/tests/confirmed_enrollment_access.sql`, no QA isolado criado por
`deploy/vps/finance-qa-bootstrap.sh`, com a migration aplicada duas vezes na mesma
transação e rollback final. Nunca inserir fixtures financeiras em produção.

Para reparar uma matrícula real, obter evidência fresca do Asaas, primeiro
sincronizar a linha já vinculada pelo reparador canônico e somente então aplicar
a observação com a referência exata da oferta. Não marcar `RECEIVED` para liberar
acesso, criar webhook sintético, alterar contratos assinados nem repetir mensagens
antigas. Erros de agenda exigem examinar as reservas; não ignorar essa barreira.

A saúde do grupo é verificada pela conexão da instância, histórico do destino e
recibos do provedor. `accepted` e a presença no histórico não comprovam entrega ou
leitura. Não reenviar registros `SUBMITTING` já aceitos para tentar obter um recibo.

## Pix particulares e depósitos sem cobrança

A classificação operacional `NAO_RECEITA` preserva o fato bancário em
`provider_status=RECEIVED`, com caixa em `aporte_ou_movimentacao`, sem receita de
mensalidade, aluno, competência pré-paga ou rateio escolar. Uma decisão da direção
se aplica ao id da transação, com consulta fresca ao Asaas, controle de duplicidade
e evidência reservada. Não transformar o pagador em uma lista permanente de
exclusão: essa pessoa pode fazer um pagamento escolar legítimo no futuro.

Pix direto sem vínculo comprovado com cobrança/assinatura fica em conferência.
Nome ou coincidência de valor não bastam para atribuir mensalidade. Uma taxa de
rescisão também não deve quitar uma mensalidade nem reativar aluno. Na operação,
a separação entre a conta/chave da escola e recebimentos pessoais reduz esse
trabalho de classificação. Não apagar o movimento bancário para fazê-lo sumir da
conciliação nem reprocessar mensagens antigas sem examinar sua natureza.
