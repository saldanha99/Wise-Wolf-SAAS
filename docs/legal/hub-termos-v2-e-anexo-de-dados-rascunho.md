# Wise Wolf Hub — Termos de Uso v2, Política de Privacidade v2, Anexo de Tratamento de Dados e aviso ao aluno convidado

> ## ⚠️ RASCUNHO PARA O ADVOGADO — NADA DISTO ESTÁ PUBLICADO
>
> Escrito pela equipe de produto em 03/11/2026 a partir do texto **vigente**
> (`supabase/functions/create-hub-checkout/legal-documents.ts`, Termos e Política
> versão `2026-08-24`) e das decisões do dono de 03/11/2026 para a Fase 1 do
> professor autônomo. **Não é parecer jurídico.** Trechos entre colchetes
> `[…]` são decisões ou números que o advogado e o dono precisam confirmar. As
> notas "Para o advogado" explicam o porquê de cada mudança e não fazem parte do
> texto ao usuário.
>
> **O que está no ar continua sendo a versão `2026-08-24`.** Publicar este texto
> exige, no mesmo commit:
> 1. versão nova em `HUB_CORE_TERMS_VERSION` e `HUB_CORE_PRIVACY_VERSION`
>    (`legal-documents.ts`), com `effectiveDate`/`effectiveDateLabel` novos;
> 2. o texto aprovado nos objetos `TERMS_DOCUMENT` e `PRIVACY_DOCUMENT` (mesmo
>    formato `wise-wolf-hub-legal-document/v1`: seções com `id`, `title`,
>    `paragraphs`, `items`);
> 3. **hash novo** em `HUB_CORE_TERMS_SHA256` e `HUB_CORE_PRIVACY_SHA256`
>    (SHA-256 do JSON serializado por `serializeHubCoreLegalDocument`);
> 4. `supabase/functions/create-hub-checkout/legal.test.ts` passando — ele
>    confere que os snapshots batem com os hashes gravados e que versão ou hash
>    diferentes são recusados (incluir `2026-08-24` na lista de versões
>    recusadas);
> 5. cada snapshot com no máximo 64 KB (`hub_core_legal_acceptances` recusa
>    acima de 65.536 bytes) e no mínimo 512 bytes.
>
> Quem aceitou a `2026-08-24` não é migrado: o próximo checkout exige o aceite
> da versão nova. O **Anexo de Tratamento de Dados** é um terceiro documento —
> hoje o aceite só tem colunas para Termos e Política; publicá-lo como documento
> próprio exige migration nova (ou incorporá-lo à Política). A Fase 1 não é
> publicada antes desta revisão.

---

## Parte 1 — Termos de Uso do Wise Wolf Hub, versão 2

Mapa em relação ao texto vigente (`TERMS_DOCUMENT`):

| Seção vigente (`id`) | v2 |
|---|---|
| 1 Aceite e alcance (`aceite`) | mantida, ajuste de alcance |
| 2 Conta e responsabilidades (`conta`) | mantida, acrescenta alunos convidados |
| 3 Soluções e limites do plano (`solucoes`) | **reescrita**: tira "School OS", inclui limite de alunos |
| 4 Assinatura, cobrança e cancelamento (`assinatura`) | **reescrita**: arrependimento, anual, atraso, PIX/boleto não pago |
| 5 Licença de uso e propriedade intelectual (`conteudo`) | **reescrita**: licença da biblioteca |
| — | **nova** 6: o professor e os próprios alunos |
| 6 Uso adequado (`uso-adequado`) | vira 7, sem mudança de mérito |
| 7 Recursos de IA (`inteligencia-artificial`) | vira 8, ajuste |
| 8 Disponibilidade e segurança (`disponibilidade`) | vira 9 |
| 9 Responsabilidade (`responsabilidade`) | vira 10, ajuste |
| 10 Alterações, lei e contato (`alteracoes`) | vira 11 |

### 1. Aceite e alcance

Estes Termos de Uso regem a contratação e o uso do Wise Wolf Hub, incluindo a
Biblioteca, o Educador IA, o Wolfie, a área de alunos do professor, as áreas
autenticadas, os conteúdos e os recursos de inteligência artificial.

