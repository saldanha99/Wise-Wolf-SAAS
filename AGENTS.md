# Instruções permanentes do projeto

## Contexto técnico: leia o CLAUDE.md

Antes de mexer em qualquer coisa, leia o [CLAUDE.md](CLAUDE.md) inteiro. Ele guarda as regras do
projeto (deploy só por `deploy/vps/release.sh` na VPS, a partir de árvore limpa na branch
`DEPLOY_GIT_BRANCH`; migrations re-executáveis e registradas no release; campo que não é coluna
derruba o update; tour de novidade em toda mudança visível) e o histórico de cada área.

Estado em 27/09/2026: o plano "Memória das Aulas" (Google Meet da escola) está publicado — registro
das aulas autorizado pela escola com direito de recusa, sem link de aceite. O que falta fazer e o
funcionamento estão em [docs/runbooks/google-meet-pedagogical-documentation.md](docs/runbooks/google-meet-pedagogical-documentation.md)
e na seção do Google Meet do CLAUDE.md.

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
