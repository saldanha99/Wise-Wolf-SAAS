-- =====================================================================
-- SEED: Adult A2 Learning Paths (General English & Everyday Conversation)
-- Expands the A2 level catalog beyond travel to provide comprehensive
-- foundational curriculum for adult learners.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TRACK: Inglês Geral A2 - Comunicação e Rotina (GENERAL)
-- ---------------------------------------------------------------------
INSERT INTO public.learning_paths (
  id,
  tenant_id,
  name,
  description,
  target_level,
  category,
  estimated_hours,
  active
) VALUES (
  '11000000-0000-0000-0000-000000000021',
  NULL, -- Global track available to all schools
  'Inglês Geral A2 - Comunicação e Rotina',
  'Consolide sua autonomia no inglês: descreva rotinas, fale sobre experiências passadas, planos futuros e situações do cotidiano com segurança.',
  'A2',
  'GENERAL',
  6,
  true
) ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  target_level = EXCLUDED.target_level,
  estimated_hours = EXCLUDED.estimated_hours,
  active = EXCLUDED.active;

-- Unit 1: Daily Routines & Habits
INSERT INTO public.learning_units (
  id,
  path_id,
  order_index,
  title,
  description,
  estimated_minutes,
  skill_focus
) VALUES (
  '11000000-1000-0000-0000-000000000031',
  '11000000-0000-0000-0000-000000000021',
  1,
  'Daily Routines & Habits',
  'Descreva seu dia a dia, horários e frequência de atividades em inglês.',
  45,
  ARRAY['vocabulary', 'grammar', 'speaking']
) ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  estimated_minutes = EXCLUDED.estimated_minutes,
  skill_focus = EXCLUDED.skill_focus;

-- Unit 1 Activities
INSERT INTO public.unit_activities (
  id,
  unit_id,
  order_index,
  type,
  title,
  description,
  content,
  xp_reward,
  estimated_minutes
) VALUES
(
  '11000000-2000-0000-0000-000000000061',
  '11000000-1000-0000-0000-000000000031',
  1,
  'vocab_cards',
  'Daily Routine Vocabulary',
  '10 termos e expressões essenciais para falar sobre hábitos diários.',
  '{"cards": [
    {"term": "Wake up", "translation": "Acordar", "example": "I usually wake up at 7 AM on weekdays."},
    {"term": "Commute to work", "translation": "Deslocar-se para o trabalho", "example": "She commutes to work by train every morning."},
    {"term": "Grab a coffee", "translation": "Tomar/pegar um café rápido", "example": "Let''s grab a coffee before the meeting starts."},
    {"term": "Run errands", "translation": "Fazer tarefas / resolver coisas na rua", "example": "I have to run some errands this afternoon."},
    {"term": "Have lunch", "translation": "Almoçar", "example": "We usually have lunch together at noon."},
    {"term": "Work out", "translation": "Praticar exercícios / malhar", "example": "He works out at the gym three times a week."},
    {"term": "Wind down", "translation": "Relaxar / desacelerar", "example": "Reading a book helps me wind down before bed."},
    {"term": "Cook dinner", "translation": "Preparar o jantar", "example": "They like to cook dinner at home on Sundays."},
    {"term": "Check emails", "translation": "Conferir e-mails", "example": "The first thing I do at work is check emails."},
    {"term": "Go to bed", "translation": "Ir dormir / ir para a cama", "example": "I try to go to bed before midnight."}
  ]}',
  40,
  8
),
(
  '11000000-2000-0000-0000-000000000062',
  '11000000-1000-0000-0000-000000000031',
  2,
  'grammar_drill',
  'Present Simple & Frequency Adverbs',
  'Fixe o uso do presente e dos advérbios de frequência.',
  '{"rule_pt": "Usamos o Present Simple com advérbios de frequência (always, usually, sometimes, never) antes do verbo principal, mas depois do verbo to be.", "exercises": [
    {"sentence": "She ___ late for work.", "options": ["is never", "never is"], "correct": 0, "exp": "Com o verbo ''to be'', o advérbio vem depois: ''is never''."},
    {"sentence": "I ___ coffee in the morning.", "options": ["always drink", "drink always"], "correct": 0, "exp": "Com verbos de ação, o advérbio vem antes: ''always drink''."},
    {"sentence": "They ___ to the gym on Mondays.", "options": ["usually go", "usually goes"], "correct": 0, "exp": "Com o pronome ''They'', o verbo permanece na base: ''usually go''."},
    {"sentence": "He ___ breakfast at 8 AM.", "options": ["has", "have"], "correct": 0, "exp": "Com ''He/She/It'', usamos a forma irregular ''has''."},
    {"sentence": "How often ___ you check your email?", "options": ["do", "does"], "correct": 0, "exp": "Com o pronome ''you'', usamos o auxiliar ''do''."}
  ]}',
  50,
  10
),
(
  '11000000-2000-0000-0000-000000000063',
  '11000000-1000-0000-0000-000000000031',
  3,
  'speaking_wolfie',
  'Describe Your Routine to Wolfie',
  'Converse com o Wolfie sobre o seu dia a dia por áudio ou texto.',
  '{"scenario": "daily_routine_chat", "instructions_pt": "Converse com o Wolfie sobre o seu dia a dia. Conte a que horas você costuma acordar, o que faz no trabalho ou estudos, e como relaxa à noite.", "target_phrases": ["I usually wake up at", "In the morning I", "After work I like to", "Before going to bed"]}',
  80,
  10
) ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  content = EXCLUDED.content,
  xp_reward = EXCLUDED.xp_reward,
  estimated_minutes = EXCLUDED.estimated_minutes;

