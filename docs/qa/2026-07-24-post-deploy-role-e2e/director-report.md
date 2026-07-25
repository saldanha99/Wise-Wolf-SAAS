# Auditoria pós-deploy — Diretor

Data: 2026-07-24

Ambiente: produção

Perfil: `SCHOOL_ADMIN`

Viewports principais: desktop 1440×900 e mobile 390×844

## Resultado

**Aprovado após as correções.**

Foram abertas as 33 rotas disponíveis no menu do Diretor e a tela de Perfil no
mobile. As rotas finais mantiveram `clientWidth` igual a `scrollWidth`, sem
estouro horizontal, alertas inesperados, exceções de página ou erros
relevantes no console.

Também foram retestados em desktop os fluxos centrais de Dashboard, Alunos,
Professores, Financeiro e Wolfie.

## Validações

- O rodapé da sidebar não cobre mais os itens de navegação.
- A área de menu rola de forma independente.
- `End` leva o foco ao último item e `Enter` abre a rota correta.
- O drawer mobile mantém o foco dentro do menu enquanto está aberto.
- O Wolfie exibe um estado vazio válido para o tenant de teste.
- A tela de Alunos não grava mais os dados de agendamentos no console.
- O Perfil abre corretamente em 390×844.
- O conteúdo principal permanece responsivo em todas as rotas verificadas.

## Regressões encerradas

| Regressão | Situação final |
|---|---|
| Frontend vazio por variáveis ausentes no bundle | Corrigida |
| Tenant textual enviado para filtro UUID do Wolfie | Corrigida |
| Rodapé desviando cliques para Perfil/Sair | Corrigida |
| Itens inferiores inacessíveis no menu | Corrigida |
| Dados de agendamentos no console | Corrigida |

## Evidências

- [Dashboard limpo](director-f939-dashboard-clean.png)
- [Lista de alunos sem log de agendamentos](director-31b-students-final.png)
- [Menu mobile no último item](director-d23-mobile-menu-final.png)
- [Perfil mobile](director-d23-mobile-profile-final.png)
- [Wolfie em estado vazio](director-final-wolfie-empty.png)
- [Professores em desktop](director-final-professors.png)

## Limpeza

A conta, a sessão, os tokens, o perfil e o tenant exclusivos desta auditoria
foram removidos depois do backup. A varredura estrutural e de payloads de log
retornou zero resíduos.
