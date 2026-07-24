# Identidade autorizada para teste E2E

## Autorização e finalidade

O proprietário do sistema autorizou explicitamente o CPF `28718884857` como identidade exclusiva para testes de ponta a ponta do fluxo de matrícula. Esse CPF pode ser reutilizado em futuras solicitações de teste de fluxo sem nova confirmação.

A autorização vale apenas para recursos criados especificamente para o teste. Nunca reutilize uma conta, oportunidade, oferta, link, cobrança ou matrícula real.

## Regras de segurança

- Nunca registre senha, token, chave de API, cookie de sessão ou qualquer outro segredo em arquivos, commits, capturas de tela, relatórios ou logs.
- Se uma senha temporária for necessária, mantenha-a somente durante a execução e descarte-a ao final.
- Use sandbox para integrações financeiras sempre que estiver disponível.
- Quando for indispensável validar o fluxo integrado autorizado, use apenas o menor valor de cobrança aceito pelo sistema.
- Não envie e-mail, WhatsApp, SMS ou outra notificação externa. Ative `testMode` ou o mecanismo equivalente antes do primeiro passo que possa notificar alguém.
- Restrinja toda consulta, alteração e exclusão ao CPF autorizado e aos identificadores exatos capturados nesta execução.
- Se um recurso não puder ser confirmado como fixture do teste, não o altere nem o apague.

## Preparação de cada execução

1. Confirme que o CPF é exatamente `28718884857`.
2. Gere um e-mail único, nunca usado em outra execução.
3. Crie uma oportunidade e uma oferta exclusivas para o teste.
4. Gere um link de matrícula exclusivo; jamais use um link real ou previamente enviado a um cliente.
5. Marque os recursos compatíveis com `testMode`, `test_fixture` ou ambos.
6. Defina o menor valor de teste aceito e confirme a supressão das notificações.
7. Registre, apenas para uso durante a execução, os IDs criados no sistema, Auth e Asaas.
8. Faça backup dos registros que serão afetados antes de começar qualquer limpeza ou correção.

## Execução do fluxo

Percorra o fluxo como um usuário final, inclusive o último botão de confirmação. Valide ao menos:

- abertura e validade do link exclusivo;
- cadastro ou retomada segura da conta de teste;
- preenchimento e validação dos dados;
- revisão e assinatura do contrato;
- criação ou recuperação idempotente do cliente financeiro;
- geração e confirmação da cobrança de menor valor;
- conclusão da matrícula sem duplicar conta, cliente, cobrança ou assinatura;
- mensagens de progresso, erro recuperável e sucesso;
- ausência de notificações externas;
- correlação entre os IDs da execução para permitir auditoria e limpeza precisa.

Se o teste falhar, reutilize somente os recursos isolados desta execução e verifique a retomada idempotente. Não troque para dados reais para contornar o erro.

## Limpeza obrigatória

Após sucesso, falha ou interrupção:

1. Preserve o backup e a lista exata de IDs criados.
2. Cancele e remova, quando permitido, assinatura, cobrança e cliente de teste no Asaas.
3. Remova a identidade de autenticação criada para o e-mail único.
4. Remova matrícula, perfil, contrato, oportunidade, oferta, link e demais registros locais exclusivamente vinculados à fixture.
5. Não remova dados por busca ampla; use os IDs capturados e confirme o marcador de teste antes de excluir.
6. Consulte novamente banco, Auth e Asaas pelo CPF, e-mail e IDs da execução.
7. Considere a limpeza concluída somente quando não houver artefato ativo ou órfão em nenhum dos três ambientes.

## Critérios para encerrar e relatar

O relatório final deve informar:

- se o fluxo completo chegou ao último botão e qual foi o resultado;
- quais etapas foram validadas;
- se houve cobrança e qual foi o valor mínimo utilizado;
- se as notificações permaneceram suprimidas;
- se a limpeza foi concluída no banco, Auth e Asaas;
- quais backups foram mantidos e onde estão, sem expor segredos;
- qualquer artefato que não tenha sido possível remover.

Se restar qualquer artefato ou houver dúvida sobre sua origem, não declare a limpeza concluída e não tente apagar recursos potencialmente reais.
