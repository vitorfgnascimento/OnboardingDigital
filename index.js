const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const { OAuth2Client } = require('google-auth-library');

const app = express();

app.use(express.json());
app.use(express.static('public'));

// Caminho absoluto do arquivo de persistência local (banco de dados simples em JSON)
const ARQUIVO_CANDIDATOS = path.join(__dirname, 'candidatos.json');

// Caminho absoluto da trilha de auditoria (registro imutável de eventos do RH)
const ARQUIVO_AUDITORIA = path.join(__dirname, 'auditoria.json');

// Caminho absoluto da base de contas de usuário (login/registro/Google)
const ARQUIVO_USUARIOS = path.join(__dirname, 'usuarios.json');

// Caminho absoluto dos tokens de sessão ativos (login persiste entre reinícios)
const ARQUIVO_SESSOES = path.join(__dirname, 'sessoes.json');

// Pasta onde os documentos PDF dos candidatos são armazenados
const PASTA_UPLOADS = path.join(__dirname, 'uploads');

// Garante que a pasta de uploads exista antes de qualquer envio
if (!fs.existsSync(PASTA_UPLOADS)) {
  fs.mkdirSync(PASTA_UPLOADS, { recursive: true });
}

// Serve os PDFs enviados pelos candidatos para visualização/download pelo RH
// (candidato.documentos[tipo].arquivo é salvo como "uploads/arquivo.pdf")
app.use('/uploads', express.static(PASTA_UPLOADS));

// Tipos de documento aceitos na jornada de admissão (uma aba para cada)
const TIPOS_DOCUMENTO = [
  'identidade',
  'cpf',
  'comprovanteResidencia',
  'comprovanteEscolaridade',
  'reservista',
  'carteiraTrabalho'
];

// Opções válidas para o campo de gênero
const GENEROS_VALIDOS = ['Masculino', 'Feminino', 'Outro', 'Prefiro não informar'];

// ---------------------------------------------------------------------------
// VALIDAÇÃO DOS DADOS PESSOAIS (espelha as regras do frontend - defesa em
// profundidade, já que a rota pode ser chamada diretamente, sem passar pela UI)
// ---------------------------------------------------------------------------

const somenteDigitos = (valor) => String(valor || '').replace(/\D/g, '');

// Verifica se DD/MM/AAAA (já sem máscara) é uma data de calendário real.
function dataNascimentoValida(digitosData) {
  if (digitosData.length !== 8) return false;
  const dia = Number(digitosData.slice(0, 2));
  const mes = Number(digitosData.slice(2, 4));
  const ano = Number(digitosData.slice(4, 8));

  if (mes < 1 || mes > 12) return false;
  const diasNoMes = new Date(ano, mes, 0).getDate();
  if (dia < 1 || dia > diasNoMes) return false;
  if (ano < 1900 || ano > new Date().getFullYear()) return false;

  return true;
}

const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const REGEX_REPETICAO = /(.)\1{2,}/i;

// Retorna a lista de erros de validação dos dados pessoais (vazia = tudo ok).
function validarDadosPessoais(dados) {
  const erros = [];
  const nome = String(dados.nomeCompleto || '').trim();
  const possuiSobrenome = nome.split(' ').filter((p) => p.length > 0).length >= 2;

  if (!nome || !possuiSobrenome || REGEX_REPETICAO.test(nome)) {
    erros.push('Nome completo inválido (informe nome e sobrenome, sem sequências repetidas).');
  }
  if (!dados.email || !REGEX_EMAIL.test(String(dados.email).trim())) {
    erros.push('E-mail inválido.');
  }
  if (!dados.genero || !GENEROS_VALIDOS.includes(dados.genero)) {
    erros.push('Gênero inválido.');
  }
  if (somenteDigitos(dados.cpf).length !== 11) {
    erros.push('CPF incompleto ou inválido.');
  }
  if (somenteDigitos(dados.cep).length !== 8) {
    erros.push('CEP incompleto ou inválido.');
  }
  if (!dataNascimentoValida(somenteDigitos(dados.dataNascimento))) {
    erros.push('Data de nascimento incompleta ou inválida.');
  }
  const digitosWhatsapp = somenteDigitos(dados.whatsapp);
  if (digitosWhatsapp.length !== 10 && digitosWhatsapp.length !== 11) {
    erros.push('WhatsApp/Telefone incompleto.');
  }
  if (!String(dados.logradouro || '').trim()) erros.push('Logradouro não informado.');
  if (!String(dados.bairro || '').trim()) erros.push('Bairro não informado.');
  if (!String(dados.numero || '').trim()) erros.push('Número não informado.');

  return erros;
}

// ---------------------------------------------------------------------------
// PERSISTÊNCIA
// ---------------------------------------------------------------------------

// Lê a lista de candidatos do arquivo. Se o arquivo ainda não existir, retorna lista vazia.
function lerCandidatos() {
  if (!fs.existsSync(ARQUIVO_CANDIDATOS)) {
    return [];
  }

  const conteudo = fs.readFileSync(ARQUIVO_CANDIDATOS, 'utf-8').trim();
  if (!conteudo) {
    return [];
  }

  const candidatos = JSON.parse(conteudo);
  // Migração leve: fichas criadas antes do módulo de contratação/autenticação
  // não têm os campos "contrato"/"usuarioId" - preenche com o valor padrão
  // para que as novas rotas funcionem sem precisar recriar a base de dados.
  candidatos.forEach((c) => {
    if (!c.contrato || !c.contrato.documentos) c.contrato = criarContratoInicial();
    TIPOS_CONTRATO.forEach((tipo) => {
      if (c.contrato.documentos[tipo] && c.contrato.documentos[tipo].arquivoAssinado === undefined) {
        c.contrato.documentos[tipo].arquivoAssinado = null;
      }
    });
    if (c.usuarioId === undefined) c.usuarioId = null;
    if (c.consentimentoFichaLGPD === undefined) c.consentimentoFichaLGPD = null;
    if (c.consentimentoContratoLGPD === undefined) c.consentimentoContratoLGPD = null;
  });

  return candidatos;
}

// Grava a lista completa de candidatos no arquivo, formatada para leitura humana.
function salvarCandidatos(lista) {
  fs.writeFileSync(ARQUIVO_CANDIDATOS, JSON.stringify(lista, null, 2), 'utf-8');
}

// Gera um identificador único para cada ficha (baseado em timestamp + sufixo aleatório).
function gerarId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// TRILHA DE AUDITORIA (LGPD) - registro imutável de eventos do RH
// ---------------------------------------------------------------------------

// Lê os eventos de auditoria já registrados. Se o arquivo ainda não existir, retorna lista vazia.
function lerAuditoria() {
  if (!fs.existsSync(ARQUIVO_AUDITORIA)) {
    return [];
  }

  const conteudo = fs.readFileSync(ARQUIVO_AUDITORIA, 'utf-8').trim();
  if (!conteudo) {
    return [];
  }

  return JSON.parse(conteudo);
}

