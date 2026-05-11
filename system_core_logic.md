# Lógica do Sistema Wise-Wolf SAAS
Este documento consolida toda a lógica estrutural e de roteamento do sistema para avaliação do Cloud Code.

---

## 1. Disparo de Aula Experimental (Opportunity Broadcast)
A aula experimental (Opportunity) é criada e disparada no backend via Supabase Edge Functions.

```typescript
// Extraído de: supabase/functions/broadcast-opportunity/index.ts

// 1. O sistema recebe dados do agendamento
const { student_name, student_phone, date, time, interests, preferred_slots } = await req.json();

// 2. Insere a oportunidade no banco de dados com status 'OPEN'
const { data: oppData, error: oppError } = await supabaseAdmin
    .from('opportunities')
    .insert({
        student_name: student_name,
        student_phone: student_phone || '',
        slots_proposed: [{ day: dayOfWeek, time: time, date: date, formatted: `${formattedDate} (${dayString})` }],
        status: 'OPEN',
        tenant_id: profile?.tenant_id || null,
        interests: interests || null,
        user_id: user.id, // Quem gerou (Diretor/Admin)
        preferred_slots: preferred_slots || null,
    })
    .select('id')
    .single();

// 3. Gera o Link Mágico (Claim Link) para o professor aceitar a aula
const params = new URLSearchParams({
    id: oppData.id,
    date: date,
    time: time,
    studentName: student_name,
    studentPhone: student_phone || ''
});
const claimLink = `https://system.wisewolflanguage.com.br/claim-opportunity?${params.toString()}`;

// 4. Dispara a mensagem no WhatsApp (via Evolution API) para o grupo de professores
const textMessage = `🐺⚡ *EXPERIMENTAL — ${formattedDate} (${dayString}) às ${time}*...
👇 *Aceitar agora:*
${claimLink}`;
```

---

## 2. Gerações de Links (Recrutamento e Matrícula)
Os links no sistema carregam o payload criptografado em Base64 na URL, garantindo segurança e que o usuário final receba a oferta pré-configurada pelo admin.

### 2.1. Recrutamento de Professores
```typescript
// Extraído de: components/TeacherInviteGenerator.tsx
const payload = {
    hourlyRate: parseFloat(hourlyRate) || 16,
    subject,
    tenantId
};

// Conversão para Base64 (UTF-8 Safe)
const json = JSON.stringify(payload);
const base64Payload = btoa(encodeURIComponent(json).replace(/%([0-9A-F]{2})/g,
    function toSolidBytes(match, p1) { return String.fromCharCode(parseInt(p1, 16)); }
));

// URL Final para o Professor (Frontend lida com o parse em /teacher-onboarding)
const url = `${APP_BASE_URL}/teacher-onboarding?offer=${base64Payload}`;
```

### 2.2. Recrutamento de Vendedores
```typescript
// Extraído de: components/CommercialInviteGenerator.tsx
const payload = {
    baseSalary: parseFloat(baseSalary) || 0,
    commissionRate: parseFloat(commissionRate) || 10,
    department: 'Sales',
    role: 'COMMERCIAL',
    tenantId
};

const json = JSON.stringify(payload);
const base64Payload = btoa(encodeURIComponent(json).replace(/%([0-9A-F]{2})/g,
    function toSolidBytes(match, p1) { return String.fromCharCode(parseInt(p1, 16)); }
));

// URL Final para o Vendedor (Frontend lida com o parse em /commercial-onboarding)
const url = `${APP_BASE_URL}/commercial-onboarding?offer=${base64Payload}`;
```

### 2.3. Link de Matrícula para Alunos
```typescript
// Extraído de: components/RegistrationLinkGenerator.tsx
const data = {
    unitId: tenantId,
    value: monthlyFee, // Preço acordado
    planDuration: duration, // Ex: 12, 6 ou 1
    classesPerWeek: frequency, // Ex: 2x na semana
    dueDay: dueDay,
    professorId: selectedProfessor || null,
    professorId2: selectedProfessor2 || null,
    schedule: validSchedule.length > 0 ? validSchedule : null,
    startDate: startDate,
    requiresEnrollment: duration !== 0,
    enrollmentFee: chargeEnrollmentFee ? enrollmentFee : 0
};