-- Unit 2: Past Memories & Last Weekend
INSERT INTO public.learning_units (
  id,
  path_id,
  order_index,
  title,
  description,
  estimated_minutes,
  skill_focus
) VALUES (
  '11000000-1000-0000-0000-000000000032',
  '11000000-0000-0000-0000-000000000021',
  2,
  'Past Memories & Last Weekend',
  'Aprenda a relatar acontecimentos e falar sobre o que você fez no passado recente.',
  50,
  ARRAY['grammar', 'reading', 'speaking']
) ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  estimated_minutes = EXCLUDED.estimated_minutes,
  skill_focus = EXCLUDED.skill_focus;

-- Unit 2 Activities
INSERT INTO public.unit_activities (
  id,
  unit_id,
  order_index,
  type,
  title,
  description,
  content,
  xp_reward,
  estimated_minutes
) VALUES
(
  '11000000-2000-0000-0000-000000000064',
  '11000000-1000-0000-0000-000000000032',
  1,
  'grammar_drill',
  'Past Simple: Regular & Irregular',
  'Aprenda a flexionar verbos comuns no passado.',
  '{"rule_pt": "Para ações finalizadas no passado, usamos o Past Simple. Verbos regulares recebem -ed (walked, watched); irregulares mudam (went, bought, saw). Com didn''t, use o verbo base.", "exercises": [
    {"sentence": "Last Saturday, I ___ to the beach with friends.", "options": ["went", "go"], "correct": 0, "exp": "''Went'' é o passado irregular de ''go''."},
    {"sentence": "We ___ a great movie yesterday evening.", "options": ["watched", "watch"], "correct": 0, "exp": "''Watched'' é a forma regular com -ed."},
    {"sentence": "She didn''t ___ any emails yesterday.", "options": ["send", "sent"], "correct": 0, "exp": "Após o auxiliar negativo ''didn''t'', o verbo volta à forma base ''send''."},
    {"sentence": "They ___ delicious Italian food for dinner.", "options": ["ate", "eated"], "correct": 0, "exp": "''Ate'' é o passado correto de ''eat'' (irregular)."},
    {"sentence": "___ you enjoy the weekend trip?", "options": ["Did", "Do"], "correct": 0, "exp": "Para perguntas no passado simples, iniciamos com ''Did''."}
  ]}',
  50,
  10
),
(
  '11000000-2000-0000-0000-000000000065',
  '11000000-1000-0000-0000-000000000032',
  2,
  'reading',
  'Reading: An Unforgettable Saturday',
  'Leia a história de um sábado inesquecível e responda às questões.',
  '{"text": "Last Saturday was very special for Lucas. In the morning, he woke up early and went to a local farmers'' market. He bought fresh bread and organic fruits. In the afternoon, he met his sister at a modern art museum in the city center. They spent two hours admiring the paintings and took many pictures. Afterwards, they had dinner at a cozy Japanese restaurant and talked about their upcoming vacation plans.", "questions": [
    {"q": "What did Lucas buy at the farmers'' market?", "options": ["Clothes and shoes", "Fresh bread and organic fruits", "Books and souvenirs", "Coffee and cake"], "correct": 1, "exp": "The text states: ''He bought fresh bread and organic fruits.''''"},
    {"q": "Where did Lucas meet his sister?", "options": ["At an art museum", "At the airport", "At the beach", "At a supermarket"], "correct": 0, "exp": "Lucas met his sister ''at a modern art museum in the city center.''''"},
    {"q": "What kind of restaurant did they visit for dinner?", "options": ["An Italian pizzeria", "A Mexican taco stand", "A Japanese restaurant", "A burger place"], "correct": 2, "exp": "The text says: ''they had dinner at a cozy Japanese restaurant.''''"}
  ]}',
  40,
  10
),
(
  '11000000-2000-0000-0000-000000000066',
  '11000000-1000-0000-0000-000000000032',
  3,
  'speaking_wolfie',
  'Tell Wolfie About Your Weekend',
  'Conte ao Wolfie sobre o que você fez no seu último fim de semana.',
  '{"scenario": "weekend_recap", "instructions_pt": "Conte ao Wolfie o que você fez no último fim de semana. Fale sobre onde foi, com quem esteve, o que comeu ou se assistiu a algo interessante.", "target_phrases": ["Last weekend I went to", "I spent time with", "It was really", "I ate delicious"]}',
  80,
  10
) ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  content = EXCLUDED.content,
  xp_reward = EXCLUDED.xp_reward,
  estimated_minutes = EXCLUDED.estimated_minutes;

