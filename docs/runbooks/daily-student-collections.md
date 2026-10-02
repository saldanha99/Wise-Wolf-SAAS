# Cobrança diária de mensalidades

A direção autorizou em 02/10/2026 o envio por WhatsApp e e-mail a Davi, Letícia
e Felipe, e a rotina diária para mensalidades realmente vencidas. O cron
`wisewolf-notify-payment-due` roda `0 12 * * *` (09h Brasília, todos os dias).
Não há regra para intimidar, negativar ou inventar perda automática de professor.

O opt-in por escola fica em `daily_payment_collection_settings`. Com ele ligado,
o cron usa o fluxo diário em `notify-payment-due/daily.ts` e deixa de aplicar os
marcos 3/10/20/30 à mesma escola. A cobrança pré-vencimento continua separada.
O dia da intenção é o calendário de Brasília, inclusive nas bordas UTC.

Antes de cada envio: perfil e matrícula ativos, contrato aceito, agenda/aula
recente, sem fixture, encerramento/exclusão em andamento ou refund. GET no Asaas
confere ID, cliente, assinatura, `OVERDUE`, vencimento e cobrança não excluída.
Link pertence ao Asaas. Quem quitou ou teve fatura excluída sai da rotina.
Não se atualiza o financeiro para fabricar elegibilidade.

WhatsApp usa a instância central e a cerca durável existente, com uma intenção
`PAYMENT_OVERDUE_DAILY_YYYYMMDD` por fatura. Outro aviso de cobrança aceito ou
incerto naquele dia evita novo WhatsApp. O e-mail tem intenção própria em
`daily_payment_email_attempts`, com chave única por escola/fatura/dia e chave de
idempotência no Resend. Os canais funcionam de modo independente; timeout fica
incerto para aquele dia, sem repetir o POST. A direção deve conferir falhas.

Dependentes usam o responsável financeiro cadastrado. E-mail só vai ao endereço
do titular autenticado ou ao responsável vinculado, com endereço confirmado na
autenticação e igual ao contato financeiro do dependente. Telefone do filho não
substitui o do responsável.

Disparo pontual, exclusivamente com autenticação de serviço e autorização da
direção: `POST /functions/v1/notify-payment-due` com JSON de quatro campos:
`mode: DAILY_COLLECTION`, `campaign_date` igual ao dia em Brasília, `tenant_id`
habilitado e `student_ids` com os IDs exatos autorizados. Corpo vazio é o cron.
Não chamar o endpoint de envio em testes. Fixtures de SQL sempre dão rollback;
Deno usa transportes falsos. Publicar apenas pelo release oficial.

Monitorar as intenções dos dois canais, falhas do cron e resultados dos
provedores. Reexecutar a mesma intenção não autoriza um segundo POST aceito ou
incerto. Desabilitar o opt-in preserva o histórico e devolve a escola à régua
normal. Não editar mensagens ou pagamentos antigos para disparar de novo.
