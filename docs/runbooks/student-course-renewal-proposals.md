# Condições comerciais de renovação

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

Os testes SQL rodam exclusivamente no ambiente de QA vazio e sem rede,
com rollback, pelo `deploy/vps/finance-qa-test.mjs`. Nunca inserir fixtures
deste teste em produção.
