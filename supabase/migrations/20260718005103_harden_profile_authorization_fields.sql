-- Protect the fields used by application authorization. RLS controls which
-- rows are writable, while this trigger prevents a user from turning an
-- otherwise legitimate self-profile update into a role/tenant escalation or
-- claiming a WhatsApp instance managed by the server-side proxy.
CREATE OR REPLACE FUNCTION public.enforce_profile_authorization_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  actor_role text;
  privileged_runtime boolean := current_user IN ('postgres', 'service_role', 'supabase_admin');
BEGIN
  IF privileged_runtime THEN
    RETURN NEW;
  END IF;

  SELECT p.role INTO actor_role
  FROM public.profiles AS p
  WHERE p.id = (SELECT auth.uid());

  IF actor_role = 'SUPER_ADMIN' THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.whatsapp_instance IS DISTINCT FROM OLD.whatsapp_instance
     OR NEW.whatsapp_instance_id IS DISTINCT FROM OLD.whatsapp_instance_id
     OR NEW.whatsapp_instance_name IS DISTINCT FROM OLD.whatsapp_instance_name
     OR NEW.whatsapp_token IS DISTINCT FROM OLD.whatsapp_token THEN
    RAISE EXCEPTION 'authorization-managed profile fields cannot be changed by this role'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_profile_authorization_fields ON public.profiles;
CREATE TRIGGER protect_profile_authorization_fields
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.enforce_profile_authorization_fields();

-- Instance credentials and ownership are server-managed. The client may read
-- only non-secret metadata and only inside its own scope.
ALTER TABLE public.whatsapp_instances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Leitura Geral WhatsInstances" ON public.whatsapp_instances;
DROP POLICY IF EXISTS "Users can delete own instances" ON public.whatsapp_instances;
DROP POLICY IF EXISTS "Users can insert own instances" ON public.whatsapp_instances;
DROP POLICY IF EXISTS "Users can manage their own instances" ON public.whatsapp_instances;
DROP POLICY IF EXISTS "Users can update own instances" ON public.whatsapp_instances;
DROP POLICY IF EXISTS "Users can view own instances" ON public.whatsapp_instances;

REVOKE ALL ON TABLE public.whatsapp_instances FROM anon, authenticated;
GRANT SELECT (id, user_id, instance_name, instance_id, status, updated_at)
  ON public.whatsapp_instances TO authenticated;

CREATE POLICY whatsapp_instances_scoped_read
ON public.whatsapp_instances
FOR SELECT
TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR public._my_role() = 'SUPER_ADMIN'
  OR EXISTS (
    SELECT 1
    FROM public.profiles AS owner
    WHERE owner.id = whatsapp_instances.user_id
      AND owner.tenant_id = public._my_tenant_id()
      AND public._my_role() = 'SCHOOL_ADMIN'
  )
);

-- AI messages inherit ownership from their conversation. Remove the two
-- historical policies whose expressions reduced to true for every signed-in
-- user, which exposed all conversations cross-tenant.
ALTER TABLE public.ai_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view messages" ON public.ai_messages;
DROP POLICY IF EXISTS "Users can insert their own messages" ON public.ai_messages;
DROP POLICY IF EXISTS ai_msg_own_insert ON public.ai_messages;
DROP POLICY IF EXISTS "Alunos veem mensagens" ON public.ai_messages;

CREATE POLICY ai_messages_owner_read
ON public.ai_messages
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.ai_conversations AS conversation
    WHERE conversation.id = ai_messages.conversation_id
      AND conversation.student_id = (SELECT auth.uid())
  )
);

-- Conversation creation and message writes now happen only through the
-- authenticated tutor Edge Function. Retain owner-scoped reads for the app,
-- but remove legacy table-level write and maintenance privileges.
REVOKE ALL ON TABLE public.ai_messages FROM anon, authenticated;
GRANT SELECT ON TABLE public.ai_messages TO authenticated;

ALTER TABLE public.ai_conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Alunos inserem suas conversas" ON public.ai_conversations;
REVOKE ALL ON TABLE public.ai_conversations FROM anon, authenticated;
GRANT SELECT ON TABLE public.ai_conversations TO authenticated;
