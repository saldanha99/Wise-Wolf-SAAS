-- Preço dos modelos de voz — sem eles o painel mostrava o volume do áudio e
-- custo zero, que é pior que campo vazio: parece que a voz não custa nada.
--
-- Verificados em 04/08/2026 na tabela oficial da OpenAI
-- (developers.openai.com/api/docs/pricing):
--
--   gpt-4o-mini-tts     texto entrada US$  0,60/1M · áudio saída US$ 12,00/1M
--   gpt-4o-transcribe   entrada       US$  2,50/1M · saída       US$ 10,00/1M
--                       (estimativa da própria OpenAI: US$ 0,006/min)
--
-- `gpt-4o-mini-transcribe` já estava cadastrado (1,25 / 5,00) e continua
-- batendo com a tabela oficial — não foi tocado.
--
-- ⚠️ Os TOKENS do `wolfie_tts` são estimados na edge function (a API de fala
-- não devolve `usage`); o preço aqui é o real. O painel rotula a linha como
-- "estimado" para ninguém ler o número como medição exata.

INSERT INTO public.ai_model_pricing
  (model, input_usd_per_1m, output_usd_per_1m, cached_usd_per_1m) VALUES
  ('gpt-4o-mini-tts',    0.60, 12.00, 0.00),
  ('gpt-4o-transcribe',  2.50, 10.00, 0.00)
ON CONFLICT (model) DO UPDATE
  SET input_usd_per_1m  = EXCLUDED.input_usd_per_1m,
      output_usd_per_1m = EXCLUDED.output_usd_per_1m,
      cached_usd_per_1m = EXCLUDED.cached_usd_per_1m,
      updated_at = now();
