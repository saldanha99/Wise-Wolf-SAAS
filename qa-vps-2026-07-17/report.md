# Relatório E2E final — migração Wise Wolf para a VPS

| Campo | Resultado |
|---|---|
| Data da validação | 18/07/2026 — America/Sao_Paulo |
| VPS | `187.127.46.251` |
| Resultado técnico | **Corte DNS, migração histórica e fluxos operacionais aprovados; encerramento condicional** |
| Condições restantes antes do encerramento definitivo | Congelar o Supabase antigo e rotacionar credenciais historicamente expostas |
| Efeitos externos evitados | Nenhuma cobrança real e nenhuma mensagem de teste enviada a clientes |

## Resumo executivo

O site institucional, o aplicativo, a API e o banco da VPS estão funcionais. As falhas encontradas durante a homologação foram corrigidas e publicadas, incluindo autenticação/sessão, exposição de credencial no navegador, isolamento por tenant, upload privado de currículos, travessia de caminhos, notificações duplicadas e a consulta inválida do painel.

O corte web está concluído e foi confirmado nos dois servidores autoritativos da Cloudflare e nos resolvedores públicos 1.1.1.1, 8.8.8.8 e 9.9.9.9:

- `wisewolflanguage.com.br`, `www`, `app`, `api` e `system` → `187.127.46.251`.
- O CNAME antigo de `system` para a Vercel não é mais publicado.
- Não existe registro AAAA divergente para `system`.

Após a propagação, o roteador HTTPS foi reiniciado de forma controlada e a Let's Encrypt validou o desafio HTTP-01. O certificado ativo cobre `app.wisewolflanguage.com.br` e `system.wisewolflanguage.com.br`, com validade até 16/10/2026. O fluxo real no novo domínio passou por login, carregamento do painel, atualização com restauração da sessão e logout persistente, sem erro de página ou requisição 4xx/5xx no painel.

A integridade da migração também foi comparada diretamente entre o Postgres hospedado antigo e o Postgres da VPS. As 137 tabelas de negócio existem nos dois lados: 12.635 linhas históricas coincidem por contagem e hash, e a VPS possui somente três linhas adicionais de auditoria geradas depois do corte. Os 80 usuários, as 80 identidades e as credenciais de autenticação coincidem. Os 181 objetos do Storage, totalizando 584.569.110 bytes, foram confirmados por identidade, tamanho e hash de conteúdo.

Durante esta auditoria foi detectado que os webhooks de Asaas e Evolution ainda estavam cadastrados no Supabase antigo. Ambos foram corrigidos nos provedores e agora apontam para `api.wisewolflanguage.com.br`; os destinos antigos deixaram de constar nesses fluxos. A origem antiga permanece online e tecnicamente gravável como fallback, portanto o bloqueio absoluto de qualquer escrita fora da VPS só existirá depois que esse projeto for congelado ou pausado.

## Matriz de validação

