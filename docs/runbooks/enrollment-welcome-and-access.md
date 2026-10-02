# Boas-vindas e acesso após matrícula

Atualizado em 02/10/2026.

Contrato aceito cria a conta, mas conclusão da matrícula continua exigindo as
cobranças previstas na oferta, liquidadas e vinculadas ao próprio aluno.
Feedback pedagógico da experimental não bloqueia essa conclusão; continua como
pendência do professor. Não preencher feedback ou aceite artificialmente.

`complete_enrollment_offer` enfileira `ENROLLMENT_STUDENT_CONFIRMED` com início,
agenda, plano, e-mail de login, portal verificado e orientação para usar a senha
criada na matrícula ou Esqueci minha senha. Não transmite senha. A intenção tem
chave única por oferta e existe mesmo se a página for fechada.

O worker e a cerca `begin_notification_delivery_submission` revalidam oferta
concluída, aluno ativo, escola, contato, conta autenticada e endereço do portal.
Fixtures são suprimidos. Recibo aceito com ID do provedor marca `wa_welcome_sent`;
enfileirar não marca envio e não altera `contract_sent_at`. O endpoint legado
`whatsapp-notificacao-matricula` não envia em paralelo quando já existe intenção
na fila. Falha, atendimento humano ou identidade alterada exigem acompanhamento;
resultado incerto não autoriza um segundo envio.

## Rastreio de 02/10

Maria Izabela de Oliveira Santos assinou em 01/10 às 20h04 BRT e pagou a taxa
às 20h06. Conta e agenda existiam, mas a conclusão retornava
`TRIAL_FEEDBACK_REQUIRED`: a retirada dessa trava na emissão da oferta não havia
chegado à etapa final. André não tinha boas-vindas de acesso registradas;
o aviso de Cleice foi suprimido por atendimento humano. A direção autorizou
expressamente os três envios: o endpoint oficial retornou `delivery=accepted`
em 02/10 às 16h51. Aceitação do provedor não comprova leitura ou entrega.
Backup na VPS: `/opt/wisewolf/backups/welcome-trace-20261002T195122Z`.

Maria foi atribuída à Gabriela Lopes por autorização da direção, com comissão
de R$ 109 PENDING. Usa o desenho retroativo existente, com metadata autorizada
e cobrança exata da primeira mensalidade. Não preencher `offers.vendor_id` nesse
reparo: o gatilho legado liberaria pela conclusão baseada na taxa. A taxa de
R$ 49,90 recebida não libera comissão. Primeira mensalidade de R$ 198, vencimento
30/10, estava PENDING. O acompanhamento `acompanhar-experimentais`, a cada
30 minutos, foi atualizado para conferir liquidação real no Asaas, cliente,
assinatura, integração, ledger, crédito e ausência de estorno; só então confirmar
a comissão pela porta administrativa, sem criar saque ou transferência.
Backup e auditoria: `/opt/wisewolf/backups/welcome-affiliate-20261002`.

## Verificação

Migrations `20261002195026` e `20261002195728`, registradas no release.
Testes SQL `enrollment_without_trial_feedback` e
`enrollment_portal_access_notifications`: repetição da migration, intenção única,
acesso, contato alterado, fixtures, cerca final, recibo e privilégios. Tour da
direção `2026-10-02-z-matricula-com-acesso`. Publicar somente pelo release oficial.