// Acrescenta um novo evento à trilha de auditoria (append-only).
function registrarEventoAuditoria(evento) {
  const eventos = lerAuditoria();
  eventos.push(evento);
  fs.writeFileSync(ARQUIVO_AUDITORIA, JSON.stringify(eventos, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// AUTENTICAÇÃO: PERSISTÊNCIA DE USUÁRIOS E SESSÕES
// ---------------------------------------------------------------------------

function lerUsuarios() {
  if (!fs.existsSync(ARQUIVO_USUARIOS)) return [];
  const conteudo = fs.readFileSync(ARQUIVO_USUARIOS, 'utf-8').trim();
  return conteudo ? JSON.parse(conteudo) : [];
}

function salvarUsuarios(lista) {
  fs.writeFileSync(ARQUIVO_USUARIOS, JSON.stringify(lista, null, 2), 'utf-8');
}

function lerSessoes() {
  if (!fs.existsSync(ARQUIVO_SESSOES)) return [];
  const conteudo = fs.readFileSync(ARQUIVO_SESSOES, 'utf-8').trim();
  return conteudo ? JSON.parse(conteudo) : [];
}

function salvarSessoes(lista) {
  fs.writeFileSync(ARQUIVO_SESSOES, JSON.stringify(lista, null, 2), 'utf-8');
}

// Tempo de validade de um token de sessão: 7 dias.
const DURACAO_SESSAO_MS = 7 * 24 * 60 * 60 * 1000;

// Gera hash de senha com scrypt (nativo do Node, sem dependências externas).
// Cada usuário tem um salt próprio; senha nunca é armazenada em texto puro.
function gerarHashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return { salt, hash };
}

function senhaConfere(senha, salt, hashEsperado) {
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  // Comparação em tempo constante para evitar timing attacks.
  const bufA = Buffer.from(hash, 'hex');
  const bufB = Buffer.from(hashEsperado, 'hex');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function dadosPublicosUsuario(usuario) {
  return { id: usuario.id, nome: usuario.nome, email: usuario.email, tipo: usuario.tipo };
}

// Cria uma sessão para o usuário e persiste o token (login e registro reutilizam isso).
function criarSessao(usuarioId) {
  const sessoes = lerSessoes();
  const token = crypto.randomBytes(32).toString('hex');
  const agora = Date.now();
  sessoes.push({ token, usuarioId, criadoEm: agora, expiraEm: agora + DURACAO_SESSAO_MS });
  salvarSessoes(sessoes);
  return token;
}

// Resolve o usuário autenticado a partir do header Authorization: Bearer <token>.
// Retorna null se o token estiver ausente, inválido ou expirado.
function resolverUsuarioPorToken(req) {
  const cabecalho = req.headers.authorization || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
  if (!token) return null;

  const sessoes = lerSessoes();
  const sessao = sessoes.find((s) => s.token === token && s.expiraEm > Date.now());
  if (!sessao) return null;

  const usuarios = lerUsuarios();
  return usuarios.find((u) => u.id === sessao.usuarioId) || null;
}

// Middleware: exige sessão válida (qualquer papel) e anexa req.usuario.
function autenticar(req, res, next) {
  const usuario = resolverUsuarioPorToken(req);
  if (!usuario) return res.status(401).json({ erro: 'Sessão inválida ou expirada. Faça login novamente.' });
  req.usuario = usuario;
  next();
}

// Middleware: anexa req.usuario se houver um token válido, mas não bloqueia a
// requisição caso não haja sessão (usado no cadastro da ficha, que continua
// funcionando de forma anônima por compatibilidade).
function autenticarOpcional(req, res, next) {
  req.usuario = resolverUsuarioPorToken(req);
  next();
}

// Middleware: exige sessão válida do papel 'rh' - protege o Painel do RH.
function exigirRh(req, res, next) {
  const usuario = resolverUsuarioPorToken(req);
  if (!usuario) return res.status(401).json({ erro: 'Sessão inválida ou expirada. Faça login novamente.' });
  if (usuario.tipo !== 'rh') return res.status(403).json({ erro: 'Acesso restrito à equipe de RH.' });
  req.usuario = usuario;
  next();
}

// ---------------------------------------------------------------------------
// REGRAS DE NEGÓCIO DOS DOCUMENTOS
// ---------------------------------------------------------------------------

// Cria a estrutura inicial dos 6 documentos, já aplicando a regra do reservista.
function criarDocumentosIniciais(genero) {
  const documentos = {};

  TIPOS_DOCUMENTO.forEach((tipo) => {
    documentos[tipo] = { arquivo: null, status: 'VERMELHO', atualizadoEm: null, pendencia: null };
  });

  // Regra do Certificado de Reservista: obrigatório apenas para gênero Masculino.
  // Nos demais casos a aba é dispensada e o status já nasce APROVADO (VERDE).
  if (genero !== 'Masculino') {
    documentos.reservista.status = 'VERDE';
    documentos.reservista.atualizadoEm = new Date().toISOString();
  }

  return documentos;
}

// Reavalia a regra do reservista quando o gênero do candidato muda.
function aplicarRegraReservista(candidato) {
  const doc = candidato.documentos.reservista;

  if (candidato.genero !== 'Masculino') {
    // Dispensado: aba desabilitada e status automático VERDE
    doc.status = 'VERDE';
    doc.arquivo = null;
    doc.atualizadoEm = new Date().toISOString();
  } else if (doc.status === 'VERDE' && !doc.arquivo) {
    // Voltou a ser obrigatório e ainda não há PDF enviado: retorna a PENDENTE
    doc.status = 'VERMELHO';
    doc.atualizadoEm = new Date().toISOString();
  }
}

// Quando "CPF incluso na identidade" está marcado, a aba CPF herda o status da Identidade.
function aplicarRegraCpfIncluso(candidato) {
  if (candidato.cpfInclusoNaIdentidade) {
    candidato.documentos.cpf.status = candidato.documentos.identidade.status;
    candidato.documentos.cpf.arquivo = null;
    candidato.documentos.cpf.atualizadoEm = new Date().toISOString();
  }
}

// Move a ficha de "Não avaliado" (VERMELHO) para "Em Análise" (AMARELO) na
// primeira interação do RH (visualizar PDF, aceitar/marcar pendência num
// documento, ou responder no chat). Não faz nada se a ficha já saiu do
// estado inicial - é uma transição de mão única, automática.
function marcarPrimeiraInteracaoRh(candidato) {
  if (candidato.status === 'VERMELHO') {
    candidato.status = 'AMARELO';
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// UPLOAD DE PDF (multer)
// ---------------------------------------------------------------------------

const armazenamento = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PASTA_UPLOADS),
  filename: (req, file, cb) => {
    // O campo "tipoDocumento" precisa ser enviado ANTES do arquivo no FormData
    const tipo = req.body.tipoDocumento || 'documento';
    cb(null, `${req.params.id}-${tipo}-${Date.now()}.pdf`);
  }
});

// Aceita somente arquivos PDF.
// Alguns navegadores (sobretudo no Windows) enviam o PDF com mimetype
// 'application/octet-stream' ou 'application/x-pdf'; por isso também
// validamos pela extensão do nome do arquivo.
const MIMETYPES_PDF = ['application/pdf', 'application/x-pdf', 'application/octet-stream'];

const filtroPdf = (req, file, cb) => {
  const extensaoPdf = path.extname(file.originalname).toLowerCase() === '.pdf';
  const mimetypeAceito = MIMETYPES_PDF.includes(file.mimetype);

  if (extensaoPdf && mimetypeAceito) {
    cb(null, true);
  } else {
    cb(new Error('Apenas arquivos PDF são aceitos.'));
  }
};

const upload = multer({
  storage: armazenamento,
  fileFilter: filtroPdf,
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB por arquivo
});

// ---------------------------------------------------------------------------
// ROTAS DE AUTENTICAÇÃO (registro, login, Google Sign-In, sessão, logout)
// ---------------------------------------------------------------------------

const REGEX_EMAIL_AUTH = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Cliente do Google verificado com o Client ID configurado via variável de
// ambiente. Sem essa variável, o botão "Entrar com o Google" continua visível
// no frontend, mas a rota /api/auth/google responde 400 explicando a causa -
// é uma limitação de credenciais (o Líder de Projeto precisa gerar as suas
// próprias no Google Cloud Console), não uma falha de implementação.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const clienteGoogle = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Versão vigente dos Termos de Uso / Política de Privacidade exibidos no
// cadastro - referenciada nos logs de consentimento para rastreabilidade
// caso o texto dos termos mude no futuro.
const VERSAO_TERMOS_CADASTRO = 'v1.0';

app.post('/api/auth/registrar', (req, res) => {
  const { nome, email, senha, aceiteTermos } = req.body;
  const nomeAparado = String(nome || '').trim();
  const emailAparado = String(email || '').trim().toLowerCase();

  if (!nomeAparado) return res.status(400).json({ erro: 'Informe seu nome.' });
  if (!REGEX_EMAIL_AUTH.test(emailAparado)) return res.status(400).json({ erro: 'E-mail inválido.' });
  if (!senha || String(senha).length < 6) return res.status(400).json({ erro: 'A senha deve ter pelo menos 6 caracteres.' });
  if (aceiteTermos !== true) {
    return res.status(400).json({ erro: 'É necessário aceitar os Termos de Uso e a Política de Privacidade para criar a conta.' });
  }

  const usuarios = lerUsuarios();
  if (usuarios.some((u) => u.email === emailAparado)) {
    return res.status(400).json({ erro: 'Já existe uma conta com este e-mail.' });
  }

  const agora = new Date().toISOString();
  const { salt, hash } = gerarHashSenha(String(senha));
  const novoUsuario = {
    id: gerarId(),
    nome: nomeAparado,
    email: emailAparado,
    senhaSalt: salt,
    senhaHash: hash,
    tipo: 'candidato',
    googleId: null,
    // Aceite inicial dos Termos de Uso/Política de Privacidade (LGPD -
    // Momento 1 da jornada), com evidência de quando e de onde partiu.
    consentimentoCadastro: { aceito: true, timestamp: agora, ip: req.ip, versaoTermo: VERSAO_TERMOS_CADASTRO },
    criadoEm: agora
  };

  usuarios.push(novoUsuario);
  salvarUsuarios(usuarios);

  registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'consentimento_cadastro',
    usuarioId: novoUsuario.id,
    email: emailAparado,
    versaoTermo: VERSAO_TERMOS_CADASTRO,
    timestamp: agora,
    ip: req.ip
  });

  const token = criarSessao(novoUsuario.id);
  return res.status(201).json({ mensagem: 'Conta criada com sucesso!', token, usuario: dadosPublicosUsuario(novoUsuario) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, senha } = req.body;
  const emailAparado = String(email || '').trim().toLowerCase();

  const usuarios = lerUsuarios();
  const usuario = usuarios.find((u) => u.email === emailAparado);

  if (!usuario || !usuario.senhaHash || !senhaConfere(String(senha || ''), usuario.senhaSalt, usuario.senhaHash)) {
    return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
  }

  const token = criarSessao(usuario.id);
  return res.status(200).json({ mensagem: 'Login realizado com sucesso!', token, usuario: dadosPublicosUsuario(usuario) });
});

// Login/registro via Google Sign-In (Google Identity Services). O frontend
// envia o "credential" (ID Token JWT) emitido pelo Google; o backend valida
// a assinatura e a audiência junto ao Google antes de confiar nos dados.
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ erro: 'Credencial do Google ausente.' });

  if (!clienteGoogle) {
    return res.status(400).json({
      erro: 'Login com Google não está configurado neste ambiente. Defina a variável GOOGLE_CLIENT_ID (ver .env.example).'
    });
  }

  let payload;
  try {
    const ticket = await clienteGoogle.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (erro) {
    return res.status(401).json({ erro: 'Não foi possível validar a credencial do Google.' });
  }

  const emailGoogle = String(payload.email || '').trim().toLowerCase();
  if (!emailGoogle) return res.status(400).json({ erro: 'A conta Google não possui e-mail associado.' });

  const usuarios = lerUsuarios();
  let usuario = usuarios.find((u) => u.email === emailGoogle);

  if (!usuario) {
    usuario = {
      id: gerarId(),
      nome: payload.name || emailGoogle,
      email: emailGoogle,
      senhaSalt: null,
      senhaHash: null,
      tipo: 'candidato',
      googleId: payload.sub,
      criadoEm: new Date().toISOString()
    };
    usuarios.push(usuario);
    salvarUsuarios(usuarios);
  } else if (!usuario.googleId) {
    usuario.googleId = payload.sub;
    salvarUsuarios(usuarios);
  }

  const token = criarSessao(usuario.id);
  return res.status(200).json({ mensagem: 'Login com Google realizado com sucesso!', token, usuario: dadosPublicosUsuario(usuario) });
});

