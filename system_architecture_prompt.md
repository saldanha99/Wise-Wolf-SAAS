# Documentação de Arquitetura e Engenharia do Sistema: Wise Wolf SaaS

**Identidade do Sistema:** Wise Wolf SaaS - Plataforma de Gestão Escolar Multi-tenant
**Stack Tecnológica:** React (Vite), TailwindCSS, Supabase (Auth, Database, Storage, Edge Functions)

---

## 1. Arquitetura de Alto Nível e Multi-Inquilino (Multi-Tenancy)
O sistema é projetado como um **SaaS (Software as a Service)** onde múltiplas escolas (Tenants/Inquilinos) coexistem em um único banco de dados, mas são logicamente isoladas.

*   **Estratégia de Isolamento:** Row-Level Security (RLS) no PostgreSQL.
    *   Toda tabela principal (`profiles`, `bookings`, `financials`, etc.) DEVE ter uma coluna `tenant_id`.
    *   Políticas RLS forçam `tenant_id = auth.user_metadata.tenant_id` (ou unido via tabela profiles).
*   **Master Tenant:** O inquilino 'master' (EduCore/Wise Wolf Platform) tem privilégios de Super Admin para visualizar/gerenciar outros inquilinos.
*   **Autenticação:** Supabase Auth gerencia a identidade.
    *   **Claims:** `tenant_id` e `role` são armazenados em `raw_user_meta_data`, mas a *fonte da verdade* para a lógica da aplicação é a tabela `profiles`.
    *   **Contas Demo:** UUIDs específicos são "hardcoded" (fixos) para usuários demo (ex: `professor.demo@wisewolf.com`) para garantir ambientes de teste estáveis.

## 2. Entidades Principais e Hierarquia

### 2.1. Tenant (Escola)
*   **Entidade Raiz.** Define o escopo dos dados.
*   **Campos Chave:** `id` (Texto, ex: 'wise-wolf-school'), `plan_id` (Link para Plano SaaS), `branding` (JSONB: cores, logo).
*   **Limites:** `student_limit` (limite de alunos), `teacher_limit` (limite de professores) - Forçados via RLS/Triggers.

### 2.2. Usuários (Profiles)
*   **Papéis (Roles):**
    *   `SUPER_ADMIN`: Dono da plataforma (SaaS). Acesso total.
    *   `SCHOOL_ADMIN`: Diretor/Gestor da escola. Acesso total dentro do seu `tenant_id`.
    *   `TEACHER`: Pode ver sua própria agenda, alunos e financeiro.
    *   `STUDENT`: Pode ver sua própria agenda, materiais e histórico financeiro.
*   **Auto-Correção (Self-Healing):** Código em `Login.tsx` detecta se um usuário Auth válido não possui uma linha na tabela `profiles` e a cria automaticamente para evitar usuários "fantasmas".

### 2.3. Calendário e Aulas
*   **Booking (Agendamento):** Representa um *horário agendado* fixo (ex: "Segundas às 10:00").
*   **ClassLog (Registro de Aula):** Representa a *execução* de uma aula em uma data específica.
    *   **Vínculo:** Ligado a um `booking_id` OU `reschedule_id` (reposição).
    *   **Status:** `PRESENÇA`, `FALTA`, `FALTA_JUSTIFICADA`, `FALTA DO PROFESSOR`.
    *   **Lógica:** Uma aula só é "Cobrada" ou "Paga" se existir um Log/Registro.

### 2.4. Financeiro
*   **Professor:**
    *   `HOURLY_RATE`: Definido em `profiles`.
    *   `TeacherClosing`: Tabela agregadora mensal. Armazena `total_lessons` (total de aulas), `total_amount` (valor total), `status` (PENDENTE -> CONFIRMADO -> PAGO).
    *   **Regra de Cálculo:** `Valor = Contagem(Logs onde status != 'FALTA DO PROFESSOR' E subtype != 'REPOSIÇÃO') * ValorHora`. *Reposições não são pagas novamente na execução, pois a aula original perdida já foi considerada.*
*   **Aluno:**
    *   `Invoices`: Notas fiscais/Cobranças. Ligadas a `profiles`. Gerenciadas manualmente ou via integração (futuro).

## 3. Armazenamento e Padrões de Engenharia

### 3.1. Buckets do Supabase Storage
*   **`avatars`**: Fotos de perfil. Leitura pública, Upload autenticado.
    *   *Peculiaridade de Engenharia:* Limite de arquivo aumentado para 20MB. Sanitização de caminho usada para evitar conflitos UUID/Texto.
*   **`invoices`**: Notas Fiscais dos professores. Privado (RLS Autenticado).
*   **`materials`**: Arquivos pedagógicos (PDFs).
    *   *Escopos:* `GLOBAL` (Sistema todo), `TENANT` (Apenas escola), `PRIVATE` (Dono professor).

