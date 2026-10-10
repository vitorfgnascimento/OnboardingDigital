// Cliente Supabase compartilhado (Postgres gerenciado) - substitui a
// persistência antiga em arquivos JSON.
//
// Chave usada, em ordem de preferência:
//   1. SUPABASE_SERVICE_KEY - chave SECRET/service_role. É a indicada: só o
//      servidor Express acessa o banco, com o RLS ligado e SEM políticas, de
//      modo que a chave pública do projeto não consegue ler nem gravar nada.
//   2. SUPABASE_KEY - chave pública (anon/publishable). Só funciona com o RLS
//      desligado, o que deixa as tabelas abertas a quem tiver essa chave.
const { createClient } = require('@supabase/supabase-js');

const chaveServico = process.env.SUPABASE_SERVICE_KEY || '';
const chave = chaveServico || process.env.SUPABASE_KEY;

if (!chaveServico) {
  console.warn(
    'AVISO DE SEGURANCA: SUPABASE_SERVICE_KEY nao definida - usando a chave publica (SUPABASE_KEY). ' +
    'Defina a chave secret e ligue o RLS (supabase/ativar_rls.sql) antes de usar dados reais.'
  );
}

const supabase = createClient(process.env.SUPABASE_URL, chave, {
  auth: { persistSession: false, autoRefreshToken: false }
});

module.exports = supabase;
