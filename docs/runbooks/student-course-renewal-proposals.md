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

## Limite desta etapa

Não há link de assinatura ou disparo automático conectado a esses rascunhos.
Não adicionar consumidor genérico à tabela. A etapa seguinte exige proposta
com período e vencimentos congelados, aceite inequívoco do aluno, prova atual
das assinaturas no Asaas e execução idempotente. Uma assinatura ativa deve
ser conciliada, não duplicada; uma conta suspensa não deve ganhar acesso por
ter somente um rascunho de renovação.

Os testes SQL rodam exclusivamente no ambiente de QA vazio e sem rede,
com rollback, pelo `deploy/vps/finance-qa-test.mjs`. Nunca inserir fixtures
deste teste em produção.
