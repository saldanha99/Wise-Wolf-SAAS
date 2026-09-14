# Adjudicação operacional limitada

Ferramenta privada para um lote explicitamente aprovado de sete casos: dois
recebimentos vinculados a alunos (um com seis competências MENSAL), quatro
recebimentos comprovados sem aluno e uma duplicidade de um recebimento canônico
`RECEIVED_IN_CASH`. Não é um importador genérico e não inclui outros casos ainda
sem confirmação comercial.

Não executar durante testes ou publicação. A implementação não realiza `POST`,
`PUT`, `PATCH` ou `DELETE` no Asaas. O padrão é dry-run; ele consulta somente os
oito pagamentos exatos duas vezes e valida o banco dentro de uma transação que
termina em rollback. O modo commit cria seis entradas e a decisão de duplicidade
em uma única transação, junto com as seis competências, antes de qualquer worker
poder enxergar o primeiro aviso.

## Preparação obrigatória pelo operador autorizado

1. Publicar e verificar as migrations e o reconciliador. Confirmar os testes
   isolados e o ambiente ROOT correto. Este procedimento não autoriza uma
   publicação por si só.
2. Conferir a aprovação privada, os sete casos, valor/data efetivos de pagamento
   e crédito, vínculo de cada aluno e as seis competências. Não inferir datas ou
   valores a partir de nomes, boleto ou mensalidade contratada. Caso os fatos
   atuais divirjam da aprovação, parar e obter nova orientação.
3. **Antes de qualquer commit, fazer backup privado verificável dos alvos**:
   linhas locais presentes e pagamento canônico, ledger bruto/estornos,
   allocations/outbox existentes, inbox e issues dos oito provider IDs e os
   perfis/memberships estritamente necessários. Preservar dados e IDs para
   comparação, sem copiar chaves, Vault, cookies, tokens ou dados de cartão.
   Guardar fora do repositório, com permissão 0600 e retenção combinada com o
   proprietário. A ferramenta não cria esse backup automaticamente.
4. Preparar um manifest fora do repositório, permissão 0600, no formato de
   `Manifest` em `core.ts`. Usar IDs/valores/datas exatos e motivos objetivos,
   sem nome/CPF/telefone. `operator` identifica honestamente quem opera;
   `approval_ref` é o SHA-256 da evidência privada de aprovação, não uma
   identidade de diretor inventada. `batch_id` é um UUID estável. `case_key` usa
   C01…C07. Não versionar manifest/provas/backups.
5. Configurar explicitamente o ambiente local seguro: `SUPABASE_URL` HTTPS,
   `SUPABASE_SERVICE_ROLE_KEY`, `ASAAS_API_URL=https://api.asaas.com/v3` e
   `ASAAS_ACCESS_TOKEN` (ou `ASAAS_API_KEY`). O broker ROOT usa esses valores
   locais e retorna o marcador `environment=platform`. A ferramenta exige
   conexão `PLATFORM_MANAGED_ROOT` configurada/saudável e verifica id, versão e
   chave antes/depois dos GETs. Não imprime nem descobre segredos
   automaticamente. Não usar arquivos/scripts de wallet.
6. Confirmar o destino SSH canônico `wisewolf-vps`, container `supabase-db`,
   banco `postgres`, operador `supabase_admin`. Não encaminhar dados privados
   por argumentos de shell nem habilitar `set -x`.

## Execução deliberada

Com as permissões mínimas do Deno adequadas ao arquivo privado, rede
configurada, variáveis acima e execução de `ssh`:

```text
deno run [permissões explícitas] scripts/asaas-adjudication/run.ts --manifest /caminho/privado/lote.json
```

Revisar o resultado dry-run e comparar com o backup/aprovação. Só então, com
autorização de execução real e o mesmo manifest:

```text
deno run [permissões explícitas] scripts/asaas-adjudication/run.ts --manifest /caminho/privado/lote.json --commit --confirm-batch UUID-EXATO-DO-MANIFEST
```

O comando privado não aceita JWT de usuário/service nem é concedido à Data API.
O ator das allocations permanece nulo em vez de fingir que um diretor executou a
RPC; a decisão imutável registra operador e referência da autorização. Nenhuma
preferência de notificações é ativada. Outbox existente pode ser consumida
normalmente depois do commit; se a operação aprovada exigir supressão de
mensagens, o responsável deve garantir a pausa dos workers pelos controles
operacionais já existentes antes de começar.

## Verificação e resultado incerto

- Confirmar seis pagamentos novos, seis entradas brutas exatas e somente uma
  correlação `DUPLICATE_OF`; nenhuma nova entrada para o duplicado.
- Conferir seis competências, soma em centavos, primeira parcela e reserva.
  Recebimentos sem aluno são `RECEBIMENTO_NAO_CLASSIFICADO`, fora da receita
  escolar e da base de repasse, mas dentro do caixa comprovado. Nunca são aporte
  presumido.
- Rodar reconciliação de leitura: divergências de dinheiro/estorno/identidade
  continuam visíveis. O reader de decisões é service-only e não autoriza
  mutação.
- Uma desconexão ou timeout na resposta **não prova rollback**: o commit pode
  ter ocorrido. Não reenviar cegamente, não alterar batch/manifest e não recriar
  linhas. Verificar a decisão persistida e todos os efeitos pelo batch em
  consulta privada read-only. O mesmo lote só é idempotente enquanto os
  fatos/provas locais e do provedor permanecem iguais; drift exige revisão.
- Não desfazer por DELETE/UPDATE manual. Estorno real segue o fluxo financeiro
  auditado; uma nova divergência invalida a correlação e exige análise.

## Testes sem produção

```text
deno test --allow-env scripts/asaas-adjudication/core.test.ts
node deploy/vps/finance-qa-test.mjs supabase/tests/private_asaas_payment_adjudication.sql
```

Os testes usam somente fixtures sintéticas, mocks GET e banco QA vazio isolado
sem rede. A suite SQL termina em rollback.
