-- RAG do Wolfie e do Planner sem OpenRouter (22/11/2026, decisão do Vinícius).
--
-- Os vetores foram gerados com openai/text-embedding-3-small (1536 dimensões).
-- Os embeddings de consulta passam a ir direto na OpenAI, MESMO modelo (a
-- ponte _shared/ai-gateway.ts desvia o endereço antigo), então os vetores
-- guardados continuam compatíveis. Re-executável.

alter table public.ai_knowledge_bases drop constraint if exists ai_knowledge_bases_provider_check;
alter table public.ai_knowledge_bases
  add constraint ai_knowledge_bases_provider_check check (provider in ('OPENAI', 'OPENROUTER'));
alter table public.ai_knowledge_bases alter column provider set default 'OPENAI';

-- As bases que já existem NÃO são renomeadas: guard_ai_knowledge_embedding_config
-- deixa provider/modelo imutáveis depois de criada (os vetores dependem disso).
-- Nelas, 'OPENROUTER' passa a registrar só a origem dos vetores; a consulta vai
-- para a OpenAI (mesmo modelo). Bases novas nascem 'OPENAI'.

CREATE OR REPLACE FUNCTION public.match_wise_wolf_knowledge(p_tenant_id text, p_knowledge_base_id uuid, p_query_embedding vector, p_match_count integer DEFAULT 8, p_min_similarity double precision DEFAULT 0.45)
 RETURNS TABLE(chunk_id uuid, document_id uuid, title text, content text, similarity double precision, chunk_index integer, metadata jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select
    chunk.id,
    document.id,
    document.title,
    chunk.content,
    (
      1 - (
        chunk.embedding OPERATOR(extensions.<=>) p_query_embedding
      )
    )::double precision,
    chunk.chunk_index,
    document.metadata || chunk.metadata
  from public.ai_knowledge_chunks as chunk
  join public.ai_knowledge_documents as document
    on document.id = chunk.document_id
   and document.knowledge_base_id = chunk.knowledge_base_id
   and document.tenant_id = chunk.tenant_id
  join public.ai_knowledge_bases as base
    on base.id = chunk.knowledge_base_id
   and base.tenant_id = chunk.tenant_id
  where chunk.tenant_id = p_tenant_id
    and chunk.knowledge_base_id = p_knowledge_base_id
    and document.status = 'READY'
    and base.status = 'ACTIVE'
    and base.provider in ('OPENAI', 'OPENROUTER')
    and base.embedding_dimensions = 1536
    and 1 - (
      chunk.embedding OPERATOR(extensions.<=>) p_query_embedding
    ) >= greatest(
      -1::double precision,
      least(coalesce(p_min_similarity, 0.45), 1::double precision)
    )
  order by chunk.embedding OPERATOR(extensions.<=>) p_query_embedding
  limit least(greatest(coalesce(p_match_count, 8), 1), 20);
$function$;