// Informa ao frontend se o Google Sign-In está configurado neste ambiente
// (e o Client ID a usar) - evita renderizar o botão do Google sem propósito.
app.get('/api/auth/google-client-id', (req, res) => {
  return res.status(200).json({ clientId: GOOGLE_CLIENT_ID || null });
});

app.get('/api/auth/sessao', autenticar, (req, res) => {
  return res.status(200).json({ usuario: dadosPublicosUsuario(req.usuario) });
});

app.post('/api/auth/logout', (req, res) => {
  const cabecalho = req.headers.authorization || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
  if (token) {
    const sessoes = lerSessoes().filter((s) => s.token !== token);
    salvarSessoes(sessoes);
  }
  return res.status(200).json({ mensagem: 'Sessão encerrada.' });
});

// Fichas vinculadas ao usuário autenticado (vínculo estrito ficha <-> perfil).
app.get('/api/auth/minhas-fichas', autenticar, (req, res) => {
  const candidatos = lerCandidatos();
  const minhasFichas = candidatos.filter((c) => c.usuarioId === req.usuario.id);
  return res.status(200).json(minhasFichas);
});

// ---------------------------------------------------------------------------
// ROTA: cadastro de nova ficha de candidato (Etapa 1 - Dados Pessoais)
// ---------------------------------------------------------------------------
// Versão vigente do Termo de Consentimento LGPD exibido no envio da ficha
// (Momento 2 da jornada) - referenciada no log de auditoria.
const VERSAO_TERMO_FICHA_LGPD = '1.0';
const FINALIDADE_TERMO_FICHA_LGPD = 'Processo Admissional e Validação de Documentos';

app.post('/api/candidato', autenticarOpcional, (req, res) => {
  const {
    nomeCompleto,
    dataNascimento,
    cpf,
    logradouro,
    bairro,
    cep,
    numero,
    complemento,
    email,
    whatsapp,
    genero,
    consentimentoLGPD
  } = req.body;

  const errosValidacao = validarDadosPessoais({
    nomeCompleto, dataNascimento, cpf, logradouro, bairro, cep, numero, email, whatsapp, genero
  });

  if (errosValidacao.length) {
    return res.status(400).json({ erro: errosValidacao.join(' ') });
  }
  if (consentimentoLGPD !== true) {
    return res.status(400).json({ erro: 'É necessário concordar com o tratamento dos dados e documentos (LGPD) para enviar a ficha.' });
  }

  const agora = new Date().toISOString();

  const novoCandidato = {
    id: gerarId(),
    nomeCompleto,
    dataNascimento,
    cpf,
    logradouro,
    bairro,
    cep,
    numero,
    complemento,
    email,
    whatsapp,
    genero: genero || null,
    status: 'VERMELHO',
    cpfInclusoNaIdentidade: false,
    documentos: criarDocumentosIniciais(genero),
    decisaoFinal: null,
    decisaoFinalEm: null,
    mensagens: [],
    // Vínculo estrito com o perfil autenticado que originou a ficha (se houver sessão).
    usuarioId: req.usuario ? req.usuario.id : null,
    contrato: criarContratoInicial(),
    // Consentimento LGPD do envio da ficha (Momento 2 da jornada) - evidência
    // de quando, de onde e sob qual finalidade os dados foram autorizados.
    consentimentoFichaLGPD: {
      aceito: true,
      dataHora: agora,
      ip: req.ip,
      versaoTermo: VERSAO_TERMO_FICHA_LGPD,
      finalidade: FINALIDADE_TERMO_FICHA_LGPD
    },
    consentimentoContratoLGPD: null,
    criadoEm: agora
  };

  const candidatos = lerCandidatos();
  candidatos.push(novoCandidato);
  salvarCandidatos(candidatos);

  registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'consentimento_ficha_lgpd',
    candidatoId: novoCandidato.id,
    versaoTermo: VERSAO_TERMO_FICHA_LGPD,
    finalidade: FINALIDADE_TERMO_FICHA_LGPD,
    timestamp: agora,
    ip: req.ip
  });

  console.log('--- Novo Candidato Recebido ---');
  console.log('ID:', novoCandidato.id);
  console.log('Nome:', nomeCompleto);
  console.log('CPF:', cpf);
  console.log('E-mail:', email);
  console.log('Gênero:', novoCandidato.genero);

  return res.status(201).json({
    mensagem: 'Ficha do candidato cadastrada com sucesso!',
    candidato: novoCandidato
  });
});

