# Cobertura: agenda vigente e oferta por aula

A tela **Cobertura de professores → Ausência & Cobertura** consulta as ocorrências de cada data pela `booking_schedule_on_date`. A prévia é somente leitura; não grava ausência nem reconstrói agenda no navegador. Falha de consulta aparece na tela e interrompe a seleção. Mudança de período ou motivo limpa a seleção anterior.

`coverage_booking_occurrences` é somente service_role, chamada por `coverage-admin` depois da autenticação e resolução da escola. Considera versões permanentes, mudanças pontuais, início da matrícula, avulsas, exclusões e antecipações. Na prévia, omite aulas já lançadas e coberturas vivas. Alunos fora da escola ou sem vínculo ativo não derrubam a lista inteira. Uma aula de uma hora continua sendo dois bookings de 30 minutos.

**Substitutos** consulta `coverage_candidates_for_booking` pela mesma ocorrência. A lista, a validação antes da gravação, o trigger e o aceite consultam a agenda efetiva; os demais controles de escola, disponibilidade, ausência, reserva, conflito, expiração e unicidade são preservados. `LessonLauncher` prioriza o horário da cobertura confirmada ao montar o lançamento do substituto.

Somente o diretor com membership `SCHOOL_ADMIN` ativa na escola pode informar `offeredRate` antes de enviar. Em branco, permanece a tarifa normal do substituto. O valor é por ocorrência de 30 minutos, positivo, com duas casas e teto de R$ 10.000,00. A edge fixa o autor a partir da sessão; o trigger confirma o papel/escola do autor e recusa adulteração por outros usuários, inclusive quem tenta passar o ID do diretor. A oferta, autoria e data ficam imutáveis depois da criação: para oferecer outros termos, é necessário cancelar e criar outro convite pelo fluxo autorizado.

O WhatsApp e a página de aceite mostram a oferta, somente para o substituto. O valor não aparece em aviso à família. As três colunas novas não são concedidas a anon/authenticated: as projeções operacionais existentes mantêm suas colunas, sem expor remuneração pela API do aluno. `v_payable_class_logs` usa a oferta confirmada da mesma escola/booking/aluno/data/professor; não cria lançamento nem pagamento antecipado, e preserva bloqueios de presença, regras de aula não pagável e ajustes financeiros explícitos existentes. Cobertura cancelada deixa de fornecer essa tarifa.

Falhas parciais aparecem com as pendências. Convites já concluídos saem da seleção antes de outra tentativa. Envio incerto conserva o registro pendente e exige conferência; não afirma entrega nem repete automaticamente.

## Validação

Migration `20261016165219_coverage_effective_schedule_director_rate.sql`, reexecutável e registrada no release. Suíte transacional `coverage_effective_schedule_director_rate.sql`: duas ocorrências na semana, versão prevalecendo sobre dia antigo, matrícula futura/exclusão omitidas, candidato que mudou de horário, recusa de coordenador/professor/diretor de outra escola, aceite idempotente, preço imutável, lançamento autenticado pelo substituto, tarifa efetiva na folha, bloqueio de pagamento e cancelamento. Dados sintéticos com metadata `test_fixture`, escola isolada, sem contatos externos, sempre revertidos.

Testes de UI conferem prévia sem escrita, erro sem fallback, valor por papel, moeda com vírgula, validação antes de enviar, invalidação do período e falha parcial. Testes Deno conferem papéis, precisão, limites e texto do convite.

A publicação usa exclusivamente `deploy/vps/release.sh`, com árvore limpa na branch configurada, dependências do lock e todas as migrations/testes registrados. Não registrar ausência nem disparar convite real para testar a publicação.

O auxiliar legado `private.coverage_candidates` pertence a `supabase_admin` em produção. O wrapper novo pertence a `postgres`: a migration concede EXECUTE somente a esse papel interno. Clones usados para validar precisam preservar os donos e ACLs reais; restaurar como `supabase_admin` evita mascarar essa dependência.
