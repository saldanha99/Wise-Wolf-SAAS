# Contrato geral PJ do professor — versão 3

Preparado em 26/10/2026 por solicitação da direção. **Não publicado**. Sem assinatura real, comunicação externa, cobrança ou alteração persistente de contrato nesta revisão.

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

Migration, teste SQL, validação Deno e tour registrados em `deploy/vps/release.sh`/`lib/featureTours.ts`. Publicação somente pelo release oficial, com árvore limpa na branch configurada, após conferência jurídica da minuta e da execução real da prestação. Não declarar V3 ativa antes de conferir a oferta no banco e os bundles publicados.
