---
name: operate-wise-wolf
description: Corrigir, testar, revisar e publicar o Wise Wolf a partir de pedidos autorizados do Hermes e do grupo WhatsApp. Usar para bugs, manutencao, interface, fluxos escolares, relatorios, deploy, rollback e incidentes da Wise Wolf ou WiseCore.
---

# Operar o Wise Wolf

## Receber e classificar

1. Obter do Hermes o grupo, remetente, pedido, evidencia e criterio de aceite.
2. Aceitar execucao apenas do grupo e dos remetentes registrados pelo Hermes.
3. Trabalhar em uma solicitacao por vez e usar um unico agente com permissao de escrita.
4. Classificar antes de editar:
   - `baixo_risco`: texto, estilo, layout, responsividade, relatorio, observabilidade ou bug de interface sem tocar seguranca, dinheiro ou dados reais.
   - `alto_risco`: banco, migration, RLS, autenticacao, tenant, contrato, cobranca, Asaas, Evolution, notificacao externa, segredo, exclusao ou alteracao em massa.

## Autonomia

O modo atual e `auto_low_risk`.

- Em `baixo_risco`, reproduzir, criar branch isolada, corrigir, testar, publicar preview e, quando o acesso de deploy estiver saudavel, publicar producao com verificacao e rollback automatico.
- Em `alto_risco`, reproduzir e preparar a correcao em isolamento, mas pedir aprovacao explicita antes de migration, integracao externa, merge ou deploy de producao.
- Nunca usar dados, contatos, contratos ou cobrancas reais como fixture.

## Escolher o executor

- Usar Antigravity com Gemini 3.7 Flash Medium para triagem, interface e revisao com contexto selecionado.
- Usar Gemini 3.7 Flash High para revisao visual ampla ou segunda opiniao.
- Usar Codex GPT-5.6 Sol como executor com escrita para correcoes simples ou complexas.
- Usar Claude Opus como executor alternativo ou revisor independente de mudanca de alto risco.
- Nao permitir dois agentes editando a mesma arvore. No fluxo headless, Antigravity e Claude revisam; Codex e o unico executor com escrita.

## Corrigir e validar

1. Atualizar a base a partir de `origin/main` em worktree isolado e preservar qualquer alteracao existente.
2. Reproduzir o problema antes da mudanca quando for possivel.
3. Fazer a menor correcao que satisfaca o criterio de aceite.
4. Executar, nesta ordem:
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
5. Para interface, validar desktop e mobile no preview.
6. Nao continuar se um teste falhar por causa da mudanca.

## Publicar

1. Fazer commit identificavel e enviar a branch para gerar preview.
2. Verificar o preview e os fluxos afetados.
3. Para producao de baixo risco, usar somente o runbook versionado em `deploy/vps/`.
4. Exigir preflight, backup, health check e rollback prontos na mesma execucao.
5. Se SSH, ambiente, backup ou health check falhar, parar sem improvisar e relatar o bloqueio.

## Relatar

Responder ao Hermes com causa, arquivos alterados, testes, URL de preview, estado do deploy, verificacao de producao, rollback disponivel e pendencias.
