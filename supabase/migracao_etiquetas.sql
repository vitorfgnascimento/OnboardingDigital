-- Migração aditiva: catálogo de etiquetas (estilo Trello) para as fichas.
-- Cada etiqueta tem uma cor e um nome opcional, e pode ser anexada a várias
-- fichas (candidatos.tags passa a guardar os ids das etiquetas). Editar o nome
-- ou a cor de uma etiqueta reflete em todas as fichas que a usam.
-- Seguro de rodar mais de uma vez e compatível com o código já publicado.

create table if not exists etiquetas (
  id text primary key,
  nome text not null default '',
  cor text not null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Mesmo critério das outras tabelas: o Supabase só é acessado pelo backend
-- Express, que já faz o controle de acesso (sessões, exigirRh).
alter table etiquetas disable row level security;
