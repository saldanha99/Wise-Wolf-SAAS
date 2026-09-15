# Avisos de falha no cartão

## Regra de negócio

O aviso depende de recusa específica recebida do Asaas, vinculada a uma
mensalidade existente, e de consulta atual ao pagamento e à assinatura.
`OVERDUE`, cartão sem token local e timeout não provam cartão inválido.
A mensagem não afirma a causa da recusa e nunca solicita cartão pelo WhatsApp.

O destinatário é o responsável financeiro cadastrado, quando houver; não há
fallback para o telefone da criança. O link `/financeiro/forma-pagamento`
é somente navegação: exige login e abre o financeiro da conta conectada,
sem token, identificação de aluno ou autorização de cobrança na URL.

## Proteções

- Implantação sem disparo retroativo: somente eventos posteriores ao corte
  persistido de ativação entram automaticamente.
- Envio entre 09h e 18h de São Paulo, uma vez por assinatura/competência,
  respeitando o intervalo mínimo por aluno.
- Pagamento confirmado/recebido, estorno, exclusão, cobertura antecipada,
  revisão financeira, mudança de vínculo, troca recente de cartão, conta
  teste, desligamento ou notificações desabilitadas impedem o envio.
- Destinatário, evidência, conteúdo e versões das integrações são conferidos
  novamente antes da única tentativa externa.
- HTTP aceito não significa entregue. A confirmação depende do recibo do
  provedor. Resultado incerto não pode ser reenviado automaticamente.
- Abrir o link não altera o cartão. Qualquer atualização e cobrança exige
  ação explícita e conferência da situação financeira atual.

## Verificação e operação

Testes SQL globais devem rodar apenas no container de QA sem rede, com dados
sintéticos, cron desativado e rollback. Nunca executar o materializador global
como teste em produção.

Depois de criar o container isolado, executar:

```sh
node deploy/vps/finance-qa-test.mjs supabase/tests/student_card_notifications.sql supabase/tests/overdue_card_obligation_fence.sql
```

O aviso está limitado à integração Asaas matriz `PLATFORM_MANAGED_ROOT` da
Wise Wolf. Outros modos de integração permanecem bloqueados até validação
específica; não basta habilitar WhatsApp em outro tenant.

`student-card-notify` é exclusivo de serviço. O corpo
`{"sweep":true,"testMode":true}` verifica a rota sem consultar cobranças,
alterar filas, chamar o Asaas ou enviar mensagens.

Não inventar recusa histórica para atender um aluno específico. Primeiro
confirmar a identidade e a evidência; encaminhamento manual de link e
correção de dados financeiros são ações distintas.

## Fontes

- [Eventos de cobranças Asaas](https://docs.asaas.com/docs/webhook-para-cobrancas)
- [Assinaturas e atualização de cartão](https://docs.asaas.com/docs/faq-assinaturas)