// ---------------------------------------------------------------------------
// ROTA: atualização dos dados pessoais / regras (gênero e CPF incluso)
// ---------------------------------------------------------------------------
app.patch('/api/candidato/:id/dados', (req, res) => {
  const { id } = req.params;
  const { genero, cpfInclusoNaIdentidade } = req.body;

  const candidatos = lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  if (genero !== undefined) {
    if (!GENEROS_VALIDOS.includes(genero)) {
      return res.status(400).json({ erro: 'Gênero inválido.' });
    }
    candidato.genero = genero;
    aplicarRegraReservista(candidato);
  }

  if (cpfInclusoNaIdentidade !== undefined) {
    candidato.cpfInclusoNaIdentidade = Boolean(cpfInclusoNaIdentidade);
    aplicarRegraCpfIncluso(candidato);
  }

  candidato.atualizadoEm = new Date().toISOString();
  salvarCandidatos(candidatos);

  return res.status(200).json({
    mensagem: 'Dados do candidato atualizados com sucesso!',
    candidato
  });
});

// ---------------------------------------------------------------------------
// ROTA: envio de um documento PDF para uma das abas
// ---------------------------------------------------------------------------
app.post('/api/candidato/:id/documento', (req, res) => {
  upload.single('arquivo')(req, res, (erroUpload) => {
    if (erroUpload) {
      if (erroUpload.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ erro: 'Arquivo excedeu o tamanho limite de 10 MB' });
      }
      return res.status(400).json({ erro: erroUpload.message });
    }

    const { id } = req.params;
    const { tipoDocumento, cpfIncluso } = req.body;
    const tipo = tipoDocumento;

    // Remove do disco um arquivo aceito pelo multer mas recusado por regra de negócio.
    const descartarArquivo = () => {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    };

    if (!TIPOS_DOCUMENTO.includes(tipo)) {
      descartarArquivo();
      return res.status(400).json({ erro: 'Tipo de documento inválido.' });
    }

    if (!req.file) {
      return res.status(400).json({ erro: 'Nenhum arquivo PDF foi enviado.' });
    }

    const candidatos = lerCandidatos();
    const candidato = candidatos.find((c) => c.id === id);

    if (!candidato) {
      descartarArquivo();
      return res.status(404).json({ erro: 'Candidato não encontrado.' });
    }

    // Ficha com decisão final (Aprovado/Reprovado) não aceita mais nenhum envio
    if (candidato.decisaoFinal) {
      descartarArquivo();
      return res.status(400).json({
        erro: 'Esta ficha já foi decidida e está bloqueada para novos envios.'
      });
    }

    const documentoAtual = candidato.documentos[tipo];
    const pendenciaAtiva = documentoAtual && documentoAtual.pendencia && documentoAtual.pendencia.ativa;

    // Documento já enviado só pode ser reenviado se o RH abriu uma pendência para ele
    if (documentoAtual && documentoAtual.arquivo && !pendenciaAtiva) {
      descartarArquivo();
      return res.status(400).json({
        erro: 'Este documento já foi enviado e a ficha está bloqueada para edição. Aguarde o RH sinalizar uma pendência para reenviar.'
      });
    }

    // Regra: reservista dispensado para gênero diferente de Masculino
    if (tipo === 'reservista' && candidato.genero !== 'Masculino') {
      descartarArquivo();
      return res.status(400).json({
        erro: 'Certificado de Reservista não é exigido para este candidato.'
      });
    }

    // Regra: aba CPF desabilitada quando o CPF está incluso na identidade
    if (tipo === 'cpf' && candidato.cpfInclusoNaIdentidade) {
      descartarArquivo();
      return res.status(400).json({
        erro: 'A aba CPF está desabilitada (CPF incluso na Identidade).'
      });
    }

    // Se havia um PDF anterior (reenvio após pendência), remove o arquivo físico antigo
    if (documentoAtual && documentoAtual.arquivo) {
      const caminhoAntigo = path.join(__dirname, documentoAtual.arquivo);
      fs.unlink(caminhoAntigo, (erro) => {
        if (erro && erro.code !== 'ENOENT') {
          console.error('Falha ao excluir PDF antigo:', caminhoAntigo, erro.message);
        }
      });
    }

    // Registra o arquivo enviado, move o documento para "Em Análise" (AMARELO) e
    // encerra qualquer pendência aberta (o reenvio pedido pelo RH foi atendido)
    candidato.documentos[tipo] = {
      arquivo: 'uploads/' + req.file.filename,
      status: 'AMARELO',
      atualizadoEm: new Date().toISOString(),
      pendencia: null
    };

    // Na aba Identidade o candidato pode declarar que o CPF está incluso no RG
    if (tipo === 'identidade' && cpfIncluso !== undefined) {
      candidato.cpfInclusoNaIdentidade = cpfIncluso === 'true' || cpfIncluso === true;
      aplicarRegraCpfIncluso(candidato);
    }

    salvarCandidatos(candidatos);

    console.log(`--- Documento recebido --- ID: ${id} | Tipo: ${tipo} | Arquivo: ${req.file.filename}`);

    return res.status(201).json({
      mensagem: 'Documento enviado com sucesso!',
      candidato
    });
  });
});

// ---------------------------------------------------------------------------
// ROTA: exclusão de um documento PDF já anexado
// ---------------------------------------------------------------------------
app.delete('/api/candidato/:id/documento/:tipo', (req, res) => {
  const { id, tipo } = req.params;

  if (!TIPOS_DOCUMENTO.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo de documento inválido.' });
  }

  const candidatos = lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  if (candidato.decisaoFinal) {
    return res.status(400).json({ erro: 'Esta ficha já foi decidida e está bloqueada para edição.' });
  }

  const documento = candidato.documentos[tipo];

  // Remove o arquivo físico da pasta uploads/ (se houver), ignorando "arquivo inexistente".
  if (documento && documento.arquivo) {
    const caminhoFisico = path.join(__dirname, documento.arquivo);
    fs.unlink(caminhoFisico, (erro) => {
      if (erro && erro.code !== 'ENOENT') {
        console.error('Falha ao excluir arquivo:', caminhoFisico, erro.message);
      }
    });
  }

  // Limpa a referência do documento (volta a PENDENTE), preservando uma eventual
  // pendência aberta pelo RH - remover o PDF antigo não deve travar o reenvio.
  candidato.documentos[tipo] = {
    arquivo: null,
    status: 'VERMELHO',
    atualizadoEm: new Date().toISOString(),
    pendencia: (documento && documento.pendencia) || null
  };

  // Reaplica as regras que podem manter o status automático mesmo sem arquivo
  if (tipo === 'reservista') aplicarRegraReservista(candidato);
  if (tipo === 'identidade') aplicarRegraCpfIncluso(candidato);

  salvarCandidatos(candidatos);

  console.log(`--- Documento excluído --- ID: ${id} | Tipo: ${tipo}`);

  return res.status(200).json({
    mensagem: 'Documento excluído com sucesso!',
    candidato
  });
});

// ---------------------------------------------------------------------------
// ROTA: listagem completa de candidatos (consumida pelo painel do RH)
// ---------------------------------------------------------------------------
app.get('/api/candidatos', (req, res) => {
  const candidatos = lerCandidatos();
  return res.status(200).json(candidatos);
});

// ---------------------------------------------------------------------------
// ROTA: alteração do status geral do candidato pelo RH (AMARELO ou VERDE)
// ---------------------------------------------------------------------------
app.patch('/api/candidato/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (status !== 'AMARELO' && status !== 'VERDE') {
    return res.status(400).json({
      erro: "Status inválido. Use 'AMARELO' (Em Análise) ou 'VERDE' (Aprovado)."
    });
  }

  const candidatos = lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  candidato.status = status;
  candidato.atualizadoEm = new Date().toISOString();
  salvarCandidatos(candidatos);

  console.log(`--- Status atualizado --- ID: ${id} | Novo status: ${status}`);

  return res.status(200).json({
    mensagem: 'Status do candidato atualizado com sucesso!',
    candidato
  });
});

