# Blueprint multi-tenant do Wise Wolf Hub e School OS

Data da revisão: 24/08/2026.

## Decisão executiva

O produto deve ter **uma identidade de login, um catálogo comercial e uma linguagem comum de capacidades**, mas preservar **dois contêineres de dados distintos**:

1. **Hub Account**: pessoa ou equipe que compra microsoluções pedagógicas, sem receber automaticamente a operação completa de uma escola.
2. **Tenant**: escola ou professor-negócio que recebe um ambiente operacional completo, com membros, alunos, dados jurídicos, marca, domínio, integrações e isolamento de ponta a ponta.

Não devemos transformar `hub_accounts` e `tenants` em uma tabela única agora. Eles representam limites de segurança e ciclos de vida diferentes. A unificação deve acontecer no catálogo e na autorização por capacidades, não misturando os dados operacionais.

Quando um professor do Hub evoluir para Professor Negócio ou School OS, o sistema deve:

- manter o mesmo `auth.users.id`;
- provisionar um novo `tenant`;
- criar a associação `tenant_memberships` como proprietário;
- registrar a origem comercial no Hub;
- conservar a conta Hub, caso ainda exista assinatura pedagógica;
- evitar copiar dados pessoais ou materiais sem uma decisão explícita do usuário.

## Três frentes comerciais

### Hub para professores

Aquisição self-service por problema específico:

| Oferta | Resultado vendido | Preço atual | Entrega |
|---|---|---:|---|
| Descoberta | Conhecer o ecossistema | 7 dias | 5 prévias, 2 gerações IA e 3 interações Wolfie |
| Professor Essencial | Material pronto para ensinar | R$ 59/mês ou R$ 590/ano | Biblioteca completa |
| Professor Pro | Preparar aulas com mais rapidez | R$ 119/mês ou R$ 1.190/ano | Biblioteca + 40 gerações IA/mês |
| Professor Studio | Ensinar e oferecer prática assistida | R$ 169/mês ou R$ 1.690/ano | Pro + 120 gerações IA + 60 interações Wolfie/mês |
| Professor Negócio | Organizar uma operação educacional | Sob proposta | Provisionamento de tenant e implantação assistida |

`Professor Studio` é uma suíte pedagógica. Ele não deve ser chamado de SaaS escolar completo.

### Wolfie para alunos

Produto B2C separado, com página e ambiente próprios. Um aluno já vinculado a uma escola Wise Wolf deve usar os benefícios incluídos no contrato da escola, sem ser conduzido a recomprá-los.

### Wise Wolf School OS

Venda assistida para escolas e professores com operação real. A promessa inclui gestão, marca própria, domínio, equipe, alunos, contratos, cobrança, comunicação e automações. O checkout público só deve ser aberto depois dos portões de segurança e implantação descritos neste documento.

## Estado atual verificado

### Fundação já existente

- A Central da Escola já reúne identidade jurídica, branding, logo, favicon, subdomínio, domínio próprio, operação, preferências, credenciais e auditoria em `components/TenantSettings.tsx`.
- O tenant ativo é resolvido no servidor pela associação ativa; a central rejeita `tenantId`, `tenant_id` e `role` enviados pelo navegador em `supabase/functions/tenant-settings-admin/index.ts`.
- Segredos preparados ficam write-only no Supabase Vault, com apenas status e últimos quatro caracteres retornando ao cliente.
- Branding público e assinatura jurídica usam buckets e namespaces distintos.
- O Hub já possui conta, associação, plano, entitlement, checkout, uso, conteúdo e isolamento próprios.
- O ciclo de assinatura do Hub e do School OS já está separado, o que evita que a cobrança de um professor substitua acidentalmente a cobrança da plataforma escolar.

### O que ainda não está realmente ativado

- As credenciais Asaas e Evolution cadastradas pelo tenant são validadas e guardadas, mas os principais runtimes ainda leem `ASAAS_API_KEY`, `ASAAS_API_URL`, `EVOLUTION_API_KEY` e `EVOLUTION_API_URL` globais.
- A validação de domínio comprova TXT e CNAME, mas ainda não provisiona rota, certificado TLS e revalidação periódica.
- Preferências de WhatsApp/e-mail não funcionam como bloqueio global em todos os emissores.
- Logo e cores não chegam de forma consistente a todos os contratos, relatórios, PDFs e documentos impressos.
- O contexto de tenant ativo continua ligado ao usuário; para múltiplas sessões simultâneas, o alvo seguro é um contexto por sessão.

### Lacunas atuais do Hub