-- Unit 3: Future Plans & Ambitions
INSERT INTO public.learning_units (
  id,
  path_id,
  order_index,
  title,
  description,
  estimated_minutes,
  skill_focus
) VALUES (
  '11000000-1000-0000-0000-000000000033',
  '11000000-0000-0000-0000-000000000021',
  3,
  'Future Plans & Ambitions',
  'Aprenda a falar sobre planos, metas e previsões para as próximas semanas e meses.',
  45,
  ARRAY['grammar', 'quiz', 'speaking']
) ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  estimated_minutes = EXCLUDED.estimated_minutes,
  skill_focus = EXCLUDED.skill_focus;

-- Unit 3 Activities
INSERT INTO public.unit_activities (
  id,
  unit_id,
  order_index,
  type,
  title,
  description,
  content,
  xp_reward,
  estimated_minutes
) VALUES
(
  '11000000-2000-0000-0000-000000000067',
  '11000000-1000-0000-0000-000000000033',
  1,
  'grammar_drill',
  'Going to vs Will for Future',
  'Diferencie intenções planejadas de decisões imediatas.',
  '{"rule_pt": "Usamos ''be going to'' para planos previamente definidos (''I am going to travel next month''). Usamos ''will'' para decisões espontâneas e previsões.", "exercises": [
    {"sentence": "I already bought the ticket. I ___ visit my parents next week.", "options": ["am going to", "will"], "correct": 0, "exp": "Plano premeditado com bilhete comprado → ''am going to''."},
    {"sentence": "The phone is ringing. I ___ answer it!", "options": ["will", "am going to"], "correct": 0, "exp": "Decisão espontânea no momento em que toca → ''will''."},
    {"sentence": "She ___ start a new course in October.", "options": ["is going to", "are going to"], "correct": 0, "exp": "Com o sujeito singular ''She'', usamos ''is going to''."},
    {"sentence": "Don''t worry, I ___ help you with that bag.", "options": ["will", "am going to"], "correct": 0, "exp": "Oferecimento espontâneo de ajuda → ''will''."},
    {"sentence": "What ___ you going to do this evening?", "options": ["are", "is"], "correct": 0, "exp": "Com o sujeito ''you'', o auxiliar é ''are''."}
  ]}',
  50,
  10
),
(
  '11000000-2000-0000-0000-000000000068',
  '11000000-1000-0000-0000-000000000033',
  2,
  'quiz',
  'Future Plans Quiz',
  'Checagem rápida de situações e expressões de futuro.',
  '{"questions": [
    {"q": "Which sentence expresses a planned intention?", "options": ["I will probably stay home.", "I am going to move to a new apartment in June.", "I think it will be sunny tomorrow.", "I just might call him."], "correct": 1, "exp": "''Am going to move'' expresses a concrete plan."},
    {"q": "Someone knocks on the door. What is the most natural reply?", "options": ["I am going to open it.", "I will get it!", "I opening it now.", "I shall be opening."], "correct": 1, "exp": "''I''ll get it!'' is the natural spontaneous choice with ''will''."},
    {"q": "What is the negative form of ''She is going to study''?", "options": ["She is not going to study.", "She doesn''t going to study.", "She won''t going to study.", "She isn''t will study."], "correct": 0, "exp": "The correct negative is ''is not going to study'' (or ''isn''t going to study'')."},
    {"q": "Choose the correct question: ''___ you going to attend the party?''", "options": ["Are", "Do", "Will", "Did"], "correct": 0, "exp": "The question form for ''going to'' starts with ''Are you''."}
  ]}',
  50,
  8
),
(
  '11000000-2000-0000-0000-000000000069',
  '11000000-1000-0000-0000-000000000033',
  3,
  'speaking_wolfie',
  'Discuss Future Goals with Wolfie',
  'Compartilhe com o Wolfie seus planos e metas para o futuro.',
  '{"scenario": "future_plans_conversation", "instructions_pt": "Compartilhe seus planos futuros com o Wolfie: fale sobre uma viagem que gostaria de fazer, uma meta de estudos ou um projeto pessoal para os próximos meses.", "target_phrases": ["I''m planning to", "Next year I want to", "I am going to", "I hope to learn"]}',
  80,
  10
) ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  content = EXCLUDED.content,
  xp_reward = EXCLUDED.xp_reward,
  estimated_minutes = EXCLUDED.estimated_minutes;