// ---------------------------------------------------------------------------
// ROTA: listagem de fichas para o Painel de Gestão do RH (Etapa 2)
// ---------------------------------------------------------------------------
app.get('/api/rh/fichas', exigirRh, (req, res) => {
  const candidatos = lerCandidatos();
  return res.status(200).json(candidatos);
});

// Status que o RH pode atribuir a uma ficha pelo Painel de Gestão.
const STATUS_VALIDOS_RH = ['VERMELHO', 'AMARELO', 'VERDE'];

// ---------------------------------------------------------------------------
// ROTA: alteração de status de uma ficha pelo RH, com registro na trilha de
// auditoria (LGPD): quem, quando (timestamp) e de onde (IP) a alteração partiu.
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/status', exigirRh, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!STATUS_VALIDOS_RH.includes(status)) {
    return res.status(400).json({
      erro: "Status inválido. Use 'VERMELHO' (Pendente), 'AMARELO' (Em Análise) ou 'VERDE' (Aprovado)."
    });
  }

  const candidatos = lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  const statusAnterior = candidato.status;
  const agora = new Date().toISOString();

  candidato.status = status;
  candidato.atualizadoEm = agora;
  salvarCandidatos(candidatos);

  const evento = {
    id: gerarId(),
    candidatoId: id,
    statusAnterior,
    statusNovo: status,
    timestamp: agora,
    ip: req.ip
  };
  registrarEventoAuditoria(evento);

  console.log(`--- [Auditoria] Status alterado pelo RH --- ID: ${id} | ${statusAnterior} -> ${status} | IP: ${req.ip}`);

  return res.status(200).json({
    mensagem: 'Status da ficha atualizado com sucesso!',
    candidato,
    evento
  });
});

// ---------------------------------------------------------------------------
// ROTA: busca de uma única ficha por id (usada pelo candidato para retornar
// à própria ficha - via link com ?id= - e ver pendências, mensagens e decisão)
// ---------------------------------------------------------------------------
app.get('/api/candidato/:id', (req, res) => {
  const candidatos = lerCandidatos();
  const candidato = candidatos.find((c) => c.id === req.params.id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  return res.status(200).json(candidato);
});

// Quem pode enviar uma mensagem no chat da ficha.
const AUTORES_VALIDOS = ['RH', 'Candidato'];

// ---------------------------------------------------------------------------
// ROTA: envio de mensagem no chat da ficha (RH <-> Candidato), com histórico
// ordenado por data/hora persistido junto da ficha em candidatos.json
// ---------------------------------------------------------------------------
app.post('/api/candidato/:id/mensagens', (req, res) => {
  const { id } = req.params;
  const { autor, texto } = req.body;

  if (!AUTORES_VALIDOS.includes(autor)) {
    return res.status(400).json({ erro: "Autor inválido. Use 'RH' ou 'Candidato'." });
  }

  const textoAparado = String(texto || '').trim();
  if (!textoAparado) {
    return res.status(400).json({ erro: 'Mensagem vazia.' });
  }

  const candidatos = lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  if (!Array.isArray(candidato.mensagens)) {
    candidato.mensagens = [];
  }

  const novaMensagem = {
    id: gerarId(),
    autor,
    texto: textoAparado,
    timestamp: new Date().toISOString(),
    ip: req.ip
  };
  candidato.mensagens.push(novaMensagem);
  // Mensagem do RH conta como primeira interação; do candidato, não.
  if (autor === 'RH') marcarPrimeiraInteracaoRh(candidato);
  candidato.atualizadoEm = novaMensagem.timestamp;
  salvarCandidatos(candidatos);

  // Trilha de auditoria (LGPD): quem escreveu, quando e de onde.
  registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'mensagem_chat',
    candidatoId: id,
    autor,
    timestamp: novaMensagem.timestamp,
    ip: req.ip
  });

  return res.status(201).json({ mensagem: 'Mensagem enviada.', candidato });
});

// ---------------------------------------------------------------------------
// ROTA: RH marca um documento já enviado como "Com Pendência / Exige Reenvio",
// com justificativa obrigatória. Libera especificamente aquele documento para
// o candidato reenviar, e registra o evento na trilha de auditoria (LGPD).
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/documento/:tipo/pendencia', exigirRh, (req, res) => {
  const { id, tipo } = req.params;
  const { justificativa } = req.body;

  if (!TIPOS_DOCUMENTO.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo de documento inválido.' });
  }

  const justificativaAparada = String(justificativa || '').trim();
  if (!justificativaAparada) {
    return res.status(400).json({ erro: 'Informe a justificativa da pendência.' });
  }

  const candidatos = lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  const documento = candidato.documentos[tipo];
  if (!documento || !documento.arquivo) {
    return res.status(400).json({ erro: 'Só é possível marcar pendência em um documento já enviado.' });
  }

  const agora = new Date().toISOString();
  documento.pendencia = { ativa: true, justificativa: justificativaAparada, criadoEm: agora };
  documento.status = 'VERMELHO';
  documento.atualizadoEm = agora;

  // CPF incluso na Identidade: acompanha automaticamente o status da Identidade.
  if (tipo === 'identidade' && candidato.cpfInclusoNaIdentidade) {
    candidato.documentos.cpf.status = 'VERMELHO';
    candidato.documentos.cpf.atualizadoEm = agora;
  }

  marcarPrimeiraInteracaoRh(candidato);
  candidato.atualizadoEm = agora;
  salvarCandidatos(candidatos);

  registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'pendencia_documento',
    candidatoId: id,
    documentoTipo: tipo,
    justificativa: justificativaAparada,
    timestamp: agora,
    ip: req.ip
  });

  console.log(`--- [Auditoria] Pendência aberta --- ID: ${id} | Documento: ${tipo} | IP: ${req.ip}`);

  return res.status(200).json({
    mensagem: 'Pendência registrada. O candidato poderá reenviar este documento.',
    candidato
  });
});

// ---------------------------------------------------------------------------
// ROTA: RH aceita um documento já enviado (marca como Aprovado/Ok a nível de
// documento). Encerra uma eventual pendência aberta e conta como primeira
// interação do RH com a ficha.
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/documento/:tipo/aceitar', exigirRh, (req, res) => {
  const { id, tipo } = req.params;

  if (!TIPOS_DOCUMENTO.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo de documento inválido.' });
  }

  const candidatos = lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  const documento = candidato.documentos[tipo];
  if (!documento || !documento.arquivo) {
    return res.status(400).json({ erro: 'Só é possível aceitar um documento já enviado.' });
  }

  const agora = new Date().toISOString();
  documento.status = 'VERDE';
  documento.pendencia = null;
  documento.atualizadoEm = agora;

  // CPF incluso na Identidade: acompanha automaticamente o status da Identidade.
  if (tipo === 'identidade' && candidato.cpfInclusoNaIdentidade) {
    candidato.documentos.cpf.status = 'VERDE';
    candidato.documentos.cpf.pendencia = null;
    candidato.documentos.cpf.atualizadoEm = agora;
  }

  marcarPrimeiraInteracaoRh(candidato);
  candidato.atualizadoEm = agora;
  salvarCandidatos(candidatos);

  registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'documento_aceito',
    candidatoId: id,
    documentoTipo: tipo,
    timestamp: agora,
    ip: req.ip
  });

  console.log(`--- [Auditoria] Documento aceito --- ID: ${id} | Documento: ${tipo} | IP: ${req.ip}`);

  return res.status(200).json({ mensagem: 'Documento aceito com sucesso!', candidato });
});

// ---------------------------------------------------------------------------
// ROTA: RH abriu/visualizou um documento (clique em "Visualizar/Baixar PDF").
// Conta como primeira interação, mas não altera nada no documento em si.
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/documento/:tipo/visualizado', exigirRh, (req, res) => {
  const { id, tipo } = req.params;

  if (!TIPOS_DOCUMENTO.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo de documento inválido.' });
  }

  const candidatos = lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  const mudou = marcarPrimeiraInteracaoRh(candidato);

  if (mudou) {
    const agora = new Date().toISOString();
    candidato.atualizadoEm = agora;
    salvarCandidatos(candidatos);

    registrarEventoAuditoria({
      id: gerarId(),
      tipoEvento: 'documento_visualizado',
      candidatoId: id,
      documentoTipo: tipo,
      timestamp: agora,
      ip: req.ip
    });
  }

  return res.status(200).json({ mensagem: 'ok', candidato });
});

