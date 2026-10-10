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
      MASTER_EMAIL: 'master@exemplo.test', MASTER_SENHA: 'Master-Senha-Forte-123',
      LIMITE_CADASTROS_HORA: '20', LIMITE_FICHAS_HORA: '12', LIMITE_UPLOADS_HORA: '200', LIMITE_MENSAGENS_10MIN: '200'
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

  // ---- Páginas: raiz = login; ficha renomeada; redirecionamento legado ----
  const raiz = await fetch(BASE + '/');
  const htmlRaiz = await raiz.text();
  t('pág.', 'Páginas', 'A raiz "/" é a tela de login', raiz.status === 200 && /Esqueci minha senha/.test(htmlRaiz), `HTTP ${raiz.status}`);
  const legado = await fetch(BASE + '/index.html?id=abc-123', { redirect: 'manual' });
  t('pág.', 'Páginas', '/index.html redireciona para /ficha.html preservando o ?id=', legado.status === 301 && legado.headers.get('location') === '/ficha.html?id=abc-123', `${legado.status} ${legado.headers.get('location')}`);
  const fichaHtml = await (await fetch(BASE + '/ficha.html')).text();
  t('pág.', 'Páginas', '/ficha.html existe e não tem mais a caixa de consentimento LGPD', fichaHtml.includes('data-termos-privacidade="ficha"') && !fichaHtml.includes('checkConsentimentoFicha'), '');
  const loginHtml = await (await fetch(BASE + '/login.html')).text();
  t('pág.', 'Páginas', 'Cadastro com frase + link "Termos de privacidade" (sem checkbox)', loginHtml.includes('data-termos-privacidade="cadastro"') && !loginHtml.includes('checkAceiteTermos'), '');
  const jsTermos = await (await fetch(BASE + '/termos-privacidade.js')).text();
  t('pág.', 'Páginas', 'Pop-up cita direitos do art. 18, finalidade, base legal e consentimento', ['art. 18', 'Por que coletamos', 'Base legal', 'Consentimento', 'Termos de privacidade', 'concorda com as políticas de privacidade e os termos de uso'].every((x) => jsTermos.includes(x)), '');
  t('pág.', 'Cadastro', 'Servidor ainda exige o aceite dos termos (aceiteTermos=false -> 400)', (await registrarCom({ aceiteTermos: false })).status === 400, '');

  // ---- Papéis: master, admin e operadores ----
  const login = async (email, senha) => {
    const r = await req('POST', '/api/auth/login', { body: { email, senha } });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, token: j.token, usuario: j.usuario };
  };
  const senhaMaster = 'Master-Senha-Forte-123';
  const m = await login('master@exemplo.test', senhaMaster);
  t('papéis', 'Master', 'Conta master (definida no ambiente do servidor) entra', m.status === 200 && m.usuario && m.usuario.tipo === 'master', `HTTP ${m.status}`);
  t('papéis', 'Master', 'Master NÃO acessa fichas de candidatos (403)', (await req('GET', '/api/rh/fichas', { token: m.token })).status === 403, '');
  t('papéis', 'Master', 'Master NÃO lê uma ficha (403)', (await req('GET', `/api/candidato/${id}`, { token: m.token })).status === 403, '');
  t('papéis', 'Master', 'Candidato não acessa a gestão do master (403)', (await req('GET', '/api/master/admins', { token: dono })).status === 403, '');
  t('papéis', 'Master', 'RH não acessa a gestão do master (403)', (await req('GET', '/api/master/admins', { token: rh })).status === 403, '');
  t('papéis', 'Master', 'Sem login a gestão do master é recusada (401)', (await req('GET', '/api/master/admins')).status === 401, '');

  // master cria o administrador (cliente); ele define a senha pelo link + senha temporária
  const novoAdmin = await (await req('POST', '/api/master/admins', { token: m.token, body: { nome: 'Admin Cliente', email: `admin${sufixo}@cliente.test` } })).json();
  t('papéis', 'Master', 'Master cria a conta admin do cliente', !!(novoAdmin.conta && novoAdmin.conta.tipo === 'admin' && novoAdmin.linkRecuperacao && novoAdmin.senhaTemporaria), JSON.stringify(novoAdmin).slice(0, 80));
  const tokenLink = (novoAdmin.linkRecuperacao || '').split('token=')[1];
  t('papéis', 'Master', 'Admin sem senha definida ainda não consegue entrar', (await login(`admin${sufixo}@cliente.test`, 'Qualquer-Senha-1')).status === 401, '');

  const redefinir = (corpo) => req('POST', '/api/auth/redefinir-senha', { body: corpo });
  t('recup.', 'Senha', 'Senha temporária errada é recusada', (await redefinir({ token: tokenLink, senhaTemporaria: 'ErradaErrada', novaSenha: 'Nova-Senha-Forte-1', confirmarSenha: 'Nova-Senha-Forte-1' })).status === 400, '');
  t('recup.', 'Senha', 'Nova senha fraca é recusada', (await redefinir({ token: tokenLink, senhaTemporaria: novoAdmin.senhaTemporaria, novaSenha: '12345678', confirmarSenha: '12345678' })).status === 400, '');
  t('recup.', 'Senha', 'Confirmação diferente da nova senha é recusada', (await redefinir({ token: tokenLink, senhaTemporaria: novoAdmin.senhaTemporaria, novaSenha: 'Nova-Senha-Forte-1', confirmarSenha: 'Outra-Senha-Forte-2' })).status === 400, '');
  const okRedef = await redefinir({ token: tokenLink, senhaTemporaria: novoAdmin.senhaTemporaria, novaSenha: 'Nova-Senha-Forte-1', confirmarSenha: 'Nova-Senha-Forte-1' });
  t('recup.', 'Senha', 'Token + senha temporária + nova senha confirmada trocam a senha', okRedef.status === 200, `HTTP ${okRedef.status}`);
  t('recup.', 'Senha', 'O mesmo link não pode ser reutilizado', (await redefinir({ token: tokenLink, senhaTemporaria: novoAdmin.senhaTemporaria, novaSenha: 'Outra-Nova-Senha-3', confirmarSenha: 'Outra-Nova-Senha-3' })).status === 400, '');

  const admin = await login(`admin${sufixo}@cliente.test`, 'Nova-Senha-Forte-1');
  t('papéis', 'Admin', 'Admin entra com a senha que definiu', admin.status === 200 && admin.usuario.tipo === 'admin', `HTTP ${admin.status}`);
  t('papéis', 'Admin', 'Admin tem todos os acessos do RH (lista fichas)', (await req('GET', '/api/rh/fichas', { token: admin.token })).status === 200, '');
  t('papéis', 'Admin', 'Admin NÃO acessa a gestão do master (403)', (await req('GET', '/api/master/admins', { token: admin.token })).status === 403, '');
  t('papéis', 'Admin', 'Operador de RH não acessa a gestão de operadores (403)', (await req('GET', '/api/admin/operadores', { token: rh })).status === 403, '');

  const novoOp = await (await req('POST', '/api/admin/operadores', { token: admin.token, body: { nome: 'Operadora RH', email: `op${sufixo}@cliente.test` } })).json();
  t('papéis', 'Admin', 'Admin cria operador do RH', !!(novoOp.conta && novoOp.conta.tipo === 'rh' && novoOp.senhaTemporaria), '');
  t('papéis', 'Admin', 'Admin não cria conta com e-mail já existente (409)', (await req('POST', '/api/admin/operadores', { token: admin.token, body: { nome: 'Dup', email: `op${sufixo}@cliente.test` } })).status === 409, '');
  await redefinir({ token: (novoOp.linkRecuperacao || '').split('token=')[1], senhaTemporaria: novoOp.senhaTemporaria, novaSenha: 'Operadora-Senha-1', confirmarSenha: 'Operadora-Senha-1' });
  const op = await login(`op${sufixo}@cliente.test`, 'Operadora-Senha-1');
  t('papéis', 'Operador', 'Operador define a senha e acessa o painel do RH', op.status === 200 && (await req('GET', '/api/rh/fichas', { token: op.token })).status === 200, '');
  t('papéis', 'Operador', 'Operador não vira admin: sem acesso à gestão (403)', (await req('GET', '/api/admin/operadores', { token: op.token })).status === 403, '');
  const idDono = (await (await req('GET', '/api/auth/sessao', { token: dono })).json()).usuario.id;
  t('papéis', 'Admin', 'Admin não gerencia outra conta admin nem a si mesmo (404)', (await req('PATCH', `/api/admin/operadores/${admin.usuario.id}`, { token: admin.token, body: { ativo: false } })).status === 404, '');
  t('papéis', 'Admin', 'Admin não gerencia conta de candidato (404)', (await req('PATCH', `/api/admin/operadores/${idDono}`, { token: admin.token, body: { ativo: false } })).status === 404, '');
  t('papéis', 'Admin', 'Admin renomeia o operador (200)', (await req('PATCH', `/api/admin/operadores/${op.usuario.id}`, { token: admin.token, body: { nome: 'Operadora Renomeada' } })).status === 200, '');

  const desativar = await req('PATCH', `/api/admin/operadores/${op.usuario.id}`, { token: admin.token, body: { ativo: false } });
  t('papéis', 'Admin', 'Admin desativa o operador', desativar.status === 200, `HTTP ${desativar.status}`);
  t('papéis', 'Admin', 'Sessão do operador desativado é encerrada (401)', (await req('GET', '/api/rh/fichas', { token: op.token })).status === 401, '');
  t('papéis', 'Admin', 'Operador desativado não consegue entrar', (await login(`op${sufixo}@cliente.test`, 'Operadora-Senha-1')).status !== 200, '');

  // ---- Recuperação de senha (esqueci minha senha) ----
  const recDesconhecido = await (await req('POST', '/api/auth/recuperar-senha', { body: { email: `ninguem${sufixo}@exemplo.test` } })).json();
  const recAdmin = await (await req('POST', '/api/auth/recuperar-senha', { body: { email: `admin${sufixo}@cliente.test` } })).json();
  t('recup.', 'Recuperação', 'Resposta igual exista a conta ou não (não revela cadastros)', recDesconhecido.mensagem === recAdmin.mensagem, '');
  t('recup.', 'Recuperação', 'Conta existente recebe link e senha temporária (modo teste)', !!(recAdmin.linkRecuperacao && recAdmin.senhaTemporaria), '');
  const antigaSessao = admin.token;
  const trocou = await redefinir({ token: (recAdmin.linkRecuperacao || '').split('token=')[1], senhaTemporaria: recAdmin.senhaTemporaria, novaSenha: 'Senha-Recuperada-7', confirmarSenha: 'Senha-Recuperada-7' });
  t('recup.', 'Recuperação', 'Redefinição por e-mail troca a senha', trocou.status === 200, `HTTP ${trocou.status}`);
  t('recup.', 'Recuperação', 'Trocar a senha encerra as sessões abertas', (await req('GET', '/api/auth/sessao', { token: antigaSessao })).status === 401, '');
  t('recup.', 'Recuperação', 'A senha antiga deixa de valer', (await login(`admin${sufixo}@cliente.test`, 'Nova-Senha-Forte-1')).status === 401, '');
  t('recup.', 'Recuperação', 'A nova senha vale', (await login(`admin${sufixo}@cliente.test`, 'Senha-Recuperada-7')).status === 200, '');
  const recMaster = await (await req('POST', '/api/auth/recuperar-senha', { body: { email: 'master@exemplo.test' } })).json();
  t('recup.', 'Recuperação', 'A conta master não usa a recuperação por e-mail', !recMaster.linkRecuperacao, '');
  const tentativas = [];
  const recTent = await (await req('POST', '/api/auth/recuperar-senha', { body: { email: `dono${sufixo}@exemplo.test` } })).json();
  for (let i = 0; i < 6; i += 1) tentativas.push((await redefinir({ token: (recTent.linkRecuperacao || '').split('token=')[1], senhaTemporaria: 'Errada-Errada-' + i, novaSenha: 'Qualquer-Senha-9', confirmarSenha: 'Qualquer-Senha-9' })).status);
  t('recup.', 'Recuperação', 'Após 5 senhas temporárias erradas o link é invalidado', (await redefinir({ token: (recTent.linkRecuperacao || '').split('token=')[1], senhaTemporaria: recTent.senhaTemporaria, novaSenha: 'Qualquer-Senha-9', confirmarSenha: 'Qualquer-Senha-9' })).status === 400, tentativas.join(','));

  // ---- 2.3 Limites de taxa (por último: consomem o orçamento da janela) ----
  const falhas = [];
  for (let i = 0; i < 6; i += 1) falhas.push((await req('POST', '/api/auth/login', { body: { email: `ninguem${sufixo}@exemplo.test`, senha: 'errada' + i } })).status);
  t('-', 'Limites', 'Login: 5 falhas seguidas levam a 429', falhas.slice(0, 5).every((s) => s === 401) && falhas[5] === 429, falhas.join(','));
  const cad = [];
  for (let i = 0; i < 24; i += 1) cad.push((await req('POST', '/api/auth/registrar', { body: { nome: 'A', email: 'invalido', senha: '1', confirmarSenha: '1' } })).status);
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
