# Aulas conectadas ao Google Meet — implantação e custos

Consulta de preços e documentação: 10/09/2026. Projeção: 7 professores agora e **12 no total** no fim do ano. Nenhuma assinatura foi contratada por esta implementação.

## Revisão: uma única conta organizadora da escola

Uma licença por professor **não foi demonstrada como exigência técnica universal**. O orçamento abaixo corresponde ao modelo individual originalmente implementado, não a uma obrigação de contratar sete ou doze licenças.

Alternativa de menor custo a validar: uma conta Workspace Business Standard da escola cria as reuniões; os professores entram com seus Gmail pessoais, cadastrados como coanfitriões nas respectivas aulas. A autorização OAuth e os arquivos ficam na conta organizadora; o acesso a cada aluno continua restrito no sistema. A senha dessa conta não é entregue aos professores.

O Google documenta coanfitriões no Standard, inclusive permissões para pessoas externas, e permite que anfitrião ou coanfitrião iniciem transcrições com gerenciamento de anfitrião ativo. A transcrição automática aguarda a entrada de anfitrião/coanfitrião pela web. Isso fundamenta um piloto centralizado, mas não é uma garantia de sete ou doze transcrições simultâneas. Não encontramos uma garantia oficial contratual de capacidade simultânea para esse cenário.

Antes de ampliar, validar com **uma licença flexível de R$ 98/mês**: dois professores externos em duas reuniões simultâneas, conta organizadora ausente, admissão do aluno, início da transcrição e importação dos dois textos na conta da escola. Aumentar depois para a concorrência máxima real. Confirmar também com o suporte Google a adequação da assinatura à operação centralizada da escola.

Coanfitriões podem ser pré-configurados pela interface do Google Calendar. Sua criação automática via `spaces.members` ainda consta como Developer Preview (`v2beta`); portanto não presumir acesso liberado nem usar esse endpoint como dependência de produção sem habilitação. O piloto pode usar configuração manual.

**Estado do código:** a implementação desta tarefa ainda usa conexão individual por professor. O modelo central exige separar a conta organizadora do professor responsável, autorizar a conexão pela direção e registrar a configuração de coanfitrião por sala. Não basta reutilizar o token de um professor para os demais. A mudança precisa manter a identificação explícita dos falantes: com o organizador ausente, ele não pode ser usado para identificar quem é o professor.