// Decisões finais válidas para o processo admissional.
const DECISOES_VALIDAS = ['APROVADO', 'REPROVADO'];

// ---------------------------------------------------------------------------
// ROTA: decisão final do processo (Aprovar/Reprovar), com registro na trilha
// de auditoria. A ficha do candidato passa a ficar travada para edição.
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/decisao', exigirRh, (req, res) => {
  const { id } = req.params;
  const { decisao } = req.body;

  if (!DECISOES_VALIDAS.includes(decisao)) {
    return res.status(400).json({ erro: "Decisão inválida. Use 'APROVADO' ou 'REPROVADO'." });
  }

  const candidatos = lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  const agora = new Date().toISOString();
  const decisaoAnterior = candidato.decisaoFinal;

  candidato.decisaoFinal = decisao;
  candidato.decisaoFinalEm = agora;
  // O status geral da ficha passa a refletir definitivamente a decisão: a
  // partir daqui ela sai da aba "Em Análise" e passa a existir exclusivamente
  // em "Aprovados" ou "Reprovados".
  candidato.status = decisao;
  candidato.atualizadoEm = agora;
  salvarCandidatos(candidatos);

  registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'decisao_final',
    candidatoId: id,
    decisaoAnterior,
    decisaoNova: decisao,
    timestamp: agora,
    ip: req.ip
  });

  console.log(`--- [Auditoria] Decisão final --- ID: ${id} | Decisão: ${decisao} | IP: ${req.ip}`);

  return res.status(200).json({
    mensagem: 'Decisão registrada com sucesso!',
    candidato
  });
});

// Rótulos do status (documento/ficha em análise) usados no relatório exportado.
const ROTULO_STATUS_CSV = {
  VERMELHO: 'NÃO AVALIADO',
  AMARELO: 'EM ANÁLISE',
  APROVADO: 'APROVADO',
  REPROVADO: 'REPROVADO',
  CONTRATACAO_CONCLUIDA: 'CONTRATAÇÃO CONCLUÍDA'
};

// Escapa um valor para uma célula de CSV (aspas duplas + delimitador ';').
function paraCelulaCsv(valor) {
  return `"${String(valor == null ? '' : valor).replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// ROTA: exportação do relatório de candidatos em CSV (compatível com Excel)
// ---------------------------------------------------------------------------
app.get('/api/rh/exportar-csv', exigirRh, (req, res) => {
  const { filtro } = req.query;
  let candidatos = lerCandidatos();

  if (filtro === 'PENDENTE') {
    candidatos = candidatos.filter((c) => c.status === 'VERMELHO');
  } else if (filtro === 'EM_ANALISE') {
    candidatos = candidatos.filter((c) => c.status === 'AMARELO');
  } else if (filtro === 'APROVADO' || filtro === 'REPROVADO') {
    candidatos = candidatos.filter((c) => c.status === filtro);
  }

  const cabecalho = ['Nome', 'CPF', 'E-mail', 'Telefone', 'CEP', 'Endereço', 'Data de Submissão', 'Status Atual'];

  const linhas = candidatos.map((c) => {
    const endereco = [c.logradouro, c.numero, c.complemento, c.bairro].filter(Boolean).join(', ');
    const statusTexto = ROTULO_STATUS_CSV[c.status] || c.status || '';

    return [
      c.nomeCompleto,
      c.cpf,
      c.email,
      c.whatsapp,
      c.cep,
      endereco,
      c.criadoEm ? new Date(c.criadoEm).toLocaleString('pt-BR') : '',
      statusTexto
    ].map(paraCelulaCsv).join(';');
  });

  const csv = [cabecalho.map(paraCelulaCsv).join(';'), ...linhas].join('\r\n');
  const conteudo = '﻿' + csv; // BOM: garante acentuação correta ao abrir no Excel

  const dataArquivo = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="candidatos_${dataArquivo}.csv"`);
  return res.status(200).send(conteudo);
});

// ---------------------------------------------------------------------------
// ROTA: geração de um PDF real da ficha individual (dados pessoais,
// documentos e declaração de consentimento LGPD), para o RH visualizar,
// baixar ou imprimir a partir do visualizador de PDF do navegador - em vez
// de acionar diretamente a caixa de diálogo de impressão do sistema.
// ---------------------------------------------------------------------------
const TITULOS_DOCUMENTO = {
  identidade: 'Identidade (RG)',
  cpf: 'CPF',
  comprovanteResidencia: 'Comprovante de Residência',
  comprovanteEscolaridade: 'Comprovante de Escolaridade',
  reservista: 'Certificado de Reservista',
  carteiraTrabalho: 'Carteira de Trabalho'
};

function formatarDataBr(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function situacaoDocumentoPdf(candidato, tipo, documento) {
  if (documento.arquivo) return 'Enviado';
  if (tipo === 'reservista' && candidato.genero !== 'Masculino') return 'Não exigido';
  if (tipo === 'cpf' && candidato.cpfInclusoNaIdentidade) return 'Não exigido (incluso na Identidade)';
  return 'Pendente';
}

app.get('/api/rh/fichas/:id/pdf', exigirRh, (req, res) => {
  const { id } = req.params;
  const candidatos = lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
  // A ficha só pode ser impressa/gerada em PDF depois que todo o trâmite de
  // contratação estiver definitivamente vigente (status terminal).
  if (candidato.status !== 'CONTRATACAO_CONCLUIDA') {
    return res.status(400).json({ erro: 'A ficha só pode ser impressa depois que a contratação for concluída.' });
  }

  const nomeArquivo = `ficha-${candidato.id}.pdf`;
  const caminho = path.join(PASTA_UPLOADS, nomeArquivo);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const stream = fs.createWriteStream(caminho);
  doc.pipe(stream);

  const endereco = [candidato.logradouro, candidato.numero, candidato.complemento, candidato.bairro, candidato.cep]
    .filter(Boolean).join(', ');
  const decisaoTexto = candidato.decisaoFinal
    ? `${candidato.decisaoFinal} em ${formatarDataBr(candidato.decisaoFinalEm)}`
    : 'Ainda não decidida';

  doc.fontSize(18).font('Helvetica-Bold').fillColor('#1a252f')
    .text(`Ficha de Admissão - ${candidato.nomeCompleto}`, { underline: false });
  doc.moveDown(1);

  doc.fontSize(13).font('Helvetica-Bold').fillColor('#00A335').text('Dados Pessoais');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#000000');

  const campo = (rotulo, valor) => doc.font('Helvetica-Bold').text(`${rotulo}: `, { continued: true }).font('Helvetica').text(valor || '-');
  campo('Nome Completo', candidato.nomeCompleto);
  campo('CPF', candidato.cpf);
  campo('Data de Nascimento', candidato.dataNascimento);
  campo('Gênero', candidato.genero);
  campo('E-mail', candidato.email);
  campo('WhatsApp/Telefone', candidato.whatsapp);
  campo('Endereço', endereco);
  campo('Decisão Final', decisaoTexto);
  campo('Data de Submissão', formatarDataBr(candidato.criadoEm));

  doc.moveDown(1);
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#00A335').text('Documentos');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#000000');

  TIPOS_DOCUMENTO.forEach((tipo) => {
    const documento = candidato.documentos[tipo] || {};
    const situacao = situacaoDocumentoPdf(candidato, tipo, documento);
    doc.font('Helvetica-Bold').text(`${TITULOS_DOCUMENTO[tipo]}: `, { continued: true }).font('Helvetica').text(situacao);
  });

  doc.moveDown(1);
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a252f').text('Declaração de Consentimento (LGPD)');
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica').fillColor('#333333').text(
    `Ao submeter esta ficha em ${formatarDataBr(candidato.criadoEm)}, o(a) candidato(a) ${candidato.nomeCompleto} ` +
    'declarou estar ciente e de acordo com a coleta, o armazenamento e o tratamento dos seus dados pessoais e ' +
    'documentos para fins exclusivos deste processo seletivo, nos termos da Lei Geral de Proteção de Dados ' +
    'Pessoais (Lei nº 13.709/2018 - LGPD).',
    { align: 'justify' }
  );

  doc.moveDown(1.5);
  doc.fontSize(8).font('Helvetica').fillColor('#666666')
    .text(`Documento gerado pelo Painel do RH em ${formatarDataBr(new Date().toISOString())}.`);

  doc.end();

  stream.on('finish', () => {
    return res.status(200).json({ mensagem: 'PDF gerado com sucesso!', arquivo: 'uploads/' + nomeArquivo });
  });
  stream.on('error', (erro) => {
    console.error('Falha ao gerar PDF da ficha:', erro.message);
    return res.status(500).json({ erro: 'Falha ao gerar o PDF da ficha.' });
  });
});