- O catálogo tinha itens sincronizados, mas nenhum material publicado por falta de direitos de distribuição na última QA. Não se deve comprar tráfego para a Biblioteca antes de existir acervo publicável.
- Educador IA e Wolfie verificam a presença da chave de entitlement, mas todos os planos possuem a chave, inclusive com limite zero. A interface pode mostrar um módulo que o servidor bloqueia corretamente.
- O plano Institucional ainda não tem gestão completa de equipe e assentos. Deve permanecer não público.
- Não há política completa de downgrade, cancelamento self-service, crédito ou prorrata.
- UTMs, GCLID, FBCLID e eventos anônimos das landing pages ainda não formam uma atribuição comercial confiável.
- Uma única conta pessoal pode sofrer conflito ao alternar entre audiência de professor e Wolfie independente. Essa convivência precisa ser resolvida antes de vender os dois produtos para a mesma identidade.

## Modelo canônico de produto

### Identidade e escopo

- `auth.users`: identidade humana única.
- `hub_accounts` e `hub_memberships`: escopo das microsoluções.
- `tenants` e `tenant_memberships`: escopo operacional do School OS.
- Nenhuma API recebe do cliente um tenant autoritativo. O servidor deriva o escopo pela sessão, associação ativa, host verificado ou recurso já pertencente ao escopo.

### Catálogo e capacidades

O catálogo deve usar a mesma taxonomia para Hub e School OS:

- `library.full_access`
- `educator_ai.generate`
- `wolfie.text_turn`
- `wolfie.voice_minutes`
- `academy.access`
- `crm.access`
- `scheduling.access`
- `contracts.access`
- `billing.student_collections`
- `automation.whatsapp`
- `automation.email`
- `branding.white_label`
- `domains.custom`
- `team.seats`

Uma microsolução é um SKU que ativa poucas capacidades. Um bundle ativa um conjunto cumulativo. O School OS ativa capacidades operacionais e exige um tenant. A autorização deve perguntar pela capacidade efetiva, não pelo nome textual do plano.

O modelo futuro deve convergir para:

- catálogo de produtos e preços;
- assinaturas e itens de assinatura;
- entitlements efetivos por `scope_type + scope_id`;
- limites e consumo por capacidade;
- histórico imutável de mudança de plano;
- origem da venda, campanha e intenção preservadas.

## Central do tenant

A experiência visual do MotoFix é uma boa referência para organização e implantação guiada. Devemos copiar a clareza da experiência, não o modelo de persistência.

### 1. Identidade jurídica

- nome exibido e razão social;
- CNPJ, endereço e contatos;
- responsável legal e contato LGPD;
- assinatura privada do responsável;
- validação de completude antes de emitir contrato.

### 2. Marca

- logo principal, versão reduzida, favicon e assinatura de e-mail;
- cores principal, secundária, fundo e contraste;
- preview do painel, portal, e-mail e documento;
- arquivos públicos e privados em buckets separados;
- processamento de imagem no servidor, allowlist de MIME, tamanho e dimensões.

### 3. Domínio

- subdomínio Wise Wolf reservado transacionalmente;
- domínio próprio com prova TXT e CNAME;
- estados `REQUESTED`, `DNS_VERIFIED`, `PROVISIONING`, `ACTIVE`, `ERROR` e `SUSPENDED`;
- unicidade case-insensitive no banco;
- bloqueio de hosts e sufixos reservados da plataforma;
- provisionamento de ingress e TLS somente após a prova de posse;
- revalidação periódica e remoção segura.

### 4. Asaas da escola

Existem duas cobranças que jamais podem compartilhar uma decisão de credencial:

1. **Cobrança da assinatura Wise Wolf**: Hub ou School OS cobrando o tenant. Usa exclusivamente a conta da plataforma.
2. **Cobrança dos alunos da escola**: tenant cobrando seus alunos. Usa uma conexão operacional própria.

Modos da conexão operacional:

- `PLATFORM_MANAGED_SUBACCOUNT`: subconta gerenciada pela Wise Wolf;
- `TENANT_BYOK`: chave da própria conta Asaas do tenant;
- `DISABLED`.

A chave do tenant nunca pode afetar checkout, renovação ou inadimplência da assinatura Wise Wolf.

### 5. Evolution API e WhatsApp

Modos:

- `PLATFORM_MANAGED`: servidor e chave da Wise Wolf, com instância explicitamente pertencente ao tenant;
- `TENANT_BYOK`: URL, chave e segredo de webhook do próprio tenant;
- `DISABLED`.

Para BYOK:

