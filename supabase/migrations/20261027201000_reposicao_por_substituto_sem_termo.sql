-- Reexecutável. Reposição de aluno atual dada por OUTRO professor segue a mesma
-- regra da cobertura pontual (20261027190000): o titular tem vínculo antigo ou
-- termo vigente e o substituto tem contrato geral aceito e está elegível.
-- Medido em 27/10/2026: a reposição da Bianca (titular Débora) atribuída à Bruna
-- era recusada com "Assinatura do termo individual pendente".
-- Aluno novo e professor sem contrato geral continuam exigindo termo.
do $patch$
declare s text;anchor text;
begin
 s:=pg_get_functiondef('private.guard_student_individual_term()'::regprocedure);
 if strpos(s,'reposicao_por_substituto')=0 then
  anchor:=E'  if sid is not null and teacher is not null and private.student_term_covers_reschedule(t,sid,teacher) then return new;end if;\n';
  if strpos(s,anchor)=0 then raise exception 'guard_reschedule_anchor_changed';end if;
  execute replace(s,anchor,anchor||E'  -- reposicao_por_substituto: aluno atual, substituto com contrato geral.\n  if sid is not null and teacher is not null and exists(select 1 from public.profiles st where st.id=sid and st.tenant_id=t\n   and (private.student_term_coverage_exempt(t,sid,st.professor_id,teacher) or private.student_term_coverage_exempt(t,sid,st.professor_id2,teacher))) then return new;end if;\n');
 end if;
end;$patch$;
