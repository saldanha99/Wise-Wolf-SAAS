-- Close authenticated upload and path-traversal gaps in the private resumes bucket.

drop policy if exists resumes_authenticated_insert on storage.objects;
drop policy if exists resumes_tenant_admin_insert on storage.objects;

create policy resumes_tenant_admin_insert
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'resumes'
  and cardinality(storage.foldername(name)) = 1
  and private.can_admin_tenant((storage.foldername(name))[1])
  and lower(storage.extension(name)) in ('pdf', 'doc', 'docx')
);

create or replace function private.guard_anonymous_resume_path()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.uid()) is null
    and coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
    and (
      new.resume_url is null
      or new.resume_url !~* '^https://api[.]wisewolflanguage[.]com[.]br/storage/v1/object/public/resumes/school-wise-wolf/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](pdf|doc|docx)$'
    )
  then
    raise exception 'invalid public resume path' using errcode = '22023';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_anonymous_resume_path() from public, anon, authenticated;

drop trigger if exists guard_anonymous_resume_path on public.job_applications;
create trigger guard_anonymous_resume_path
before insert or update of resume_url on public.job_applications
for each row execute function private.guard_anonymous_resume_path();

comment on function private.guard_anonymous_resume_path() is
  'Restricts anonymous application resumes to canonical signed-upload paths.';