// ---------------------------------------------------------------------------
// MÓDULO DE ACEITE VIRTUAL DE CONTRATOS POR CLIQUE (ASSINATURA ELETRÔNICA
// SIMPLES) - lista de documentos/contratos que o candidato aprovado precisa
// ler e aceitar individualmente (um clique = um aceite), antes de concluir a
// assinatura digital unificada.
// ---------------------------------------------------------------------------

const CONTRATOS_DOCUMENTOS = [
  { tipo: 'contratoTrabalho', titulo: 'Contrato de Trabalho (CLT)' },
  { tipo: 'termoConfidencialidade', titulo: 'Termo de Confidencialidade' },
  { tipo: 'politicaPrivacidade', titulo: 'Política de Privacidade e Tratamento de Dados (LGPD)' }
];
const TIPOS_CONTRATO = CONTRATOS_DOCUMENTOS.map((d) => d.tipo);

// Estrutura inicial do módulo de contratação: um estado de aceite por
// documento (null até o clique, com o PDF assinado gerado no aceite) + a
// assinatura digital unificada (só existe depois que TODOS os documentos
// acima estiverem aceitos) + a validação do RH.
function criarContratoInicial() {
  const documentos = {};
  TIPOS_CONTRATO.forEach((tipo) => { documentos[tipo] = { aceite: null, arquivoAssinado: null }; });
  return { documentos, assinaturaConcluida: null, validacaoRh: null };
}

function nomeArquivoMinuta(tipo) {
  return `minuta-${tipo}.pdf`;
}

function caminhoMinuta(tipo) {
  return path.join(PASTA_UPLOADS, nomeArquivoMinuta(tipo));
}