- guardar a API key e o segredo de webhook no Vault;
- guardar configuração pública separadamente;
- aceitar somente HTTPS;
- bloquear localhost, redes privadas, link-local, metadata endpoints e portas não permitidas;
- resolver DNS com proteção contra rebinding;
- validar a conta e registrar `last_verified_at`, `last_error_code` e saúde;
- nunca inferir ownership pelo sufixo do nome da instância;
- restringir criar, rotacionar e excluir conexão a owner/admin;
- autenticar webhook, validar timestamp, impedir replay e deduplicar eventos.

### 6. Automações e comunicação

- preferências globais por canal;
- políticas por evento e público;
- templates com branding do tenant;
- horários silenciosos e fuso do tenant;
- fila transacional, tentativas, dead letter e auditoria;
- botão de teste que usa dado fictício, nunca um cliente real.

### 7. Equipe e segurança

- owner, administrador, coordenador, professor, financeiro e aluno;
- matriz de permissões por capacidade e ação;
- sessões ativas, MFA, expiração e revogação;
- histórico de mudança de configuração sem segredos;
- reautenticação para domínio, credenciais, exclusão e exportação.

## Broker de integrações

Antes de ativar BYOK, todos os consumidores Asaas, Evolution, OpenAI e OpenRouter devem pedir a configuração efetiva a um broker server-side.

Entrada mínima do broker:

- identidade autenticada ou chamada interna assinada;
- recurso que já possui `tenant_id` ou contexto de tenant derivado da sessão;
- capacidade necessária;
- finalidade da operação.

Saída interna:

- modo `PLATFORM_MANAGED`, `PLATFORM_MANAGED_SUBACCOUNT`, `TENANT_BYOK` ou `DISABLED`;
- configuração pública validada;
- segredo desencriptado apenas durante a chamada;
- identificador da integração e versão para auditoria.

O broker deve falhar fechado se o tenant estiver inativo, a capacidade não existir, a conexão estiver doente ou a finalidade não combinar com o tipo de credencial.

## Branding em todo o produto

O runtime visual deve aplicar um `BrandContext` derivado do tenant. Documentos exigem regra adicional:

- contratos, notas, recibos e relatórios recebem um `DocumentBrandSnapshot` no momento da emissão;
- o snapshot contém nome exibido, logo referenciada por asset imutável, cores, contatos e versão;
- dados jurídicos e assinatura têm snapshot próprio e privado;
- uma troca futura de logo não altera documentos históricos;
- e-mails e WhatsApp usam a marca atual, salvo quando anexados a um documento já emitido.

Nenhum documento pode usar Wise Wolf como fallback silencioso quando o contrato promete white-label. Se a marca obrigatória estiver incompleta, a emissão deve ser bloqueada ou explicitamente marcada como co-branded conforme o plano.

## Controles obrigatórios de isolamento

1. RLS em todas as tabelas expostas e views com `security_invoker = true`.
2. `tenant_id` derivado no servidor; nunca confiado do body, query string ou metadata editável.
3. FKs compostas que impeçam relacionar aluno, professor, agenda, cobrança ou documento de tenants diferentes.
4. Funções `SECURITY DEFINER` com `search_path = ''`, allowlist explícita e `REVOKE` de `PUBLIC`.
5. Contexto ativo por sessão, não apenas por usuário.
6. Namespace e quota por tenant em todos os buckets.
7. Segredos write-only em Vault, rotação, versão, auditoria e sem resposta crua do provedor.
8. Webhooks com assinatura constante, timestamp, proteção contra replay, inbox idempotente e reconciliação.
9. Outbox para e-mail e WhatsApp; a transação de negócio não pode depender de envio síncrono.
10. Logs estruturados sem CPF, token, chave, conteúdo pedagógico privado ou resposta integral do provedor.
11. Testes A/B com dois tenants em cada fluxo crítico.
12. Estado da assinatura aplicado no servidor; esconder menu nunca substitui autorização.

## Achados de segurança desta revisão

Foram encontrados caminhos legados em que uma função financeira confiava apenas no UUID do professor ou em um papel global, além de views financeiras executadas com privilégios do dono. A correção desta revisão:

- coloca fachadas tenant-aware em `teacher_pay_projection` e `get_teacher_closing_report`;
- falha fechado quando a identidade do professor possui histórico operacional ambíguo ou mais de um tenant ativo, até que toda a folha receba `tenant_id` como chave canônica;
- bloqueia transferência de aluno para professor de outro tenant;
- revalida tenant, assinatura, lifecycle, horários, conflitos e data de corte ao aplicar a transferência;
- retira `EXECUTE` das implementações legadas;
- torna helpers financeiros/agendados internos e restringe as três views financeiras ao serviço;
- adiciona teste de regressão com dois tenants.

