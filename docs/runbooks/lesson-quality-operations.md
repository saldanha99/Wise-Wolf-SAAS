# Operação de qualidade das aulas

Implementação de 12/09/2026. Complementa o [plano de auditoria](../audits/2026-09-12-plano-qualidade-aulas-meet.md) e o [runbook Google](google-meet-pedagogical-documentation.md).

## Onde operar

Na navegação da escola: **Qualidade das aulas** contém Acompanhamento, Aceites de horário, Contatos verificados, Salas e continuidade e Conta central Google. O papel `COORDINATOR` tem navegação restrita à qualidade, sem financeiro ou gestão das credenciais Google. Não foram criados colaboradores nem modificados papéis reais.

O professor encontra **Salas e continuidade** e o dossiê na ficha do aluno. Professores atuais e destinatários de transferência pendente/aceita têm acesso pedagógico autenticado; o link público de transferência não expõe o dossiê. A confirmação de leitura salva uma cópia do conteúdo consultado, com autor e data.

## Lançamento e antecipação

- Nenhuma linha começa marcada como aula concluída. O professor escolhe as ocorrências que efetivamente deseja lançar.
- Aula concluída exige objetivo, conteúdo trabalhado, dificuldades observadas, tarefa e próximo passo. Quando não houve dificuldade ou tarefa, isso deve ser declarado; um plano sugerido nunca é preenchido como conteúdo realizado.
- O servidor impede lançamento de conclusão antes do fim e exige justificativa quando o lançamento for tardio, conforme a regra exibida no formulário.
- A conclusão remunerável de aula experimental também aguarda o fim: a antiga exceção de superadministrador não pode criar novos lançamentos futuros. Repetições exatas de comandos históricos já concluídos preservam a idempotência.
- Cada item do lote tem resultado próprio. Erros em uma aula não escondem as aulas salvas; repetição não paga novamente.
- Antecipação consome a ocorrência futura e remunera na data real. O horário autorizado de antecipação prevalece sobre o horário semanal original, inclusive na auditoria independente.
- Limitação explícita da identidade financeira legada: não se podem lançar duas ocorrências financeiras do mesmo booking na mesma data real. A criação da antecipação rejeita esse choque, sem esconder a aula regular.

## Contato independente e remarcação

1. Professor solicita alteração de contato; a escola confere identidade e vínculo e aprova com justificativa. Um responsável pode estar vinculado a mais de um filho.
2. O envio de auditoria prefere o contato verificado. O cadastro legado é fallback sinalizado como não verificado, para não interromper a operação durante a migração.
3. Docentes não conseguem alterar diretamente o destinatário da auditoria, a sala oficial ou a agenda. Apagar/recriar booking não contorna essa proteção. Pausas que impliquem cancelar agenda precisam da escola.
4. Mudança de horário exige proposta com motivo, iniciador informado, vigência e escopo pontual/permanente. A família aceita pelo link; a escola revisa e aplica. O aceite, sozinho, não muda a agenda.
5. O botão **Enviar aceite** usa a fila central e revalida contato, token, conteúdo e estado antes de enviar. Copiar link permanece como alternativa. Fixtures são suprimidas.
6. O histórico de vigência preserva os horários antigos. Alteração pontual exclui a ocorrência de origem e retorna à grade habitual depois.

Contatos revogados invalidam os links vinculados às novas entregas. Links antigos sem vínculo de destinatário mantêm a compatibilidade e continuam classificados como não verificados.

## Retorno e apuração

O responsável pode registrar presença pelo fluxo existente e, separadamente, informar atraso, término antecipado, pedido de mudança e comentário. **Não acompanhei** não confirma presença, falta ou satisfação.

No WhatsApp, responder à mensagem da aula com 1/2/3 registra retorno de qualidade. Relatos textuais explícitos também podem ser vinculados a uma auditoria recente de contato verificado. O servidor confere escola, instância, destinatário atual e identificação da mensagem. Se houver ambiguidade, solicita contexto; nunca escolhe um filho/aula arbitrariamente. Essa resposta não altera a folha.

A Central mostra sessões previstas, auditorias criadas, enviadas, entregues, lidas, retornos, falhas e lançamentos pendentes. Recibos de leitura dependem do provedor e das configurações do destinatário. Ausência de resposta não é aprovação. Os indicadores têm denominadores diferentes: uma sessão pedagógica pode agrupar vários blocos financeiros.

Casos permitem atribuir responsável, registrar análise, aguardar retorno, resolver e acompanhar. Relatos, correções e decisões permanecem no histórico. Casos com correção de relato não desaparecem automaticamente. O job `wisewolf-lesson-quality-queue` materializa sessões e abre casos de falta de lançamento há mais de 24 horas e falha/incerteza de entrega. Os alertas não enviam penalizações nem modificam pagamento.

## Salas, documentação e troca de professor

Uma sessão com evidência não muda de professor/horário silenciosamente quando um booking muda. A escola pode **Replanejar sessão futura**, com motivo, somente antes do início e sem auditoria, lançamento ou documentação revisada. A sessão antiga e sua sala são arquivadas; novas ocorrências exigem nova autorização documental.

**Arquivar não revoga o link externo no Google.** A escola deve orientar os participantes a usar apenas a nova sala e tratar a sala antiga no Google quando necessário. O sistema deixa de oferecê-la e de processá-la automaticamente.

O Google é destinado a documentação e continuidade pedagógica. Não há coleta de entradas/saídas, cálculo de atraso pelo Meet, ranking automático de professores ou efeito financeiro de um resumo de IA. A restrição de uso da API foi preservada, não contornada pelo Gmail pessoal do professor.

Configuração Google permanece desativada por padrão. É preciso conectar conta elegível, registrar autorização documental e validar um piloto, incluindo professor externo como coanfitrião, entrada pela web, aulas simultâneas e documentos. AI Pro não foi tratado como substituto garantido de uma licença organizacional. Gemini API adicional é opt-in e cobra separadamente, com estimativa e confirmação.

As notas importadas são rascunhos. Revisão humana gera nova versão; apenas uma versão verificada alimenta a memória do aluno. Revogação documental impede novas coletas; retenção das cópias brutas e configuração/artefatos no Google devem ser geridos conforme o runbook específico.

## Verificação e implantação

- Quatro migrações novas incluídas no pipeline oficial, com testes SQL transacionais, RLS, reexecução, interfaces e funções.
- Banco QA criado somente com schema, sem copiar dados reais; testes usam fixtures isoladas e rollback. Cron/Vault são verificados no ambiente de release, não fingidos no QA.
- QA móvel com backend simulado verificou formulário, falha/retry e aceite. Contraste foi corrigido.
- Pixel de marketing restrito às campanhas públicas do domínio da plataforma; não carrega em páginas operacionais, links com token, localhost ou domínio de outra escola. Referrer da aplicação é suprimido.
- Nenhuma conta Google, chamada paga de IA, mensagem real de teste, folha ou cadastro real foi alterado durante o desenvolvimento.

Depois do deploy, conferir abas, jobs e falhas de entrega. Cadastrar/verificar os contatos prioritários e conectar a conta Google apenas após o piloto. Não ativar a documentação automaticamente para todos os alunos nem preencher retroativamente evidência que nunca foi coletada.