const jsonStr = JSON.stringify(data);
const base64 = btoa(unescape(encodeURIComponent(jsonStr)));

// URL Final para o Aluno se Matricular
const url = `${APP_BASE_URL}/matricula?data=${base64}`;
```

---

## 3. Continuidade nas Rotas (Fluxo Pós-Aula Experimental)
Após uma aula experimental (`Opportunity` convertida em `Booking`), o sistema entra na fase de feedback para fechar o ciclo.

```typescript
// Extraído de: components/TrialFeedback.tsx & components/TrialsToContracts.tsx
// 1. O Professor realiza a aula e preenche o Feedback (TRIAL_FEEDBACK)
const submitFeedback = async (status: 'CONVERTED' | 'MISSED' | 'NOT_INTERESTED') => {
    // Atualiza a aula de experimental
    await supabase.from('bookings').update({ status }).eq('opportunity_id', trial.id);

    // Atualiza a oportunidade
    await supabase.from('opportunities').update({ status }).eq('id', trial.id);
    
    // Se converteu, notifica os diretores/vendedores (CRM Update)
    if (status === 'CONVERTED') {
        // Envia notificação / Alerta de conversão pendente de Matrícula Oficial
    }
}

// 2. Continuidade no Painel Comercial/Admin:
// O Administrador / Vendedor vê na aba "Aulas Experimentais (Trial)" o status da aula.
// Se Status === 'CONVERTED', o vendedor pode clicar em "Gerar Link de Matrícula"
// que reaproveita os dados (Aluno, Telefone, Professor que deu a aula, Horário) e
// injeta diretamente no RegistrationLinkGenerator.
```

---

## 4. Lógica de "Indique e Ganhe" (Programa de Afiliados)
O sistema possui a geração de links parametrizados via código de afiliado (UUID do usuário logado) e capta essa referência (Ref) na hora da matrícula.

### 4.1. Geração do Link de Indicação
```typescript
// Extraído de: components/AffiliatePanel.tsx e components/TeacherAffiliateCard.tsx
// Identifica quem está gerando a indicação (Pode ser Professor, Aluno, Vendedor)
const affiliateLink = `${APP_BASE_URL}/matricula?ref=${user.id}`;

// Formato da mensagem:
const shareText = `👉 ${affiliateLink}\n\nGaranta sua vaga na Wise Wolf...`;
```

### 4.2. Captação da Indicação e Matrícula
```typescript
// Extraído de: components/PublicRegistration.tsx
// 1. Na página de matrícula, o sistema busca na URL o parâmetro `ref`
const urlParams = new URLSearchParams(window.location.search);
const affiliateRefId = urlParams.get('ref'); // O ID do usuário que indicou

// 2. Quando o aluno finaliza a matrícula e o perfil (STUDENT) é criado:
if (affiliateRefId) {
    // a) O sistema verifica quem é o dono do ID referenciado (se é ALUNO ou PROFESSOR/VENDEDOR)
    const { data: referrerData } = await supabase.from('profiles').select('role').eq('id', affiliateRefId).single();
    
    // b) Aplica a lógica de benefício (Ex: Desconto na próxima mensalidade ou Comissão)
    // Se o referrerData.role === 'TEACHER' || 'COMMERCIAL':
    // -> Adiciona R$ 50,00 no fechamento mensal do professor/vendedor (TeacherClosings/Commissions)
    // Se o referrerData.role === 'STUDENT':
    // -> Registra um desconto (Discount/Credit) na próxima cobrança Asaas do aluno que indicou.
    
    // Opcionalmente, salvar na tabela de afiliados:
    await supabase.from('affiliate_conversions').insert({
        referrer_id: affiliateRefId,
        new_student_id: newUserId,
        status: 'CONVERTED',
        reward_amount: 50.00
    });
}
```
