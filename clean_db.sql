-- SCRIPT DE LIMPEZA COMPLETA (PARA WISE WOLF LANGUAGES)
-- Execute no SQL Editor do Supabase

BEGIN;

-- 1. Remover agendamentos, faltas e reagendamentos
DELETE FROM bookings;
DELETE FROM reschedules;
-- DELETE FROM lessons; -- se existir

-- 2. Remover perfis (ajuste se quiser manter o seu perfil admin atual)
-- Se você souber seu ID de admin, use: DELETE FROM profiles WHERE id != 'seu-id-aqui';
-- Caso contrário, para limpar tudo:
DELETE FROM profiles WHERE role != 'SUPER_ADMIN'; 

-- 3. Limpar Escolas (Tenants) que não sejam a principal
-- DELETE FROM tenants WHERE id NOT IN ('school-wise-wolf');

COMMIT;

-- NOTA: Para limpar os usuários de Login, vá em:
-- Authentication -> Users e remova manualmente os e-mails de teste.
