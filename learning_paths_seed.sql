-- =====================================================================
-- SEED: Business B1 - trilha de exemplo
-- =====================================================================

-- Path principal
INSERT INTO learning_paths (id, tenant_id, name, description, target_level, category, estimated_hours, active)
VALUES (
  '11111111-1111-1111-1111-000000000001',
  NULL, -- global
  'Business English B1',
  'Trilha completa para profissionais que precisam de inglês para reuniões, emails e apresentações.',
  'B1',
  'BUSINESS',
  6,
  true
) ON CONFLICT (id) DO NOTHING;

-- Unit 1
INSERT INTO learning_units (id, path_id, order_index, title, description, estimated_minutes, skill_focus)
VALUES (
  '22222222-2222-2222-2222-000000000001',
  '11111111-1111-1111-1111-000000000001',
  1,
  'Opening a Meeting',
  'Abertura de reuniões em inglês — vocabulário e expressões essenciais.',
  45,
  ARRAY['vocabulary', 'speaking']
) ON CONFLICT (id) DO NOTHING;

INSERT INTO unit_activities (id, unit_id, order_index, type, title, description, content, xp_reward, estimated_minutes)
VALUES
(
  '33333333-2222-1111-0001-000000000001',
  '22222222-2222-2222-2222-000000000001',
  1,
  'vocab_cards',
  'Meeting Vocabulary',
  '12 palavras-chave para abrir reuniões.',
  '{"cards":[
    {"term":"Welcome aboard","translation":"Bem-vindo a bordo","example":"Welcome aboard, John. Let me introduce the team."},
    {"term":"Get started","translation":"Começar","example":"Let''s get started with today''s agenda."},
    {"term":"Agenda","translation":"Pauta","example":"There are three items on the agenda today."},
    {"term":"Apologies for being late","translation":"Desculpe pelo atraso","example":"Apologies for being late, the previous meeting overran."},
    {"term":"To kick off","translation":"Dar início","example":"I''d like to kick off with the sales update."},
    {"term":"On behalf of","translation":"Em nome de","example":"On behalf of the team, thank you for joining."},
    {"term":"Cover the following points","translation":"Abordar os seguintes pontos","example":"Today we''ll cover the following points: budget, timeline, and risks."},
    {"term":"Quick round of introductions","translation":"Rápida rodada de apresentações","example":"Let''s do a quick round of introductions."},
    {"term":"Action items","translation":"Itens de ação","example":"We''ll review the action items at the end."},
    {"term":"Wrap up by","translation":"Encerrar até","example":"We''ll aim to wrap up by 11."},
    {"term":"Floor is yours","translation":"A palavra é sua","example":"Maria, the floor is yours."},
    {"term":"Touch base","translation":"Alinhar","example":"Let''s touch base after the call."}
  ]}',
  40,
  10
),
(
  '33333333-2222-1111-0001-000000000002',
  '22222222-2222-2222-2222-000000000001',
  2,
  'quiz',
  'Quick Check: Meeting Phrases',
  '5 perguntas rápidas para fixar o vocabulário.',
  '{"questions":[
    {"q":"How do you start a meeting?","options":["Let''s kick off","Let''s kick out","Let''s kick down","Let''s kick in"],"correct":0,"exp":"''Kick off'' is the standard expression."},
    {"q":"What do you say when someone joins your team?","options":["Welcome on board","Welcome aboard","Welcome onboard","All are correct"],"correct":3,"exp":"All three variants are acceptable in business English."},
    {"q":"Translate: ''Em nome de toda a equipe...''","options":["In behalf of","On behalf of","By behalf of","With behalf of"],"correct":1,"exp":"''On behalf of'' is the only correct form."},
    {"q":"What''s the meaning of ''touch base''?","options":["Briefly meet/talk","Touch the table","Reach the goal","Confirm a base"],"correct":0,"exp":"''Touch base'' means to briefly check in or align."},
    {"q":"How do you formally pass the speaking turn?","options":["Your floor","Floor to you","The floor is yours","You floor"],"correct":2,"exp":"''The floor is yours'' is the polite professional phrase."}
  ]}',
  50,
  5
),
(
  '33333333-2222-1111-0001-000000000003',
  '22222222-2222-2222-2222-000000000001',
  3,
  'speaking_wolfie',
  'Practice with Wolfie: Open the Meeting',
  'Pratique com o Wolfie. Você abrirá uma reunião de status do projeto.',
  '{"scenario":"business_meeting_open","instructions_pt":"Você é o líder do projeto. Abra a reunião apresentando-se, agradeça pela presença, mencione 3 itens da pauta e passe a palavra para alguém.","target_phrases":["kick off","welcome aboard","on behalf of","the floor is yours"]}',
  80,
  10
) ON CONFLICT (id) DO NOTHING;

-- Unit 2
INSERT INTO learning_units (id, path_id, order_index, title, description, estimated_minutes, skill_focus)
VALUES (
  '22222222-2222-2222-2222-000000000002',
  '11111111-1111-1111-1111-000000000001',
  2,
  'Giving Updates',
  'Como apresentar updates de projeto: status, blockers, próximos passos.',
  50,
  ARRAY['grammar', 'speaking']
) ON CONFLICT (id) DO NOTHING;

