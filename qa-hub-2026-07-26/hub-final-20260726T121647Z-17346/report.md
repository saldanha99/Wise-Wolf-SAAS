# Relatório final — Wise Wolf Hub

- Data: 26/07/2026
- Release validada: `20260726T114300Z-4a8c1e160ab4`
- Execução isolada: `hub-final-20260726T121647Z-17346`
- Ambiente: produção
- Resultado: aprovado

## Escopo entregue

- onboarding protegido e recuperável para usuários autenticados;
- ativação idempotente do plano Discovery;
- personalização por público, função, nível CEFR, objetivo, interesses e modalidade;
- Wolfie Studio com recomendações baseadas no mesmo catálogo usado pela experiência escolar;
- nove universos e 56 experiências com identificadores únicos e campos obrigatórios completos;
- recomendações verificadas para reprodução humana, tecnologia, aviação, crianças/Roblox, IELTS, varejo, laboratório, logística e beleza;
- Teaching Studio com saída pedagógica estruturada;
- checkout em três etapas, revisão explícita, validação de documento e chave idempotente;
- bloqueio de fixture financeira em produção antes de qualquer efeito externo.

## Prova de produção

1. Conta de autenticação única e confirmada foi criada sem envio de e-mail.
2. A primeira ativação criou uma assinatura `DISCOVERY` com status `TRIALING`.
3. A repetição da ativação retornou a mesma assinatura com `alreadyActive=true`.
4. O perfil B1 de uma professora de inglês para crianças foi salvo e retornou corretamente no bootstrap do Hub.
5. As cotas Discovery retornaram `wolfie.turn=3` e `educator_ai.generate=2`.
6. O checkout de fixture retornou `TEST_MODE_REQUIRES_SANDBOX`.
7. Nenhuma sessão de checkout, cliente Asaas ou cobrança foi criada.
8. Nenhuma notificação externa foi enviada.
9. A página pública respondeu HTTP 200; navegação, catálogo, planos e o modal com as jornadas Professor, Aprendiz e Instituição foram inspecionados no navegador publicado.

## Limpeza e segurança

- Conta Hub: 0 registros restantes.
- Membership: 0 registros restantes.
- Perfil: 0 registros restantes.
- Auth: identidade removida e consulta final retornou 404.
- Busca final por fixtures `hub-final-*`: 0 em Auth e 0 em Hub.
- Backup sanitizado preservado em `/opt/wisewolf/backups/e2e-hub-hub-final-20260726T121647Z-17346/fixture-sanitized.json`.
- Nenhuma senha, token, chave, cookie ou documento de teste foi gravado no relatório ou no backup.

## Validações técnicas

- TypeScript: aprovado.
- Edge Functions: aprovadas na checagem Deno.
- Build de produção: aprovado.
- Integridade de diferenças: aprovada.
- Script de release: sintaxe aprovada.
- Containers de frontend e Edge Functions: ativos.
- Função de preferências e coluna de idempotência: presentes no banco de produção.

Observação não bloqueante: o build mantém o aviso de otimização de pacotes grandes e a base local de compatibilidade de navegadores está desatualizada. Eles não impediram a publicação nem os testes funcionais, mas são candidatos apropriados para uma rodada futura de desempenho.
