# Registros operacionais, convites e origem dos leads

Publicado em 27/10/2026 pelo release oficial `20261027T143316Z-6269f48e561e`, origem `c8916503a5ba95467cf61abf6a2e98e361bb88e0`. Os três canais privados foram habilitados prospectivamente após a conferência dos participantes e das permissões.

## Pontualidade e privacidade

`private.school_operation_channels` habilita separadamente `teacher_attendance`, `student_attendance` e `lead_source`, com grupo próprio e início prospectivo. Sem configuração habilitada nada é enviado. A direção autorizou três grupos privados com os mesmos participantes do canal de Coordenação; os ids e a composição verificada ficam nas evidências reservadas, fora do Git público.

A avaliação de presença já existente chama `capture_school_meet_evidence` somente quando todas as conferências terminaram. Ela preserva a régua de consentimento/recusa, professor efetivo, entrega da sala, fim previsto e retenção. Conta confirmada do professor e e-mail exato do aluno identificam seus próprios horários. Convidado desconhecido não é presumido aluno. Sem horário confiável o registro é UNVERIFIED, sem alerta de atraso. Só relatório nativo de participação do Google; nenhum uso de participants da API para desempenho, nem extração de horário de notas da IA.

Guarda-se relatório referenciado, horário previsto, primeira entrada, atraso e status. Correções geram revisão, com prazo de até 90 dias, sem CSV nas mensagens. Limite inicial do aviso: 5 minutos. Não cria multa, desconto, falta em class_logs ou mudança de folha. Não habilita o antigo extrato de pontualidade desligado por escola. Redação sugerida de comunicação e contestação em `docs/legal/registro-de-aulas-pontualidade-e-dever-de-comunicacao.md`; nenhum contrato assinado é reescrito.

A Central de Qualidade tem a aba Registros e origens, somente direção/coordenação do tenant. Ela distingue registro técnico, ausência de identificação e estado de envio. A ausência de resposta do aluno não significa que a aula ocorreu.

## Mensagens e falhas

Outbox privada por evento/tenant. Antes do envio há claim, fonte recalculada, grupo configurado, instância central e integração revalidados e transição atômica para SUBMITTING. O teto de mensagens é consultado antes de SUBMITTING; adiamento sem POST expira o claim e permite retomada. Um resultado incerto fica UNKNOWN ou SUBMITTING e não é retomado automaticamente. ACCEPTED indica aceite do provedor, não entrega ou leitura. Falha antes de submeter pode retomar após lease. Fixtures e previews são suprimidos. Não existe backfill de mensagens antigas.

Cron a cada dois minutos chama `school-operations-notify` autenticado pela chave já existente no Vault (`wisewolf_service_role_key`). A rota interna via Kong retornou HTTP 200 em testMode depois da ativação, sem envio externo. A configuração não aceita destinatário ou corpo vindo do navegador. O serviço usa somente fontes e grupos autorizados no banco. Retenção de registros, revisões e outbox: até 90 dias.

## Professores suspensos

`teacher_opportunity_recipient_eligible` exige papel TEACHER, tenant, lifecycle ativo, status Ativo, membership ativa e escola operacional; fixtures ficam fora. Convite inicial, lembrete e aceite reconsultam essa regra. Convite em grupo foi removido: um grupo não consegue excluir somente os membros suspensos. O aceite atômico existente mantém suas guardas de agenda/ciclo de vida. Links antigos não habilitam professor suspenso.

Regularização pontual autorizada dos dois professores foi auditada, com backup e preservação dos campos assinados. Não muda os registros de folha anteriores nem transfere alunos por inferência. Grupos antigos continuam precisando de revisão de membros para privacidade, mesmo sem novos convites do sistema.

## Origem dos contatos

O banco normaliza a evidência enviada nos campos notes já autorizados da captura pública. UTMs e metadados `Origem:` são allowlisted; caminho sem query e hostname de referência, sem segredo nem identificador publicitário bruto. Canal e local de entrada são independentes: tráfego pago pode chegar ao blog. fbclid isolado não prova anúncio. Sem evidência: DIRECT_UNKNOWN ou WHATSAPP_UNKNOWN. Dados de navegador são indícios declarados do acesso, não prova de atribuição publicitária.

`public/school-origin-tracking.js` adiciona a página inicial, página do contato, referência e campanha aos formulários do institucional sem alterar os outros pedidos. Só atua no domínio público; não roda em system/app/api/hub/wolfie. Armazena metadados mínimos na sessão, sem cookies identificadores ou novo fornecedor. As landings do aplicativo usam o mesmo envelope. Os dados legados são derivados do que já estava nas notes, sem inventar origem nem enviar avisos retroativos.

Publicação do institucional: depois do release do app, `deploy/vps/publish-institutional-origin-tracker.sh` confere o SHA do asset servido, copia a versão atual inteira para uma nova release e acrescenta somente o script no início do head dos HTMLs, antes de o cliente dos formulários capturar fetch. Preserva os arquivos, configuração e conteúdo existentes; usa `/opt/wisewolf/institucional/activate-release.sh`, com validações e backup reversível. Não compila nem publica o trabalho local de outro projeto que esteja modificado.

## Validação

Migration reexecutável, registrada no release; testes SQL em transação com rollback, duas aplicações. ACLs, supressão de fixtures, imutabilidade de origem, classificação prudente, fonte alterada e impossibilidade de retomar resultado incerto. Deno: mensagem de alerta/origem e elegibilidade do professor. Vitest: captura entre páginas, ausência de segredos nos metadados e integração da Central. Todos os testes HTTP de produção usam testMode e não enviam mensagens de teste a pessoas reais.


## Conferência de publicação

Passaram 1.285 testes Vitest, 1.487 Deno e 176 suítes SQL, com migration em
execução dupla e rollback no ensaio. Sete arquivos de functions e quatro
arquivos públicos conferidos por SHA-256. RPC autenticada da direção retornou os
três canais; os dois cadastros suspensos ficaram inelegíveis, mantendo cinco
prestadores ativos elegíveis. Não se criou aula, lead ou mensagem fictícia para
testar na produção. A inspeção visual da sessão publicada ficou indisponível
nas configurações do navegador; a validação usou testes, banco e arquivos HTTP.

Institucional publicado pelo ativador oficial em `20261027T145048Z`: 3.177 HTMLs
com somente a inclusão do script e outros 477 arquivos idênticos ao backup.
Três páginas HTTP conferidas e SHA do tracker igual ao app. Avisos prospectivos;
não se deve esperar mensagens antigas nos grupos recém-criados. O guia em PDF
foi revisado visualmente e permanece em armazenamento reservado, fora do Git.
Fixtures de captação devem usar origem de preview/teste e e-mail
`@example.invalid`, para ficarem fora da fila de comunicação.