Ao marcar o aceite no checkout, a pessoa declara que leu esta versão, que tem
capacidade para contratar em nome próprio ou da organização informada e que
concorda com estas condições. O aceite da Política de Privacidade e do Anexo de
Tratamento de Dados é registrado separadamente e não autoriza marketing.

> **Para o advogado:** só o alcance mudou (área de alunos e o Anexo).

### 2. Conta e responsabilidades

Cada conta tem ambiente, assinatura, permissões e dados próprios. O titular deve
fornecer informações corretas, manter as credenciais protegidas e limitar o
acesso às pessoas autorizadas.

Atividades de usuários autorizados, inclusive de alunos que o titular convidar
para a conta, são atribuídas à respectiva conta. Suspeita de uso indevido deve
ser comunicada pelos canais oficiais exibidos na plataforma.

### 3. Soluções e limites do plano

As funcionalidades dependem do plano, do ciclo e dos limites apresentados no
momento da contratação, entre eles o número de alunos que o professor pode
manter na conta. Contam no limite os alunos em situação **ativa** ou **pausada**;
o aluno **encerrado** libera a vaga. Quando o limite é atingido, o professor
pode encerrar um aluno ou mudar de plano; nenhum aluno é apagado por isso.

Recursos podem ser incluídos, substituídos ou descontinuados para preservar
segurança, qualidade pedagógica ou viabilidade técnica, sem retirar direitos já
adquiridos no período pago em desacordo com a legislação aplicável.

> **Para o advogado:**
> - Sai a menção ao "School OS" (texto vigente, §3), que não é vendido no Hub.
> - Limites decididos em 03/11/2026 (`team.seats` do plano):
>   Descoberta 3 · Essencial 5 · Pro 20 · Studio 50 · Institucional 100.
>   [Confirmar se os números entram no texto ou só na página de planos — sugestão:
>   só na página, para não exigir versão nova dos Termos a cada ajuste comercial.]

### 4. Assinatura, cobrança, atraso e cancelamento

Preço, periodicidade, tributos e forma de pagamento são exibidos antes da
criação da cobrança. Os recursos pagos são liberados somente depois da
confirmação do provedor de pagamento.

**Primeiro pagamento.** Se a primeira cobrança por PIX ou boleto não for paga em
**5 dias**, a contratação é cancelada automaticamente e nenhuma cobrança nova é
gerada. O professor pode contratar de novo quando quiser.

**Atraso.** Se uma renovação não for paga no vencimento, o acesso continua
normal por **5 dias de carência**. Depois disso, enquanto o pagamento não for
regularizado, a gestão de alunos e os recursos pagos ficam **somente para
consulta**: nada é apagado, e o acesso completo volta quando o pagamento for
confirmado.

**Direito de arrependimento.** Na contratação feita pela internet, o professor
pode desistir em até **7 dias** contados da contratação [ou do primeiro acesso
pago — confirmar o marco], com devolução integral do valor pago, pelos canais do
painel ou do suporte.

**Cancelamento.** O professor pode cancelar a renovação a qualquer momento pelo
painel. O cancelamento impede novas cobranças; o acesso continua até o fim do
período já pago, no plano mensal ou anual. [No plano anual, fora do prazo de
arrependimento, não há devolução proporcional do período restante — confirmar.]

Pedidos de reembolso fora dessas hipóteses são analisados pelos canais
oficiais, observados o período contratado, a natureza do serviço e os direitos
previstos na legislação brasileira.

> **Para o advogado:**
> - Arrependimento: art. 49 do CDC. Confirmar se o professor autônomo que compra
>   ferramenta para a própria atividade é consumidor (destinatário final) — a
>   tendência é tratar como tal; o texto já o trata assim.
> - "Sem devolução proporcional no anual" pode ser questionado como abusivo
>   (art. 51 do CDC) se não houver alternativa clara; avaliar oferecer o anual
>   com desconto explícito em troca da fidelidade.
> - Carência de 5 dias e corte de PIX/boleto em 5 dias: decisões de 03/11/2026.
>   **Ainda não implementadas** — hoje o PIX não pago fica pendente/vencido sem
>   prazo de corte (`docs/runbooks/hub-primeira-compra-real.md`). O texto só pode
>   ser publicado junto com o código que faz isso.
> - "Somente para consulta" significa: o professor vê, mas não cria nem altera
>   alunos, agenda e presença. Os alunos convidados continuam vendo o que já
>   receberam [confirmar].

