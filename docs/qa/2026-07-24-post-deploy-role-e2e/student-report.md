# Auditoria pós-deploy — Aluno

Data: 2026-07-24

Ambiente: produção

Perfil: `STUDENT`

Viewports principais: desktop 1440×900 e mobile 390×844

## Resultado

**Aprovado após as correções.**

Foram abertas as 10 rotas disponíveis no menu do Aluno e a tela de Perfil no
mobile. Todas mantiveram largura responsiva, sem alerta inesperado,
exceção de página ou erro relevante no console.

Dashboard, onboarding, contrato, prática e evolução também foram exercitados
em desktop ou nos dois tamanhos de tela.

## Validações

- O drawer mobile alcança o último item e não produz estouro horizontal.
- O onboarding permanece dentro da viewport nos cinco passos.
- O foco entra no onboarding, circula dentro do diálogo e volta ao elemento
  correto ao fechar.
- O passo atual do onboarding é preservado durante a sessão.
- O contrato recebe foco inicial no botão de fechar e devolve o foco ao botão
  que abriu o diálogo.
- A prática recriou quatro atividades de fixture sem chamar IA externa.
- As quatro atividades ficaram pendentes e com `generated_by_ai=false`.
- Evolução concluiu com o estado válido “Ainda não há registros de aula
  suficientes”, sem erro da função de insights.
- Perfil, aulas, links, materiais, financeiro, indicações, treinamentos,
  prática, evolução e Wolfie ficaram utilizáveis em 390×844.

## Regressões encerradas

| Regressão | Situação final |
|---|---|
| Onboarding extrapolava a viewport e perdia estado | Corrigida |
| Diálogo de contrato não gerenciava foco | Corrigida |
| Prática não diferenciava fallback de fixture | Corrigida |
| Insights consultavam coluna inexistente | Corrigida |
| Gráficos podiam iniciar com largura/altura inválidas | Corrigida |

## Evidências

- [Dashboard desktop](student-final-dashboard-desktop.png)
- [Dashboard mobile](student-final-dashboard-mobile.png)
- [Último passo do onboarding mobile](student-final-onboarding-last-mobile.png)
- [Contrato com foco](student-final-contract-dialog.png)
- [Prática com fallback isolado](student-final-mobile-practice-fallback.png)
- [Evolução final mobile](student-d23-evolution-final-mobile.png)
- [Perfil mobile](student-d23-mobile-profile-final.png)
- [Último item do menu mobile](student-final-mobile-menu-end.png)

## Limpeza

As quatro atividades recriadas, a conta, a sessão, os tokens, o perfil e o
tenant exclusivos desta auditoria foram removidos depois do backup. A
varredura estrutural e de payloads de log retornou zero resíduos.
