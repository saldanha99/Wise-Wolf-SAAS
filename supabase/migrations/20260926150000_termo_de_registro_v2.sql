-- Termo de registro das aulas, versão 2: prazo de guarda dito com precisão.
--
-- A v1 dizia "a transcrição completa fica guardada por até 90 dias". Só a
-- CÓPIA no sistema da escola vence em 90 dias (GOOGLE_MEET_RAW_RETENTION_DAYS);
-- os arquivos originais do Google (transcrição, anotações e relatório de
-- presença) continuam no Drive da conta central — o sistema não os apaga, e
-- apagá-los exigiria acesso amplo ao Drive. A v2 diz isso e oferece a exclusão
-- a pedido (direito do titular). Ninguém tinha aceitado a v1 quando a v2 saiu.
--
-- Texto é versão nova, nunca update: quem aceitou uma versão aceitou aquele
-- texto. A versão vigente é a publicada por último.

insert into private.lesson_recording_terms (audience, version, body, published_at) values
(
  'STUDENT', 'v2',
  $term$As aulas acontecem numa sala do Google Meet criada pela escola. Nessas salas, o Google transcreve a aula (converte em texto o que foi falado) e gera anotações automáticas. A aula não é gravada em vídeo.

Para que usamos
• Registrar o que foi trabalhado em cada aula, para dar continuidade ao aprendizado, inclusive se o aluno mudar de professor.
• Planejar as próximas aulas e acompanhar a evolução do aluno.
• Confirmar que a aula aconteceu: o Google informa a que horas cada participante entrou e saiu da sala.

Quem tem acesso
• O professor do aluno e a coordenação pedagógica da escola.
• O professor revisa o resumo antes de ele entrar na ficha do aluno.
• O Google processa os dados como fornecedor da escola (Google Workspace).

Por quanto tempo
• No sistema da escola, a transcrição completa e o relatório de presença ficam por até 90 dias; depois fica só o resumo aprovado, enquanto o aluno estudar na escola.
• Os arquivos originais do Google ficam na conta Google da escola, que só a direção acessa. Você pode pedir a exclusão deles a qualquer momento pelo WhatsApp da escola.

Menores de 18 anos
• Quem autoriza é o responsável legal.

Dá para mudar de ideia
• A qualquer momento, pelo mesmo link ou pedindo à escola pelo WhatsApp. As aulas seguintes deixam de ser transcritas.

Sem autorização, a aula acontece normalmente, só que sem transcrição.$term$,
  now()
),
(
  'TEACHER', 'v2',
  $term$As aulas da escola acontecem em salas do Google Meet criadas pela conta da escola, com você como coanfitrião. Nessas salas, o Google transcreve a aula e gera anotações automáticas. A aula não é gravada em vídeo. Depois da aula, você revisa o resumo antes de ele entrar na ficha do aluno.

Para que usamos
• Continuidade pedagógica do aluno, inclusive se ele mudar de professor.
• Planejamento das próximas aulas.
• Confirmação de que a aula aconteceu: o Google informa a que horas cada participante entrou e saiu da sala.

Como usamos
• Uma divergência (por exemplo, aula lançada sem ninguém na sala) vira um aviso para a coordenação conversar com você.
• Nada disso muda o seu pagamento automaticamente. Qualquer ajuste passa pela direção, como hoje.

Quem tem acesso
• A coordenação e a direção da escola; o professor que assumir o aluno recebe o dossiê pedagógico dele.

Por quanto tempo
• No sistema da escola, a transcrição completa e o relatório de presença ficam por até 90 dias; o resumo aprovado fica enquanto o aluno estudar na escola.
• Os arquivos originais do Google ficam na conta Google da escola, que só a direção acessa. Você pode pedir a exclusão deles a qualquer momento.

Você pode revogar quando quiser, nesta mesma tela. A partir daí, as suas aulas deixam de ser transcritas.$term$,
  now()
)
on conflict (audience, version) do nothing;
