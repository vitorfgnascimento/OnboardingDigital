-- Contas de login (candidato e rh) - substitui usuarios.json
create table if not exists usuarios (
  id text primary key,
  nome text not null,
  email text not null unique,
  senha_salt text,
  senha_hash text,
  tipo text not null default 'candidato',
  google_id text,
  cpf text,
  data_nascimento text,
  ativo boolean not null default true,
  token_ativacao text,
  consentimento_cadastro jsonb,
  criado_em timestamptz not null default now()
);

-- Tokens de sessão ativos - substitui sessoes.json
create table if not exists sessoes (
  token text primary key,
  usuario_id text not null references usuarios(id) on delete cascade,
  criado_em bigint not null,
  expira_em bigint not null
);

-- Fichas de admissão - substitui candidatos.json
create table if not exists candidatos (
  id text primary key,
  nome_completo text,
  cpf text,
  email text,
  whatsapp text,
  genero text,
  cep text,
  logradouro text,
  bairro text,
  numero text,
  complemento text,
  data_nascimento text,
  status text not null default 'EM_ANALISE',
  cpf_incluso_na_identidade boolean default false,
  documentos jsonb,
  decisao_final text,
  decisao_final_em timestamptz,
  usuario_id text references usuarios(id),
  contrato jsonb,
  consentimento_ficha_lgpd jsonb,
  consentimento_contrato_lgpd jsonb,
  integracao_ponto jsonb,
  ficha_pdf text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Histórico de chat RH <-> Candidato - tabela própria (antes era um array
-- embutido em cada candidato)
create table if not exists mensagens_chat (
  id text primary key,
  candidato_id text not null references candidatos(id) on delete cascade,
  autor text not null,
  nome_autor text,
  texto text not null,
  "timestamp" timestamptz not null default now(),
  ip text
);
create index if not exists idx_mensagens_chat_candidato on mensagens_chat(candidato_id);