-- ---------------------------------------------------------------------
-- 2. TRACK: Conversação Cotidiana A2 - Situações Práticas (CONVERSATION)
-- ---------------------------------------------------------------------
INSERT INTO public.learning_paths (
  id,
  tenant_id,
  name,
  description,
  target_level,
  category,
  estimated_hours,
  active
) VALUES (
  '11000000-0000-0000-0000-000000000022',
  NULL, -- Global track available to all schools
  'Conversação Cotidiana A2 - Situações Práticas',
  'Ganhe segurança para falar inglês nas interações do dia a dia: pequenas conversas (small talk), pedir orientações na cidade e fazer pedidos em lojas e restaurantes.',
  'A2',
  'CONVERSATION',
  5,
  true
) ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  target_level = EXCLUDED.target_level,
  estimated_hours = EXCLUDED.estimated_hours,
  active = EXCLUDED.active;

-- Unit 1: Small Talk & Icebreakers
INSERT INTO public.learning_units (
  id,
  path_id,
  order_index,
  title,
  description,
  estimated_minutes,
  skill_focus
) VALUES (
  '11000000-1000-0000-0000-000000000034',
  '11000000-0000-0000-0000-000000000022',
  1,
  'Small Talk & Icebreakers',
  'Fórmulas práticas para puxar conversa e manter um diálogo casual e amigável em inglês.',
  40,
  ARRAY['vocabulary', 'quiz', 'speaking']
) ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  estimated_minutes = EXCLUDED.estimated_minutes,
  skill_focus = EXCLUDED.skill_focus;

