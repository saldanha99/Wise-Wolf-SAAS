# Retomada do financeiro por competência — 14/09/2026

## Objetivo e limites da recuperação inicial

Recuperar a conversa interrompida no Claude, confrontar o relato com o código
salvo e identificar o ponto seguro de continuação. Esta etapa não publica a
feature, não liquida pagamentos e não envia mensagens.

Foram recuperados o histórico local da sessão original, as respostas à ferramenta
de perguntas, a memória de continuidade, o plano privado da triagem e o resultado
dos agentes. Esses registros são evidência histórica, não prova do estado atual
dos pagamentos. Identidades, IDs do provedor e detalhes individuais permanecem
nos registros privados, fora deste documento e de novos commits.

## Estado confirmado nesta retomada

| Local | Evidência |
| --- | --- |
| Checkout | Branch `feat/financeiro-competencia-20260914`, HEAD `beb2f60b7f6f60cd3225d5d0c3cdb857f3ef9cb7`; árvore limpa antes deste documento |
| GitHub | Consulta `git ls-remote`: branch de produção `codex/wolfie-standalone-funnel` em `16692eb8f1734c7a94f54422e32bf130b858bc83`; branch financeira não retornada |
| VPS | Release ativo `20260914T062940Z-17ff99aa3cc9`, provenance `source_git_sha=16692eb8f1734c7a94f54422e32bf130b858bc83`, estado `active` |

O commit financeiro está um commit à frente da branch de produção consultada.
Não usar `main` como base de publicação sem reconciliação: a branch efetivamente
publicada é outra. Não trocar branches, mesclar nem sobrescrever a VPS com base
apenas no nome exibido na interface.

## Decisões recuperadas da direção

- Pagamento completo: informar o valor integral já recebido, a data e o intervalo
  coberto; liberar o rateio mês a mês, com reserva dos meses futuros.
- Caixinha: usar o calendário real da competência da fatura e a regra vigente
  de remuneração; comparar com as aulas efetivamente pagáveis, sem multiplicador
  fixo de quatro semanas.
- Enviar fechamento da caixinha no grupo da Gestão no dia 1º, por professor,
  com valor a completar/devolver e explicação das diferenças.
- Corrigir os 15 casos identificados na triagem, com aviso no grupo, depois das
  correções e da validação. A listagem histórica não equivale a 15 novas entradas
  de caixa: inclui cartão ainda não liquidado e representação duplicada do mesmo
  dinheiro. Reconsultar o estado autoritativo antes de executar cada caso.
- Um recebimento externo foi confirmado verbalmente como pagamento completo,
  mas o valor, a data e o período utilizados no rascunho foram inferidos. Não
  registrar esse rascunho como fato: confirmar os campos antes de qualquer baixa.
- Não reabrir a conciliação histórica deixada de lado por decisão anterior da
  direção. A retomada não autoriza reclassificação geral do passado.

## O que o Claude entregou e o que não entregou

O último fluxo teve conclusão somente do agente de banco. Mensagens e revisões
independentes foram interrompidas por limite de uso. O resultado final desse
agente está salvo e o trabalho foi commitado, embora o print ainda relate WIP.

O commit `beb2f60` contém a migration
`20260914100000_competencia_e_pagamento_completo.sql`, seu teste SQL, registros
no release, texto de aviso, testes do texto e motivos adicionais no painel
Caixinha × Folha. Implementa parcelas, RPCs de cadastro/cancelamento, rateio
mensal e parte da cobertura financeira. Não é uma entrega completa de ponta a
ponta.

Pendências explícitas, confirmadas no código:

1. Produtor, fila durável, worker e envio das parcelas posteriores à primeira.
2. Fechamento da caixinha no grupo no dia 1º, com deduplicação e rastreabilidade.
3. Tela de registro/cancelamento de pagamento completo.
4. Cobertura em `list_students_overview`,
   `recompute_student_financial_status_pre_lifecycle_impl` e
   `generate_monthly_student_payments`.