// Gera, uma única vez por tipo (se ainda não existir em disco), a minuta
// padrão de cada documento como PDF de exemplo - texto simples, suficiente
// para abrir corretamente no visualizador de PDF do navegador. Em um
// cenário real, estes arquivos seriam fornecidos pelo time Jurídico/RH.
function garantirMinutaContrato(tipo, titulo) {
  const caminho = caminhoMinuta(tipo);
  if (fs.existsSync(caminho)) return;
  const tituloEscapado = titulo.replace(/[()\\]/g, '');
  const conteudo = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 220 >>
stream
BT /F1 14 Tf 50 780 Td (MINUTA - ${tituloEscapado}) Tj ET
BT /F1 10 Tf 50 750 Td (Documento de exemplo - Onboarding Digital) Tj ET
BT /F1 10 Tf 50 730 Td (Substitua por um modelo real fornecido pelo Juridico/RH.) Tj ET
endstream
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF`;
  fs.writeFileSync(caminho, conteudo);
}

function garantirMinutasContrato() {
  CONTRATOS_DOCUMENTOS.forEach((doc) => garantirMinutaContrato(doc.tipo, doc.titulo));
}

// Hash SHA-256 do conteúdo exato de todas as minutas, na ordem fixa de
// CONTRATOS_DOCUMENTOS - evidência de integridade de qual versão dos
// documentos foi efetivamente aceita no momento da assinatura digital.
function calcularHashDocumentosContrato() {
  const hash = crypto.createHash('sha256');
  CONTRATOS_DOCUMENTOS.forEach((doc) => {
    hash.update(fs.readFileSync(caminhoMinuta(doc.tipo)));
  });
  return hash.digest('hex');
}

// Nome/caminho do PDF assinado de UM documento de UM candidato (gerado no
// momento do aceite - distinto da minuta genérica, que é a mesma para todos).
function nomeArquivoContratoAssinado(candidatoId, tipo) {
  return `contrato-${tipo}-${candidatoId}-assinado.pdf`;
}

// Gera (ou regenera, se o aceite for refeito) o PDF assinado de um documento
// do contrato: reproduz o texto da minuta e acrescenta um carimbo visível de
// assinatura eletrônica (nome, CPF, data/hora, IP e quem confirmou), para que
// o documento aberto pelo candidato ou pelo RH mostre claramente que aquele
// exemplar específico foi assinado - não é só um registro no banco de dados.
function gerarDocumentoContratoAssinado(candidato, tipo, titulo, aceite) {
  const nomeArquivo = nomeArquivoContratoAssinado(candidato.id, tipo);
  const caminho = path.join(PASTA_UPLOADS, nomeArquivo);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const stream = fs.createWriteStream(caminho);
  const prontoQuandoGravado = new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(nomeArquivo));
    stream.on('error', reject);
  });
  doc.pipe(stream);

  doc.fontSize(16).font('Helvetica-Bold').fillColor('#1a252f').text(titulo);
  doc.moveDown(1);
  doc.fontSize(10).font('Helvetica').fillColor('#333333').text(
    'Documento de exemplo - Onboarding Digital. Em um cenário real, este seria o ' +
    'texto integral do documento fornecido pelo time Jurídico/RH.'
  );
  doc.moveDown(2);

  const alturaCarimbo = 110;
  const yCarimbo = doc.y;
  doc.save();
  doc.rect(50, yCarimbo, doc.page.width - 100, alturaCarimbo).fillAndStroke('#eafaef', '#00A335');
  doc.restore();

  doc.fontSize(12).font('Helvetica-Bold').fillColor('#00812a')
    .text('✓ ASSINADO ELETRONICAMENTE', 60, yCarimbo + 10);
  doc.fontSize(9).font('Helvetica').fillColor('#1a252f');
  doc.text(`Assinado por: ${candidato.nomeCompleto} (CPF ${candidato.cpf})`, 60, yCarimbo + 32);
  doc.text(`Data/Hora: ${formatarDataBr(aceite.timestamp)}`, 60, yCarimbo + 47);
  doc.text(`IP de origem: ${aceite.ip || '-'}`, 60, yCarimbo + 62);
  doc.text(`Confirmado por: ${aceite.por === 'RH' ? 'RH (em nome do candidato)' : 'Candidato'}`, 60, yCarimbo + 77);
  doc.text(
    'Assinatura eletrônica válida nos termos da MP nº 2.200-2/2001 e da Lei nº 14.063/2020.',
    60, yCarimbo + 92
  );

  doc.end();
  return prontoQuandoGravado;
}

// Download da minuta de um documento/contrato específico.
app.get('/api/contrato/minuta/:tipo', (req, res) => {
  const { tipo } = req.params;
  if (!TIPOS_CONTRATO.includes(tipo)) {
    return res.status(400).json({ erro: 'Documento de contrato inválido.' });
  }
  garantirMinutaContrato(tipo, CONTRATOS_DOCUMENTOS.find((d) => d.tipo === tipo).titulo);
  return res.download(caminhoMinuta(tipo), nomeArquivoMinuta(tipo));
});

// O candidato clica em "Li e Aceito os Termos" para UM documento (aceite por
// clique = assinatura eletrônica simples). Só é permitido para fichas já
// APROVADAS pelo RH. Grava timestamp (ISO) e IP no documento e na auditoria.
app.post('/api/candidato/:id/contrato/:tipo/aceite', async (req, res) => {
  const { id, tipo } = req.params;
  if (!TIPOS_CONTRATO.includes(tipo)) {
    return res.status(400).json({ erro: 'Documento de contrato inválido.' });
  }

  const candidatos = lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
  if (candidato.status !== 'APROVADO') {
    return res.status(400).json({ erro: 'O aceite dos documentos só está disponível para fichas aprovadas e ainda não contratadas.' });
  }

  const agora = new Date().toISOString();
  const aceite = { timestamp: agora, ip: req.ip, por: 'CANDIDATO' };
  const titulo = CONTRATOS_DOCUMENTOS.find((d) => d.tipo === tipo).titulo;
  garantirMinutaContrato(tipo, titulo);
  const arquivoAssinado = await gerarDocumentoContratoAssinado(candidato, tipo, titulo, aceite);

  candidato.contrato.documentos[tipo].aceite = aceite;
  candidato.contrato.documentos[tipo].arquivoAssinado = 'uploads/' + arquivoAssinado;
  candidato.atualizadoEm = agora;
  salvarCandidatos(candidatos);

  registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'aceite_documento_contrato',
    candidatoId: id,
    documentoTipo: tipo,
    por: 'CANDIDATO',
    timestamp: agora,
    ip: req.ip
  });

  return res.status(200).json({ mensagem: 'Documento aceito com sucesso!', candidato });
});

// RH também pode marcar o aceite de um documento em nome do candidato
// (mesmo layout/ação "Aceitar Documento" usado nos demais cards do painel).
app.patch('/api/rh/fichas/:id/contrato/:tipo/aceitar', exigirRh, async (req, res) => {
  const { id, tipo } = req.params;
  if (!TIPOS_CONTRATO.includes(tipo)) {
    return res.status(400).json({ erro: 'Documento de contrato inválido.' });
  }

  const candidatos = lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
  if (candidato.status !== 'APROVADO') {
    return res.status(400).json({ erro: 'O aceite dos documentos só está disponível para fichas aprovadas e ainda não contratadas.' });
  }

  const agora = new Date().toISOString();
  const aceite = { timestamp: agora, ip: req.ip, por: 'RH' };
  const titulo = CONTRATOS_DOCUMENTOS.find((d) => d.tipo === tipo).titulo;
  garantirMinutaContrato(tipo, titulo);
  const arquivoAssinado = await gerarDocumentoContratoAssinado(candidato, tipo, titulo, aceite);

  candidato.contrato.documentos[tipo].aceite = aceite;
  candidato.contrato.documentos[tipo].arquivoAssinado = 'uploads/' + arquivoAssinado;
  candidato.atualizadoEm = agora;
  salvarCandidatos(candidatos);

  registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'aceite_documento_contrato',
    candidatoId: id,
    documentoTipo: tipo,
    por: 'RH',
    timestamp: agora,
    ip: req.ip
  });

  return res.status(200).json({ mensagem: 'Documento aceito com sucesso!', candidato });
});

// Conclusão unificada da assinatura digital: só é permitida quando TODOS os
// documentos da lista já foram aceitos individualmente. Grava o log de
// auditoria completo (IP, timestamp ISO, CPF do candidato e hash SHA-256 do
// conteúdo exato das minutas aceitas).
// Base legal citada no log de assinatura eletrônica simples (Momento 3 da
// jornada): validade da assinatura eletrônica (MP nº 2.200-2/2001 e Lei nº
// 14.063/2020) e a base legal do tratamento dos metadados (LGPD, Art. 7º).
const BASE_LEGAL_ASSINATURA_DIGITAL = 'MP nº 2.200-2/2001; Lei nº 14.063/2020; LGPD Art. 7º, II e V';

app.post('/api/candidato/:id/contrato/concluir', (req, res) => {
  const { id } = req.params;
  const { consentimentoContratoLGPD } = req.body;
  const candidatos = lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
  if (candidato.status !== 'APROVADO') {
    return res.status(400).json({ erro: 'A assinatura digital só está disponível para fichas aprovadas e ainda não contratadas.' });
  }

  const pendentes = TIPOS_CONTRATO.filter((tipo) => !candidato.contrato.documentos[tipo].aceite);
  if (pendentes.length) {
    return res.status(400).json({ erro: 'Confirme o aceite de todos os documentos antes de concluir a assinatura digital.' });
  }
  if (consentimentoContratoLGPD !== true) {
    return res.status(400).json({ erro: 'É necessário declarar ciência sobre a assinatura eletrônica (IP, timestamp e hash) para concluir.' });
  }

  garantirMinutasContrato();
  const agora = new Date().toISOString();
  const hash = calcularHashDocumentosContrato();

  candidato.contrato.assinaturaConcluida = { timestamp: agora, ip: req.ip, cpf: candidato.cpf, hash };
  // Consentimento específico da assinatura eletrônica do contrato (Momento 3
  // da jornada) - registrado separadamente do consentimento da ficha (Momento
  // 2), com o hash e a base legal citada ao candidato no momento do aceite.
  candidato.consentimentoContratoLGPD = {
    aceito: true,
    dataHora: agora,
    ip: req.ip,
    hashDocumentos: hash,
    baseLegal: BASE_LEGAL_ASSINATURA_DIGITAL
  };
  candidato.atualizadoEm = agora;
  salvarCandidatos(candidatos);

  registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'assinatura_digital_concluida',
    candidatoId: id,
    cpf: candidato.cpf,
    hashDocumentos: hash,
    baseLegal: BASE_LEGAL_ASSINATURA_DIGITAL,
    timestamp: agora,
    ip: req.ip
  });

  return res.status(200).json({ mensagem: 'Assinatura digital concluída com sucesso!', candidato });
});

// RH finaliza o processo: exige a assinatura digital unificada já concluída
// pelo candidato, e move o status geral da ficha para o estado terminal.
app.patch('/api/rh/fichas/:id/contrato/validar', exigirRh, (req, res) => {
  const { id } = req.params;
  const candidatos = lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
  if (candidato.status !== 'APROVADO') {
    return res.status(400).json({ erro: 'Só é possível validar a contratação de uma ficha aprovada.' });
  }
  if (!candidato.contrato.assinaturaConcluida) {
    return res.status(400).json({ erro: 'Aguardando a conclusão da assinatura digital pelo candidato.' });
  }

  const agora = new Date().toISOString();
  candidato.contrato.validacaoRh = { timestamp: agora, ip: req.ip, validadoPor: req.usuario.id };
  candidato.status = 'CONTRATACAO_CONCLUIDA';
  candidato.atualizadoEm = agora;
  salvarCandidatos(candidatos);

  registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'contratacao_concluida',
    candidatoId: id,
    timestamp: agora,
    ip: req.ip
  });

  return res.status(200).json({ mensagem: 'Contratação concluída com sucesso!', candidato });
});

// ---------------------------------------------------------------------------
// CONTA DE RH DE TESTES (MVP/Dev) - semeada de forma idempotente no boot,
// já que o formulário público de registro só cria contas 'candidato'.
// Credenciais documentadas no README.md, apenas para uso em desenvolvimento.
// ---------------------------------------------------------------------------
const EMAIL_RH_TESTE = 'rh@onboarding.local';
const SENHA_RH_TESTE = 'onboarding123';

function garantirUsuarioRhTeste() {
  const usuarios = lerUsuarios();
  if (usuarios.some((u) => u.email === EMAIL_RH_TESTE)) return;

  const { salt, hash } = gerarHashSenha(SENHA_RH_TESTE);
  usuarios.push({
    id: gerarId(),
    nome: 'RH Onboarding Digital',
    email: EMAIL_RH_TESTE,
    senhaSalt: salt,
    senhaHash: hash,
    tipo: 'rh',
    googleId: null,
    criadoEm: new Date().toISOString()
  });
  salvarUsuarios(usuarios);
  console.log('--- Conta de RH de testes criada (MVP/Dev):', EMAIL_RH_TESTE, '---');
}

garantirUsuarioRhTeste();
garantirMinutasContrato();

// Porta configurável via variável de ambiente PORT (padrão do Node/Express e
// das plataformas de deploy em nuvem, como Render e Railway, que injetam essa
// variável automaticamente). Padrão local: 3001, evitando conflito com outros
// servidores locais, como o do projeto Pré-Vendas na 3000.
const PORTA = process.env.PORT || 3001;
app.listen(PORTA, () => {
  console.log(`Servidor de Onboarding Digital rodando em http://localhost:${PORTA}`);
});
