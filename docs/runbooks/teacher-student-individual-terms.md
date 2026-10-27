# Termo individual por aluno

Implementação solicitada em 27/10/2026. A ativação é prospectiva por escola,
separada da aplicação da migration. Confirmar publicação antes de declarar ativa.

## Partes e manifestação

O aluno mantém o contrato com a escola. O instrumento individual é escola-PJ,
com o aluno como beneficiário, e texto integral da versão 1 em
`docs/legal/termo-individual-professor-aluno-v1.md`. Cada ocorrência da grade é
uma unidade de 30 minutos; unidades consecutivas compõem aulas de maior duração.
O quadro identifica aluno, empresa/representante, escola, vigência, grade,
referência da fonte, remuneração reservada e contrato geral efetivamente assinado.
O termo não reescreve vias gerais anteriores, não transfere seu signatário PF/PJ,
não cria multa retroativa nem desconto automático.

Fluxo: proposta -> dados da empresa -> assinatura da escola -> assinatura do
próprio professor -> confirmação pertinente da agenda -> termo executado.
Quando o aluno confirma a grade ao assinar o contrato de matrícula, a prova é
ligada pela acceptance_id, em campo separado da assinatura profissional.
Em cobertura da mesma ocorrência contratada, registra-se a origem no booking;
não se inventa nova manifestação da família sobre honorários. Alterações que
precisam de nova confirmação aparecem no início do portal da família.
Coordenador prepara e acompanha; só SCHOOL_ADMIN assina pela escola. Professor
precisa ter contrato geral aceito e cadastro/membership ativos. Ele pode recusar.
As assinaturas exigem nome digitado, leitura e declaração de representação, conta
autenticada, versão e SHA-256 iguais à via apresentada. Nenhum operador assina
pelas partes. O PDF contém via integral e comprovantes separados, sem afirmar
certificação ICP-Brasil. Família não recebe honorários, CPF do representante,
texto profissional ou assinatura da outra parte.

Professor: Início (pendências) ou Meu Contrato > Termos por aluno. Direção:
Contratos; direção e coordenação: Central de Qualidade. Família: início do portal.
Uma proposta não atribuída, inclusive cobertura ofertada a vários prestadores,
não garante aula. Depois dos aceites, confirmar a atribuição no fluxo oficial.

## Travas e escritores

Tabelas privadas com RLS e sem grants a navegador/service_role. A única API
humana é `teacher_student_terms`; contexto e papel vêm do banco. Conteúdo e
assinaturas são imutáveis após a primeira assinatura. Recusa/retirada não
ressuscitam em tentativas de rotina. Reemissão explícita exige justificativa e
novos aceites, preservando a versão anterior e eventos. Retirada de proposta já
atribuída exige primeiro o encerramento no fluxo oficial.

`begin_enrollment_offer` mantém a assinatura aluno-escola e a reserva sem iniciar
Asaas. A proposta nasce pela fonte autenticada; `record_enrollment_contract_terms`
liga a confirmação da grade. `materialize_enrollment_offer_schedule` e a conclusão
autoritativa recusam TEACHER_TERM_PENDING. `sync-student-asaas`,
`create-asaas-subscription` e `create-enrollment-pix` consultam a guarda canônica
antes de operações no provedor, inclusive caminhos administrativos.

Triggers em bookings, booking_schedule_versions, reschedules e class_coverages
fecham inserções e mudanças materiais sem termo executado para a pessoa,
professor, grade e vigência. A ficha também exige termo para novos professores;
o cadastro ainda pendente de oferta não confirma atendimento. Coberturas novas,
convites de cobertura para vários prestadores, transferências e solicitações de
mudança de horário preparam proposta da própria fonte. Troca direta de horário passa a proposta persistente enquanto faltar termo; a tela informa a pendência e a grade anterior permanece. Depois dos aceites, o usuário retoma a alteração oficial. Transferência nova fica PENDING e só é autorizada pela gestão em Concluir atribuição da transferência após os três registros; a aplicação respeita a data futura. Mudança aplicada sem os aceites é recusada na mesma transação. O link de
cobertura não assina o instrumento: orienta entrar no portal autenticado e depois
retomar o convite. Vínculos de cada linha apontam para a revisão exata, sob lock
compartilhado até a atribuição. Encerramento/substituição retira a autorização de
novas atribuições, sem apagar assinaturas ou provas históricas.

Atendimento manual/reposição: preparar a grade em Termos por aluno, recolher as
manifestações e só então repetir a atribuição oficial. Preparação não altera a
agenda nem ocupa horário; os validadores canônicos continuam conferindo conflito,
financeiro, cobertura e titularidade. Aula passada atestada da época anterior à
política não exige assinatura retroativa. Treinamento de professor sem aluno não
é matrícula e mantém seu fluxo próprio.

## Transição e ativação

Não fabricar assinatura ou bloquear aulas antigas já prometidas. Ativação pelo
operador depois de publicar: backup validado, comparação dos contratos/assinaturas,
registro em private.teacher_student_term_legacy_offers somente das ofertas já
iniciadas (processing_by não nulo) antes do início da política. A política da
Wise Wolf é habilitada com starts_at; outros tenants permanecem desabilitados.
Transferências já aceitas e ainda não aplicadas são congeladas em teacher_student_term_legacy_transfers, com pessoa, professor, grade e vigência exatos, para cumprir a transição já assumida sem inventar assinatura. Mudança no snapshot perde a exceção. Solicitações de horário ainda abertas recebem proposta individual quando elegíveis. Essas exceções não se aplicam a novas ofertas nem novas atribuições manuais. As
linhas antigas da agenda podem seguir sem alteração material; nova grade,
novo professor, cobertura ou transferência futura exigem termo novo.

Não ativar via update remoto improvisado sem backup e auditoria. Não preparar
termos de toda a carteira, forçar assinaturas de professores ou mudar instrumentos
assinados só para preencher a tabela nova. Uma pendência precisa de acompanhamento
humano; não autoriza abandono do aluno. Sem envio externo ou cobrança de teste.

## Validação

Migration criada pelo CLI e reexecutável, registrada com sua suíte SQL no release.
Ensaio aplica duas vezes em transação com rollback. Fixtures isoladas testam:
separação de papéis, fonte/versão alterada, texto imutável, replay, família sem
honorários, encerramento sem reuso, matrícula pública, guarda de cobrança,
materialização única de cada unidade, aceite de cobertura antes/depois do termo, proposta de horário sem alteração prematura e transferência futura pendente/aceita sem aplicação antecipada.
Fixtures usam exemplo inválido de e-mail e marca test_fixture; a decisão de
mensagem que exclui fixtures é substituída apenas dentro do rollback para
exercitar a assinatura positiva e restaurada antes do fim. Workers externos não
veem essa substituição. Nenhuma identidade ou integração real é acionada.

Testes de tela cobrem assinatura nominal/declarações, confirmação de agenda sem
contrato profissional e recusa de versão desatualizada. Deno verifica que falha
ou resposta malformada da guarda nunca autoriza cobrança. Tours por papel no
catálogo. Publicação somente por deploy/vps/release.sh, árvore limpa, dependências
do lockfile. Conferir RPCs, ACLs, triggers e hashes dos bundles/functions no ar.