5. Tratamento seguro das cobranças Asaas emitidas para meses cobertos, sem
   cancelar automaticamente uma cobrança real apenas por coincidência de mês.
6. Conclusão do caminho de conciliação autoritativa e execução individual da
   triagem, preservando a trava já publicada contra cobrança indevida.

## Achados estáticos desta retomada — bloqueadores de publicação

Estes achados foram identificados por leitura do código; os testes de regressão
em banco ainda precisam reproduzi-los e validar as correções.

- **Reversão financeira:** `private.student_month_covered` verifica somente
  parcela `ACTIVE`, sem validar o pagamento de origem. O caminho de webhook
  existente não invalida as novas parcelas após estorno/chargeback. Cobertura,
  relatórios e situação financeira precisam convergir para a mesma regra.
- **Natureza da obrigação:** filtros de pendência baseados apenas em aluno/mês
  não distinguem mensalidade de matrícula, multa de cancelamento ou extra.
  Cobertura de mensalidade não pode quitar nem esconder essas outras obrigações.
- **Histórico:** o upsert em `private.prepayment_insert_parcelas` reaproveita a
  linha e sobrescreve criação/autoria, limpando cancelamento/autoria. Adicionar
  histórico de revisões/eventos que preserve cadastro, cancelamento e recadastro.
- **Caixinha não comprovada:** `private.caixinha_fechamento_unchecked` aceita
  snapshots `PREPARED`, `SUBMITTING` e `UNKNOWN` como fonte de aviso; esses estados
  não comprovam entrega. Parcelas posteriores sem snapshot recebem
  `sem_aviso=false`. Separar estimativa, reserva preparada e aviso confirmado.
- **Autorização:** a nova RPC `payment_split_installment` verifica perfil e
  tenant, mas não aplica o mesmo guard de ciclo de vida/membership utilizado nas
  escritas. Revalidar também a política de leitura de parcelas contra as regras
  canônicas da escola.
- **Concorrência com mensagens:** o cancelamento trava o aluno, mas não usa a
  mesma trava do pagamento/fila de envio. A existência de um snapshot selado não
  dispensa testes de cancelamento e recadastro concorrentes com `SUBMITTING`.
- **Estado anterior do perfil:** cancelar uma cobertura recalcula `paid_through`
  apenas pelas parcelas desta tabela. Cobertura legada anterior, ainda presente
  somente no perfil, precisa ser preservada/reconciliada, não apagada por efeito
  colateral.

## Validação efetivamente executada nesta retomada

- `npm run typecheck`: passou.
- `deno test --cached-only --allow-read supabase/functions/payment-split-notify/`:
  32 testes passaram, nenhum falhou; testes sem acesso à rede ou credenciais.
- `deno check --frozen supabase/functions/payment-split-notify/index.ts`: passou.
- Consulta GitHub e leitura da provenance/ativação da VPS: realizadas.
- Nenhum teste SQL, migração ou alteração em dados reais foi executado aqui.
  Os 21 testes SQL e medições relatados pelo Claude são evidência histórica,
  ainda não revalidados nesta retomada.

## Sequência de continuação

1. Reproduzir e corrigir reversão, histórico e autorização com fixtures isoladas.
2. Fechar a cobertura nos leitores e geradores restantes, incluindo testes de
   ausência de cobranças/notificações indevidas e de duplicação de dinheiro.
3. Implementar fila durável por parcela e fechamento mensal, vinculando mensagem,
   competência, escola e snapshot; falha ambígua de envio exige reconciliação,
   não reenvio automático às cegas.
4. Completar a interface e verificar cadastro → reserva → competência → aviso →
   fechamento → cancelamento/estorno, com perfis de acesso distintos.
5. Revisar o pacote de release, reaplicabilidade das migrations e drift da VPS.
   Publicar somente com os bloqueadores resolvidos e os testes proporcionais ao
   risco concluídos. Não contornar travas de publicação.
6. Revalidar a triagem caso a caso e aplicar apenas as ações comprovadas. Não
   usar valores ou datas inferidos e não contar duas vezes a mesma entrada.

