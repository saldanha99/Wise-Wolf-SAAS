# Parcelas futuras e fechamento da caixinha

## Escopo e segurança

`monthly-reserve-notify` processa duas atividades separadas:

1. Recalcular o estado financeiro após cadastro, cancelamento ou revisão de um pagamento completo. Essa fila interna funciona mesmo sem WhatsApp, sem opt-in e fora da janela mensal. Cada claim, recompute e ack é uma RPC separada; não mover o recompute para dentro do trigger financeiro.
2. Comunicar no grupo da gestão as parcelas MENSAL 2..N e a posição da caixinha do mês anterior. A primeira parcela continua no fluxo nativo `payment-split-notify`. Pagamentos LEGADO não geram novas parcelas de rateio.

A migration não cadastra nem habilita escolas. O diretor deve consentir em `configure_monthly_reserve_notifications`. O padrão é começar no próximo mês; o mês corrente só pode ser habilitado no dia 1 antes das 09h, no fuso `America/Sao_Paulo`. Não retroagir `starts_on` para disparar históricos.

## Dependências e execução

- Migration financeira principal, incluindo `prepayment_allocation_is_valid` e a fila de recompute.
- Migration `20260914195230_monthly_reserve_notification_outbox.sql` e função `monthly-reserve-notify`, incluindo seus arquivos locais e o formatter de `payment-split-notify/message.ts`.
- Grupo `dre_report_settings.destino` ativo, obrigatoriamente terminado em `@g.us`.
- Rota do tenant operacional, instância Evolution conectada, webhook autenticado v3, proprietário SCHOOL_ADMIN com vínculo ativo e integração saudável/versionada.
- Chave service role existente no Vault `wisewolf_service_role_key`; nunca copiar a chave para SQL versionado, arquivos de teste ou logs.

O cron `wisewolf-monthly-reserve-notify` chama o helper a cada minuto. O helper só faz a chamada HTTP se houver recompute interno pendente ou aviso pendente de escola habilitada dentro da janela de avisos. O processamento interno independe de mensagens. A janela de avisos abre no dia 1 às 09h e admite recuperação de indisponibilidade até o dia 7 às 23h59, sempre em São Paulo. Não envia competências antigas em lote. Uma fonte temporariamente indisponível aguarda cinco minutos antes de nova preparação, sem impedir o progresso de outras escolas. Isso só vale antes da autorização externa: `UNKNOWN` e `FAILED` nunca são recolocados na fila.

O endpoint aceita somente serviço autenticado e POST `{"sweep":true}`. `{"sweep":true,"testMode":true}` é um hard gate: não consulta nem altera filas, não resolve segredos e não envia. Esse modo testa autenticação/runtime, não constitui um teste de entrega real.

## Evidência e conciliação

Cada intenção tem deduplicação por parcela ou mês de fechamento. A sequência é claim → snapshot preparado → autorização final sob locks → um único POST → persistência do resultado. Depois da autorização não há consulta mutável, alteração de destino ou segunda chave de envio.

- `SUBMITTING` com `provider_delivery_status=accepted` significa apenas aceite HTTP do provedor.
- `SENT` exige recibo `delivered` ou `read`, correlacionado por tenant, instância e id de mensagem. Isso é a evidência reportada pelo provedor, não garantia de leitura por todos os participantes do grupo.
- `UNKNOWN` significa resultado ou recibo ausente/ambíguo. Não há reenvio automático. `FAILED` também exige revisão e não retorna à fila.
- Um receipt tardio pode resolver `UNKNOWN`. O caminho autenticado existente `_shared/whatsapp-inbox.ts` grava `reconcile_whatsapp_provider_delivery`, que atualiza `private.whatsapp_provider_delivery_receipts`; o novo trigger conecta esse ledger à outbox mensal. O receipt recebido antes da resposta HTTP também é reconciliado.
- A perda de resposta do banco após um POST tenta persistir novamente o mesmo resultado/id conhecido, nunca reenviar ao provedor.
- Estorno, chargeback e cancelamento continuam sendo aceitos. Um snapshot enviado permanece histórico, com `reconciliation_required=true`. Isso pede ajuste na conciliação; não apaga dinheiro já comunicado nem produz uma segunda mensagem automática.

No painel da caixinha, somente snapshots com entrega comprovada podem integrar a coluna de reserva avisada. `PREPARED`, `SUBMITTING`, `FAILED` e `UNKNOWN` não são avisos confirmados. O fechamento é uma posição congelada no momento da apuração, não transferência bancária nem quitação da folha. Correções posteriores são consultadas na conciliação e na trilha histórica.

## Validação sem efeitos externos

O teste Deno `supabase/functions/monthly-reserve-notify/worker.test.ts` usa provider e RPCs simulados, inclusive fluxo integral, falha após POST, recompute versionado e hard gate `testMode`.

Os testes SQL `monthly_reserve_notification_outbox.sql`, `prepayment_core_integrity.sql` e `prepayment_maturity_queue.sql` rodam antes da publicação no QA isolado, em transações revertidas. Exercitam claims globais e relógio sintético; não integram os savepoints de teste na base de produção, pois não devem reivindicar filas de alunos reais. Uma guarda no início exige cron desligado e ausência de perfis, usuários e segredos. As fixtures são sintéticas, sem chamadas a provedores; o teste de virada do mês confirma que o helper de cron não chama HTTP sem chave. Nunca executar trechos desses testes com autocommit. Cobrem fuso, dedupe, permissões, recibo fora de ordem e estorno após entrega.

Antes de ativar uma escola, verificar o grupo e a capacidade real de receber receipts v3. Se não houver confirmação, manter opt-in desligado. Inspecionar `last_error`, `provider_delivery_status`, timestamps e `reconciliation_required`; nunca inferir entrega apenas de HTTP 2xx ou de `automation_sent`.