### 3.2. Triggers e Funções de Banco de Dados
*   **`enforce_storage_limit`**:
    *   *Propósito:* Impedir que inquilinos excedam sua cota de disco do plano.
    *   *Lógica:* Soma `metadata->size` da tabela `storage.objects`. Compara com `saas_plans.features->>'storage_limit'`.
    *   *Correção Crítica:* Lida com `tenant_id` baseado em texto e extração de JSONB para limites.

### 3.3. Engenharia Client-Side (Frontend)
*   **Roteador:** Estado `activeTab` personalizado em `App.tsx` (Comportamento SPA sem React Router para abas do Dashboard).
*   **Gerenciamento de Estado:**
    *   `loadAppData()` em `App.tsx` busca dados "Globais" (Usuário Atual, Tenant, Professores) e passa via props (prop-drilling) para componentes.
    *   Componentes gerenciam dados locais (ex: `TeacherFinancials` busca seus próprios logs).
*   **Tema:** Estratégia de classe `dark` do Tailwind. Cores da marca injetadas via Variáveis CSS (`--primary-color`).

## 4. Fluxos Operacionais (Como funciona)

### 4.1. O "Ciclo de Vida da Aula"
1.  **Agendamento:** Admin/Professor cria um `Booking` recorrente.
2.  **Lançador:** `LessonLauncher.tsx` detecta "Agendamentos de Hoje".
3.  **Execução:** Professor clica em "Lançar Aula". Cria um `class_log`.
4.  **Regularização:** Se um professor esquece, aparece em `PendingLessons.tsx` (últimos 7 dias).
5.  **Financeiro:** No fim do mês, `TeacherFinancials.tsx` agrega esses logs em um relatório `TeacherClosing` para pagamento.

### 4.2. Financeiro "Self-Service" (Professor)
1.  Sistema auto-calcula o valor.
2.  Professor revisa no "Cofre do Professor".
3.  Professor clica em "Confirmar" (anexa Nota Fiscal/Recibo).
4.  Admin recebe "Pendente de Aprovação" em `InvoiceManager.tsx`.
5.  Admin aprova -> Status `AGUARDANDO_PAGAMENTO`.
6.  Admin marca como pago -> Status `PAGO`.

### 4.3. Pedagógico
*   **Acesso Granular:** Visibilidade do material depende do escopo. Alunos só veem materiais se:
    *   For `GLOBAL` (Biblioteca Pública).
    *   Pertencer ao seu `TENANT` (Escola).
    *   *Futuro:* For explicitamente atribuído a eles via `TeacherPedagogicalModal` (Atribuições).

## 5. Notas Críticas de Engenharia para IA
*   **UUID vs Texto:** O sistema usa **UUIDs** para Usuários (Supabase Auth) mas strings de **TEXTO** para IDs de Tenant (ex: 'wise-wolf-school'). *Sempre faça o 'cast' (conversão) com cuidado no SQL.*
*   **Fallback de Mock:** `constants.tsx` contém dados fictícios extensos (`MOCK_TENANTS`). O app frequentemente recorre a eles se o DB retornar null, útil para dev mas perigoso para prod se não tratado.
*   **Manipulação de Datas:** Todas as datas são armazenadas como strings ISO UTC mas exibidas no local do usuário (`pt-BR`).
*   **Sanitização:** Uploads de arquivos sanitizam nomes de arquivo para evitar que caracteres especiais quebrem os caminhos do Storage.

### 4.4. Fluxo de Matrícula (Onboarding)
O sistema possui um fluxo completo de "Link Mágico" para auto-matrícula de alunos:
1.  **Gerador de Links (`RegistrationLinkGenerator.tsx`):**
    *   Admin configura termos: Plano (Mensal/Semestral/Anual), Valor, Frequência e Dia de Vencimento.
    *   **Alocação Acadêmica:** Permite pré-selecionar o Professor Responsável (usa um *Searchable Dropdown* para lidar com listas grandes) e a Grade Horária.
    *   **Output:** Gera uma URL com payload Base64 contendo todos os parâmetros.
2.  **Registro Público (`PublicRegistration.tsx`):**
    *   Decodifica o payload Base64.
    *   Coleta dados pessoais e financeiros (Cartão/Pix/Boleto via Asaas).
    *   cria o Usuário (Auth), Perfil (DB), Assinatura (Asaas) e Agenda (Bookings) em uma única transação lógica.
    *   **Contrato Digital:** Gera um PDF dinâmico (`ContractDocument.tsx`) com assinatura digital e carimbo de autenticação (IP/Timestamp). Permite download imediato ou acesso futuro via URL assinada.

### 4.5. Gestão de Professores
*   **Reatribuição:** Admins podem alterar o professor responsável de um aluno a qualquer momento via `StudentProfileForm`, que agora suporta busca de professores para facilitar a gestão em escolas com grande corpo docente.