## Continuação autorizada — implementação e QA

Após a recuperação, a direção autorizou continuar a implementação. O registro
acima permanece como fotografia inicial; não representa o estado de conclusão.
Nenhum teste descrito abaixo movimentou pagamentos ou enviou mensagens reais.

Implementado no checkout, ainda sem publicação nesta atualização:

- Parcelas com ciclos imutáveis, histórico append-only, cancelamento motivado e
  controle de concorrência. Cadastro não altera mensalidade nem cobertura legada
  do perfil. EXTERNO é declaração auditada LEGADO, sem criar receita ou rateio.
- Estorno parcial, chargeback e divergência de origem suspendem a validade da
  cobertura e pedem revisão. Fila transacional recomputa o perfil sem travar o
  processamento do fato financeiro no webhook.
- Cobertura restrita a mensalidades nos relatórios, cobrança, geração mensal e
  situação financeira. Matrícula, multa, material e aula extra não são quitados
  por uma coincidência de mês. Cancelamento da única cobertura externa remove
  somente o ACTIVE comprovadamente derivado dela, preservando status sem essa
  evidência.
- Fila de parcelas 2..N e fechamento mensal com opt-in, janela mensal, snapshot,
  confirmação por recibo, um único envio e reconciliação de resultados incertos.
  Primeira parcela permanece no aviso nativo. Histórico enviado não é apagado
  após cancelamento/estorno; é destacado como reserva em revisão.
- Interface da direção para cadastro, histórico, cancelamento de cobertura e
  solicitação individual de cancelamento de cobrança pendente coberta. O último
  exige consulta da cobrança exata no Asaas, nova validação antes do DELETE e
  comprovação do resultado; não cancela a assinatura e não repete DELETE incerto.
- Painel separa reserva com aviso confirmado, previsão sem aviso e valores em
  revisão. Nenhuma dessas colunas comprova saldo ou transferência bancária.

### Ambiente de teste

`deploy/vps/finance-qa-bootstrap.sh` cria um container efêmero PostgreSQL 17 com
schema-only, `network=none`, sem portas, armazenamento tmpfs e cron impedido de
executar jobs. Nenhum perfil, usuário, segredo ou job de produção foi copiado.
Somente metadados de papéis/ACLs são reproduzidos, sem LOGIN ou senhas.

`deploy/vps/finance-qa-test.mjs` valida o label e a ausência de rede antes de
executar; aplica as novas migrations duas vezes e reverte cada teste. Não aponta
para `supabase-db`. Fixtures usam identidades sintéticas. A cópia sem dados fez
aparecer dependências prévias dos testes em catálogos, papéis e configuração de
produção; não confundir esses pré-requisitos ausentes com regressão do código.

### Resultados intermediários efetivamente observados

- Aplicação: 140 arquivos / 687 testes passaram antes da última ampliação da UI.
- Backend: os dois blocos Deno da publicação passaram, 758 + 163 testes, sem
  permissão de rede para executar requests de negócio.
- Build com configuração pública equivalente à publicação passou. O build sem
  configuração foi corretamente recusado pelas travas de vídeos e API própria;
  nenhuma dessas travas foi desabilitada.
- `npm audit`: zero vulnerabilidades; nove testes Node de publicação/privacidade
  e testes do preflight passaram.
- Os seis SQL centrais passaram com DDL aplicada duas vezes: integridade do
  pagamento completo, cobertura/gestão, fila mensal, competência original,
  cancelamento individual de cobrança e autorização SECURITY DEFINER.
- `deploy/vps/prepayment-concurrency-qa.mjs` passou quatro disputas reais entre
  duas conexões, comprovando espera via `pg_blocking_pids`: estorno → cadastro,
  cadastro → estorno, inbox de estorno → cadastro e cadastro → inbox. Cobertura
  inválida não permaneceu utilizável; observação de inbox não fabricou estorno
  no pagamento de origem. O banco dedicado foi removido e a ausência validada.