### 5. Licença da Biblioteca e propriedade intelectual

A assinatura concede ao professor uma licença **pessoal, limitada, não
exclusiva, intransferível e revogável** para usar os materiais da Biblioteca
**nas próprias aulas e com os próprios alunos**, enquanto a assinatura estiver
ativa. A licença permite:

- usar os materiais na tela durante a aula;
- imprimir cópias para uso na aula, na quantidade necessária para os alunos
  daquela aula;
- enviar material ao aluno **somente pelo próprio Hub**, que identifica a cópia
  com marca d'água [recurso ainda não disponível — até lá, envio ao aluno não é
  permitido; ver nota].

Não é permitido:

- publicar, vender, revender, sublicenciar ou compartilhar os materiais em
  sites, redes sociais, grupos, cursos, plataformas ou com outros professores;
- enviar o arquivo do material ao aluno por fora do Hub (e-mail, WhatsApp,
  drive compartilhado);
- remover marca d'água, aviso de autoria ou de licença;
- copiar em massa, usar robôs ou extração automatizada, ou fazer engenharia
  reversa do serviço;
- usar os materiais para treinar ou alimentar sistemas de inteligência
  artificial fora do Hub.

**Depois do cancelamento ou do fim da assinatura**, a licença termina: o
professor deixa de baixar e de enviar materiais pelo Hub e não deve iniciar uso
novo das cópias impressas. [Confirmar: cópias já impressas e entregues a alunos
durante a assinatura podem continuar com os alunos.]

Marcas, interfaces, software, trilhas, materiais e demais ativos continuam com
seus titulares. Materiais criados pelo próprio professor com o Educador IA
pertencem ao professor, observados os direitos sobre os elementos da plataforma.

> **Para o advogado:**
> - Base do texto vigente: §5 (`conteudo`), que só dizia "licença limitada…
>   durante a vigência do acesso" e "não distribuir fora das permissões do
>   plano", sem dizer quais são as permissões.
> - O envio ao aluno com marca d'água ficou **para depois** (decisão de
>   03/11/2026). Duas saídas: (a) publicar já com a cláusula e o recurso
>   "indisponível", ou (b) tirar o terceiro item e reincluí-lo numa versão
>   futura. Sugestão: (b), para o texto não prometer o que não existe.
> - Titularidade do material gerado por IA: confirmar a redação (o conteúdo
>   gerado pode reproduzir trechos de terceiros; o professor revisa — §8).

### 6. O professor e os próprios alunos

O Hub é uma ferramenta para o professor organizar o próprio trabalho. **O aluno
contrata o professor, não a Wise Wolf.** O professor é o único responsável:

- pela relação comercial com os próprios alunos: preço, cobrança, recibos,
  contrato, cancelamento, reembolso e obrigações fiscais;
- pela relação pedagógica: conteúdo das aulas, avaliação, frequência e
  comunicação com o aluno e com o responsável;
- pelos dados pessoais dos alunos que cadastrar ou convidar, como
  **controlador**, nos termos da Política de Privacidade e do Anexo de
  Tratamento de Dados;
- por obter a autorização do pai, mãe ou responsável antes de cadastrar ou
  convidar aluno menor de 18 anos.

A Wise Wolf não intermedeia pagamentos entre professor e aluno, não garante a
contratação ou a permanência de alunos, não presta as aulas e não responde por
acordos entre professor e aluno. Pedidos de alunos sobre aulas, cobrança ou
dados serão encaminhados ao professor.

