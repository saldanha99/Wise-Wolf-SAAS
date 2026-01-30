-- Add unique constraint to profiles to prevent duplication within a tenant
-- We want to ensure one email/cpf per tenant, or globally?
-- Usually email is global for auth, but profile might be tenant specific. 
-- However, `auth.users` handles email uniqueness globally.
-- Let's enforce unique CPF per tenant.

ALTER TABLE public.profiles
ADD CONSTRAINT profiles_cpf_tenant_key UNIQUE (cpf, tenant_id);

-- Also ensure email is unique per tenant in profiles (though auth handles it, profiles should match)
ALTER TABLE public.profiles
ADD CONSTRAINT profiles_email_tenant_key UNIQUE (email, tenant_id);