-- Unit 1 Activities
INSERT INTO public.unit_activities (
  id,
  unit_id,
  order_index,
  type,
  title,
  description,
  content,
  xp_reward,
  estimated_minutes
) VALUES
(
  '11000000-2000-0000-0000-000000000071',
  '11000000-1000-0000-0000-000000000034',
  1,
  'vocab_cards',
  'Small Talk Phrases',
  '10 frases para quebrar o gelo e papear com naturalidade.',
  '{"cards": [
    {"term": "How''s everything going?", "translation": "Como estão as coisas? / Tudo bem?", "example": "Hey Mark, how''s everything going with you?"},
    {"term": "Nice weather today, isn''t it?", "translation": "O tempo está bom hoje, não está?", "example": "Beautiful sunny morning, nice weather today, isn''t it?"},
    {"term": "What do you do for fun?", "translation": "O que você gosta de fazer para se divertir?", "example": "When you have free time, what do you do for fun?"},
    {"term": "Have you seen that new movie?", "translation": "Você já viu aquele filme novo?", "example": "Have you seen that new sci-fi movie everyone is talking about?"},
    {"term": "Long time no see!", "translation": "Quanto tempo não nos vemos!", "example": "Lucas! Long time no see, how have you been?"},
    {"term": "By the way", "translation": "Por falar nisso / a propósito", "example": "By the way, did you finish that report?"},
    {"term": "Speaking of which", "translation": "Falando nisso", "example": "Speaking of which, we should book the tickets today."},
    {"term": "Sounds interesting!", "translation": "Parece interessante!", "example": "You''re learning photography? That sounds interesting!"},
    {"term": "Good to see you", "translation": "Bom te ver", "example": "It''s always good to see you, take care!"},
    {"term": "Catch you later!", "translation": "Até mais / nos vemos depois!", "example": "I need to run, catch you later!"}
  ]}',
  40,
  8
),
(
  '11000000-2000-0000-0000-000000000072',
  '11000000-1000-0000-0000-000000000034',
  2,
  'quiz',
  'Small Talk Etiquette Quiz',
  'Teste sua sensibilidade para respostas em bate-papos cotidianos.',
  '{"questions": [
    {"q": "When someone says ''How are you doing?'', what is the most natural reply?", "options": ["I am do well.", "Pretty good, thanks! How about you?", "Yes, I am doing.", "I do good."], "correct": 1, "exp": "''Pretty good, thanks! How about you?'' is polite, natural and keeps conversation flowing."},
    {"q": "What expression do you use to change the topic smoothly?", "options": ["By the way", "On the way", "In the way", "Under way"], "correct": 0, "exp": "''By the way'' is the standard transition phrase in English."},
    {"q": "If a friend says ''I ran my first marathon yesterday'', how do you react?", "options": ["Why did you do that?", "That''s incredible! Congratulations!", "I don''t care.", "Never mind."], "correct": 1, "exp": "''That''s incredible! Congratulations!'' shows positive engagement."},
    {"q": "What does ''Long time no see'' mean?", "options": ["I haven''t seen you in a long time.", "I cannot see you clearly.", "The time is too long.", "I do not want to see you."], "correct": 0, "exp": "It is an informal expression used when meeting someone after a prolonged period."}
  ]}',
  50,
  8
),
(
  '11000000-2000-0000-0000-000000000073',
  '11000000-1000-0000-0000-000000000034',
  3,
  'speaking_wolfie',
  'Coffee Break Chat with Wolfie',
  'Puxe uma conversa amigável com o Wolfie como se estivessem num intervalo para café.',
  '{"scenario": "coffee_break_chat", "instructions_pt": "Imagine que você encontrou o Wolfie durante um intervalo para café. Puxe uma conversa amigável, pergunte como foi a semana dele e compartilhe um hobby ou algo que você fez recentemente.", "target_phrases": ["How is your day going?", "What do you like to do on weekends?", "That sounds really cool", "Have a great day"]}',
  80,
  10
) ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  content = EXCLUDED.content,
  xp_reward = EXCLUDED.xp_reward,
  estimated_minutes = EXCLUDED.estimated_minutes;

-- Unit 2: Getting Around & Asking for Directions
INSERT INTO public.learning_units (
  id,
  path_id,
  order_index,
  title,
  description,
  estimated_minutes,
  skill_focus
) VALUES (
  '11000000-1000-0000-0000-000000000035',
  '11000000-0000-0000-0000-000000000022',
  2,
  'Getting Around & Asking for Directions',
  'Como pedir e dar orientações no trânsito, na rua e no transporte público com clareza.',
  45,
  ARRAY['vocabulary', 'reading', 'speaking']
) ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  estimated_minutes = EXCLUDED.estimated_minutes,
  skill_focus = EXCLUDED.skill_focus;

