-- Migração aditiva: Banco de Talentos + Configurações do RH.
-- Seguro de rodar mais de uma vez (if not exists / on conflict do nothing) e
-- compatível com o código já publicado, que simplesmente ignora as novas colunas.

-- Banco de Talentos: candidatos arquivados (saem da lista ativa) e suas tags.
alter table candidatos add column if not exists banco_talentos boolean not null default false;
alter table candidatos add column if not exists banco_talentos_em timestamptz;
alter table candidatos add column if not exists tags jsonb not null default '[]'::jsonb;

-- Configurações gerais do RH (uma única linha, id = 'geral').
create table if not exists configuracoes (
  id text primary key,
  mensagem_boas_vindas text,
  documentos_obrigatorios jsonb,
  email_contato_rh text,
  atualizado_em timestamptz not null default now()
);

insert into configuracoes (id, mensagem_boas_vindas, documentos_obrigatorios, email_contato_rh)
values (
  'geral',
  'Bem-vindo(a) ao processo admissional! Preencha seus dados e anexe os documentos solicitados para dar andamento à sua contratação.',
  '{"identidade":true,"cpf":true,"comprovanteResidencia":true,"comprovanteEscolaridade":true,"reservista":true,"carteiraTrabalho":true}'::jsonb,
  ''
)
on conflict (id) do nothing;

-- Mesmo critério das outras tabelas: o Supabase só é acessado pelo backend
-- Express, que já faz o controle de acesso (sessões, exigirRh).
alter table configuracoes disable row level security;