Arquivos:

- `supabase/migrations/20260824152421_harden_teacher_finance_tenant_scope.sql`
- `supabase/tests/teacher_finance_tenant_scope.sql`

Essa correção só estará efetiva em produção após passar pelos testes de banco e pelo processo normal de publicação.

## Estratégia de marketing

### Regra principal

Vender a dor resolvida, não uma lista de módulos.

- “Pare de perder horas procurando material” leva para `/biblioteca`.
- “Planeje aulas personalizadas em minutos” leva para `/educador-ia`.
- “Ofereça prática entre as aulas” leva para `/wolfie`.
- “Profissionalize sua carteira de alunos” leva para `/professores#professor-negocio`.
- “Opere sua escola com marca, cobrança e automação” leva para `/saas-escolar`.

### Papel das páginas

- `/hub`: mapa do ecossistema e segmentação inicial.
- `/professores`: comparação Essencial, Pro, Studio e evolução para Professor Negócio.
- `/biblioteca`, `/educador-ia` e `/wolfie`: landing pages de aquisição por dor.
- `/escolas` e `/saas-escolar`: diagnóstico e venda assistida.

### Upsell dentro do produto

- prévias esgotadas sugerem Essencial;
- uso de IA perto do limite sugere Pro ou Studio;
- necessidade de agenda, contrato, cobrança ou equipe sugere Professor Negócio;
- várias pessoas usando a mesma conta sugerem equipe ou School OS, nunca compartilhamento de senha.

## Portões de lançamento

### P0 — antes de ampliar o School OS

- publicar e validar a correção de escopo financeiro desta revisão;
- concluir broker tenant-aware e separar cobrança da plataforma da cobrança dos alunos;
- ativar Evolution/Asaas do tenant somente por conexão explicitamente selecionada;
- migrar contexto ativo para sessão;
- provisionar domínio e TLS com estado, unicidade e revalidação;
- corrigir gating visual com limite zero;
- manter plano Institucional oculto;
- publicar somente materiais com direito de distribuição registrado;
- executar testes reais de dois tenants em banco e navegador.

### P1 — experiência white-label completa

- propagar branding para todos os documentos, e-mails e templates;
- adicionar preview e checklist de implantação no padrão de clareza do MotoFix;
- disponibilizar teste de conexão, rotação e desconexão segura;
- tornar preferências de comunicação efetivas em todos os emissores;
- padronizar capacidades do Hub e School OS.

### P2 — escala comercial

- gestão self-service de equipe e assentos;
- cancelamento, downgrade agendado, crédito e prorrata;
- atribuição de campanha e eventos de funil;
- expansão orientada por consumo e necessidade operacional;
- catálogo de add-ons somente quando billing e entitlement suportarem composição sem ambiguidade.

## Critérios de aceite

Uma versão pode ser chamada de multi-tenant pronta para venda somente se os seguintes testes passarem:

1. Admin A não lê, altera, exporta nem dispara automação para recurso do tenant B.
2. Professor A não usa UUID, URL, slug, storage path ou RPC para acessar dados do professor B.
3. Logo A nunca aparece no tenant B; documentos antigos preservam o snapshot correto.
4. Credencial Asaas A nunca cobra assinatura Wise Wolf nem cliente do tenant B.
5. Instância Evolution A não envia nem recebe por número, webhook ou instância do tenant B.
6. Domínio A não pode ser reservado, verificado ou provisionado para B, inclusive sob concorrência.
7. Suspender assinatura remove capacidades no servidor sem apagar dados e sem depender da interface.
8. Reativar assinatura restaura apenas as capacidades contratadas.
9. Webhook repetido, atrasado ou fora de ordem não duplica cobrança, matrícula, acesso ou mensagem.
10. Backups, exportações, observabilidade e suporte seguem o mesmo limite de tenant.

## O que aproveitar do MotoFix

Aproveitar:

- configuração por cartões e seções;
- checklist de implantação;
- previews de marca;
- badges de saúde e último teste;
- guias passo a passo de DNS e Asaas;
- segredo mascarado e ações separadas de atualizar/desconectar.

Não copiar:

- filtragem apenas em memória sem RLS;
- Evolution global tratado como se fosse instância própria;
- domínio sem unicidade transacional;
- leads públicos sem tenant resolvido pelo host;
- segredos em texto ou JSON editável em massa;
- sucesso otimista antes de o servidor confirmar persistência;
- arquivos privados no mesmo espaço público de logos.
