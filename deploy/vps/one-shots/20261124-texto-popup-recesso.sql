-- Texto revisado dos pop-ups do recesso 2026 (Vinícius, 24/11/2026, via Chefe).
-- Só dados em public.platform_notices; o modal respeita quebras de linha (whitespace-pre-line).
-- Reexecutável. Antes: textos da migration 20261124120000 (seção 10).
update public.platform_notices set body = E'De 24/12 (quinta) a 01/01 (sexta) não haverá aulas, incluindo o Natal (25/12) e o Ano-Novo (01/01).\n\nAs aulas voltam normalmente em 02/01/2027, no seu horário de sempre.\n\nAs aulas desses dias fazem parte do período regular do seu plano, sem reposição nem desconto na mensalidade. O mesmo vale para os feriados nacionais ao longo do ano.\n\nBoas festas!\nEquipe Wise Wolf'
 where tenant_id = 'school-wise-wolf' and slug = 'recesso-2026' and audience = 'STUDENT';
update public.platform_notices set body = E'De 24/12 a 01/01 não haverá aulas. As aulas voltam em 02/01/2027.\n\nAs aulas que estavam na sua agenda nesses dias serão lançadas automaticamente como "Recesso (remunerada)" ou "Feriado (remunerada)" e entram no seu pagamento normalmente. O mesmo vale para os feriados nacionais ao longo do ano.\n\nVocê não precisa registrar nada nem fazer reposição.\n\nBoas festas!\nEquipe Wise Wolf'
 where tenant_id = 'school-wise-wolf' and slug = 'recesso-2026' and audience = 'TEACHER';
