-- O termo individual só executa com as DUAS assinaturas e a confirmação da
-- família (achado em 01/11/2026 testando o link da Teacher Maria em rollback).
-- Antes do link, o professor só assinava depois da escola, e o ramo dele
-- executava olhando só a família. A migration 20261101010000 liberou "qualquer
-- ordem" e tirou essa espera, mas o ramo do professor ficou igual: professor
-- assinando primeiro com a família já confirmada viraria EXECUTED sem a escola
-- (liberando matrícula e agenda). Nenhum termo chegou a executar assim.
do $patch$
declare s text;anchor text;
begin
 s:=pg_get_functiondef('public.teacher_student_terms(text,uuid,jsonb)'::regprocedure);
 anchor:='teacher_typed_name=name,status=case when family_confirmed_at is not null then ''EXECUTED'' else status end';
 if strpos(s,anchor)>0 then
  s:=replace(s,anchor,'teacher_typed_name=name,status=case when school_signed_at is not null and family_confirmed_at is not null then ''EXECUTED'' else status end');
  execute s;
 elsif strpos(s,'teacher_typed_name=name,status=case when school_signed_at is not null and family_confirmed_at is not null')=0 then
  raise exception 'term_teacher_sign_anchor_changed';
 end if;
end;$patch$;
