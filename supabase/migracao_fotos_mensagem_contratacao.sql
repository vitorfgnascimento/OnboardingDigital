-- Migração aditiva: foto de perfil (candidato e RH) e mensagem editável de
-- "Contratação concluída" nas configurações do RH.
-- A foto é guardada como data URL (JPEG reduzido no navegador), porque o disco
-- do servidor na Vercel é efêmero. Seguro de rodar mais de uma vez.

alter table usuarios add column if not exists foto text;

alter table configuracoes add column if not exists foto_rh text;
alter table configuracoes add column if not exists titulo_contratacao_concluida text;
alter table configuracoes add column if not exists mensagem_contratacao_concluida text;
