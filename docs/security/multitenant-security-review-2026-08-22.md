# Revisão de segurança multi-tenant — 22/08/2026

## Objetivo

Esta revisão trata a escola como fronteira de segurança. O tenant de uma ação
nunca pode ser escolhido pelo navegador, inferido de dados legados do perfil ou
deduzido por coincidência de nomes de instância. A autoridade vem da sessão
autenticada, do contexto ativo e de uma associação `ACTIVE`.

## Controles implementados

### Central do diretor

- Configurações agrupadas em identidade, branding, portal, operação,
  integrações e segurança.
- Leitura e escrita passam por uma Edge Function que deriva o tenant no
  servidor, rejeita `tenantId` e papel enviados pelo cliente, limita frequência
  e registra auditoria sem segredos.
- Alterações usam versão otimista para impedir que duas sessões sobrescrevam
  configurações silenciosamente.
- Logo e favicon usam bucket público próprio, namespace da escola e allowlist de
  formato/tamanho. O bucket legado inteiro foi tornado privado; os arquivos
  visuais antigos só passam por um proxy que aceita `logo` ou `favicon`.
- A assinatura do representante usa `tenant-legal-assets`, privado e isolado
  por tenant. O banco persiste somente o path; a Edge Function deriva escola e
  autorização no servidor e materializa URL assinada por 15 minutos.
- Credenciais são write-only, validadas no provedor e armazenadas no Vault. A
  resposta contém somente status, ambiente, últimos quatro caracteres e datas.
- Identidade jurídica não é publicada no resolver anônimo.

### Autorização e isolamento

- Automações manuais de diretor executam somente no tenant ativo; o modo global
  fica reservado ao serviço interno.
- WhatsApp, cobrança, gestão escolar e RH usam associação ativa em vez de
  `profiles.role/tenant_id` como fonte de autoridade.
- Instâncias do WhatsApp têm `tenant_id` canônico e nome globalmente único. O
  inbound resolve a escola por essa tabela, nunca pelo primeiro perfil que
  coincidir.
- Usuários suspensos ou revogados são recusados nos endpoints endurecidos e nos
  helpers de RLS, mesmo quando a associação ao tenant ainda aparece como ativa.
- Helpers privilegiados de associação, papel e vínculo professor-aluno são
  amarrados ao tenant ativo do chamador. Uma chamada direta não pode usá-los
  como oráculo para sondar UUIDs ou relações de outra escola.
- Policies permissivas críticas, views financeiras e RPCs de automação foram
  fechadas; testes negativos cobrem Tenant A contra Tenant B.
- Acesso anônimo direto a `prospects` foi removido.

### Convites e contratos

- Convites de professor e vendedor são UUIDs de uso único, com expiração,
  claim atômico e tenant persistido no servidor. Payload base64 editável foi
  removido.
- Identidade jurídica de contrato é carregada do tenant ativo e congelada pelo
  servidor; o navegador não pode enviá-la nem substituí-la.
- Contratos de professor ficam em registro por `(tenant_id, user_id)`, com
  snapshots jurídico, comercial e da parte contratada. A consulta não lê PII
  global de `profiles` para autorizar outro tenant.
- Marcas, representantes e assinaturas reais da plataforma foram removidos dos
  fallbacks. Documento incompleto falha fechado.
- A rota antiga de contrato deslogado foi desativada; contrato com PII exige
  autenticação e tenant ativo.
- URLs públicas legadas de assinatura são removidas, e o objeto antigo fica
  apenas como backup administrativo no bucket legado privado. Convites/ofertas
  ainda abertos com esse snapshot são revogados; o diretor deve reuploadar a
  assinatura privada e emitir um novo link.

### Experimentais e oportunidades

- O navegador não escreve diretamente em oportunidades, agenda, links de
  matrícula ou desfechos de experimental. Comandos passam por RPCs validadas,
  idempotentes e vinculadas ao tenant ativo.
- O professor não recebe leitura direta da tabela de oportunidades. A prévia de
  aceite devolve apenas os campos necessários, valida associação ativa e exige
  a geração atual do link.
- Links de aceite não carregam nome, telefone ou tenant na URL. Cada reabertura
  incrementa a geração, invalidando links anteriores e impedindo replay.
- Experimental não usa grupo de WhatsApp. Disparos são individuais e somente
  para professores ativos da escola; solicitações direcionadas nunca entram no
  leilão geral.
- Confirmação pública de interesse não cria appointment. A agenda só é ocupada
  quando o professor autenticado aceita a oportunidade direcionada.

### Incidente de remarcação

- A agenda original permanece intacta até uma resposta afirmativa inequívoca
  do professor.
- Respostas negativas como “acredito que eu não consigo” nunca são tratadas
  como aceite.