| Jornada/verificação | Resultado | Evidência |
|---|---|---|
| Site raiz e `www` na VPS | **Passou** | HTTP 200 e TLS válido até 15/10/2026 |
| Aplicativo `app` na VPS | **Passou** | HTTP 200, build de produção ativo e TLS válido |
| API/Supabase | **Passou** | Auth e todos os contêineres centrais saudáveis |
| Dados históricos do schema `public` | **Passou** | 137 tabelas; 12.635 linhas coincidentes por contagem e hash; três logs adicionais somente na VPS |
| Usuários e identidades de autenticação | **Passou** | 80 usuários e 80 identidades; hashes de ID, e-mail e credencial coincidentes |
| Storage | **Passou** | 181 objetos e 584.569.110 bytes; conteúdo confirmado por ETag ou SHA-256 |
| Atividade residual na origem | **Passou** | Nenhuma criação/atualização no `public` após o dump final; 21 crons antigos desativados |
| Destinos Asaas e Evolution | **Passou após correção** | Ambos os provedores apontam para as Edge Functions da VPS e não para o Supabase antigo |
| Login inválido | **Passou** | Feedback visível e acessível, sem vazar detalhes |
| Login válido de diretor | **Passou** | Token 200 e dashboard carregado |
| Restauração da sessão | **Passou** | Dashboard permaneceu autenticado após refresh |
| Logout | **Passou** | API respondeu 204 e a sessão local foi removida |
| Painel financeiro | **Passou** | Consulta de alunos respondeu 200; referência inexistente a `modality` removida |
| Contrato do aluno | **Passou na compilação** | Campo corrigido para `fidelity_plan` |
| Site institucional desktop | **Passou** | Sem erros de página ou referência ao Supabase antigo |
| Site institucional mobile 390×844 | **Passou** | Sem overflow horizontal |
| Sitemap e arquivos estáticos | **Passou** | 2.027 URLs válidas; arquivos ocultos e PDF inexistente retornam 404 |
| Formulário “Trabalhe Conosco” | **Passou** | Wizard abriu e avançou; backend de upload testado separadamente |
| Upload público de currículo | **Passou** | URL assinada, upload, leitura anônima bloqueada, leitura administrativa e limpeza |
| RLS de leads/candidaturas | **Passou** | Anônimo, aluno, administrador e superadmin testados em transação com rollback |
| Isolamento de currículos | **Passou** | Aluno e admin de outro tenant bloqueados; admin do tenant permitido |
| Travessia de caminho | **Passou** | 3 testes unitários; variantes simples, codificadas e duplamente codificadas bloqueadas |
| Funções de WhatsApp | **Passou em segurança** | Chamadas anônimas retornam 401; payloads são carregados no servidor |
| Evolution/WhatsApp | **Passou em leitura** | Instância principal respondeu HTTP 200, estado `open`; nenhuma mensagem real enviada |
| Pagamentos/Asaas | **Passou em autenticação/validação** | Nenhuma cobrança real foi criada durante a homologação |
| `system` público na VPS | **Passou** | DNS público na VPS, HTTP 301, HTTPS estrito 200 e certificado válido com SAN de `system` |

## Correções publicadas

1. Regra de host adicionada para `app` e `system`, com fallback de SPA no Nginx.
2. Auth apontado para a API da VPS; login, mensagem de erro, restauração de sessão e logout corrigidos.
3. Credenciais da Evolution removidas dos bundles e operações administrativas movidas para proxy autenticado no servidor.
4. Escritas de perfil sensíveis protegidas contra alteração de papel, tenant e campos financeiros.
5. Leads e candidaturas isolados por tenant; leitura de PII por aluno e acesso cruzado foram bloqueados.
6. Formulários públicos limitados por origem, tamanho, formato, tenant e quota durável por IP.
7. Bucket `resumes` tornado privado, com limite de 10 MB e allowlist PDF/DOC/DOCX.
8. Upload público migrado para URL assinada; upload direto por aluno ou anônimo foi bloqueado.
9. Caminhos de currículo canonicalizados antes de qualquer download com `service_role`, impedindo acesso a `contracts`, `invoices` ou outro tenant.
10. Notificações de CRM e RH tornadas server-only e idempotentes; dados são buscados pelo UUID no banco.
11. Site institucional migrado para um único cliente Supabase da VPS e removido o segredo Gemini do bundle.
12. Consulta inválida `profiles.modality` removida; painel agora mostra receita recebida e MRR contratado.
13. Scripts locais de diagnóstico deixaram de conter a chave pública antiga e agora usam variáveis de ambiente.
14. `sitemap.xml` passou a ser gerado no build com rotas canônicas e termos publicados; o Nginx deixou de transformar arquivos inexistentes em soft-404 da SPA.
15. Webhooks de Asaas e Evolution foram corrigidos diretamente nos provedores para as Edge Functions da VPS.

## Segurança e testes automatizados

- `npm run typecheck`: passou no aplicativo.
- `npx tsc --noEmit`: passou no institucional.
- Build de produção dos dois frontends: passou.
- `deno check` das funções alteradas: passou.
- Testes do parser de currículo: **3 passaram, 0 falharam**.
- Suite SQL `public_intake_rls.sql`: passou diretamente e é autocontida com `BEGIN/ROLLBACK`.
- Varredura de JWT literal no código atual: passou.
- Varredura dos bundles: sem projeto Supabase antigo, chave Evolution ou segredo Gemini.
- Sitemap XML validado: **2.027 URLs**, sendo 2.010 termos publicados do glossário.
- Contêineres `db`, `auth`, `rest`, `kong`, `storage` e `edge-functions`: saudáveis, sem restart ou OOM.

Builds ativos:

