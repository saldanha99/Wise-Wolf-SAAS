-- Popula os dados reais da Wise Wolf Language em tenants.school_info
-- (dados recuperados do código antes do commit 17ad4f9 que os removeu da fonte).
-- Usados no cabeçalho/rodapé/qualificação das partes do contrato (ContractDocument).
UPDATE public.tenants
SET school_info = jsonb_build_object(
  'name', 'WISE WOLF LANGUAGE',
  'cnpj', '55.806.029/0001-57',
  'address', 'Rua Um, 256 - Recanto do Céu - Santa Isabel/SP',
  'email', 'wisewolflanguage@gmail.com',
  'phone', '(11) 97168-1451',
  'city', 'Santa Isabel',
  'state', 'SP',
  'directorName', 'Wise Wolf Language'
)
WHERE id IN ('school-wise-wolf', 'wise-wolf-school');
