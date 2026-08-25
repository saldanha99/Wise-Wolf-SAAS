update public.hub_plans
set
  name = 'Descoberta Professor',
  description = 'Acesso gratuito para preparar a primeira aula com a Wise Wolf.',
  audience = 'EDUCATOR',
  features = '["Prévia da biblioteca", "2 planos com Educador IA", "Prática inicial com o Wolfie", "Sem cartão"]'::jsonb
where code = 'DISCOVERY';

update public.hub_plans
set
  name = 'Professor Essencial',
  description = 'Biblioteca organizada para preparar aulas com mais agilidade.',
  features = '["Biblioteca com curadoria", "Filtros por nível e contexto", "Atualizações do acervo", "Uso individual"]'::jsonb
where code = 'LIBRARY_SOLO';

update public.hub_plans
set
  name = 'Professor Pro',
  description = 'Biblioteca e inteligência pedagógica para planejar com contexto.',
  features = '["Biblioteca completa", "Educador IA", "40 gerações mensais", "Planos estruturados por objetivo"]'::jsonb
where code = 'EDUCATOR_PRO';

update public.hub_plans
set
  name = 'Professor Studio',
  description = 'Preparação pedagógica e prática individual no mesmo Hub.',
  features = '["Tudo do Professor Pro", "Wolfie por texto no Hub", "60 interações mensais", "Cotas pedagógicas ampliadas"]'::jsonb
where code = 'HUB_COMPLETE';
