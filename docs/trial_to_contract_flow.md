# Fluxo: Aula Experimental → Link de Matrícula → Contrato

## Visão Geral

```
Lead (Oportunidade)  →  Experimental (Claim)  →  Feedback  →  Link Matrícula  →  Aluno se Matricula
     ↓                       ↓                      ↓              ↓                    ↓
  opportunities         appointments          trial_feedback   enrollment_links     profiles (STUDENT)
  status='OPEN'         type='experimental'                    status='PENDING'     + student_contracts
                                                                                   opportunities = WON
```

> [!IMPORTANT]
> O aluno **NÃO é criado** durante a experimental nem ao gerar o link.
> O `profile` (role=STUDENT) só é criado quando o aluno **preenche o link mágico**.

---

## Etapas do Fluxo

### 1. Criação da Oportunidade (Diretor)
- Diretor cria vaga relâmpago
- `opportunities` → `status = 'OPEN'`
- Dados do lead: `student_name`, `student_phone`

### 2. Claim da Experimental (Professor)
**Componente:** `ClaimOpportunity.tsx`

| Ação | Tabela | Campos |
|---|---|---|
| Cria agendamento | `appointments` | `type='experimental'`, `professor_id`, `student_name`, `student_phone` |
| Atualiza oportunidade | `opportunities` | `status='CLAIMED'`, `winner_teacher_id`, `trial_appointment_id`, `trial_status='SCHEDULED'`, `conversion_status='OPEN'` |

**NÃO cria:** ❌ profiles, ❌ student_contracts, ❌ enrollment_links

### 3. Após a Aula (Professor)
- Professor marca `trial_status = 'DONE'`
- Professor registra `trial_feedback`: nível, plano, interesse (1-5), notas

### 4. Gerar Link de Matrícula (Diretor)
**Componente:** `TrialsToContracts.tsx`

O diretor vê a experimental na aba *Experimentais* e clica **"Gerar Link Matrícula"**.

O modal pré-preenche:
- **Professor** = `winner_teacher_id` (da experimental)
- **Frequência** = baseada no `trial_feedback.recommended_plan`
- **Plano** = Anual (padrão), Semestral ou Mensal
- **Preço** = calculado automaticamente pela `PRICING_TABLE`

Ao clicar "Gerar Link Mágico":
1. Cria registro em `enrollment_links` (status=PENDING)
2. Gera URL `/matricula?data=<base64>` com `opportunityId` embutido
3. Link fica visível no card da experimental

### 5. Aluno Completa Matrícula
**Componente:** `PublicRegistration.tsx`

Ao completar (pagamento confirmado):
1. Cria `profiles` (role=STUDENT) com `professor_id = professorId` do link
2. Cria assinatura no Asaas
3. **Se `opportunityId` no link:**
   - Atualiza `opportunities.conversion_status = 'WON'`, `student_id = userId`
   - Atualiza `enrollment_links.status = 'USED'`

---

## Tabelas Envolvidas

| Tabela | Quando é usada |
|---|---|
| `opportunities` | Criação da vaga → Claim → Link → Conversão |
| `appointments` | Claim (agendamento experimental) |
| `trial_feedback` | Após a aula (feedback do professor) |
| `enrollment_links` | Geração do link de matrícula |
| `profiles` | **Somente quando aluno preenche o link** (role=STUDENT) |

## KPIs Disponíveis

| KPI | Cálculo |
|---|---|
| Total | Todas as experimentais |
| Aula Feita | `trial_status = 'DONE'` |
| Links Enviados | experimentais com `enrollment_links` |
| Convertidos | `conversion_status = 'WON'` |
| Perdidos | `conversion_status = 'LOST'` |
| Taxa Conversão | Convertidos / Aulas Feitas × 100 |
