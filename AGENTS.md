# Instruções permanentes do projeto

## Testes de ponta a ponta de matrícula

O proprietário do sistema autorizou o CPF `28718884857` como identidade exclusiva de teste de fluxo. Ele pode ser reutilizado em futuros testes de ponta a ponta sem pedir nova confirmação ao proprietário.

Antes de executar qualquer teste com esse CPF, leia e siga integralmente [docs/runbooks/e2e-test-identities.md](docs/runbooks/e2e-test-identities.md).

Regras obrigatórias:

- trate o CPF autorizado apenas como dado de teste; nunca o associe a uma conta, oportunidade, oferta ou link real;
- crie um e-mail único para cada execução e use uma oferta e uma oportunidade isoladas;
- marque todos os registros e integrações compatíveis com `testMode` e/ou `test_fixture`;
- prefira sandbox; quando o fluxo autorizado exigir cobrança integrada, use somente o menor valor aceito pelo sistema;
- suprima mensagens, e-mails e outras notificações externas durante o teste;
- faça backup dos registros afetados antes de qualquer limpeza;
- ao terminar, remova todos os artefatos de teste do banco local, autenticação e Asaas e valide que não restaram registros;
- nunca grave senhas, tokens, chaves, cookies ou outros segredos neste arquivo, no runbook, em commits ou em logs.

Essa autorização cobre somente a identidade acima e as ações reversíveis necessárias ao teste e à limpeza dos artefatos criados por ele. Ela não autoriza alterações ou exclusões em dados reais.

## Operação pelos agentes do Hermes

- Carregue `.agents/skills/operate-wise-wolf/SKILL.md` para qualquer solicitação da Wise Wolf.
- O modo operacional é `auto_low_risk`: mudanças de baixo risco podem ser corrigidas, testadas e publicadas autonomamente.
- Banco, migrations, RLS, autenticação, tenant, contratos, cobrança, Asaas, Evolution, notificações externas, segredos, exclusões e alterações em massa exigem aprovação explícita para produção.
- Use apenas um agente com escrita por solicitação. No fluxo headless, Codex é o executor com escrita; Antigravity e Claude revisam em sequência.
- Trabalhe em branch ou worktree isolado a partir de `origin/main`.
- Antes de publicar, execute `npm run typecheck`, `npm test` e `npm run build`.
- Preview pode ser publicado automaticamente. Produção exige o runbook versionado em `deploy/vps/`, preflight, backup, health check e rollback.
- Estado operacional, conversa e autorização ficam no Hermes; não grave tickets ou mensagens em memória global.
