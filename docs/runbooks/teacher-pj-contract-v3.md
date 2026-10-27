# Contrato geral PJ do professor — versão 3

Preparado e **publicado em 26/10/2026** por solicitação da direção, pelo release oficial `20261027T003901Z-40582250ab26`, origem `7d05e10c2263406749a4c2f6b817895a3663173a`. A oferta TEACHER da Wise Wolf passou para V3; STUDENT permaneceu na V2. A implantação não produziu assinatura real, comunicação externa ou cobrança, nem reescreveu contratos anteriores.

## Regra documental

O aviso de saída é bilateral, escrito e contratualmente fixado em 30 dias corridos a partir do dia seguinte ao recebimento comprovado. Não é mínimo universal do art. 599 do Código Civil e não afasta relação de emprego que exista na realidade. A transição mantém somente atendimentos já aceitos até a data final, com remuneração normal; não exige novos alunos ou permanência até conseguir substituto. A redução ou dispensa pode ser acordada por escrito; motivo justificado exige exame individual. Bônus de 10% mantido, sem alterar direito anterior.

Multa do aviso tem base demonstrável e proporção dos dias injustificadamente suprimidos; a multa por ausência injustificada usa os honorários da ocorrência não prestada. Apuração com comunicação e cinco dias úteis para manifestação, limites legais e vedação de reparação duplicada. Nenhum débito, desconto, negativação ou lançamento Asaas foi implementado.

Minuta integral: `docs/legal/contrato-geral-professor-pj-v3.md`. PDF de 9 páginas: `output/pdf/wise-wolf-contrato-professor-pj-v3.pdf`. A exportação das cláusulas 1–10 usa a mesma fonte do aplicativo (`lib/teacherPjContract.ts`), por `npx tsx scripts/export-teacher-pj-contract.ts`; a Cláusula 11ª é extraída integralmente do componente e mantém o aviso de registro das aulas.

## Versão e identidade

- V1 e V2 não foram editadas no documento. Manter as cláusulas antigas, inclusive a redação problemática, para reproduzir fielmente as vias anteriores; não fazer substituição global de texto.
- V3 identifica a empresa e o representante. CNPJ numérico ou alfanumérico com DV, razão social, endereço e CPF do representante são exigidos na tela e no servidor. A conferência estrutural não atesta situação cadastral, regime fiscal ou poderes reais: conferir os documentos da empresa na contratação.
- Convite público: `register-teacher/provider-identity.ts`, validação antes da criação da conta e arquivo `party_snapshot.providerIdentity` junto da cópia e do PDF. A identidade fiscal é salva nos campos reais `profiles.cnpj` e `cnpj_company_name`.
- Conta existente nunca aceita: RPC `accept_teacher_pj_contract(text,integer,jsonb)`, somente autenticado, própria conta TEACHER ativa, membership e contexto da escola. Perfil bloqueado na transação; versão oferecida e dados são conferidos antes das escritas. Snapshot, aceite e perfil são gravados juntos.
- API antiga mantém dois argumentos e delega ao corpo V2 em `private`, com acesso do navegador revogado. Escola oferecendo V3 não pode aceitar contrato novo pela API antiga nem com versão omitida. Repetição de aceite concluído não substitui sua cópia.
- `PublicContractView` lê a identidade congelada em `tenant_contract_records`, devolvida pela edge `tenant-legal-assets`, e não o cadastro fiscal atual. O aceite pelo app continua sem `commercial_snapshot.rateUnit`; `displayRateUnit` é apenas exibição, preservando a régua financeira existente.
- Seed one-shot promove somente TEACHER da Wise Wolf de V2 para V3. STUDENT, outras escolas, vias assinadas e decisões posteriores são preservados.

Para professor que já assinou, preparar e formalizar aditivo próprio com efeitos futuros e concordância adequada. Não usar a RPC de primeiro aceite para substituir contrato, transferir identidade PF/PJ ou inventar concordância. A implementação de aditivo e a assinatura obrigatória por aluno não fazem parte desta alteração.

## Validação realizada

- Typecheck, 78 testes Vitest relacionados e 12 testes Deno aprovados; build aprovado com `VITE_HUB_PUBLIC_VIDEOS=true`, após validação dos 21 artefatos públicos existentes. A execução sem a flag para na guarda desses vídeos; nenhum arquivo de configuração foi alterado para contornar a guarda.
- Migration `20261026222538_contrato_professor_pj_e_transicao.sql` aplicada duas vezes na mesma transação na VPS, como `supabase_admin`, com lock timeout de 3 segundos e statement timeout de 25 segundos, seguida de `contrato_professor_pj_e_transicao.sql` e rollback. Suíte legada `versao_do_contrato_no_aceite.sql` validada em transação separada, também com migration 2× e rollback. Sem efeito persistente.
- Provas: acesso anônimo/estudante/suspenso recusado, API antiga não contorna identidade PJ, versão desatualizada e empresa inválida recusadas antes de cópia, CNPJ alfanumérico, snapshot congelado, repetição idempotente e preservação do contrato anterior. Nenhuma mensagem externa ou dado financeiro real foi usado no teste.
- PDF renderizado e revisado em todas as páginas; conferência automática de limites e presença de todas as cláusulas numeradas.

Migration, teste SQL, validação Deno e tour registrados em `deploy/vps/release.sh`/`lib/featureTours.ts`. Publicações futuras somente pelo release oficial, com árvore limpa na branch configurada. Conferir a oferta no banco e os bundles publicados antes de declarar uma nova versão ativa.

## Publicação conferida

- Release oficial concluído com 1.276 testes Vitest, 1.483 testes Deno, typechecks, build, pré-validação dupla das migrations com rollback e as 175 suítes SQL registradas; testes HTTP finais aprovados.
- Oferta efetiva conferida no PostgreSQL da VPS: TEACHER 3 e STUDENT 2; catálogo V3 e one-shot presentes. Nova RPC disponível somente para autenticados; `anon` sem execução e corpo legado em `private` sem execução pelo navegador.
- Hashes dos quatro arquivos publicados de `register-teacher` e `tenant-legal-assets` iguais aos da origem. Cinco bundles HTTP conferidos, incluindo as quatro telas contratuais e o tour de novidade.
- Comparação antes/depois: os três registros contratuais existentes e as nove assinaturas de professores foram preservados integralmente nos campos verificados. Nenhum novo aceite real foi criado para testar a publicação.
- Backup reversível do release em `/opt/wisewolf/backups/release-20261027T003901Z-40582250ab26`; referência reservada da comparação em `/opt/wisewolf/backups/teacher-pj-publish-20261027T002811Z`. Arquivos privados locais e relatórios de alunos foram preservados fora do repositório público.
- Aditivo para professores que já assinaram e assinatura obrigatória individual por aluno continuam sem implementação neste release.
