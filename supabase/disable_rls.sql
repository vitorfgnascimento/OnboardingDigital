-- O Supabase ativa Row Level Security por padrão em tabelas criadas pelo SQL
-- Editor. Neste projeto, o Supabase só é acessado pelo backend Express
-- (nunca diretamente pelo navegador do candidato/RH) - a segurança de acesso
-- já é garantida pela própria API (sessões, tokens, exigirRh etc.), então
-- manter RLS ligado aqui só bloqueia as próprias operações do servidor sem
-- adicionar proteção real. Desativa RLS nas 4 tabelas.
alter table usuarios disable row level security;
alter table sessoes disable row level security;
alter table candidatos disable row level security;
alter table mensagens_chat disable row level security;