| Artefato | SHA-256 |
|---|---|
| Aplicativo — `index.html` | `f6d90a7063efe0a8930fd47260ece18a3a1883703416cd3bb1cddebcd32222e3` |
| Institucional — `index.html` | `bb161245fa19611ec645863ce713dfc546ec91a4f8ac5eaaf0eb57de18c5c507` |
| Institucional — `sitemap.xml` | `9cf98a5f26f0a078210797c152102eea67950b90d71f977bd682c2a2176ba21c` |

## Condições obrigatórias restantes antes do encerramento definitivo

### Congelar o Supabase antigo

- Os sites, builds ativos, Edge Functions, funções SQL, dados persistidos, crons, DNS e webhooks operacionais não possuem referência ativa ao projeto antigo.
- Mesmo assim, o projeto hospedado antigo continua online, com permissões de escrita protegidas por RLS. Uma chamada direta com credenciais antigas ainda pode alcançar essa origem.
- Após a janela de observação/rollback, pausar o projeto antigo ou colocá-lo em modo somente leitura. Até essa ação, a garantia vale para todos os fluxos operacionais conhecidos, mas não para chamadas diretas ao endereço antigo.

### Rotacionar credenciais historicamente expostas

- Rotacionar a chave global da Evolution no provedor e atualizar o segredo da VPS.
- Revogar/rotacionar quaisquer tokens `service_role` antigos que tenham aparecido no repositório ou em backups anteriores.
- Limpar o histórico Git em uma operação coordenada, pois isso reescreve commits e exige alinhamento da equipe.
- Recriar as Edge Functions e repetir o teste read-only da instância após a rotação.

A chave Evolution atual funciona e não está mais no bundle, mas deve ser considerada comprometida porque já foi publicada anteriormente.

## Riscos residuais não bloqueantes

- Os formulários possuem quota por IP e validações rígidas, mas ainda não usam Turnstile/CAPTCHA. Recomenda-se adicioná-lo como defesa adicional contra abuso distribuído.
- Há um aviso visual do Recharts durante a montagem inicial de um gráfico; não causou falha funcional nem requisição 4xx/5xx.
- Não foi feita cobrança real nem envio de mensagem real. Após a rotação das credenciais, recomenda-se um smoke test com número e conta de sandbox controlados.
- O wildcard `*.wisewolflanguage.com.br` ainda aponta para a Vercel; subdomínios não declarados continuam sendo enviados para lá. Remover somente se a migração de todos os subdomínios for intencional.
- Registros legados de `mail`, `ftp`, CalDAV/CardDAV, cPanel e `blog` ainda apontam para destinos antigos ou incompatíveis com a nova VPS. Eles não afetam o site nem o sistema, mas precisam de uma revisão separada antes de desativar a hospedagem antiga.
- Sessões e refresh tokens do Auth antigo não foram migrados de propósito. Usuários e senhas foram preservados, mas uma sessão antiga precisa autenticar novamente na VPS.

## Evidências e rollback

Evidências visuais:

- `screenshots/final-app-dashboard-vps.png`
- `screenshots/final-root-vps-supabase.png`
- `screenshots/final-root-mobile-vps.png`
- `screenshots/final-invalid-login-feedback.png`
- `screenshots/final-session-restored-after-refresh.png`
- `screenshots/final-whatsapp-connection-safe.png`
- `screenshots/system-after-dns-login.png`
- `screenshots/system-after-dns-dashboard.png`
- `screenshots/system-after-dns-session-restored.png`
- `screenshots/system-after-dns-logout.png`

Backups na VPS:

- `/opt/wisewolf/backups/public-intake-20260718T035220Z`
- `/opt/wisewolf/backups/panel-fix-20260718T035910Z`
- `/opt/wisewolf/backups/resume-path-20260718T041000Z`
- `/opt/wisewolf/backups/institutional-seo-20260718T042202Z`
- `/opt/wisewolf/institucional/src/dist.previous-20260718T035512Z`

## Decisão

**Os dados históricos foram integralmente validados na VPS e todos os fluxos operacionais conhecidos agora gravam nela, inclusive Asaas e Evolution. A aplicação pode operar na VPS. Para transformar essa garantia operacional em bloqueio absoluto contra qualquer gravação na origem, ainda é necessário congelar/pausar o Supabase antigo; a rotação das credenciais históricas continua obrigatória para o encerramento de segurança.**