> **Para o advogado:** modelo B decidido em 03/11/2026. Seção nova; não há
> equivalente no texto vigente (o §9 `responsabilidade` só dizia "cada parte
> responde por seus próprios atos"). Avaliar se cabe declarar expressamente a
> ausência de vínculo de trabalho ou de representação entre Wise Wolf e
> professor.

### 7. Uso adequado

(Texto vigente do §6 `uso-adequado`, sem mudança de mérito.)

É proibido usar o Hub para fraude, assédio, violação de direitos, envio de
conteúdo malicioso, tentativa de acesso a outra conta, sobrecarga intencional ou
qualquer finalidade ilegal.

O acesso poderá ser limitado preventivamente quando houver risco relevante à
segurança, indício de fraude, inadimplência ou violação destes Termos, com
revisão proporcional ao risco e às obrigações legais.

### 8. Recursos de inteligência artificial

Respostas, materiais, planos e sugestões gerados por inteligência artificial são
apoio. Podem conter imprecisões e devem ser revisados pelo professor antes de
serem usados com alunos ou em decisões pedagógicas, administrativas, financeiras
ou jurídicas.

O professor não deve inserir segredos, dados excessivos ou dados de alunos além
do necessário para a finalidade pedagógica. Os campos de objetivo e interesses
do aluno não devem conter dados de saúde, religião, política, vida familiar ou
financeira.

> **Para o advogado:** base: §7 vigente. Acrescentada a orientação sobre dados
> de alunos, porque o Educador IA usa objetivo e interesses do aluno para
> personalizar material.

### 9. Disponibilidade e segurança

(Texto vigente do §8 `disponibilidade`, sem mudança.)

### 10. Responsabilidade

A Wise Wolf responde pelos deveres que a lei não permite excluir. Fora dessas
hipóteses, cada parte responde por seus próprios atos, conteúdo, credenciais e
decisões tomadas com base no uso do serviço, e o professor responde, perante os
próprios alunos, pela relação descrita no item 6.

Links, integrações e serviços de terceiros têm condições próprias. A
indisponibilidade de um terceiro será tratada com diligência, sem transformar o
Hub em garantidor irrestrito desse serviço externo.

### 11. Alterações, lei e contato

(Texto vigente do §10 `alteracoes`, sem mudança.)

---

## Parte 2 — Política de Privacidade do Wise Wolf Hub, versão 2

Mapa em relação ao texto vigente (`PRIVACY_DOCUMENT`):

| Seção vigente (`id`) | v2 |
|---|---|
| 1 Papel e abrangência (`papel`) | **reescrita**: papéis por categoria de dado |
| 2 Dados tratados (`dados`) | acrescenta a categoria "alunos do professor" |
| 3 Finalidades e bases legais (`finalidades`) | acrescenta as finalidades da área de alunos |
| 4 Compartilhamento e fornecedores (`compartilhamento`) | **reescrita**: lista de suboperadores |
| 5 Isolamento e segurança (`isolamento`) | mantida |
| 6 Retenção e eliminação (`retencao`) | **reescrita**: encerramento da conta |
| 7 Direitos do titular (`direitos`) | ajuste: aluno pede ao professor |
| 8 Transferências internacionais (`transferencias`) | ajuste |
| 9 Cookies, menores e escolhas (`cookies`) | **reescrita**: menores na área de alunos |
| 10 Atualizações e contato (`atualizacoes`) | mantida |

### 1. Papéis e abrangência

Esta Política explica como o Wise Wolf Hub trata dados pessoais em páginas
públicas, cadastro, checkout, área autenticada, suporte e uso das soluções.

- **Dados do professor e da conta** (cadastro, contratação, uso, suporte): a
  Wise Wolf é **controladora**.
- **Dados dos alunos que o professor cadastra ou convida**: o **professor é o
  controlador** e a Wise Wolf atua como **operadora**, tratando esses dados só
  para prestar o serviço ao professor, conforme o Anexo de Tratamento de Dados.
- **Escolas** que usam soluções da Wise Wolf para administrar os próprios alunos
  seguem o mesmo princípio: a escola é a controladora.

> **Para o advogado:** o §1 vigente já previa o professor como controlador "em
> recursos usados… para administrar dados de seus próprios alunos", mas sem
> dizer quais dados nem remeter a um contrato de operador.

### 2. Dados tratados

(Itens vigentes de cadastro, contratação, uso pedagógico, segurança e aceite
legal, mantidos.) Acrescenta:

- **Alunos do professor** — cadastrados ou convidados pelo professor: nome,
  telefone, e-mail, nome e contato do responsável (quando o aluno for menor),
  nível, objetivo e interesses de estudo, agenda de aulas, presença (aula dada,
  falta), situação do aluno (ativo, pausado, encerrado), atividades atribuídas e
  concluídas, recados entre professor e aluno e, quando o aluno aceita o
  convite, os dados da conta dele (nome, e-mail, preferências).

O Hub **não** pede ao professor dados de saúde, religião, opinião política,
origem racial ou étnica, vida sexual, biometria ou documentos do aluno, nem
dados de pagamento entre professor e aluno.

> **Para o advogado:**
> - Hoje já existem nome de exibição, nível, objetivo, interesses e anotações do
>   professor (`hub_educator_learners`), atividades (`hub_learner_assignments`)
>   e o perfil do aluno que aceita o convite (`hub_member_profiles`). Telefone,
>   e-mail, responsável, agenda, presença e situação chegam com a Fase 1.
> - O campo de anotações do professor é texto livre: avaliar se basta a
>   orientação (Termos §8) ou se o campo deve ter limite e aviso na tela.

### 3. Finalidades e bases legais

(Itens vigentes mantidos.) Para os dados dos alunos, a Wise Wolf trata **por
instrução do professor** e só para:

- exibir e organizar a lista de alunos, a agenda, a presença e a situação de
  cada um;
- enviar ao aluno o convite e as mensagens que o professor pedir;
- entregar ao aluno convidado as atividades atribuídas pelo professor;
- personalizar materiais com o Educador IA a partir de nível, objetivo e
  interesses;
- manter segurança, registros técnicos e cumprir obrigações legais.

A base legal desse tratamento é definida pelo professor, como controlador
[sugestão de base mais provável para o professor: execução do contrato com o
aluno (art. 7º, V) e, para menor, consentimento de um dos pais ou responsável
(art. 14, §1º) — confirmar]. A Wise Wolf **não** usa dados dos alunos para
marketing próprio, não os vende e não os usa para treinar modelos de
inteligência artificial.

### 4. Compartilhamento e fornecedores (suboperadores)

Os dados podem ser compartilhados, no limite necessário, com estes fornecedores,
que recebem instruções, deveres de confidencialidade e controles compatíveis com
a função:

| Fornecedor | Função | Dados |
|---|---|---|
| Servidor próprio (VPS) com banco de dados, autenticação e arquivos | hospedagem de todo o Hub | todos |
| Asaas | cobrança da assinatura do professor | dados de contratação do professor (nunca do aluno) |
| Provedor de envio de e-mail [Resend] | e-mails da conta e convites | nome e e-mail do destinatário |
| Provedor de WhatsApp [Evolution API] | mensagens de serviço e convites | nome, telefone e texto da mensagem |
| Provedores de IA [OpenRouter e os modelos que ele aciona; OpenAI para o Wolfie] | Educador IA e Wolfie | nível, objetivo, interesses e o texto do pedido; nunca telefone ou e-mail do aluno |

Mudança relevante nessa lista será informada aos professores com antecedência
[30 dias — confirmar], com direito de encerrar a conta se discordarem.

Também poderemos compartilhar informações por obrigação legal, ordem válida ou
para proteger direitos, pessoas e a integridade do serviço. Não vendemos dados
pessoais.

> **Para o advogado:** a lista vem do código atual. Conferir com o dono:
> provedor e país do servidor (desde 16/10/2026 a VPS é outra), contrato e
> configuração de retenção/treino de cada provedor de IA, e se o Asaas é
> operador ou controlador independente para os dados de pagamento. O RIPD da
> memória das aulas (`docs/lgpd/ripd-memoria-das-aulas.md`, pendências J3 e J5)
> tem as mesmas perguntas para a escola.

### 5. Isolamento e segurança

(Texto vigente, sem mudança.)

### 6. Retenção e eliminação

Mantemos dados pelo período necessário para executar o serviço, cumprir
obrigações, resolver disputas, prevenir fraude e exercer direitos. Depois disso,
são eliminados, anonimizados ou mantidos de forma restrita quando houver base
legal.

**Encerramento da conta do professor.** Quando a conta é encerrada (a pedido do
professor ou depois do fim da assinatura [+ prazo — confirmar]):

1. o professor tem [30] dias para exportar a lista de alunos, a agenda e a
   presença;
2. depois disso, os dados dos alunos do professor são **eliminados** em até
   [90] dias, inclusive dos backups no ciclo normal de renovação deles;
3. ficam guardados, de forma restrita, só os registros de contratação, cobrança
   e aceite do próprio professor, pelos prazos legais.

Durante o atraso (Termos §4) e depois do cancelamento, enquanto a conta não for
encerrada, **nada é apagado**: os dados ficam somente para consulta.

O aluno **encerrado** pelo professor continua na lista do professor, sem ocupar
vaga, até que o professor o apague ou a conta seja encerrada.

> **Para o advogado:** os prazos entre colchetes são proposta da equipe de
> produto. Não existe hoje rotina de exportação nem de eliminação por
> encerramento de conta do Hub — é trabalho da Fase 1 e precisa estar pronto
> antes da publicação deste texto.

### 7. Direitos do titular

(Texto vigente mantido.) Acrescenta: o aluno cadastrado por um professor exerce
os direitos **perante o professor**, que é o controlador. Pedido que chegar à
Wise Wolf será encaminhado ao professor e apoiado conforme o Anexo de
Tratamento de Dados, sem que a Wise Wolf decida por ele, salvo obrigação legal.

### 8. Transferências internacionais

Alguns fornecedores, em especial os de inteligência artificial e de envio de
mensagens, podem processar dados fora do Brasil. Nessas situações adotamos
mecanismos contratuais e medidas de segurança compatíveis com a LGPD
[mecanismo do art. 33 a definir — cláusulas-padrão da ANPD, a confirmar].

### 9. Cookies, menores e escolhas

Podemos usar armazenamento local e tecnologias essenciais para autenticação,
segurança, preferências e funcionamento. Tecnologias não essenciais respeitam as
escolhas apresentadas quando aplicável.

**Menores de 18 anos.** O professor só pode cadastrar ou convidar aluno menor
com a autorização de um dos pais ou do responsável, e deve registrar no Hub o
nome e o contato do responsável. O convite para criança [menor de 12 anos] é
enviado ao responsável, e não à criança. O Hub não deve ser usado para coletar
dados além do necessário para as aulas.

> **Para o advogado:** o §9 vigente só dizia que contas de menores "devem ser
> administradas por responsáveis e instituições". Pontos: idade a partir da qual
> o adolescente pode ter conta própria; como o professor comprova a autorização
> (declaração no cadastro? registro do aceite do responsável?); Enunciado CD/ANPD
> nº 1/2023 (a confirmar) sobre bases para dados de crianças e adolescentes.

### 10. Atualizações e contato

(Texto vigente, sem mudança.)

---

## Parte 3 — Anexo de Tratamento de Dados (DPA) entre o professor e a Wise Wolf

Este Anexo integra os Termos de Uso e vale para os dados pessoais de alunos e
responsáveis que o professor cadastra ou convida no Hub ("Dados dos Alunos").

**1. Papéis.** O professor é o **controlador** dos Dados dos Alunos. A Wise Wolf
é a **operadora** e trata esses dados somente em nome do professor e conforme
as instruções dele, que são as configurações e ações que ele faz no Hub e este
Anexo.

**2. Objeto e duração.** Tratamento necessário para prestar o Hub ao professor
(lista de alunos, agenda, presença, situação, convites, mensagens, atividades e
personalização por IA), enquanto durar a conta, mais o prazo de eliminação do
item 9.

**3. Instruções.** A Wise Wolf não trata Dados dos Alunos para finalidade
própria, não os vende, não os usa para marketing nem para treinar modelos de
IA. Se uma instrução do professor violar a lei, a Wise Wolf avisa e pode
recusar.

**4. Confidencialidade.** Só pessoas da Wise Wolf que precisam, para suporte ou
segurança, acessam Dados dos Alunos, sob dever de confidencialidade e com
registro de acesso [confirmar: hoje o suporte da plataforma tem acesso amplo ao
banco; definir regra e registro].

**5. Segurança.** A Wise Wolf mantém as medidas descritas na Política de
Privacidade: isolamento lógico por conta, controle por função, políticas de
acesso no banco de dados, credenciais protegidas e registros de eventos.

**6. Suboperadores.** O professor autoriza os suboperadores listados na
Política de Privacidade (§4). A Wise Wolf impõe a eles obrigações equivalentes
às deste Anexo, avisa sobre mudança relevante com antecedência [30 dias] e o
professor pode encerrar a conta se discordar.

**7. Direitos dos titulares.** A Wise Wolf encaminha ao professor, em até [5]
dias úteis, pedido de aluno ou responsável que receber, e oferece no Hub os
meios para o professor consultar, corrigir, exportar e apagar os Dados dos
Alunos.

**8. Incidentes.** A Wise Wolf comunica ao professor, em até [48 horas] depois
de confirmar, incidente de segurança que envolva Dados dos Alunos, com o que se
sabe sobre natureza, dados afetados, medidas tomadas e contato, para que o
professor avalie a comunicação à ANPD e aos titulares. [Confirmar prazo à luz
da Resolução CD/ANPD nº 15/2024 — a confirmar.]

**9. Fim do tratamento.** No encerramento da conta, o professor pode exportar os
Dados dos Alunos em [30] dias; depois, a Wise Wolf os elimina em até [90] dias,
salvo guarda exigida por lei.

**10. Transferência internacional.** Feita só com os suboperadores listados e
com o mecanismo do art. 33 da LGPD indicado na Política.

**11. Informações e auditoria.** A Wise Wolf fornece, a pedido razoável do
professor, as informações necessárias para demonstrar o cumprimento deste
Anexo [forma e frequência a confirmar — sugestão: questionário anual e
documentação, sem auditoria presencial].

**12. Responsabilidade.** Cada parte responde pelo descumprimento das próprias
obrigações nos termos da LGPD (art. 42) e dos Termos de Uso.

> **Para o advogado:**
> - Para a publicação, decidir se o Anexo é documento próprio com aceite
>   separado (exige migration: `hub_core_legal_acceptances` só tem colunas de
>   Termos e Política) ou uma seção da Política.
> - Professor autônomo raramente lê DPA. Sugestão: na tela da área de alunos,
>   um resumo de 3 linhas ("você é o responsável pelos dados dos seus alunos;
>   peça autorização do responsável para menores; a Wise Wolf só guarda os
>   dados para o Hub funcionar") com link para o Anexo.

---

## Parte 4 — Aviso curto ao aluno convidado

Mostrado na página do convite (hoje `hub_learner_invite_preview`, antes de o
aluno criar conta ou entrar) e no primeiro acesso.

> **Você foi convidado por {nome do professor}.**
>
> Ao aceitar, você entra no ambiente de estudos do seu professor no Wise Wolf
> Hub. Quem cuida das suas aulas, da cobrança e dos seus dados é o seu
> professor. A Wise Wolf fornece a plataforma e guarda seus dados só para ela
> funcionar.
>
> O professor vê seu nome, contato, agenda, presença e as atividades que você
> fizer. Para corrigir ou apagar seus dados, fale com o seu professor.
>
> Se você tem menos de 18 anos, o seu responsável precisa saber deste convite e
> concordar com ele.
>
> [Política de Privacidade] · [Termos de Uso]

> **Para o advogado:** o aviso não é termo de consentimento — a base é do
> professor (Política §3). Confirmar se o aceite do convite deve registrar a
> versão do aviso (hoje o aceite do convite não grava versão de texto nenhum).

---

## Pendências para fechar antes de publicar

| # | Pendência | Quem |
|---|---|---|
| L1 | Todos os colchetes deste rascunho (prazos, idade, anual, marco do arrependimento) | advogado + dono |
| L2 | Consumidor ou não: professor autônomo comprando ferramenta (Termos §4) | advogado |
| L3 | Envio ao aluno com marca d'água: publicar a cláusula agora ou na versão futura (Termos §5) | dono |
| L4 | Lista de suboperadores, país do servidor e mecanismo de transferência internacional | dono + advogado |
| L5 | Anexo como documento próprio (migration) ou seção da Política | dono + desenvolvimento |
| L6 | Rotinas que o texto promete e ainda não existem: corte do PIX/boleto em 5 dias, carência de 5 dias com modo só consulta, exportação e eliminação no encerramento, limite de alunos por plano | desenvolvimento (Fase 1) |
| L7 | Regra e registro de acesso do suporte da plataforma a Dados dos Alunos (Anexo §4) | dono |
| L8 | Versão nova, hash novo e `legal.test.ts` no mesmo commit (topo deste arquivo) | desenvolvimento |