Fontes: [coanfitriões](https://support.google.com/meet/answer/10885841?hl=en), [transcrição e entrada do coanfitrião](https://support.google.com/meet/answer/12849897?hl=en), [API de membros em acesso antecipado](https://developers.google.com/workspace/meet/api/guides/meeting-spaces-configuration).

## Orçamento do modelo individual

No modelo individual: Google Workspace **Business Standard**, conta individual da escola para cada professor organizador. Alunos entram como convidados e não precisam de licença Workspace. A senha não é compartilhada. O login da Wise Wolf continua sendo o atual; cada professor autoriza sua conta Google uma vez em **Links de Aula → Aulas conectadas**.

| Professores organizadores | Standard com compromisso anual, mensal | Standard flexível, mensal |
| --- | ---: | ---: |
| Piloto: 1 | R$ 81,80 | R$ 98,00 |
| Atual: 7 | R$ 572,60 | R$ 686,00 |
| Projeção: 12 | R$ 981,60 | R$ 1.176,00 |

Preço de tabela por usuário: R$ 81,80/mês com compromisso de um ano ou R$ 98/mês sem compromisso anual. No anual, o total de um ano com sete licenças constantes é R$ 6.871,20; com doze constantes, R$ 11.779,20. Contratações ao longo do período mudam o total. Se forem **12 contratações adicionais**, serão 19 contas: R$ 1.554,20/mês no anual ou R$ 1.862/mês no flexível. O checkout e eventual proposta de revendedor prevalecem sobre estas projeções.

Fonte: [tabela oficial de faturamento do Google](https://knowledge.workspace.google.com/admin/billing/compare-flexible-and-annual-fixed-term-payment-plans?hl=pt-br).

Para validar qualidade de transcrição em aulas que alternam português e inglês, começar com **uma licença flexível por R$ 98/mês**. Confirmar transcrição, autorização da API, importação e revisão em aula de teste antes de comprar sete ou doze. Depois do piloto, avaliar o compromisso anual para a equipe estável; ele exige compromisso de pagamento e não permite reduzir livremente as licenças contratadas durante o período.

### Google AI Pro resolve?

Google AI Pro de conta pessoal inclui alguns recursos premium, inclusive gravação e “Take notes for me” conforme a comparação atual. **Notas resumidas não equivalem à transcrição completa atribuída a participantes.** A página específica de transcrições lista Business Standard/Plus, algumas edições Enterprise/Education e Workspace Individual; não lista Google AI Pro pessoal. Portanto, esta implementação não pressupõe que Google AI Pro libere a transcrição necessária. Para gestão de sete a doze professores, contas corporativas individuais também permitem administração e desligamento centralizados.

Fontes: [comparação de recursos premium](https://support.google.com/google-workspace-individual/answer/10459644?hl=en), [edições com transcrição](https://support.google.com/meet/answer/12849897?hl=pt-BR).

### Outros custos

- **Meet REST API:** uso padrão sem custo adicional, sujeito a cotas. O Google informa cobrança futura de excesso de cotas ainda em 2026; conferir antes de aumentar o volume. [Cotas e preços](https://developers.google.com/workspace/meet/api/guides/limits).
- **Análise pedagógica:** usa o OpenRouter já adotado no projeto; conta pessoal de Gemini/Google Pro não paga essa API. Modelo inicial `openai/gpt-4o-mini`: US$ 0,15/milhão de tokens de entrada e US$ 0,60/milhão de saída. Exemplo ilustrativo: 8.000 tokens de entrada + 1.500 de saída = **US$ 0,0021/aula**, ou US$ 2,10 para mil aulas. Não inclui taxas do provedor, câmbio, tributos, reprocessamentos ou gerações futuras do planejador. [Preço do modelo](https://openrouter.ai/openai/gpt-4o-mini).
- **Servidor e banco:** reaproveita a VPS/Supabase existentes; não exige servidor de videoconferência, gravação nem GPU. Não foi feita medição de capacidade da VPS nesta tarefa: custo incremental de servidor é zero **somente enquanto couber na capacidade disponível**.
- **Armazenamento:** vídeo permanece fora do processamento. Um orçamento de 100–400 KB por transcrição daria 0,1–0,4 GB por mil aulas, antes de índices e backups. O texto bruto importado expira em 30 dias; memórias revisadas são preservadas. Os arquivos originais do Google Drive têm ciclo de vida independente.
- **Domínio:** pode usar um domínio que a escola já possui, após verificar sua propriedade. Registro/renovação depende do domínio e registrador. Não estimamos um valor sem saber qual domínio será usado.

Fórmula: licenças dos professores + consumo de IA + eventual capacidade adicional de VPS/backup + domínio. Evitar vídeo e uma segunda transcrição paga é a economia principal.

## O que está implementado

1. Conexão OAuth por professor, vinculada ao tenant e ao perfil autenticado. Tokens de renovação criptografados, sem leitura por usuários da API pública.
2. Sala real do Google por agendamento regular ativo. Criação solicita transcrição automática e desliga gravação de vídeo. Criação com resultado incerto fica em conferência, sem repetir automaticamente e criar salas órfãs.
3. Botões do professor e aluno na Central de Acessos. O professor conecta a conta, cria a sala e acessa histórico e revisão. O aluno só recebe links das salas dos agendamentos atuais.
4. Importação paginada de transcrições finalizadas, individualizadas por recurso Google e sem duplicação. Consulta manual e worker periódico a cada cinco minutos, se o ambiente possui pg_cron/pg_net/vault.
5. Identificação do participante aluno pelo professor antes da análise. A fala do professor não serve como evidência biográfica do aluno. Contas/dispositivos compartilhados precisam ser conferidos; nomes de exibição não são identidade suficiente.
6. Proposta pedagógica com evidências literais: interesses declarados, contexto profissional, conteúdo, vocabulário, dificuldades, pontos fortes, preparação do professor, próxima aula e sugestões ao outro teacher.
7. Aprovação/rejeição pelo professor responsável. Só a aprovação cria uma memória VERIFIED, de forma atômica. O planejador já autorizado para aquele aluno recebe os dados estruturados nos modos de aula e teste oral. Não se grava um perfil psicológico ou pontuação de pronúncia a partir do texto.
8. Expiração dos textos brutos após 30 dias. O resumo e os trechos de evidência aprovados continuam na memória pedagógica. Para excluir todo o histórico, também é necessário excluir essas memórias, a proposta e, conforme a política da escola, o original do Drive.

### O que não foi afirmado como pronto

- A chamada abre no Google Meet. Não há iframe de vídeo embutido: o SDK público de add-ons coloca **a plataforma no Meet**, e não automaticamente o Meet dentro da plataforma. A referência REST menciona Meet Embed SDK, mas não encontramos documentação pública de acesso suficiente para entregar essa experiência como disponível para esta conta. [Opções de integração](https://developers.google.com/workspace/meet/overview).
- Transcrição só começa se o Google permitir e entrar alguém com privilégio para transcrever. Criar a sala e marcar ON não prova que a transcrição está rodando. O professor deve conferir o indicador do Meet no piloto. [Configuração oficial](https://developers.google.com/workspace/meet/api/guides/meeting-spaces-configuration).
- A integração inicial cobre **agendamentos regulares individuais ativos**. Reposições, coberturas e experimentais ainda usam seus fluxos existentes; a implantação desses caminhos exige mapear suas permissões e ocorrências separadamente.
- Professor substituto/testador só recebe memória pelo planejador quando já possui o vínculo autorizado nesse sistema; não se abriu acesso geral a todo perfil de aluno.
- Não há atribuição automática de licença nem login compartilhado da escola. Cada docente organizador utiliza sua identidade Google.
- Não há teste real de OAuth, reunião ou transcrição sem uma conta elegível autorizada e um projeto Google configurado.

## Configuração para ativar

1. Contratar o piloto Workspace Standard e verificar o domínio escolhido. Criar conta individual para o professor piloto. Não compartilhar senha.
2. Em um projeto Google Cloud da escola, habilitar **Google Meet REST API**. Configurar a tela de consentimento OAuth e um cliente do tipo **Web application**. Para a mesma organização Workspace, preferir aplicação interna; se houver contas externas, configurar publicação/verificação exigida pelo Google. Modo de teste externo tem restrições e expiração de autorizações: não usar como operação definitiva.
3. Registrar como redirect URI exato: `https://api.wisewolflanguage.com.br/functions/v1/google-meet`. O callback não usa cookies, apenas estado aleatório de uso único com expiração. Configurar proxy para não registrar query strings do callback, que contêm código OAuth de uso único; nunca persistir tokens em logs.
4. Configurar no runtime privado, sem colocar valores em frontend, Git ou mensagens:
   - `GOOGLE_MEET_ENABLED_TENANTS=school-wise-wolf` (lista de escolas autorizadas ao piloto);
   - `GOOGLE_MEET_CLIENT_ID`;
   - `GOOGLE_MEET_CLIENT_SECRET`;
   - `GOOGLE_MEET_REDIRECT_URI`;
   - `GOOGLE_MEET_TOKEN_KEY`: chave aleatória de 32 bytes codificada em Base64, exclusiva para criptografia; guardar cópia segura para recuperação. Não trocar sem migrar os tokens;
   - `GOOGLE_MEET_ALLOWED_DOMAINS`: domínio Workspace confirmado, sem `@`; enquanto vazio aceita outras contas Google elegíveis, útil só para piloto deliberado;
   - `GOOGLE_MEET_ANALYSIS_MODEL=openai/gpt-4o-mini`;
   - `OPENROUTER_API_KEY` já usado pelo projeto.
5. Publicar a migration `20260910014514_google_meet_learning_integration.sql`, a função `google-meet`, a função `lesson-planner` alterada e o frontend. A função usa `verify_jwt=false` para receber callback público, mas todas as operações autenticadas são verificadas no próprio servidor.
6. Confirmar as permissões OAuth: `openid`, `email`, `meetings.space.created`, `meetings.space.readonly`, `meetings.space.settings`. A conta organizadora autoriza; a integração não recebe senha. [Autorização Meet](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize).
7. Verificar pg_cron, pg_net e o segredo existente `wisewolf_service_role_key` no Vault. Sem essas extensões, configurar o scheduler existente para POST autenticado `{"action":"worker"}` na função a cada cinco minutos. Não usar uma automação de conversa do Codex como scheduler de produção.
8. No perfil do professor piloto → Links de Aula, conectar a conta licenciada. Criar sala de um agendamento isolado de teste, com transparência e autorização dos participantes. Entrar com essa mesma conta, confirmar transcrição, falar exemplos fictícios em português e inglês e encerrar. Nunca usar teste para enviar mensagens a alunos reais.
9. Buscar transcrições, confirmar o participante, revisar a análise e aprovar. Conferir no planejador e no teste oral do mesmo aluno. Testar que outro aluno/tenant não vê a memória. Não publicar isso como disponível para todos antes desse teste.

### Recuperação e desligamento

- “Desconectar” tenta revogar a autorização no Google e remove o token local; não apaga aulas e memórias existentes. O usuário também pode remover o acesso pela conta Google.
- `CREATING`/`REVIEW` de sala: resultado da criação pode ser incerto. Um operador confere a conta organizadora e o histórico antes de reconciliar `space_name`/`meeting_uri` ou liberar nova tentativa. Não repetir POST automaticamente.
- `ANALYZING` prolongado: a chamada pode ter sido cobrada. Conferir o provedor e a proposta antes de permitir nova análise; não redefinir automaticamente a cada retry.
- Desativar `GOOGLE_MEET_ENABLED_TENANTS` impede novas operações Google. Os links antigos da aplicação permanecem disponíveis. Não desfazer a migration apagando transcrições reais como rollback; manter dados e reverter apenas a interface/runtime quando necessário.