- Um “sim” solto também não move a aula: todo aceite positivo precisa trazer o
  código exato do pedido. A recusa sem código só fecha um pedido quando ele é o
  único pendente e sempre preserva a agenda.
- Cada pedido recebe código, expira, é idempotente e mantém tenant, professor,
  oportunidade e agendamento vinculados.
- Conflitos consideram compromissos `scheduled` e `confirmed`, evitando duas
  aulas no mesmo intervalo.
- Uma experimental cujo appointment já está `confirmed` continua sendo tratada
  como aula com professor definido; ela nunca volta ao leilão por engano.

## Validação executada

- Auditoria de dependências: zero vulnerabilidades em nível moderado ou maior.
- TypeScript, build de produção e verificação dos ativos visuais passaram.
- 185 testes Vitest e 358 testes Deno passaram; a checagem Deno cobriu todas as
  Edge Functions do portão de release.
- As oito migrations novas e os oito testes SQL relacionados passaram no parser
  PostgreSQL. A execução transacional das fixtures contra o banco real permanece
  como portão obrigatório da publicação e não foi executada na base de produção
  durante esta revisão.

## Estado das integrações

O cofre por tenant está pronto e seguro para receber chaves. A migração completa
dos consumidores ainda deve ocorrer provedor por provedor. Até essa etapa, uma
credencial validada no cofre deve ser apresentada como **preparada**, não como
canal ativo. Funções que ainda usam chaves globais da plataforma não podem
afirmar BYOK ou isolamento de conta do provedor.

## Pendências obrigatórias antes da abertura ampla do SaaS

1. Migrar todos os consumidores de Asaas, Evolution e modelos de IA para um
   broker de segredos tenant-aware, com modo `PLATFORM_MANAGED` ou `TENANT_BYOK`.
2. Trocar o segredo do webhook Evolution em query string por header assinado,
   timestamp, proteção contra replay e idempotência por integração/evento.
3. Tornar o contexto ativo escopado à sessão, não apenas ao usuário, evitando
   que duas abas ou dispositivos troquem o tenant um do outro.
4. Revisar a allowlist completa de funções `SECURITY DEFINER`; nenhuma função
   antiga deve herdar `EXECUTE` de `PUBLIC`, `anon` ou `authenticated`.
5. Adicionar FKs e vínculos compostos de tenant aos relacionamentos de aluno,
   professor, plano, cobrança e agenda. A referência deve provar que os dois
   lados pertencem à mesma escola.
6. Aplicar namespace e quota nos buckets restantes (`avatars`, materiais e
   treinamentos), além de limpeza de objetos substituídos.
7. Provisionar domínio próprio com ingress e TLS reais, revalidação periódica e
   desativação quando DNS/propriedade deixarem de corresponder.
8. Reduzir logs: telefone em hash/últimos quatro, sem corpo de mensagem, payload
   bruto, resposta de provedor ou segredo; definir retenção e descarte.
9. Gerar ou selar o PDF contratual no servidor. O snapshot persistido já é
   autoritativo, mas o arquivo submetido pelo navegador não deve ser a única
   evidência documental.
10. Tornar a entrega de oportunidades transacional, com outbox e reconciliação
    de falhas por destinatário; criar o registro no banco não pode ser confundido
    com mensagem efetivamente entregue.
11. Completar testes de integração em Postgres real e E2E com dois tenants para
    cada endpoint, RPC, policy, webhook e Storage policy.

## Portões de publicação

- Executar migrations e testes SQL na mesma transação; só gravar marcador após
  todos passarem.
- Bloquear release que publique banco/frontend sem as Edge Functions acopladas.
- Fazer backup antes da migração e manter rollback coerente de frontend,
  funções e banco.
- Antes de fechar o bucket legado, inventariar e copiar para backup seguro os
  objetos `tenant-branding/<tenant>/signature/*`. Depois da migração, confirmar
  que as URLs públicas antigas retornam erro e orientar cada escola a fazer o
  reupload privado antes de reemitir convites ou ofertas revogados.
- Validar smoke tests de autenticação para configurações, WhatsApp, pagamentos,
  automações, RH e convites.
- Publicar primeiro em janela controlada; observar auditoria, erros de tenant e
  filas antes de liberar novos tenants.
- Reemitir oportunidades abertas após a publicação: links antigos sem parâmetro
  de geração ficam intencionalmente inválidos e não devem ser reaproveitados.

## Critério de aceite

O sistema está apto a escalar quando os testes provarem que Tenant A não lê,
altera, dispara, cobra, envia, lista arquivo ou reutiliza capacidade do Tenant B;
que uma associação suspensa falha; e que nenhum segredo ou PII aparece em
respostas, logs ou resolvers públicos.
