# Cobrança Asaas já vinculada: observação e reparo restrito

## Contrato

O webhook reconhece uma cobrança sem `externalReference` quando seu id Asaas já aponta, de forma única, para uma linha local com aluno e escola. Antes de atualizar essa linha, lê novamente a cobrança e sua assinatura no Asaas, verifica cliente, valor, referência canônica, integração e estabilidade dos objetos. Não descobre alunos por valor, nome, data ou mensalidade; não cria pagamento, matrícula, assinatura nem cobrança.

`CONFIRMED` atualiza apenas a confirmação: continua sem baixa de caixa, data de crédito ou rateio. `RECEIVED` exige `creditDate`; `RECEIVED_IN_CASH` exige `paymentDate`. O vencimento pode ser corrigido para o valor corroborado no Asaas, sem mudar a identidade da fatura. A assinatura atual do perfil pode estar ausente, mas uma identidade de assinatura já registrada não pode mudar silenciosamente.

A função SQL exige serviço autenticado, compara o snapshot local sob locks e limita a idade da observação a 45 segundos, inclusive o tempo esperando locks. O helper limita as consultas externas a 20 segundos e rejeita troca de credencial/versão. Eventos positivos anteriores ao GET não podem regredir seu resultado; estorno/chargeback continua no fluxo de revisão existente. `NAO_RECEITA` não é reclassificado por esse reparo.

As evidências privadas são imutáveis e minimizadas: ids necessários ao vínculo, valor, status e datas. Não copiar respostas integrais contendo dados de cartão ou tokens. Um GET não inventa um timestamp de evento; `last_authoritative_observed_at` é separado dos metadados do webhook.

## Reparo explícito após publicação

O reparo não roda automaticamente nem reabre toda a caixa de triagem. Para uma cobrança previamente verificada, um operador autorizado pode chamar `asaas-reconcile` usando autenticação de serviço e este corpo:

```json
{"repairBoundPayment":{"localPaymentId":"<uuid-da-linha-local-verificada>"}}
```

O alvo é exclusivamente um UUID local, na escola de referência autorizada pelo reconciliador. Não combinar com flags de reparo histórico ou de vínculo. Resolver o alvo por leitura antes da chamada; nunca registrar ids de clientes reais, comprovantes ou credenciais neste runbook. A implementação não executou reparos em dados reais.

O resultado `UPDATED` ou `ALREADY_APPLIED` ainda depende da recomputação financeira agregada, feita em outra transação. Erros temporários de provedor/banco/recompute são repetíveis com o mesmo alvo; não repetir chamadas que retornem conflito de identidade ou evidência. `IGNORED` não significa que uma nova baixa aconteceu.

Um snapshot já auditado cujo estado local depois divergiu retorna `bound_previous_proof_local_state_diverged`, exigindo revisão explícita. Não contornar essa proteção alterando status ou removendo a trilha. Estorno, valor divergente, cliente/assinatura/tenant divergente, cobrança excluída ou crédito não comprovado também bloqueiam a baixa.

Após sucesso, verificar por leitura a mesma linha, a data de caixa em São Paulo, o ledger e a intenção nativa de notificação. O mecanismo preserva snapshots mensais já enviados; mudança de vencimento não autoriza apagar o histórico ou fazer transferência bancária. A intenção WhatsApp não é prova de entrega. Issues de vínculo/status/vencimento cobertas são resolvidas pela observação; os eventos antigos da inbox continuam preservados, sem replay em massa.

## Validação

- Deno: `supabase/functions/asaas-webhook/bound-payment-observation.test.ts` e `event-contract.test.ts` usam provider/RPCs simulados, sem rede Asaas.
- SQL: `supabase/tests/corroborated_bound_payment_observation.sql`, somente em transação revertida no QA isolado. A guarda exige cron desligado e ausência de perfis, usuários e segredos. Não executar no savepoint de publicação em produção: a fixture cria a escola canônica e sua conexão ROOT sintética. Cobre confirmação sem caixa, liquidação idempotente, rejeições de identidade/valor, edição administrativa, eventos atrasados, estorno e virada de data em São Paulo.
- A migration `20260914202244_corroborated_bound_payment_observation.sql` deve preceder o deploy dos consumidores. Os novos campos são consultados pelo webhook e pelo reconciliador.