-- Unit 2 Activities
INSERT INTO public.unit_activities (
  id,
  unit_id,
  order_index,
  type,
  title,
  description,
  content,
  xp_reward,
  estimated_minutes
) VALUES
(
  '11000000-2000-0000-0000-000000000074',
  '11000000-1000-0000-0000-000000000035',
  1,
  'vocab_cards',
  'Directions & Landmarks',
  'Vocabulário para se orientar e pedir ajuda na rua.',
  '{"cards": [
    {"term": "Turn left / Turn right", "translation": "Vire à esquerda / Vire à direita", "example": "Turn left at the traffic lights, then go straight."},
    {"term": "Go straight ahead", "translation": "Siga em frente", "example": "Go straight ahead for two blocks."},
    {"term": "On the corner", "translation": "Na esquina", "example": "The pharmacy is right on the corner of 5th Avenue."},
    {"term": "Across from", "translation": "Em frente a / do outro lado de", "example": "The library is across from the post office."},
    {"term": "Within walking distance", "translation": "A uma distância caminhável", "example": "The subway station is within walking distance from my hotel."},
    {"term": "How do I get to...?", "translation": "Como eu chego até...?", "example": "Excuse me, how do I get to the central train station?"},
    {"term": "Take the subway / bus", "translation": "Pegar o metrô / ônibus", "example": "Take the blue subway line to Central Square."},
    {"term": "Next to", "translation": "Ao lado de", "example": "The bakery is right next to the bank."}
  ]}',
  40,
  8
),
(
  '11000000-2000-0000-0000-000000000075',
  '11000000-1000-0000-0000-000000000035',
  2,
  'reading',
  'Dialogue: Finding the Museum',
  'Acompanhe o diálogo entre um turista e um morador e responda.',
  '{"text": "Tourist: Excuse me, could you tell me how to get to the National Gallery?\nResident: Sure! It is not far from here. Walk straight along King Street for two blocks. When you reach the public library, turn right onto Victoria Road. Walk another block and you will see a large park. The National Gallery is on the other side of the park, right next to the historic fountain. It takes about ten minutes on foot.\nTourist: That is very helpful! Thank you very much.\nResident: You are welcome! Enjoy your visit.", "questions": [
    {"q": "What street should the tourist walk along first?", "options": ["King Street", "Victoria Road", "5th Avenue", "Central Square"], "correct": 0, "exp": "The resident instructs: ''Walk straight along King Street for two blocks.''''"},
    {"q": "What should the tourist do when reaching the library?", "options": ["Turn left", "Turn right onto Victoria Road", "Take the bus", "Stop and enter"], "correct": 1, "exp": "The resident says: ''turn right onto Victoria Road.''''"},
    {"q": "What landmark is next to the National Gallery?", "options": ["A train station", "A historic fountain", "A modern bank", "A pharmacy"], "correct": 1, "exp": "The gallery is ''right next to the historic fountain.''''"}
  ]}',
  40,
  10
),
(
  '11000000-2000-0000-0000-000000000076',
  '11000000-1000-0000-0000-000000000035',
  3,
  'speaking_wolfie',
  'Ask Wolfie for Directions',
  'Simule pedir orientações na rua para encontrar um lugar na cidade.',
  '{"scenario": "lost_in_the_city", "instructions_pt": "Você está caminhando por uma cidade no exterior e precisa encontrar uma farmácia ou uma estação de metrô. Peça ajuda ao Wolfie (que é um morador local amigável) e confirme o caminho.", "target_phrases": ["Excuse me, could you help me?", "How do I get to", "Is it far from here?", "Thank you so much"]}',
  80,
  10
) ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  content = EXCLUDED.content,
  xp_reward = EXCLUDED.xp_reward,
  estimated_minutes = EXCLUDED.estimated_minutes;

