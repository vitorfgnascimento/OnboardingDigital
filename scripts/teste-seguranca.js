// Bateria de testes de segurança, repetível e isolada.
//
//   npm run teste:seguranca
//
// Sobe um Supabase FALSO (scripts/supabase-falso.js) e uma instância do
// servidor em portas e pasta de dados temporárias: nada toca o Supabase real
// nem a pasta uploads/ do projeto. Para testar uma instância já em execução:
//   TESTE_BASE=http://localhost:3001 node scripts/teste-seguranca.js
//
// Cada teste cita o item do roadmap (ex.: "2.1"). Testes marcados como
// PENDENTE cobrem itens ainda não tratados e não derrubam a bateria.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PORTA_FALSO = 54330;
const PORTA_APP = 3010;
const processos = [];
let pastaTemp = null;

const resultados = [];
function t(item, grupo, nome, ok, detalhe, pendente = false) {
  resultados.push({ item, grupo, nome, ok: !!ok, detalhe: detalhe === undefined ? '' : String(detalhe), pendente });
}

async function aguardar(url, tentativas = 40) {
  for (let i = 0; i < tentativas; i += 1) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch (e) { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Servidor não respondeu em ' + url);
}

async function iniciarAmbiente() {
  pastaTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-teste-'));
  const falso = spawn(process.execPath, [path.join(__dirname, 'supabase-falso.js')], {
    env: { ...process.env, FALSO_PORTA: String(PORTA_FALSO) }, stdio: 'ignore'
  });
  processos.push(falso);
  await aguardar(`http://127.0.0.1:${PORTA_FALSO}/__objetos`);

  const app = spawn(process.execPath, ['index.js'], {
    cwd: RAIZ,
    env: {
      ...process.env,
      NODE_ENV: 'test', PORT: String(PORTA_APP), DIRETORIO_DADOS: pastaTemp,
      SUPABASE_URL: `http://127.0.0.1:${PORTA_FALSO}`, SUPABASE_KEY: 'chave-de-teste', SUPABASE_SERVICE_KEY: '',
      ARMAZENAMENTO_DRIVER: 'local', SENHA_RH_TESTE: '', API_KEY_ADMISSOES: 'chave-api-de-teste-0123456789',
      LIMITE_CADASTROS_HORA: '12', LIMITE_FICHAS_HORA: '12', LIMITE_UPLOADS_HORA: '200', LIMITE_MENSAGENS_10MIN: '200'
    },
    stdio: 'ignore'
  });
  processos.push(app);
  await aguardar(`http://localhost:${PORTA_APP}/login.html`);
  return `http://localhost:${PORTA_APP}`;
}

function encerrarAmbiente() {
  processos.forEach((p) => { try { p.kill(); } catch (e) { /* já encerrado */ } });
  if (pastaTemp) { try { fs.rmSync(pastaTemp, { recursive: true, force: true }); } catch (e) { /* ignora */ } }
}

async function suite(BASE, urlFalso) {
  const J = { 'Content-Type': 'application/json' };
  const req = (m, p, { token, body, form, headers } = {}) => fetch(BASE + p, {
    method: m,
    headers: Object.assign({}, form ? {} : (body ? J : {}), token ? { Authorization: 'Bearer ' + token } : {}, headers || {}),
    body: form || (body ? JSON.stringify(body) : undefined)
  });
  const sufixo = Date.now().toString(36);
  const senhaOk = 'Senha-Teste-123';
  const ficha = (extra = {}) => Object.assign({
    nomeCompleto: 'Fulano de Tal', dataNascimento: '10/05/1990', cpf: '123.456.789-09', cep: '01310-930',
    logradouro: 'Av Teste', bairro: 'Centro', numero: '100', complemento: '', email: 'f@exemplo.test',
    whatsapp: '(11) 98765-4321', genero: 'Feminino', consentimentoLGPD: true
  }, extra);
  const pdfForm = (tipo, conteudo, nome = 'doc.pdf') => {
    const f = new FormData(); f.append('tipoDocumento', tipo);
    f.append('arquivo', new File([conteudo], nome, { type: 'application/pdf' })); return f;
  };
  const novaConta = async (email) => {
    const r = await (await req('POST', '/api/auth/registrar', { body: { nome: 'Pessoa Teste', email, senha: senhaOk, confirmarSenha: senhaOk, dataNascimento: '01/01/1990', cpf: '529.982.247-25', aceiteTermos: true } })).json();
    return (await (await req('POST', '/api/auth/ativar', { body: { token: r.tokenAtivacao } })).json()).token;
  };

  // ---- contas e fichas usadas pelos testes (antes dos testes de limite) ----
  const rh = (await (await req('POST', '/api/auth/login', { body: { email: 'rh@onboarding.local', senha: 'onboarding123' } })).json()).token;
  const dono = await novaConta(`dono${sufixo}@exemplo.test`);
  const outro = await novaConta(`outro${sufixo}@exemplo.test`);
  const id = (await (await req('POST', '/api/candidato', { token: dono, body: ficha({ email: `dono${sufixo}@exemplo.test` }) })).json()).candidato.id;
  const up = await (await req('POST', `/api/candidato/${id}/documento`, { token: dono, form: pdfForm('identidade', '%PDF-1.4\nSIGILOSO\n%%EOF') })).json();
  const arquivo = up.candidato.documentos.identidade.arquivo;

  // ---- 2.1 Cabeçalhos ----
  const h = (await req('GET', '/login.html')).headers;
  t('2.1', 'Cabeçalhos', 'Content-Security-Policy com frame-ancestors e object-src none', /frame-ancestors/.test(h.get('content-security-policy') || '') && /object-src 'none'/.test(h.get('content-security-policy') || ''), h.get('content-security-policy') ? 'presente' : 'ausente');
  t('2.1', 'Cabeçalhos', 'X-Content-Type-Options: nosniff', h.get('x-content-type-options') === 'nosniff', h.get('x-content-type-options') || 'ausente');
  t('2.1', 'Cabeçalhos', 'X-Frame-Options (anti clickjacking)', !!h.get('x-frame-options'), h.get('x-frame-options') || 'ausente');
  t('2.1', 'Cabeçalhos', 'Referrer-Policy', !!h.get('referrer-policy'), h.get('referrer-policy') || 'ausente');
  t('2.1', 'Cabeçalhos', 'X-Powered-By oculto', !h.get('x-powered-by'), h.get('x-powered-by') || 'oculto');

  // ---- Superfície exposta ----
  for (const p of ['/.env', '/package.json', '/index.js', '/supabase/schema.sql', '/db/supabase.js', '/storage/armazenamento.js', '/.git/config', '/..%2f..%2findex.js']) {
    const r = await fetch(BASE + p);
    t('-', 'Superfície', `GET ${p} não exposto`, [400, 403, 404].includes(r.status), `HTTP ${r.status}`);
  }
  const testesPublico = (await fetch(BASE + '/testes.html')).status === 200;
  t('1.5', 'Superfície', '/testes.html não deveria estar público em produção', !testesPublico, testesPublico ? 'público' : 'oculto', true);

  // ---- Autorização ----
  for (const [nome, p] of [['GET /api/candidatos', '/api/candidatos'], [`GET /api/candidato/:id`, `/api/candidato/${id}`], ['GET /api/rh/fichas', '/api/rh/fichas'], [`GET /api/candidato/:id/mensagens`, `/api/candidato/${id}/mensagens`]]) {
    t('-', 'Autorização', `${nome} sem login é recusado`, (await req('GET', p)).status === 401, '');
  }
  t('-', 'Autorização', 'Outro candidato não lê a ficha (403)', (await req('GET', `/api/candidato/${id}`, { token: outro })).status === 403, '');
  t('-', 'Autorização', 'RH não escreve como Candidato no chat (403)', (await req('POST', `/api/candidato/${id}/mensagens`, { token: rh, body: { autor: 'Candidato', texto: 'x' } })).status === 403, '');

  // ---- Documentos (1.2 / 1.3 / 2.2) ----
  const semAssinatura = await fetch(`${BASE}/${arquivo}`);
  t('1.2', 'Documentos', 'Arquivo sem URL assinada é recusado (403)', semAssinatura.status === 403, `HTTP ${semAssinatura.status}`);
  const sig = await (await req('POST', '/api/arquivos/assinar', { token: dono, body: { arquivo } })).json();
  const entrega = sig.url ? await fetch(BASE + sig.url) : null;
  t('1.2', 'Documentos', 'Dono baixa o próprio arquivo pela URL assinada', entrega && entrega.status === 200 && (await entrega.text()).includes('SIGILOSO'), entrega ? `HTTP ${entrega.status}` : 'sem URL');
  t('1.2', 'Documentos', 'Outro candidato não recebe URL assinada (403)', (await req('POST', '/api/arquivos/assinar', { token: outro, body: { arquivo } })).status === 403, '');
  const u = sig.url ? new URL(BASE + sig.url) : null;
  if (u) {
    const nome = decodeURIComponent(u.pathname.split('/').pop());
    t('1.2', 'Documentos', 'Assinatura adulterada é recusada', (await fetch(`${BASE}/uploads/${nome}?exp=${u.searchParams.get('exp')}&sig=${'0'.repeat(64)}`)).status === 403, '');
    t('1.2', 'Documentos', 'Link expirado é recusado', (await fetch(`${BASE}/uploads/${nome}?exp=${Date.now() - 1000}&sig=${u.searchParams.get('sig')}`)).status === 403, '');
  }
  t('2.2', 'Upload', 'HTML disfarçado de PDF é recusado', (await req('POST', `/api/candidato/${id}/documento`, { token: dono, form: pdfForm('cpf', '<html><script>x</script></html>', 'cpf.pdf') })).status === 400, '');
  t('2.2', 'Upload', 'Tipo de documento inexistente é recusado', (await req('POST', `/api/candidato/${id}/documento`, { token: dono, form: pdfForm('../../x', '%PDF-1.4\n%%EOF') })).status === 400, '');
  t('2.2', 'Upload', 'Nome do arquivo gerado pelo servidor (id-tipo-aleatório)', new RegExp(`^uploads/${id}-identidade-[0-9a-f]{16}\\.pdf$`).test(arquivo), arquivo);

  // ---- 2.4 Senha, CPF e tamanho de campos ----
  const registrarCom = (extra) => req('POST', '/api/auth/registrar', { body: Object.assign({ nome: 'Fraca Teste', email: `fraca${sufixo}${Math.random().toString(36).slice(2, 6)}@exemplo.test`, senha: senhaOk, confirmarSenha: senhaOk, dataNascimento: '01/01/1990', cpf: '529.982.247-25', aceiteTermos: true }, extra) });
  for (const [rotulo, senha] of [['12345678 (comum)', '12345678'], ['curta (Ab1)', 'Ab1'], ['sem número (SomenteLetras)', 'SomenteLetras'], ['sem letra (98765432)', '98765432'], ['senha123 (comum)', 'senha123']]) {
    t('2.4', 'Senha/CPF', `Senha fraca recusada: ${rotulo}`, (await registrarCom({ senha, confirmarSenha: senha })).status === 400, '');
  }
  t('2.4', 'Senha/CPF', 'CPF com dígito verificador inválido recusado no cadastro', (await registrarCom({ cpf: '123.456.789-00' })).status === 400, '');
  t('2.4', 'Senha/CPF', 'CPF com todos os dígitos iguais recusado na ficha', (await req('POST', '/api/candidato', { token: dono, body: ficha({ cpf: '111.111.111-11' }) })).status === 400, '');
  t('2.4', 'Senha/CPF', 'CPF válido continua aceito na ficha', (await req('POST', '/api/candidato', { token: dono, body: ficha({ cpf: '529.982.247-25' }) })).status === 201, '');
  t('2.4', 'Senha/CPF', 'Complemento muito longo é recusado', (await req('POST', '/api/candidato', { token: dono, body: ficha({ complemento: 'x'.repeat(5000) }) })).status === 400, '');
  t('2.4', 'Senha/CPF', 'Mensagem de chat acima de 2000 caracteres é recusada', (await req('POST', `/api/candidato/${id}/mensagens`, { token: dono, body: { autor: 'Candidato', texto: 'a'.repeat(2001) } })).status === 400, '');

  // ---- 2.6 IDs imprevisíveis ----
  t('2.6', 'IDs', 'IDs de ficha são UUID (gerador criptográfico)', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/.test(id), id);

  // ---- 2.8 Sessões: o banco só guarda o hash do token ----
  if (urlFalso) {
    const sessoes = await (await fetch(`${urlFalso}/rest/v1/sessoes`)).json();
    const hashDono = require('crypto').createHash('sha256').update(dono).digest('hex');
    t('2.8', 'Sessões', 'Token em texto puro NÃO está no banco', !sessoes.some((s) => s.token === dono || s.token === rh), `${sessoes.length} sessões`);
    t('2.8', 'Sessões', 'O hash SHA-256 do token está no banco', sessoes.some((s) => s.token === hashDono), '');
  }
  const semSessao = await req('GET', '/api/auth/sessao', { token: 'a'.repeat(64) });
  t('2.8', 'Sessões', 'Token inventado continua recusado (401)', semSessao.status === 401, `HTTP ${semSessao.status}`);

  // ---- 2.7 Integridade: mudanças em paralelo em fichas diferentes não se desfazem ----
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    ids.push((await (await req('POST', '/api/candidato', { token: dono, body: ficha({ nomeCompleto: `Paralelo Numero${i} Teste` }) })).json()).candidato.id);
  }
  await Promise.all(ids.map((x) => req('PATCH', `/api/candidato/${x}/status`, { token: rh, body: { status: 'PENDENTE_ASSINATURA' } })));
  const estados = await Promise.all(ids.map(async (x) => (await (await req('GET', `/api/candidato/${x}`, { token: rh })).json()).status));
  t('2.7', 'Integridade', '6 alterações simultâneas em fichas diferentes foram todas gravadas', estados.every((e) => e === 'PENDENTE_ASSINATURA'), estados.join(','));

  // ---- Itens ainda pendentes (aparecem como PENDENTE até serem tratados) ----
  const dup =await (await req('POST', '/api/auth/registrar', { body: { nome: 'Dup', email: `dono${sufixo}@exemplo.test`, senha: senhaOk, confirmarSenha: senhaOk, dataNascimento: '01/01/1990', cpf: '529.982.247-25', aceiteTermos: true } })).json();
  t('3.3', 'Enumeração', 'Cadastro não revela se o e-mail já existe', !/já existe/i.test(dup.erro || ''), dup.erro || '', true);

  // ---- 2.3 Limites de taxa (por último: consomem o orçamento da janela) ----
  const falhas = [];
  for (let i = 0; i < 6; i += 1) falhas.push((await req('POST', '/api/auth/login', { body: { email: `ninguem${sufixo}@exemplo.test`, senha: 'errada' + i } })).status);
  t('-', 'Limites', 'Login: 5 falhas seguidas levam a 429', falhas.slice(0, 5).every((s) => s === 401) && falhas[5] === 429, falhas.join(','));
  const cad = [];
  for (let i = 0; i < 16; i += 1) cad.push((await req('POST', '/api/auth/registrar', { body: { nome: 'A', email: 'invalido', senha: '1', confirmarSenha: '1' } })).status);
  t('2.3', 'Limites', 'Cadastro tem limite por hora (429)', cad.includes(429), `${cad.filter((s) => s === 429).length} de 16 bloqueadas`);
  const fichas = [];
  for (let i = 0; i < 16; i += 1) fichas.push((await req('POST', '/api/candidato', { token: dono, body: ficha() })).status);
  t('2.3', 'Limites', 'Criação de fichas tem limite por hora (429)', fichas.includes(429), `${fichas.filter((s) => s === 429).length} de 16 bloqueadas`);
}

