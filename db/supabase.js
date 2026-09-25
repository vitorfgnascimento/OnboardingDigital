// Cliente Supabase compartilhado (Postgres gerenciado) - substitui a
// persistência antiga em arquivos JSON. Usa a chave anon-public: a API
// PostgREST do Supabase aplica as regras de acesso definidas no projeto.
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = supabase;
