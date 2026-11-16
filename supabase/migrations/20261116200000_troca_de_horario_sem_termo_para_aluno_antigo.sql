-- Troca de horário de aluno antigo não abre termo individual.
--
-- Caso (15/11/2026): a Teacher Laís pediu para mover a aula da Cleice (aluna dela
-- desde antes da política do termo) de 10:00 para 17:30 só naquele dia. O gatilho
-- de schedule_change_requests preparou um termo e mandou "Aluno novo para você"
-- com link de assinatura. O termo não trava nada (a agenda de vínculo antigo é
-- dispensada desde 20261027175500), mas a professora assinou achando que era o
-- que faltava para a agenda mudar. Isabella/Mateus (03/11) tinham 3 iguais.
--
-- Regra: mesmo professor com vínculo antigo (student_term_legacy_relationship) ou
-- com termo vigente cobrindo o aluno não ganha termo por troca de horário.
-- Remendo por âncora em private.student_term_source_proposal.

do $$
declare
  v_def text;
  v_anchor text := E'elsif tg_table_name=''schedule_change_requests'' then\n  if new.status in(''CANCELLED'',''REJECTED'',''DECLINED'',''EXPIRED'') then return new;end if;';
  v_patch text := E'elsif tg_table_name=''schedule_change_requests'' then\n  if new.status in(''CANCELLED'',''REJECTED'',''DECLINED'',''EXPIRED'') then return new;end if;\n  -- troca_de_horario_aluno_antigo: vínculo antigo ou termo vigente do mesmo professor dispensa termo novo\n  if private.student_term_legacy_relationship(new.tenant_id,new.student_id,new.teacher_id) or exists(select 1 from private.teacher_student_terms tt where tt.tenant_id=new.tenant_id and tt.student_id=new.student_id and tt.teacher_id=new.teacher_id and tt.status=''EXECUTED'' and tt.retired_at is null) then return new;end if;';
begin
  v_def := pg_get_functiondef('private.student_term_source_proposal'::regproc);
  if position('troca_de_horario_aluno_antigo' in v_def) > 0 then
    return;
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'ancora_de_student_term_source_proposal_nao_encontrada';
  end if;
  execute replace(v_def, v_anchor, v_patch);
end;
$$;

-- One-shot: encerra os termos já criados por troca de horário de aluno antigo
-- que ainda esperam a família. Termo executado não é tocado.
do $$
begin
  if exists(select 1 from public.schema_one_shots where key = 'troca_de_horario_sem_termo_aluno_antigo_20261116') then
    return;
  end if;
  update private.teacher_student_terms t
     set status = 'SUPERSEDED',
         closed_reason = 'Troca de horário de aluno com vínculo anterior ao termo: termo dispensado',
         updated_at = now()
   where t.source_kind = 'SCHEDULE_CHANGE'
     and t.status = 'PROPOSED'
     and private.student_term_legacy_relationship(t.tenant_id, t.student_id, t.teacher_id);
  insert into public.schema_one_shots(key, nota) values ('troca_de_horario_sem_termo_aluno_antigo_20261116', 'Termos PROPOSED de troca de horário de aluno antigo encerrados');
end;
$$;