INSERT INTO unit_activities (id, unit_id, order_index, type, title, description, content, xp_reward, estimated_minutes)
VALUES
(
  '33333333-2222-1111-0002-000000000001',
  '22222222-2222-2222-2222-000000000002',
  1,
  'grammar_drill',
  'Present Perfect vs Past Simple',
  'Quando usar "I have finished" vs "I finished".',
  '{"rule_pt":"Use Past Simple quando o momento é específico no passado (ontem, semana passada). Use Present Perfect quando o resultado importa agora ou o tempo é vago.","exercises":[
    {"sentence":"I ___ the report yesterday.","options":["finished","have finished"],"correct":0,"exp":"''Yesterday'' = momento específico → past simple"},
    {"sentence":"We ___ the budget already. Here it is.","options":["approved","have approved"],"correct":1,"exp":"''Already'' + resultado disponível agora → present perfect"},
    {"sentence":"She ___ to the client last Friday.","options":["spoke","has spoken"],"correct":0,"exp":"''Last Friday'' = momento específico → past simple"},
    {"sentence":"I ___ him three times this week.","options":["emailed","have emailed"],"correct":1,"exp":"''This week'' (ainda em curso) → present perfect"},
    {"sentence":"The team ___ the demo two hours ago.","options":["delivered","has delivered"],"correct":0,"exp":"''Two hours ago'' = momento específico → past simple"}
  ]}',
  60,
  10
),
(
  '33333333-2222-1111-0002-000000000002',
  '22222222-2222-2222-2222-000000000002',
  2,
  'speaking_wolfie',
  'Practice: Project Update',
  'Apresente um update de 60 segundos sobre um projeto fictício.',
  '{"scenario":"project_status_update","instructions_pt":"Em 60s: 1) status atual (on track/at risk/blocked), 2) o que foi feito esta semana (present perfect), 3) o que vem na próxima (going to / will), 4) blockers se houver.","target_phrases":["on track","at risk","blocker","next week we''re going to","have completed"]}',
  90,
  10
) ON CONFLICT (id) DO NOTHING;

-- Unit 3
INSERT INTO learning_units (id, path_id, order_index, title, description, estimated_minutes, skill_focus)
VALUES (
  '22222222-2222-2222-2222-000000000003',
  '11111111-1111-1111-1111-000000000001',
  3,
  'Email Etiquette',
  'Estrutura, tom e fórmulas para emails profissionais em inglês.',
  40,
  ARRAY['writing', 'reading']
) ON CONFLICT (id) DO NOTHING;

INSERT INTO unit_activities (id, unit_id, order_index, type, title, description, content, xp_reward, estimated_minutes)
VALUES
(
  '33333333-2222-1111-0003-000000000001',
  '22222222-2222-2222-2222-000000000003',
  1,
  'reading',
  'Anatomy of a Professional Email',
  'Leia o exemplo e identifique cada parte.',
  '{"text":"Dear Mark,\n\nI hope this email finds you well. I''m writing to follow up on our discussion last Tuesday regarding the Q4 launch.\n\nWould you be available for a quick call this Thursday at 3 PM to align on the final timeline? If that doesn''t work, please let me know what suits you better.\n\nLooking forward to your reply.\n\nBest regards,\nAna","questions":[
    {"q":"What is the purpose of the email?","options":["To complain","To follow up on a discussion","To resign","To invoice"],"correct":1,"exp":"Phrase ''I''m writing to follow up'' indicates the purpose."},
    {"q":"What is the polite alternative offered?","options":["Schedule next month","Send an email instead","Let her know a better time","Cancel altogether"],"correct":2,"exp":"''Please let me know what suits you better'' offers flexibility."}
  ]}',
  40,
  10
),
(
  '33333333-2222-1111-0003-000000000002',
  '22222222-2222-2222-2222-000000000003',
  2,
  'vocab_cards',
  'Email Openers & Closers',
  '10 expressões para começar e terminar emails com elegância.',
  '{"cards":[
    {"term":"I hope this email finds you well","translation":"Espero que este email te encontre bem","example":"Dear Sarah, I hope this email finds you well."},
    {"term":"I''m writing to","translation":"Estou escrevendo para","example":"I''m writing to confirm our meeting."},
    {"term":"Further to our conversation","translation":"Dando seguimento à nossa conversa","example":"Further to our conversation yesterday, here is the proposal."},
    {"term":"Please find attached","translation":"Em anexo segue","example":"Please find attached the updated report."},
    {"term":"Should you have any questions","translation":"Caso tenha dúvidas","example":"Should you have any questions, feel free to reach out."},
    {"term":"Looking forward to hearing from you","translation":"Aguardo seu retorno","example":"Looking forward to hearing from you soon."},
    {"term":"Best regards","translation":"Atenciosamente (formal)","example":"Best regards, Ana"},
    {"term":"Kind regards","translation":"Cordialmente","example":"Kind regards, Ana"},
    {"term":"All the best","translation":"Tudo de bom","example":"All the best, Ana"},
    {"term":"Thanks in advance","translation":"Desde já agradeço","example":"Thanks in advance for your help."}
  ]}',
  40,
  5
) ON CONFLICT (id) DO NOTHING;