-- Unit 3: Shopping & Everyday Orders
INSERT INTO public.learning_units (
  id,
  path_id,
  order_index,
  title,
  description,
  estimated_minutes,
  skill_focus
) VALUES (
  '11000000-1000-0000-0000-000000000036',
  '11000000-0000-0000-0000-000000000022',
  3,
  'Shopping & Everyday Orders',
  'Como fazer compras, perguntar preços, pedir tamanhos e fazer pedidos em lojas e cafés.',
  45,
  ARRAY['grammar', 'quiz', 'speaking']
) ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  estimated_minutes = EXCLUDED.estimated_minutes,
  skill_focus = EXCLUDED.skill_focus;

-- Unit 3 Activities
INSERT INTO public.unit_activities (
  id,
  unit_id,
  order_index,
  type,
  title,
  description,
  content,
  xp_reward,
  estimated_minutes
) VALUES
(
  '11000000-2000-0000-0000-000000000077',
  '11000000-1000-0000-0000-000000000036',
  1,
  'grammar_drill',
  'Polite Requests: Would like & Could I',
  'Aprenda fórmulas de polidez para pedir produtos e serviços.',
  '{"rule_pt": "Em lojas e restaurantes, usamos ''I would like'' (ou ''I''d like'') e ''Could I have'' para fazer pedidos com educação.", "exercises": [
    {"sentence": "I ___ a cup of black coffee, please.", "options": ["would like", "want to like"], "correct": 0, "exp": "''I would like'' é a expressão padrão educada para pedidos."},
    {"sentence": "___ I try this jacket on in a medium size?", "options": ["Could", "Should"], "correct": 0, "exp": "''Could I...'' é a forma de solicitar permissão com cortesia."},
    {"sentence": "How much ___ these sunglasses cost?", "options": ["do", "does"], "correct": 0, "exp": "Com o substantivo no plural (''these sunglasses''), usamos ''do''."},
    {"sentence": "Do you have this shirt ___ blue?", "options": ["in", "on"], "correct": 0, "exp": "Para cores em vestuário, usamos a preposição ''in''."},
    {"sentence": "Could we ___ the bill, please?", "options": ["have", "to have"], "correct": 0, "exp": "Após o verbo modal ''could'', usamos a forma base ''have''."}
  ]}',
  50,
  10
),
(
  '11000000-2000-0000-0000-000000000078',
  '11000000-1000-0000-0000-000000000036',
  2,
  'quiz',
  'Shopping Dialogues Quiz',
  'Identifique as melhores respostas e termos no ambiente de compras.',
  '{"questions": [
    {"q": "The cashier asks: ''Cash or card?'' How do you answer?", "options": ["By card, please.", "I am paying cards.", "Give me card.", "Card is here."], "correct": 0, "exp": "''By card, please'' is standard and polite."},
    {"q": "You want to know where the fitting room is. What do you ask?", "options": ["Where can I try this on?", "Where do I dress?", "Where is clothes?", "Show me test."], "correct": 0, "exp": "''Where can I try this on?'' is the most natural question."},
    {"q": "What does the salesperson mean by ''Can I help you find anything?''", "options": ["They want to know if you need assistance.", "They are asking you to leave.", "They want to sell your items.", "They need your help."], "correct": 0, "exp": "It is a standard customer greeting to offer help."},
    {"q": "What is the receipt called in English?", "options": ["Receipt", "Recipe", "Notice", "Check-in"], "correct": 0, "exp": "''Receipt'' is the proof of purchase. ''Recipe'' is a cooking instruction."}
  ]}',
  50,
  8
),
(
  '11000000-2000-0000-0000-000000000079',
  '11000000-1000-0000-0000-000000000036',
  3,
  'speaking_wolfie',
  'Order at a Store with Wolfie',
  'Simule uma compra em uma loja em conversa com o Wolfie.',
  '{"scenario": "retail_shopping", "instructions_pt": "Você está em uma loja de roupas ou eletrônicos. O Wolfie é o atendente. Pergunte sobre um produto, peça um tamanho ou cor diferente, pergunte o preço e finalize a compra.", "target_phrases": ["I''d like to look at", "Do you have this in", "How much does it cost?", "I''ll take it, by card please"]}',
  80,
  10
) ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  content = EXCLUDED.content,
  xp_reward = EXCLUDED.xp_reward,
  estimated_minutes = EXCLUDED.estimated_minutes;