- Regressões financeiras adicionais passaram: agregação de status, ledger,
  trava de cobrança pelo Asaas, fencing de rateio e de mensagens financeiras,
  outbox de gestão, fechamento mensal, escopo financeiro por professor,
  contexto financeiro da gestão, conciliação de período, pagamentos liquidados,
  conciliação de caixa, reparos de vínculos legados, offboarding, identidades de
  pagamento/transferência, fencing de período, remarcações e troca de plano.

### Ampliação e revisão final do núcleo

- A aplicação passou novamente: 141 arquivos, 696 testes, sem os avisos de
  sincronização React que estavam presentes no primeiro ensaio.
- Avanço automático da cobertura na virada do mês validado em SQL no QA,
  inclusive com WhatsApp desativado. Não depende do opt-in dos avisos.
- Caminho UPDATE-ONLY de cobrança já vinculada implementado com GET novo,
  identidade/versionamento revalidados, auditoria financeira minimizada e
  proteção de eventos antigos. CONFIRMED não cria caixa. A revisão independente
  encontrou e corrigiu o apagamento de estado de disputa, a classificação de
  dois eventos de chargeback e a aceitação de replay com datas locais divergentes.
  SQL aplicado duas vezes passou no QA; 32 testes Deno focais passaram.
- O ensaio visual isolado confirmou legibilidade em 1280px e 390px, ausência de
  overflow, prévia com centavos exatos e confirmação obrigatória. O controle
  nativo de mês e comandos posteriores tiveram limitações de automação; este
  ensaio não é apresentado como um E2E completo de envio do formulário.
- Releitura mínima da triagem confirmou oito pagamentos locais e sete sem linha.
  Nenhuma entrada/aviso foi produzida nesta inspeção. As sete ausências exigem
  importação explícita ou correlação de duplicidade, e não são atendidas por uma
  atualização de fatura existente. O comando operacional privado para esses
  casos está em implementação, com dry-run e transação atômica.

### Validação pré-publicação do conjunto integrado

- Aplicação: typecheck, 142 arquivos / 699 testes e build de produção passaram.
- Backend: formatação de 220 arquivos, typecheck e os dois blocos Deno do
  release passaram: 769 + 197 testes (966 no total).
- Dez testes SQL centrais passaram no QA com todas as sete migrations novas
  executadas duas vezes: integridade, cobertura/gestão, virada de mês, fila
  mensal, competência, cancelamento de cobrança, observação corroborada,
  adjudicação privada, relatórios de recebimentos sem classificação e
  fechamento mensal.
- Adjudicação privada concluída: lote atômico, dry-run, prova nova antes do
  commit, ordem de locks, auditoria imutável, sem identidade de diretor
  fabricada, sem mutações no Asaas e sem criar caixa para duplicidade.
  O procedimento operacional exige backup privado verificável e confirmação
  explícita do lote; resultado de commit incerto não autoriza repetição cega.
- Recebimentos sem classificação permanecem no caixa, em categoria própria,
  fora da receita/DRE e do rateio. DRE e balancete apresentam esse saldo
  separadamente. Estorno parcial e total foram testados; nada é presumido como
  mensalidade ou aporte.
- Onze testes Node de publicação/privacidade, cenários do preflight,
  `bash -n`, `git diff --check` e auditoria de dependências de produção passaram.
  Nenhuma vulnerabilidade foi reportada nessa auditoria.

Este registro antecede a publicação e a execução dos casos reais: os testes não
representam baixa dos 15 pagamentos nem entrega de seus avisos. O recebimento
externo sem valor/data/período confirmados continua fora do lote.

Os testes de integração ROOT e de claims globais executam somente no QA sem
rede, guardado por ausência de perfis/usuários/segredos e cron desativado. Não
substituem conexão real por fixture nem reivindicam trabalho real durante a
publicação.

Pendências desta atualização: concluir/testar adjudicação dos pagamentos ausentes,
revisão final, publicação e execução individual comprovada da triagem. O
recebimento externo sem valor/data/período confirmados continua bloqueado; não
foi transformado em fato por inferência.