async function main() {
  let base = process.env.TESTE_BASE;
  try {
    if (!base) base = await iniciarAmbiente();
    await suite(base, process.env.TESTE_BASE ? null : `http://127.0.0.1:${PORTA_FALSO}`);
  } catch (erro) {
    console.error('ERRO ao executar a bateria:', erro.message);
    encerrarAmbiente();
    process.exit(2);
  }
  encerrarAmbiente();

  let grupoAtual = '';
  resultados.forEach((r) => {
    if (r.grupo !== grupoAtual) { grupoAtual = r.grupo; console.log(`\n## ${grupoAtual}`); }
    const marca = r.ok ? '[ OK  ]' : (r.pendente ? '[PEND.]' : '[FALHA]');
    console.log(`${marca} (${r.item}) ${r.nome}${r.detalhe && !r.ok ? ' -> ' + r.detalhe : ''}`);
  });
  const ok = resultados.filter((r) => r.ok).length;
  const pend = resultados.filter((r) => !r.ok && r.pendente).length;
  const falhas = resultados.filter((r) => !r.ok && !r.pendente).length;
  console.log(`\nTotal: ${resultados.length} testes | ${ok} ok | ${pend} pendentes (itens do roadmap) | ${falhas} falhas`);
  process.exit(falhas ? 1 : 0);
}

main();
