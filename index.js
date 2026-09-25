// Carrega variáveis de ambiente de um .env local (desenvolvimento) antes de
// qualquer outro módulo ser inicializado - na Vercel isso é um no-op, pois a
// plataforma já injeta as variáveis de ambiente nativamente.
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { OAuth2Client } = require('google-auth-library');
const supabase = require('./db/supabase');

const app = express();

app.use(express.json());

// A primeira tela do sistema é o login, não a ficha do candidato - só depois
// de entrar (ou criar conta) é que o candidato é levado à Ficha de Admissão.
app.get('/', (req, res) => res.redirect('/login.html'));

// Caminho absoluto (não relativo ao cwd) - na Vercel (serverless), o
// diretório de trabalho durante a execução da função não é garantidamente a
// raiz do projeto, então 'public' relativo pode não resolver para a pasta
// certa e todo pedido de página estática (login.html, rh.html etc.) falha
// com "Cannot GET" mesmo com os arquivos presentes no projeto.
app.use(express.static(path.join(__dirname, 'public')));

// Diretório gravável dos arquivos de dados (JSON, PDFs, planilha Mestre).
// Na Vercel (serverless) o diretório do projeto é somente leitura - só /tmp
// aceita gravação - então lá os arquivos são redirecionados para /tmp.
// AVISO IMPORTANTE: /tmp é efêmero (apagado a cada cold start/nova
// instância, e não é compartilhado entre instâncias concorrentes). Isso
// evita que a aplicação quebre com erro de disco somente-leitura em
// produção na Vercel, mas NÃO resolve persistência de dados - candidatos,
// usuários e sessões cadastrados em produção podem ser perdidos a qualquer
// momento. Para persistência real na Vercel, é necessário migrar para um
// banco de dados gerenciado (Vercel Postgres/KV, Supabase etc.) - fora do
// escopo desta adaptação, que só garante compatibilidade estrutural.
const DIRETORIO_DADOS = process.env.VERCEL ? '/tmp' : __dirname;

// Caminho absoluto do arquivo de persistência local (banco de dados simples em JSON)
const ARQUIVO_CANDIDATOS = path.join(DIRETORIO_DADOS, 'candidatos.json');

// Caminho absoluto da trilha de auditoria (registro imutável de eventos do RH)
const ARQUIVO_AUDITORIA = path.join(DIRETORIO_DADOS, 'auditoria.json');

// Caminho absoluto da base de contas de usuário (login/registro/Google)
const ARQUIVO_USUARIOS = path.join(DIRETORIO_DADOS, 'usuarios.json');

// Caminho absoluto dos tokens de sessão ativos (login persiste entre reinícios)
const ARQUIVO_SESSOES = path.join(DIRETORIO_DADOS, 'sessoes.json');

// Pasta onde os documentos PDF dos candidatos são armazenados
const PASTA_UPLOADS = path.join(DIRETORIO_DADOS, 'uploads');

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

// Mapeia uma linha da tabela "candidatos" (snake_case, Postgres) + as
// mensagens de chat já carregadas para o objeto camelCase que o resto deste
// arquivo e os dois frontends (public/index.html, public/rh.html) esperam.
function candidatoParaCamelCase(row, mensagens) {
  return {
    id: row.id,
    nomeCompleto: row.nome_completo,
    cpf: row.cpf,
    email: row.email,
    whatsapp: row.whatsapp,
    genero: row.genero,
    cep: row.cep,
    logradouro: row.logradouro,
    bairro: row.bairro,
    numero: row.numero,
    complemento: row.complemento,
    dataNascimento: row.data_nascimento,
    status: row.status,
    cpfInclusoNaIdentidade: row.cpf_incluso_na_identidade,
    documentos: row.documentos,
    decisaoFinal: row.decisao_final,
    decisaoFinalEm: row.decisao_final_em,
    usuarioId: row.usuario_id,
    contrato: row.contrato,
    consentimentoFichaLGPD: row.consentimento_ficha_lgpd,
    consentimentoContratoLGPD: row.consentimento_contrato_lgpd,
    integracaoPonto: row.integracao_ponto,
    fichaPdf: row.ficha_pdf,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
    mensagens: mensagens || []
  };
}

// Mapeia um candidato (camelCase, formato do app) para a linha snake_case da
// tabela "candidatos" - "mensagens" fica de fora de propósito, pois tem
// caminho de gravação próprio (tabela "mensagens_chat", ver rota POST
// /api/candidato/:id/mensagens) e não deve ser reescrito num upsert genérico.
function candidatoParaSnakeCase(c) {
  return {
    id: c.id,
    nome_completo: c.nomeCompleto,
    cpf: c.cpf,
    email: c.email,
    whatsapp: c.whatsapp,
    genero: c.genero,
    cep: c.cep,
    logradouro: c.logradouro,
    bairro: c.bairro,
    numero: c.numero,
    complemento: c.complemento,
    data_nascimento: c.dataNascimento,
    status: c.status,
    cpf_incluso_na_identidade: !!c.cpfInclusoNaIdentidade,
    documentos: c.documentos,
    decisao_final: c.decisaoFinal || null,
    decisao_final_em: c.decisaoFinalEm || null,
    usuario_id: c.usuarioId || null,
    contrato: c.contrato,
    consentimento_ficha_lgpd: c.consentimentoFichaLGPD,
    consentimento_contrato_lgpd: c.consentimentoContratoLGPD,
    integracao_ponto: c.integracaoPonto,
    ficha_pdf: c.fichaPdf || null,
    criado_em: c.criadoEm,
    // Sempre com um valor explícito (nunca undefined): um candidato recém
    // criado ainda não tem atualizadoEm - cai para criadoEm. Isso evita um
    // problema real do PostgREST em upserts em lote: se um objeto do lote
    // não tem a chave (undefined) enquanto outros têm, o PostgREST manda
    // NULL para essa linha, violando a coluna NOT NULL da tabela.
    atualizado_em: c.atualizadoEm || c.criadoEm || new Date().toISOString()
  };
}

// Mapeia uma linha da tabela "mensagens_chat" para o formato camelCase já
// usado pelo chat (candidato_id fica de fora - é implícito, o array já está
// aninhado dentro do candidato correspondente).
function mensagemParaCamelCase(row) {
  return {
    id: row.id,
    autor: row.autor,
    nomeAutor: row.nome_autor,
    texto: row.texto,
    timestamp: row.timestamp,
    ip: row.ip
  };
}

// Lê a lista de candidatos do Supabase (tabela "candidatos" + mensagens de
// chat embutidas a partir de "mensagens_chat"). Mantém exatamente o mesmo
// formato (camelCase, array) que o restante do arquivo sempre esperou.
async function lerCandidatos() {
  const { data: linhas, error: erroCandidatos } = await supabase.from('candidatos').select('*');
  if (erroCandidatos) throw erroCandidatos;

  const { data: mensagensLinhas, error: erroMensagens } = await supabase
    .from('mensagens_chat')
    .select('*')
    .order('timestamp', { ascending: true });
  if (erroMensagens) throw erroMensagens;

  const mensagensPorCandidato = {};
  (mensagensLinhas || []).forEach((m) => {
    if (!mensagensPorCandidato[m.candidato_id]) mensagensPorCandidato[m.candidato_id] = [];
    mensagensPorCandidato[m.candidato_id].push(mensagemParaCamelCase(m));
  });

  const candidatos = (linhas || []).map((row) => candidatoParaCamelCase(row, mensagensPorCandidato[row.id] || []));

  // Migração leve: fichas criadas antes do módulo de contratação/autenticação
  // não têm os campos "contrato"/"usuarioId" preenchidos - aplica o mesmo
  // valor padrão que já existia na época dos arquivos JSON.
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
    if (c.integracaoPonto === undefined) c.integracaoPonto = criarIntegracaoPontoInicial();

    // Migração: fichas gravadas antes da consolidação para 4 status ainda têm
    // os valores antigos (VERMELHO/AMARELO/APROVADO) - normaliza para o
    // modelo atual assim que lidas, sem precisar recriar a base de dados.
    if (c.status === 'VERMELHO' || c.status === 'AMARELO') c.status = 'EM_ANALISE';
    else if (c.status === 'APROVADO') c.status = 'PENDENTE_ASSINATURA';
  });

  return candidatos;
}

// Grava (upsert) a lista completa de candidatos no Supabase - "mensagens" é
// excluído do upsert de propósito (ver candidatoParaSnakeCase). Toda gravação
// (nova ficha, mudança de status, decisão, contrato etc.) também dispara a
// atualização da planilha Mestre em Excel, em segundo plano - não bloqueia a
// resposta da requisição que originou a gravação.
async function salvarCandidatos(lista) {
  const linhas = lista.map(candidatoParaSnakeCase);
  const { error } = await supabase.from('candidatos').upsert(linhas, { onConflict: 'id' });
  if (error) throw error;
  atualizarPlanilhaMestre();
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

// Mapeia uma linha da tabela "usuarios" (snake_case) para o objeto camelCase
// que o restante do arquivo espera.
function usuarioParaCamelCase(row) {
  return {
    id: row.id,
    nome: row.nome,
    email: row.email,
    senhaSalt: row.senha_salt,
    senhaHash: row.senha_hash,
    tipo: row.tipo,
    googleId: row.google_id,
    cpf: row.cpf,
    dataNascimento: row.data_nascimento,
    ativo: row.ativo,
    tokenAtivacao: row.token_ativacao,
    consentimentoCadastro: row.consentimento_cadastro,
    criadoEm: row.criado_em
  };
}

// Mapeia um usuário (camelCase) para a linha snake_case da tabela "usuarios".
function usuarioParaSnakeCase(u) {
  return {
    id: u.id,
    nome: u.nome,
    email: u.email,
    senha_salt: u.senhaSalt || null,
    senha_hash: u.senhaHash || null,
    tipo: u.tipo,
    google_id: u.googleId || null,
    cpf: u.cpf || null,
    data_nascimento: u.dataNascimento || null,
    ativo: u.ativo !== false,
    token_ativacao: u.tokenAtivacao || null,
    consentimento_cadastro: u.consentimentoCadastro || null,
    criado_em: u.criadoEm
  };
}

async function lerUsuarios() {
  const { data, error } = await supabase.from('usuarios').select('*');
  if (error) throw error;
  return (data || []).map(usuarioParaCamelCase);
}

async function salvarUsuarios(lista) {
  const linhas = lista.map(usuarioParaSnakeCase);
  const { error } = await supabase.from('usuarios').upsert(linhas, { onConflict: 'id' });
  if (error) throw error;
}

// Mapeia uma linha da tabela "sessoes" (snake_case) para o objeto camelCase
// que o restante do arquivo espera. criadoEm/expiraEm continuam números
// (epoch ms), como sempre foram - a coluna é "bigint" justamente para isso.
function sessaoParaCamelCase(row) {
  return {
    token: row.token,
    usuarioId: row.usuario_id,
    criadoEm: Number(row.criado_em),
    expiraEm: Number(row.expira_em)
  };
}

function sessaoParaSnakeCase(s) {
  return {
    token: s.token,
    usuario_id: s.usuarioId,
    criado_em: s.criadoEm,
    expira_em: s.expiraEm
  };
}

async function lerSessoes() {
  const { data, error } = await supabase.from('sessoes').select('*');
  if (error) throw error;
  return (data || []).map(sessaoParaCamelCase);
}

// "lista" representa o estado completo desejado das sessões - mesmo padrão
// do antigo arquivo JSON, que era sobrescrito por inteiro (ex.: no logout, o
// token removido não pode "sobrar" no banco) - por isso a tabela é
// substituída por completo a cada gravação, em vez de um upsert simples.
async function salvarSessoes(lista) {
  const { error: erroDelete } = await supabase.from('sessoes').delete().neq('token', '');
  if (erroDelete) throw erroDelete;
  if (!lista.length) return;
  const linhas = lista.map(sessaoParaSnakeCase);
  const { error } = await supabase.from('sessoes').insert(linhas);
  if (error) throw error;
}

// Tempo de validade de um token de sessão: 7 dias.
const DURACAO_SESSAO_MS = 7 * 24 * 60 * 60 * 1000;

// Gera hash de senha com bcrypt. O salt fica embutido no próprio hash (não
// precisa de um campo separado) - senha nunca é armazenada em texto puro.
function gerarHashSenha(senha) {
  const hash = bcrypt.hashSync(String(senha), 10);
  return { salt: null, hash };
}

// Contas criadas antes da migração para bcrypt ainda têm senhaSalt preenchido
// (hash gerado com scrypt, nativo do Node) - continuam funcionando via essa
// verificação legada, sem exigir que o usuário redefina a senha.
function senhaConfereScryptLegado(senha, salt, hashEsperado) {
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  // Comparação em tempo constante para evitar timing attacks.
  const bufA = Buffer.from(hash, 'hex');
  const bufB = Buffer.from(hashEsperado, 'hex');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function senhaConfere(senha, salt, hashEsperado) {
  if (salt) return senhaConfereScryptLegado(String(senha), salt, hashEsperado);
  return bcrypt.compareSync(String(senha), hashEsperado);
}

function dadosPublicosUsuario(usuario) {
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    tipo: usuario.tipo,
    cpf: usuario.cpf || null,
    dataNascimento: usuario.dataNascimento || null
  };
}

// Cria uma sessão para o usuário e persiste o token (login e registro reutilizam isso).
async function criarSessao(usuarioId) {
  const sessoes = await lerSessoes();
  const token = crypto.randomBytes(32).toString('hex');
  const agora = Date.now();
  sessoes.push({ token, usuarioId, criadoEm: agora, expiraEm: agora + DURACAO_SESSAO_MS });
  await salvarSessoes(sessoes);
  return token;
}

// Resolve o usuário autenticado a partir do header Authorization: Bearer <token>.
// Retorna null se o token estiver ausente, inválido ou expirado.
async function resolverUsuarioPorToken(req) {
  const cabecalho = req.headers.authorization || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
  if (!token) return null;

  const sessoes = await lerSessoes();
  const sessao = sessoes.find((s) => s.token === token && s.expiraEm > Date.now());
  if (!sessao) return null;

  const usuarios = await lerUsuarios();
  return usuarios.find((u) => u.id === sessao.usuarioId) || null;
}

// Middleware: exige sessão válida (qualquer papel) e anexa req.usuario.
async function autenticar(req, res, next) {
  try {
    const usuario = await resolverUsuarioPorToken(req);
    if (!usuario) return res.status(401).json({ erro: 'Sessão inválida ou expirada. Faça login novamente.' });
    req.usuario = usuario;
    next();
  } catch (erro) {
    console.error('Falha ao resolver sessão:', erro.message);
    return res.status(500).json({ erro: 'Falha ao validar a sessão.' });
  }
}

// Middleware: anexa req.usuario se houver um token válido, mas não bloqueia a
// requisição caso não haja sessão (usado no cadastro da ficha, que continua
// funcionando de forma anônima por compatibilidade).
async function autenticarOpcional(req, res, next) {
  try {
    req.usuario = await resolverUsuarioPorToken(req);
  } catch (erro) {
    console.error('Falha ao resolver sessão (opcional):', erro.message);
    req.usuario = null;
  }
  next();
}

// Middleware: exige sessão válida do papel 'rh' - protege o Painel do RH.
async function exigirRh(req, res, next) {
  try {
    const usuario = await resolverUsuarioPorToken(req);
    if (!usuario) return res.status(401).json({ erro: 'Sessão inválida ou expirada. Faça login novamente.' });
    if (usuario.tipo !== 'rh') return res.status(403).json({ erro: 'Acesso restrito à equipe de RH.' });
    req.usuario = usuario;
    next();
  } catch (erro) {
    console.error('Falha ao resolver sessão RH:', erro.message);
    return res.status(500).json({ erro: 'Falha ao validar a sessão.' });
  }
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

// Estrutura inicial do controle de integração com o sistema de ponto/RH
// externo (Arquitetura B2B) - nasce como "não exportado"; fica marcado
// manualmente pelo RH (ou por uma futura integração automática) quando os
// dados do candidato admitido são enviados ao sistema de ponto de destino.
function criarIntegracaoPontoInicial() {
  return { exportado: false, timestamp: null, sistemaAlvo: null };
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

app.post('/api/auth/registrar', async (req, res) => {
  try {
  const { nome, email, senha, confirmarSenha, dataNascimento, cpf, aceiteTermos } = req.body;
  const nomeAparado = String(nome || '').trim();
  const emailAparado = String(email || '').trim().toLowerCase();

  if (!nomeAparado) return res.status(400).json({ erro: 'Informe seu nome.' });
  if (!REGEX_EMAIL_AUTH.test(emailAparado)) return res.status(400).json({ erro: 'E-mail inválido.' });
  if (!senha || String(senha).length < 6) return res.status(400).json({ erro: 'A senha deve ter pelo menos 6 caracteres.' });
  if (senha !== confirmarSenha) {
    return res.status(400).json({ erro: 'As senhas não coincidem.' });
  }
  if (!dataNascimentoValida(somenteDigitos(dataNascimento))) {
    return res.status(400).json({ erro: 'Data de nascimento incompleta ou inválida.' });
  }
  if (somenteDigitos(cpf).length !== 11) {
    return res.status(400).json({ erro: 'CPF incompleto ou inválido.' });
  }
  if (aceiteTermos !== true) {
    return res.status(400).json({ erro: 'É necessário aceitar os Termos de Uso e a Política de Privacidade para criar a conta.' });
  }

  const usuarios = await lerUsuarios();
  if (usuarios.some((u) => u.email === emailAparado)) {
    return res.status(400).json({ erro: 'Já existe uma conta com este e-mail.' });
  }

  const agora = new Date().toISOString();
  const { salt, hash } = gerarHashSenha(String(senha));
  const novoUsuario = {
    id: gerarId(),
    nome: nomeAparado,
    email: emailAparado,
    dataNascimento,
    cpf,
    senhaSalt: salt,
    senhaHash: hash,
    tipo: 'candidato',
    googleId: null,
    // Conta criada mas ainda não confirmada - só é ativada ao clicar no link
    // de ativação (simulado no console/modal de teste, ver /api/auth/ativar).
    ativo: false,
    tokenAtivacao: crypto.randomBytes(24).toString('hex'),
    // Aceite inicial dos Termos de Uso/Política de Privacidade (LGPD -
    // Momento 1 da jornada), com evidência de quando e de onde partiu.
    consentimentoCadastro: { aceito: true, timestamp: agora, ip: req.ip, versaoTermo: VERSAO_TERMOS_CADASTRO },
    criadoEm: agora
  };

  usuarios.push(novoUsuario);
  await salvarUsuarios(usuarios);

  registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'consentimento_cadastro',
    usuarioId: novoUsuario.id,
    email: emailAparado,
    versaoTermo: VERSAO_TERMOS_CADASTRO,
    timestamp: agora,
    ip: req.ip
  });

  console.log('\n=== [SIMULAÇÃO DE E-MAIL] Confirmação de cadastro ===');
  console.log(`Para: ${emailAparado}`);
  console.log(`Link de ativação: http://localhost:${PORTA}/login.html?ativacao=${novoUsuario.tokenAtivacao}`);
  console.log('=======================================================\n');

  return res.status(201).json({
    mensagem: 'Conta criada! Confirme seu cadastro pelo link de ativação (verifique o console do servidor nesse ambiente de testes).',
    linkAtivacao: `/login.html?ativacao=${novoUsuario.tokenAtivacao}`,
    tokenAtivacao: novoUsuario.tokenAtivacao
  });
  } catch (erro) {
    console.error('Falha ao registrar usuário:', erro.message);
    return res.status(500).json({ erro: 'Falha ao criar a conta.' });
  }
});

// Ativa a conta a partir do token de ativação enviado (simulado) por e-mail,
// e já cria a sessão em seguida (auto-login pós-confirmação).
app.post('/api/auth/ativar', async (req, res) => {
  try {
  const { token } = req.body;
  if (!token) return res.status(400).json({ erro: 'Token de ativação ausente.' });

  const usuarios = await lerUsuarios();
  const usuario = usuarios.find((u) => u.tokenAtivacao === token);
  if (!usuario) {
    return res.status(404).json({ erro: 'Link de ativação inválido ou já utilizado.' });
  }

  usuario.ativo = true;
  usuario.tokenAtivacao = null;
  await salvarUsuarios(usuarios);

  const sessaoToken = await criarSessao(usuario.id);
  return res.status(200).json({ mensagem: 'Conta ativada com sucesso!', token: sessaoToken, usuario: dadosPublicosUsuario(usuario) });
  } catch (erro) {
    console.error('Falha ao ativar conta:', erro.message);
    return res.status(500).json({ erro: 'Falha ao ativar a conta.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
  const { email, senha } = req.body;
  const emailAparado = String(email || '').trim().toLowerCase();

  const usuarios = await lerUsuarios();
  const usuario = usuarios.find((u) => u.email === emailAparado);

  if (!usuario || !usuario.senhaHash || !senhaConfere(String(senha || ''), usuario.senhaSalt, usuario.senhaHash)) {
    return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
  }

  if (usuario.ativo === false) {
    return res.status(403).json({ erro: 'Conta ainda não ativada. Verifique o link de confirmação enviado no cadastro (ou o console do servidor, neste ambiente de testes).' });
  }

  const token = await criarSessao(usuario.id);

  // Trilha de auditoria (LGPD): registra quem entrou, quando e de onde -
  // mesmo padrão já usado para o consentimento de cadastro e o chat.
  registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'login',
    usuarioId: usuario.id,
    email: usuario.email,
    tipo: usuario.tipo,
    timestamp: new Date().toISOString(),
    ip: req.ip
  });

  return res.status(200).json({ mensagem: 'Login realizado com sucesso!', token, usuario: dadosPublicosUsuario(usuario) });
  } catch (erro) {
    console.error('Falha ao fazer login:', erro.message);
    return res.status(500).json({ erro: 'Falha ao fazer login.' });
  }
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

  let usuarios;
  let usuario;
  try {
    usuarios = await lerUsuarios();
    usuario = usuarios.find((u) => u.email === emailGoogle);

    if (!usuario) {
      usuario = {
        id: gerarId(),
        nome: payload.name || emailGoogle,
        email: emailGoogle,
        senhaSalt: null,
        senhaHash: null,
        tipo: 'candidato',
        googleId: payload.sub,
        ativo: true,
        criadoEm: new Date().toISOString()
      };
      usuarios.push(usuario);
      await salvarUsuarios(usuarios);
    } else if (!usuario.googleId) {
      usuario.googleId = payload.sub;
      await salvarUsuarios(usuarios);
    }

    const token = await criarSessao(usuario.id);
    return res.status(200).json({ mensagem: 'Login com Google realizado com sucesso!', token, usuario: dadosPublicosUsuario(usuario) });
  } catch (erro) {
    console.error('Falha no login com Google:', erro.message);
    return res.status(500).json({ erro: 'Falha ao autenticar com o Google.' });
  }
});

// Informa ao frontend se o Google Sign-In está configurado neste ambiente
// (e o Client ID a usar) - evita renderizar o botão do Google sem propósito.
app.get('/api/auth/google-client-id', (req, res) => {
  return res.status(200).json({ clientId: GOOGLE_CLIENT_ID || null });
});

app.get('/api/auth/sessao', autenticar, (req, res) => {
  return res.status(200).json({ usuario: dadosPublicosUsuario(req.usuario) });
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const cabecalho = req.headers.authorization || '';
    const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
    if (token) {
      const sessoes = (await lerSessoes()).filter((s) => s.token !== token);
      await salvarSessoes(sessoes);
    }
    return res.status(200).json({ mensagem: 'Sessão encerrada.' });
  } catch (erro) {
    console.error('Falha ao encerrar sessão:', erro.message);
    return res.status(500).json({ erro: 'Falha ao encerrar a sessão.' });
  }
});

// Fichas vinculadas ao usuário autenticado (vínculo estrito ficha <-> perfil).
app.get('/api/auth/minhas-fichas', autenticar, async (req, res) => {
  try {
  const candidatos = await lerCandidatos();
  const minhasFichas = candidatos.filter((c) => c.usuarioId === req.usuario.id);
  return res.status(200).json(minhasFichas);
  } catch (erro) {
    console.error('Falha ao buscar minhas fichas:', erro.message);
    return res.status(500).json({ erro: 'Falha ao buscar suas fichas.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: cadastro de nova ficha de candidato (Etapa 1 - Dados Pessoais)
// ---------------------------------------------------------------------------
// Versão vigente do Termo de Consentimento LGPD exibido no envio da ficha
// (Momento 2 da jornada) - referenciada no log de auditoria.
const VERSAO_TERMO_FICHA_LGPD = '1.0';
const FINALIDADE_TERMO_FICHA_LGPD = 'Processo Admissional e Validação de Documentos';

app.post('/api/candidato', autenticarOpcional, async (req, res) => {
  try {
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
    status: 'EM_ANALISE',
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
    integracaoPonto: criarIntegracaoPontoInicial(),
    criadoEm: agora
  };

  const candidatos = await lerCandidatos();
  candidatos.push(novoCandidato);
  await salvarCandidatos(candidatos);

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
  } catch (erro) {
    console.error('Falha ao cadastrar candidato:', erro.message);
    return res.status(500).json({ erro: 'Falha ao cadastrar a ficha.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: atualização dos dados pessoais / regras (gênero e CPF incluso)
// ---------------------------------------------------------------------------
app.patch('/api/candidato/:id/dados', async (req, res) => {
  try {
  const { id } = req.params;
  const { genero, cpfInclusoNaIdentidade } = req.body;

  const candidatos = await lerCandidatos();
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
  await salvarCandidatos(candidatos);

  return res.status(200).json({
    mensagem: 'Dados do candidato atualizados com sucesso!',
    candidato
  });
  } catch (erro) {
    console.error('Falha ao atualizar dados do candidato:', erro.message);
    return res.status(500).json({ erro: 'Falha ao atualizar os dados do candidato.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: envio de um documento PDF para uma das abas
// ---------------------------------------------------------------------------
app.post('/api/candidato/:id/documento', (req, res) => {
  upload.single('arquivo')(req, res, async (erroUpload) => {
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

    try {
    const candidatos = await lerCandidatos();
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

    await salvarCandidatos(candidatos);

    console.log(`--- Documento recebido --- ID: ${id} | Tipo: ${tipo} | Arquivo: ${req.file.filename}`);

    return res.status(201).json({
      mensagem: 'Documento enviado com sucesso!',
      candidato
    });
    } catch (erro) {
      console.error('Falha ao salvar documento:', erro.message);
      return res.status(500).json({ erro: 'Falha ao salvar o documento.' });
    }
  });
});

// ---------------------------------------------------------------------------
// ROTA: exclusão de um documento PDF já anexado
// ---------------------------------------------------------------------------
app.delete('/api/candidato/:id/documento/:tipo', async (req, res) => {
  try {
  const { id, tipo } = req.params;

  if (!TIPOS_DOCUMENTO.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo de documento inválido.' });
  }

  const candidatos = await lerCandidatos();
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

  await salvarCandidatos(candidatos);

  console.log(`--- Documento excluído --- ID: ${id} | Tipo: ${tipo}`);

  return res.status(200).json({
    mensagem: 'Documento excluído com sucesso!',
    candidato
  });
  } catch (erro) {
    console.error('Falha ao excluir documento:', erro.message);
    return res.status(500).json({ erro: 'Falha ao excluir o documento.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: listagem completa de candidatos (consumida pelo painel do RH)
// ---------------------------------------------------------------------------
app.get('/api/candidatos', async (req, res) => {
  try {
    const candidatos = await lerCandidatos();
    return res.status(200).json(candidatos);
  } catch (erro) {
    console.error('Falha ao listar candidatos:', erro.message);
    return res.status(500).json({ erro: 'Falha ao listar candidatos.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: alteração do status geral do candidato pelo RH (EM_ANALISE ou
// PENDENTE_ASSINATURA)
// ---------------------------------------------------------------------------
app.patch('/api/candidato/:id/status', async (req, res) => {
  try {
  const { id } = req.params;
  const { status } = req.body;

  if (status !== 'EM_ANALISE' && status !== 'PENDENTE_ASSINATURA') {
    return res.status(400).json({
      erro: "Status inválido. Use 'EM_ANALISE' (Em Análise) ou 'PENDENTE_ASSINATURA' (Pendente de Assinatura)."
    });
  }

  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  candidato.status = status;
  candidato.atualizadoEm = new Date().toISOString();
  await salvarCandidatos(candidatos);

  console.log(`--- Status atualizado --- ID: ${id} | Novo status: ${status}`);

  return res.status(200).json({
    mensagem: 'Status do candidato atualizado com sucesso!',
    candidato
  });
  } catch (erro) {
    console.error('Falha ao atualizar status:', erro.message);
    return res.status(500).json({ erro: 'Falha ao atualizar o status.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: listagem de fichas para o Painel de Gestão do RH (Etapa 2)
// ---------------------------------------------------------------------------
app.get('/api/rh/fichas', exigirRh, async (req, res) => {
  try {
    const candidatos = await lerCandidatos();
    return res.status(200).json(candidatos);
  } catch (erro) {
    console.error('Falha ao listar fichas do RH:', erro.message);
    return res.status(500).json({ erro: 'Falha ao listar as fichas.' });
  }
});

// Status que o RH pode atribuir a uma ficha pelo Painel de Gestão.
const STATUS_VALIDOS_RH = ['EM_ANALISE', 'PENDENTE_ASSINATURA'];

// ---------------------------------------------------------------------------
// ROTA: alteração de status de uma ficha pelo RH, com registro na trilha de
// auditoria (LGPD): quem, quando (timestamp) e de onde (IP) a alteração partiu.
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/status', exigirRh, async (req, res) => {
  try {
  const { id } = req.params;
  const { status } = req.body;

  if (!STATUS_VALIDOS_RH.includes(status)) {
    return res.status(400).json({
      erro: "Status inválido. Use 'EM_ANALISE' (Em Análise) ou 'PENDENTE_ASSINATURA' (Pendente de Assinatura)."
    });
  }

  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  const statusAnterior = candidato.status;
  const agora = new Date().toISOString();

  candidato.status = status;
  candidato.atualizadoEm = agora;
  await salvarCandidatos(candidatos);

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
  } catch (erro) {
    console.error('Falha ao atualizar status (RH):', erro.message);
    return res.status(500).json({ erro: 'Falha ao atualizar o status da ficha.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: busca de uma única ficha por id (usada pelo candidato para retornar
// à própria ficha - via link com ?id= - e ver pendências, mensagens e decisão)
// ---------------------------------------------------------------------------
app.get('/api/candidato/:id', async (req, res) => {
  try {
    const candidatos = await lerCandidatos();
    const candidato = candidatos.find((c) => c.id === req.params.id);

    if (!candidato) {
      return res.status(404).json({ erro: 'Candidato não encontrado.' });
    }

    return res.status(200).json(candidato);
  } catch (erro) {
    console.error('Falha ao buscar candidato:', erro.message);
    return res.status(500).json({ erro: 'Falha ao buscar o candidato.' });
  }
});

// Quem pode enviar uma mensagem no chat da ficha.
const AUTORES_VALIDOS = ['RH', 'Candidato'];

// ---------------------------------------------------------------------------
// ROTA: consulta das mensagens do chat via HTTP Polling - o front-end chama
// isto periodicamente (a cada poucos segundos) enquanto o chat está visível.
// Escolhido no lugar de um stream SSE mantido aberto porque funciona de
// forma segura em ambiente serverless (Vercel): cada chamada é uma
// requisição curta e independente, sem depender de uma conexão HTTP
// mantida aberta (que seria encerrada pelo limite de execução da função) nem
// de estado em memória compartilhado entre instâncias/invocações diferentes.
// Aceita ?apos=<timestamp ISO> para retornar só as mensagens novas desde a
// última consulta do front-end, evitando reenviar o histórico inteiro a
// cada poll.
// ---------------------------------------------------------------------------
app.get('/api/candidato/:id/mensagens', async (req, res) => {
  try {
    const { id } = req.params;
    const { apos } = req.query;

    // Consulta direta em mensagens_chat (tabela própria, normalizada) - mais
    // eficiente do que carregar a lista inteira de candidatos só para filtrar
    // o array embutido de mensagens de um único candidato.
    const { data: candidatoRow, error: erroCandidato } = await supabase
      .from('candidatos')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (erroCandidato) throw erroCandidato;
    if (!candidatoRow) return res.status(404).json({ erro: 'Candidato não encontrado.' });

    let consulta = supabase
      .from('mensagens_chat')
      .select('*')
      .eq('candidato_id', id)
      .order('timestamp', { ascending: true });
    if (apos) {
      consulta = consulta.gt('timestamp', new Date(apos).toISOString());
    }

    const { data: linhas, error: erroMensagens } = await consulta;
    if (erroMensagens) throw erroMensagens;

    const mensagens = (linhas || []).map(mensagemParaCamelCase);
    return res.status(200).json({ mensagens });
  } catch (erro) {
    console.error('Falha ao buscar mensagens:', erro.message);
    return res.status(500).json({ erro: 'Falha ao buscar as mensagens.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: envio de mensagem no chat da ficha (RH <-> Candidato), com histórico
// ordenado por data/hora persistido junto da ficha em candidatos.json
// ---------------------------------------------------------------------------
app.post('/api/candidato/:id/mensagens', async (req, res) => {
  try {
    const { id } = req.params;
    const { autor, texto, nomeAutor } = req.body;

    if (!AUTORES_VALIDOS.includes(autor)) {
      return res.status(400).json({ erro: "Autor inválido. Use 'RH' ou 'Candidato'." });
    }

    const textoAparado = String(texto || '').trim();
    if (!textoAparado) {
      return res.status(400).json({ erro: 'Mensagem vazia.' });
    }

    // Busca só a linha do candidato (não a lista inteira) - o suficiente para
    // validar existência e a regra de bloqueio por REPROVADO.
    const { data: candidatoRow, error: erroCandidato } = await supabase
      .from('candidatos')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (erroCandidato) throw erroCandidato;

    if (!candidatoRow) {
      return res.status(404).json({ erro: 'Candidato não encontrado.' });
    }

    // Bloqueio definitivo: processo finalizado (reprovado) não recebe mais
    // mensagens de nenhum dos dois lados.
    if (candidatoRow.status === 'REPROVADO') {
      return res.status(400).json({ erro: 'Atendimento encerrado. Este processo admissional foi finalizado.' });
    }

    // Nome exibido junto da mensagem: do candidato sempre vem da própria ficha
    // (nunca confia no valor enviado pelo cliente); do RH vem do corpo da
    // requisição, já que esta rota não tem middleware de autenticação.
    const nomeAutorFinal = autor === 'Candidato'
      ? candidatoRow.nome_completo
      : (String(nomeAutor || '').trim() || 'RH');

    const agora = new Date().toISOString();
    const novaMensagem = {
      id: gerarId(),
      autor,
      nomeAutor: nomeAutorFinal,
      texto: textoAparado,
      timestamp: agora,
      ip: req.ip
    };

    // Insere a mensagem diretamente na tabela própria (mensagens_chat), sem
    // passar pelo upsert da ficha inteira - evita sobrescrever concorrentemente
    // o restante dos dados do candidato só para acrescentar uma mensagem.
    const { error: erroInsercao } = await supabase.from('mensagens_chat').insert({
      id: novaMensagem.id,
      candidato_id: id,
      autor: novaMensagem.autor,
      nome_autor: novaMensagem.nomeAutor,
      texto: novaMensagem.texto,
      timestamp: novaMensagem.timestamp,
      ip: novaMensagem.ip
    });
    if (erroInsercao) throw erroInsercao;

    // Só o carimbo de atualização da ficha muda - um update pontual, não um
    // upsert da linha inteira.
    const { error: erroUpdate } = await supabase
      .from('candidatos')
      .update({ atualizado_em: agora })
      .eq('id', id);
    if (erroUpdate) throw erroUpdate;

    // Trilha de auditoria (LGPD): quem escreveu, quando e de onde.
    registrarEventoAuditoria({
      id: gerarId(),
      tipoEvento: 'mensagem_chat',
      candidatoId: id,
      autor,
      timestamp: agora,
      ip: req.ip
    });

    // Devolve a ficha completa (mesmo formato de sempre) para o frontend
    // atualizar seu cache local e a lista de mensagens em tela.
    const { data: mensagensLinhas, error: erroMensagens } = await supabase
      .from('mensagens_chat')
      .select('*')
      .eq('candidato_id', id)
      .order('timestamp', { ascending: true });
    if (erroMensagens) throw erroMensagens;

    candidatoRow.atualizado_em = agora;
    const candidato = candidatoParaCamelCase(candidatoRow, (mensagensLinhas || []).map(mensagemParaCamelCase));

    return res.status(201).json({ mensagem: 'Mensagem enviada.', candidato });
  } catch (erro) {
    console.error('Falha ao enviar mensagem:', erro.message);
    return res.status(500).json({ erro: 'Falha ao enviar a mensagem.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: RH marca um documento já enviado como "Com Pendência / Exige Reenvio",
// com justificativa obrigatória. Libera especificamente aquele documento para
// o candidato reenviar, e registra o evento na trilha de auditoria (LGPD).
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/documento/:tipo/pendencia', exigirRh, async (req, res) => {
  try {
  const { id, tipo } = req.params;
  const { justificativa } = req.body;

  if (!TIPOS_DOCUMENTO.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo de documento inválido.' });
  }

  const justificativaAparada = String(justificativa || '').trim();
  if (!justificativaAparada) {
    return res.status(400).json({ erro: 'Informe a justificativa da pendência.' });
  }

  const candidatos = await lerCandidatos();
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

  candidato.atualizadoEm = agora;
  await salvarCandidatos(candidatos);

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
  } catch (erro) {
    console.error('Falha ao registrar pendência:', erro.message);
    return res.status(500).json({ erro: 'Falha ao registrar a pendência.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: RH aceita um documento já enviado (marca como Aprovado/Ok a nível de
// documento). Encerra uma eventual pendência aberta e conta como primeira
// interação do RH com a ficha.
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/documento/:tipo/aceitar', exigirRh, async (req, res) => {
  try {
  const { id, tipo } = req.params;

  if (!TIPOS_DOCUMENTO.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo de documento inválido.' });
  }

  const candidatos = await lerCandidatos();
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

  candidato.atualizadoEm = agora;
  await salvarCandidatos(candidatos);

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
  } catch (erro) {
    console.error('Falha ao aceitar documento:', erro.message);
    return res.status(500).json({ erro: 'Falha ao aceitar o documento.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: RH abriu/visualizou um documento (clique em "Visualizar/Baixar PDF").
// Não altera nada no documento em si; apenas registra o evento na auditoria.
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/documento/:tipo/visualizado', exigirRh, async (req, res) => {
  try {
  const { id, tipo } = req.params;

  if (!TIPOS_DOCUMENTO.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo de documento inválido.' });
  }

  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  const agora = new Date().toISOString();

  registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'documento_visualizado',
    candidatoId: id,
    documentoTipo: tipo,
    timestamp: agora,
    ip: req.ip
  });

  return res.status(200).json({ mensagem: 'ok', candidato });
  } catch (erro) {
    console.error('Falha ao registrar visualização:', erro.message);
    return res.status(500).json({ erro: 'Falha ao registrar a visualização.' });
  }
});

// Decisões finais válidas para o processo admissional.
const DECISOES_VALIDAS = ['APROVADO', 'REPROVADO'];

// ---------------------------------------------------------------------------
// ROTA: decisão final do processo (Aprovar/Reprovar), com registro na trilha
// de auditoria. A ficha do candidato passa a ficar travada para edição.
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/decisao', exigirRh, async (req, res) => {
  try {
  const { id } = req.params;
  const { decisao } = req.body;

  if (!DECISOES_VALIDAS.includes(decisao)) {
    return res.status(400).json({ erro: "Decisão inválida. Use 'APROVADO' ou 'REPROVADO'." });
  }

  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  const agora = new Date().toISOString();
  const decisaoAnterior = candidato.decisaoFinal;

  candidato.decisaoFinal = decisao;
  candidato.decisaoFinalEm = agora;
  // O status geral da ficha passa a refletir definitivamente a decisão: a
  // partir daqui ela sai de "Em Análise" e passa a existir exclusivamente em
  // "Pendente de Assinatura" (aprovado, aguardando aceite/assinatura do
  // contrato) ou "Reprovado".
  candidato.status = decisao === 'APROVADO' ? 'PENDENTE_ASSINATURA' : 'REPROVADO';
  candidato.atualizadoEm = agora;
  await salvarCandidatos(candidatos);

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
  } catch (erro) {
    console.error('Falha ao registrar decisão:', erro.message);
    return res.status(500).json({ erro: 'Falha ao registrar a decisão.' });
  }
});

// Rótulos do status (documento/ficha em análise) usados no relatório exportado.
const ROTULO_STATUS_CSV = {
  EM_ANALISE: 'EM ANÁLISE',
  PENDENTE_ASSINATURA: 'PENDENTE DE ASSINATURA',
  REPROVADO: 'REPROVADO',
  CONTRATACAO_CONCLUIDA: 'CONTRATAÇÃO CONCLUÍDA'
};

// Rótulos do status a nível de documento individual (VERMELHO/AMARELO/VERDE
// - independente do status geral da ficha), usados apenas para o Certificado
// de Reservista no relatório.
const ROTULO_STATUS_DOCUMENTO = {
  VERMELHO: 'PENDENTE',
  AMARELO: 'EM ANÁLISE',
  VERDE: 'APROVADO'
};

// Rótulo textual do Certificado de Reservista para o relatório: segue a
// mesma regra de dispensa por gênero usada no resto do sistema.
function rotuloReservistaRelatorio(candidato) {
  if (candidato.genero !== 'Masculino') return 'Não exigido';
  const status = candidato.documentos.reservista?.status;
  return ROTULO_STATUS_DOCUMENTO[status] || status || '';
}

// Resumo compacto do status dos 6 documentos obrigatórios (quantos já foram
// enviados e quantos já foram aceitos/aprovados pelo RH) para uma única
// célula do relatório.
function resumoStatusDocumentosRelatorio(candidato) {
  let enviados = 0;
  let aceitos = 0;
  TIPOS_DOCUMENTO.forEach((tipo) => {
    const documento = candidato.documentos[tipo] || {};
    if (documento.arquivo || documento.status === 'VERDE') enviados++;
    if (documento.status === 'VERDE') aceitos++;
  });
  return `${enviados}/${TIPOS_DOCUMENTO.length} enviados | ${aceitos}/${TIPOS_DOCUMENTO.length} aceitos`;
}

// Cabeçalho completo do relatório de admissões (CSV legado e planilha Mestre
// em Excel compartilham exatamente as mesmas 23 colunas).
const CABECALHO_RELATORIO = [
  'Nome Completo', 'CPF', 'E-mail', 'Telefone', 'Gênero', 'CEP', 'Endereço', 'Número', 'Complemento',
  'Status Atual', 'Data de Submissão', 'Última Atualização',
  'Consentimento LGPD', 'Timestamp LGPD', 'IP LGPD',
  'Status Documentos', 'CPF no RG', 'Reservista',
  'Aceite Contratual', 'Timestamp Aceite Contrato', 'Hash Contrato',
  'Exportado Ponto', 'Sistema Ponto Alvo'
];

// Monta a linha (array de 23 valores brutos, sem formatação de célula) de um
// candidato para o relatório de admissões - usada pela planilha Mestre em
// Excel. Fica centralizada aqui para nunca haver divergência de colunas.
function montarLinhaRelatorio(c) {
  const endereco = [c.logradouro, c.bairro].filter(Boolean).join(', ');
  const statusTexto = ROTULO_STATUS_CSV[c.status] || c.status || '';
  const consentimentoFicha = c.consentimentoFichaLGPD;
  const assinatura = c.contrato?.assinaturaConcluida;
  const integracaoPonto = c.integracaoPonto || criarIntegracaoPontoInicial();

  return [
    c.nomeCompleto,
    c.cpf,
    c.email,
    c.whatsapp,
    c.genero,
    c.cep,
    endereco,
    c.numero,
    c.complemento,
    statusTexto,
    formatarDataBr(c.criadoEm),
    formatarDataBr(c.atualizadoEm),
    consentimentoFicha?.aceito ? 'Sim' : 'Não',
    consentimentoFicha ? formatarDataBr(consentimentoFicha.dataHora) : '',
    consentimentoFicha?.ip || '',
    resumoStatusDocumentosRelatorio(c),
    c.cpfInclusoNaIdentidade ? 'Sim' : 'Não',
    rotuloReservistaRelatorio(c),
    assinatura ? 'Sim' : 'Não',
    assinatura ? formatarDataBr(assinatura.timestamp) : '',
    assinatura?.hash || '',
    integracaoPonto.exportado ? 'Sim' : 'Não',
    integracaoPonto.sistemaAlvo || ''
  ];
}

// ---------------------------------------------------------------------------
// PLANILHA MESTRE (Excel .xlsx) - relatorio_geral_admissoes.xlsx na raiz do
// projeto, regenerada automaticamente a cada gravação de candidatos.json
// (nova ficha, mudança de status, decisão, contrato etc. - ver o hook dentro
// de salvarCandidatos()), sempre refletindo os dados mais recentes do sistema.
// ---------------------------------------------------------------------------
const ARQUIVO_PLANILHA_MESTRE = path.join(DIRETORIO_DADOS, 'relatorio_geral_admissoes.xlsx');

// Cores de destaque (fundo/texto) por status, aplicadas na coluna "Status
// Atual" de cada linha - o equivalente visual de uma formatação condicional,
// calculado no momento da geração (o arquivo é sempre recriado do zero, então
// não há necessidade de uma regra dinâmica do Excel).
const ESTILO_STATUS_PLANILHA = {
  'CONTRATAÇÃO CONCLUÍDA': { fundo: 'FF00A335', texto: 'FFFFFFFF' },
  'PENDENTE DE ASSINATURA': { fundo: 'FFF97316', texto: 'FFFFFFFF' },
  'EM ANÁLISE': { fundo: 'FFF5E40B', texto: 'FF1A1A1A' },
  REPROVADO: { fundo: 'FFFF0303', texto: 'FFFFFFFF' }
};

const BORDA_FINA_PLANILHA = {
  top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' }
};

// Colunas de código, data ou status ficam centralizadas nas linhas de dados
// (o texto livre - nome, e-mail, endereço, complemento e o sistema de ponto
// - continua alinhado à esquerda, mais legível para conteúdo longo).
const COLUNAS_CENTRALIZADAS_PLANILHA = new Set([
  'CPF', 'Telefone', 'Gênero', 'CEP', 'Número',
  'Status Atual', 'Data de Submissão', 'Última Atualização',
  'Consentimento LGPD', 'Timestamp LGPD', 'IP LGPD',
  'Status Documentos', 'CPF no RG', 'Reservista',
  'Aceite Contratual', 'Timestamp Aceite Contrato', 'Hash Contrato',
  'Exportado Ponto'
]);

// Gera (ou recria por completo) a planilha Mestre a partir do estado atual
// de candidatos.json - lê sempre do disco, nunca de um parâmetro em memória,
// para que a última gravação da fila (ver atualizarPlanilhaMestre) sempre
// reflita o estado mais recente, mesmo sob gravações concorrentes.
async function gerarOuAtualizarPlanilhaMestre() {
  const candidatos = await lerCandidatos();

  const workbook = new ExcelJS.Workbook();
  const planilha = workbook.addWorksheet('Relatório de Admissões');

  const linhaCabecalho = planilha.addRow(CABECALHO_RELATORIO);
  linhaCabecalho.eachCell((celula) => {
    celula.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    celula.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF005623' } };
    celula.alignment = { horizontal: 'center', vertical: 'middle' };
    celula.border = BORDA_FINA_PLANILHA;
  });

  const indiceColunaStatus = CABECALHO_RELATORIO.indexOf('Status Atual') + 1;
  const indicesCentralizados = CABECALHO_RELATORIO
    .map((titulo, indice) => (COLUNAS_CENTRALIZADAS_PLANILHA.has(titulo) ? indice + 1 : null))
    .filter((indice) => indice !== null);

  candidatos.forEach((c) => {
    const linha = planilha.addRow(montarLinhaRelatorio(c));
    linha.eachCell((celula) => { celula.border = BORDA_FINA_PLANILHA; });
    indicesCentralizados.forEach((indice) => {
      linha.getCell(indice).alignment = { horizontal: 'center', vertical: 'middle' };
    });

    const estilo = ESTILO_STATUS_PLANILHA[String(linha.getCell(indiceColunaStatus).value || '')];
    if (estilo) {
      const celulaStatus = linha.getCell(indiceColunaStatus);
      celulaStatus.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: estilo.fundo } };
      celulaStatus.font = { color: { argb: estilo.texto }, bold: true };
      celulaStatus.alignment = { horizontal: 'center', vertical: 'middle' };
    }
  });

  planilha.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: CABECALHO_RELATORIO.length } };

  // Largura automática por coluna, baseada no maior conteúdo (cabeçalho incluso).
  CABECALHO_RELATORIO.forEach((titulo, indice) => {
    const coluna = planilha.getColumn(indice + 1);
    let maiorTamanho = titulo.length;
    coluna.eachCell({ includeEmpty: true }, (celula) => {
      const tamanho = String(celula.value == null ? '' : celula.value).length;
      if (tamanho > maiorTamanho) maiorTamanho = tamanho;
    });
    coluna.width = Math.min(maiorTamanho + 2, 60);
  });

  await workbook.xlsx.writeFile(ARQUIVO_PLANILHA_MESTRE);
}

// Fila serializada: garante que nunca haja duas gravações do mesmo arquivo
// .xlsx em paralelo (o que poderia corromper o arquivo) quando várias
// requisições disparam atualizações quase ao mesmo tempo.
let filaPlanilhaMestre = Promise.resolve();
function atualizarPlanilhaMestre() {
  filaPlanilhaMestre = filaPlanilhaMestre.then(gerarOuAtualizarPlanilhaMestre).catch((erro) => {
    console.error('Falha ao atualizar a planilha mestre:', erro.message);
  });
  return filaPlanilhaMestre;
}

// ---------------------------------------------------------------------------
// ROTA: download da planilha Mestre de admissões em Excel (.xlsx), sempre
// atualizada com os dados mais recentes do sistema antes do envio.
// ---------------------------------------------------------------------------
app.get('/api/rh/exportar-relatorio', exigirRh, async (req, res) => {
  try {
    await atualizarPlanilhaMestre();
    return res.download(ARQUIVO_PLANILHA_MESTRE, 'relatorio_geral_admissoes.xlsx');
  } catch (erro) {
    console.error('Falha ao exportar a planilha mestre:', erro.message);
    return res.status(500).json({ erro: 'Falha ao gerar o relatório em Excel.' });
  }
});

// ---------------------------------------------------------------------------
// DASHBOARD DE ADMISSÕES - filtros compartilhados entre o painel visual
// (public/rh.html) e o relatório em PDF gerado abaixo, para que o PDF
// exportado sempre reflita exatamente o que o RH está vendo na tela.
// ---------------------------------------------------------------------------

// Aplica os mesmos filtros do painel (período de submissão, status e busca
// por nome/CPF) sobre a lista de candidatos.
function filtrarCandidatosParaDashboard(candidatos, query = {}) {
  let resultado = candidatos;
  const { dataInicio, dataFim, status, busca } = query;

  if (status) {
    resultado = resultado.filter((c) => c.status === status);
  }

  if (dataInicio) {
    const inicio = new Date(`${dataInicio}T00:00:00`);
    resultado = resultado.filter((c) => new Date(c.criadoEm) >= inicio);
  }

  if (dataFim) {
    const fim = new Date(`${dataFim}T23:59:59`);
    resultado = resultado.filter((c) => new Date(c.criadoEm) <= fim);
  }

  if (busca) {
    const termo = String(busca).trim().toLowerCase();
    const termoDigitos = termo.replace(/\D/g, '');
    resultado = resultado.filter((c) => {
      const nome = (c.nomeCompleto || '').toLowerCase();
      const cpfDigitos = (c.cpf || '').replace(/\D/g, '');
      return nome.includes(termo) || (termoDigitos.length > 0 && cpfDigitos.includes(termoDigitos));
    });
  }

  return resultado;
}

// Calcula os KPIs consolidados (contagens, percentuais e taxa de adesão por
// etapa da jornada) sobre um conjunto de candidatos já filtrado. Os quatro
// buckets de status (em análise/pendente de assinatura/reprovadas/concluídas)
// são mutuamente exclusivos e somam o total.
function calcularKpisDashboard(candidatos) {
  const total = candidatos.length;
  const percentual = (valor) => (total === 0 ? 0 : Math.round((valor / total) * 1000) / 10);

  const contratacoesConcluidas = candidatos.filter((c) => c.status === 'CONTRATACAO_CONCLUIDA').length;
  const emAnalise = candidatos.filter((c) => c.status === 'EM_ANALISE').length;
  const pendenteAssinatura = candidatos.filter((c) => c.status === 'PENDENTE_ASSINATURA').length;
  const reprovadas = candidatos.filter((c) => c.status === 'REPROVADO').length;

  const comAceiteContrato = candidatos.filter((c) => c.contrato?.assinaturaConcluida).length;

  return {
    total,
    contratacoesConcluidas, percentualContratacoesConcluidas: percentual(contratacoesConcluidas),
    emAnalise, percentualEmAnalise: percentual(emAnalise),
    pendenteAssinatura, percentualPendenteAssinatura: percentual(pendenteAssinatura),
    reprovadas, percentualReprovadas: percentual(reprovadas),
    etapaAceiteContrato: percentual(comAceiteContrato)
  };
}

// Rótulos e valores de cada filtro aplicado na tela do Dashboard, para exibir
// de forma explícita no cabeçalho do PDF exportado - o RH precisa ver
// exatamente qual período/status/busca gerou aquele relatório.
function descreverFiltrosDashboard(query = {}) {
  const { dataInicio, dataFim, status, busca } = query;
  const partes = [];

  if (dataInicio || dataFim) {
    partes.push(`Período: ${dataInicio ? formatarDataBr(`${dataInicio}T00:00:00`).split(',')[0] : 'início'} até ${dataFim ? formatarDataBr(`${dataFim}T00:00:00`).split(',')[0] : 'hoje'}`);
  }
  if (status) {
    partes.push(`Status: ${ROTULO_STATUS_CSV[status] || status}`);
  }
  if (busca) {
    partes.push(`Busca: "${busca}"`);
  }

  return partes.length ? partes.join('   |   ') : 'Nenhum filtro aplicado - todos os registros do sistema';
}

// ---------------------------------------------------------------------------
// ROTA: relatório visual do Dashboard de Admissões em PDF (A4 paisagem),
// respeitando os mesmos filtros (período/status/busca) aplicados na tela.
// ---------------------------------------------------------------------------
app.get('/api/relatorio/dashboard-pdf', exigirRh, async (req, res) => {
  try {
    const candidatosFiltrados = filtrarCandidatosParaDashboard(await lerCandidatos(), req.query);
    const kpis = calcularKpisDashboard(candidatosFiltrados);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="dashboard_admissoes.pdf"');

    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    doc.pipe(res);

    const larguraUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Cabeçalho corporativo
    doc.rect(doc.page.margins.left, doc.page.margins.top, larguraUtil, 55).fill('#005623');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18)
      .text('Dashboard de Admissões', doc.page.margins.left + 15, doc.page.margins.top + 10);
    doc.font('Helvetica').fontSize(9)
      .text('Sistema de Onboarding Digital & Conformidade Trabalhista', doc.page.margins.left + 15, doc.page.margins.top + 34);
    doc.font('Helvetica-Bold').fontSize(9)
      .text(`Gerado em: ${formatarDataBr(new Date().toISOString())}`, doc.page.margins.left, doc.page.margins.top + 10, { width: larguraUtil - 15, align: 'right' });
    doc.font('Helvetica').fontSize(9)
      .text(`Registros no filtro: ${kpis.total}`, doc.page.margins.left, doc.page.margins.top + 34, { width: larguraUtil - 15, align: 'right' });

    // Filtros aplicados - mostrado sempre, mesmo sem filtro nenhum (deixa
    // explícito que o relatório traz TODOS os registros nesse caso), para que
    // o PDF nunca deixe dúvida sobre qual período/status/busca foi impresso.
    const yFiltros = doc.page.margins.top + 62;
    doc.rect(doc.page.margins.left, yFiltros, larguraUtil, 22).fill('#f4f6f9');
    doc.fillColor('#1a252f').font('Helvetica-Bold').fontSize(8)
      .text('FILTROS APLICADOS:  ', doc.page.margins.left + 10, yFiltros + 7, { continued: true })
      .font('Helvetica').fillColor('#333333')
      .text(descreverFiltrosDashboard(req.query));

    doc.y = yFiltros + 22 + 15;

    // Blocos de KPI
    const blocos = [
      { rotulo: 'Total de Admissões', valor: String(kpis.total), destaque: '#1a252f' },
      { rotulo: 'Contratações Concluídas', valor: `${kpis.contratacoesConcluidas} (${kpis.percentualContratacoesConcluidas}%)`, destaque: '#00A335' },
      { rotulo: 'Em Análise', valor: `${kpis.emAnalise} (${kpis.percentualEmAnalise}%)`, destaque: '#F5E40B' },
      { rotulo: 'Pendente de Assinatura', valor: `${kpis.pendenteAssinatura} (${kpis.percentualPendenteAssinatura}%)`, destaque: '#F97316' },
      { rotulo: 'Recusadas / Reprovadas', valor: `${kpis.reprovadas} (${kpis.percentualReprovadas}%)`, destaque: '#FF0303' }
    ];

    const espacamento = 10;
    const larguraBloco = (larguraUtil - espacamento * (blocos.length - 1)) / blocos.length;
    const yBlocos = doc.y;
    const alturaBloco = 55;

    blocos.forEach((bloco, indice) => {
      const x = doc.page.margins.left + indice * (larguraBloco + espacamento);
      doc.lineWidth(1).rect(x, yBlocos, larguraBloco, alturaBloco).stroke('#cccccc');
      doc.rect(x, yBlocos, 4, alturaBloco).fill(bloco.destaque);
      doc.fillColor('#6c757d').font('Helvetica-Bold').fontSize(8)
        .text(bloco.rotulo.toUpperCase(), x + 10, yBlocos + 8, { width: larguraBloco - 16 });
      doc.fillColor('#2c3e50').font('Helvetica-Bold').fontSize(14)
        .text(bloco.valor, x + 10, yBlocos + 26, { width: larguraBloco - 16 });
    });

    doc.y = yBlocos + alturaBloco + 22;

    // Dois painéis lado a lado, espelhando os mesmos 2 gráficos exibidos na
    // aba "Estatísticas & Relatórios" do painel (mesmas cores e categorias),
    // para que o PDF exportado seja fiel ao que o RH vê na tela.
    const yPaineis = doc.y;
    const alturaPaineis = 130;
    const larguraPainel = (larguraUtil - espacamento) / 2;
    const xPainelEsquerdo = doc.page.margins.left;
    const xPainelDireito = doc.page.margins.left + larguraPainel + espacamento;

    doc.lineWidth(1).rect(xPainelEsquerdo, yPaineis, larguraPainel, alturaPaineis).stroke('#e6e9ee');
    doc.lineWidth(1).rect(xPainelDireito, yPaineis, larguraPainel, alturaPaineis).stroke('#e6e9ee');

    // Painel 1: Distribuição por Status - barra segmentada proporcional
    // (equivalente ao gráfico de rosca da tela) com legenda e percentuais.
    doc.fillColor('#1a252f').font('Helvetica-Bold').fontSize(10)
      .text('Distribuição por Status', xPainelEsquerdo + 12, yPaineis + 10);

    const fatias = [
      { rotulo: 'Contratação Concluída', valor: kpis.contratacoesConcluidas, pct: kpis.percentualContratacoesConcluidas, cor: '#00A335' },
      { rotulo: 'Em Análise', valor: kpis.emAnalise, pct: kpis.percentualEmAnalise, cor: '#F5E40B' },
      { rotulo: 'Pendente de Assinatura', valor: kpis.pendenteAssinatura, pct: kpis.percentualPendenteAssinatura, cor: '#F97316' },
      { rotulo: 'Reprovado', valor: kpis.reprovadas, pct: kpis.percentualReprovadas, cor: '#FF0303' }
    ];

    const xBarraSegmentada = xPainelEsquerdo + 12;
    const larguraBarraSegmentada = larguraPainel - 24;
    const yBarraSegmentada = yPaineis + 32;
    const alturaBarraSegmentada = 16;

    if (kpis.total === 0) {
      doc.rect(xBarraSegmentada, yBarraSegmentada, larguraBarraSegmentada, alturaBarraSegmentada).fill('#e6e9ee');
    } else {
      let xSegmento = xBarraSegmentada;
      fatias.forEach((fatia) => {
        const largura = (fatia.valor / kpis.total) * larguraBarraSegmentada;
        if (largura > 0) doc.rect(xSegmento, yBarraSegmentada, largura, alturaBarraSegmentada).fill(fatia.cor);
        xSegmento += largura;
      });
    }

    let yLegenda = yBarraSegmentada + alturaBarraSegmentada + 14;
    fatias.forEach((fatia) => {
      doc.rect(xPainelEsquerdo + 12, yLegenda, 8, 8).fill(fatia.cor);
      doc.fillColor('#333333').font('Helvetica').fontSize(8)
        .text(`${fatia.rotulo}: ${fatia.valor} (${fatia.pct}%)`, xPainelEsquerdo + 26, yLegenda - 1, { width: larguraPainel - 40 });
      yLegenda += 14;
    });

    // Painel 2: Taxa de Adesão por Etapa - gráfico de barras verticais
    // (mesmas 4 categorias e cores do gráfico da tela).
    doc.fillColor('#1a252f').font('Helvetica-Bold').fontSize(10)
      .text('Taxa de Adesão por Etapa', xPainelDireito + 12, yPaineis + 10);

    const etapas = [
      { rotulo: 'Reprovado', pct: kpis.percentualReprovadas, cor: '#FF0303' },
      { rotulo: 'Em Análise', pct: kpis.percentualEmAnalise, cor: '#F5E40B' },
      { rotulo: 'Pend. Assinatura', pct: kpis.percentualPendenteAssinatura, cor: '#F97316' },
      { rotulo: 'Aceite Contrato', pct: kpis.etapaAceiteContrato, cor: '#00A335' }
    ];

    const alturaMaximaBarra = 60;
    const yBaseBarras = yPaineis + 32 + alturaMaximaBarra;
    const larguraBarraVertical = 26;
    const espacoEntreBarras = (larguraPainel - 24 - larguraBarraVertical * etapas.length) / (etapas.length + 1);

    etapas.forEach((etapa, indice) => {
      const x = xPainelDireito + 12 + espacoEntreBarras * (indice + 1) + larguraBarraVertical * indice;
      const alturaBarra = Math.max((etapa.pct / 100) * alturaMaximaBarra, etapa.pct > 0 ? 3 : 0);
      doc.fillColor('#333333').font('Helvetica-Bold').fontSize(7)
        .text(`${etapa.pct}%`, x - 5, yBaseBarras - alturaBarra - 11, { width: larguraBarraVertical + 10, align: 'center' });
      doc.rect(x, yBaseBarras - alturaBarra, larguraBarraVertical, alturaBarra).fill(etapa.cor);
      doc.fillColor('#333333').font('Helvetica').fontSize(6.5)
        .text(etapa.rotulo, x - 8, yBaseBarras + 4, { width: larguraBarraVertical + 16, align: 'center' });
    });
    doc.moveTo(xPainelDireito + 12, yBaseBarras).lineTo(xPainelDireito + larguraPainel - 12, yBaseBarras).lineWidth(0.5).stroke('#cccccc');

    doc.y = yPaineis + alturaPaineis + 22;

    // Tabela analítica dos candidatos filtrados
    doc.fillColor('#1a252f').font('Helvetica-Bold').fontSize(11).text('Candidatos no Filtro Selecionado', doc.page.margins.left);
    doc.moveDown(0.4);

    const colunas = [
      { titulo: 'Nome Completo', largura: 0.24 },
      { titulo: 'CPF', largura: 0.14 },
      { titulo: 'Status Atual', largura: 0.20 },
      { titulo: 'Data de Submissão', largura: 0.16 },
      { titulo: 'Aceite Contrato', largura: 0.13 },
      { titulo: 'Exportado Ponto', largura: 0.13 }
    ];
    const xColunas = [];
    let acumulado = doc.page.margins.left;
    colunas.forEach((coluna) => { xColunas.push(acumulado); acumulado += larguraUtil * coluna.largura; });

    function desenharCabecalhoTabela() {
      const yCabecalho = doc.y;
      doc.rect(doc.page.margins.left, yCabecalho, larguraUtil, 20).fill('#005623');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
      colunas.forEach((coluna, indice) => {
        doc.text(coluna.titulo, xColunas[indice] + 4, yCabecalho + 6, { width: larguraUtil * coluna.largura - 8 });
      });
      doc.y = yCabecalho + 20;
    }

    desenharCabecalhoTabela();
    doc.font('Helvetica').fontSize(8).fillColor('#000000');

    candidatosFiltrados.forEach((c, indice) => {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 20) {
        doc.addPage();
        desenharCabecalhoTabela();
        doc.font('Helvetica').fontSize(8).fillColor('#000000');
      }

      const yLinha = doc.y;
      if (indice % 2 === 1) {
        doc.rect(doc.page.margins.left, yLinha, larguraUtil, 18).fill('#f4f6f9');
      }

      const statusTexto = ROTULO_STATUS_CSV[c.status] || c.status || '';
      const aceiteTexto = c.contrato?.assinaturaConcluida ? 'Sim' : 'Não';
      const pontoTexto = c.integracaoPonto?.exportado ? 'Sim' : 'Não';
      const valores = [c.nomeCompleto, c.cpf, statusTexto, formatarDataBr(c.criadoEm), aceiteTexto, pontoTexto];

      doc.fillColor('#000000').font('Helvetica').fontSize(8);
      valores.forEach((valor, indiceColuna) => {
        doc.text(String(valor || '-'), xColunas[indiceColuna] + 4, yLinha + 5, { width: larguraUtil * colunas[indiceColuna].largura - 8 });
      });
      doc.y = yLinha + 18;
    });

    if (candidatosFiltrados.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#6c757d')
        .text('Nenhum candidato encontrado para os filtros selecionados.', doc.page.margins.left, doc.y + 6);
    }

    doc.end();
  } catch (erro) {
    console.error('Falha ao gerar o PDF do dashboard:', erro.message);
    return res.status(500).json({ erro: 'Falha ao gerar o relatório em PDF.' });
  }
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

// ---------------------------------------------------------------------------
// API REST v1 - integração com sistemas externos de admissão (protegida por
// API Key). API_KEY_ADMISSOES deve ser configurada via variável de ambiente
// em produção; o valor fixo abaixo é apenas um padrão de desenvolvimento.
// ---------------------------------------------------------------------------
const CHAVE_API_ADMISSOES = process.env.API_KEY_ADMISSOES || 'onboarding-dev-key-2026';

function exigirApiKeyAdmissoes(req, res, next) {
  const chaveRecebida = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!chaveRecebida || chaveRecebida !== CHAVE_API_ADMISSOES) {
    return res.status(401).json({ erro: 'API Key inválida ou ausente. Use o header "x-api-key" ou "Authorization: Bearer <TOKEN>".' });
  }
  next();
}

// Remove acentos e normaliza para minúsculas, para comparar rótulos em
// pt-BR vindos da query string sem depender de acento/caixa exatos.
function normalizarTextoComparacao(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Aceita tanto o código interno (EM_ANALISE) quanto o rótulo em português
// (com ou sem acentos/caixa, ex.: "Contratação Concluída") e devolve o
// código interno correspondente, ou null se não houver correspondência.
function resolverCodigoStatus(valorConsulta) {
  if (!valorConsulta) return null;
  if (Object.prototype.hasOwnProperty.call(ROTULO_STATUS_CSV, valorConsulta)) {
    return valorConsulta;
  }
  const alvo = normalizarTextoComparacao(valorConsulta);
  const codigo = Object.keys(ROTULO_STATUS_CSV).find(
    (chave) => normalizarTextoComparacao(ROTULO_STATUS_CSV[chave]) === alvo
  );
  return codigo || null;
}

// Monta o registro estruturado de uma ficha para consumo por sistemas
// externos de admissão: dados cadastrais, status, documentos, LGPD, aceite
// contratual e integração de ponto. Não inclui mensagens do chat nem
// caminhos de arquivo além dos indicadores booleanos.
function montarRegistroApiAdmissao(c) {
  const documentos = TIPOS_DOCUMENTO.map((tipo) => {
    const documento = c.documentos?.[tipo] || {};
    return {
      tipo,
      titulo: TITULOS_DOCUMENTO[tipo],
      status: documento.status || null,
      arquivo: !!documento.arquivo,
      validado: documento.status === 'VERDE'
    };
  });

  const assinatura = c.contrato?.assinaturaConcluida;
  const aceiteContratual = assinatura
    ? { concluido: true, timestamp: assinatura.timestamp, hash: assinatura.hash, cpf: assinatura.cpf }
    : { concluido: false };

  return {
    nomeCompleto: c.nomeCompleto,
    cpf: c.cpf,
    email: c.email,
    whatsapp: c.whatsapp,
    genero: c.genero,
    cep: c.cep,
    logradouro: c.logradouro,
    bairro: c.bairro,
    numero: c.numero,
    complemento: c.complemento,
    dataNascimento: c.dataNascimento,
    status: c.status,
    statusRotulo: ROTULO_STATUS_CSV[c.status] || c.status || '',
    criadoEm: c.criadoEm,
    atualizadoEm: c.atualizadoEm,
    documentos,
    auditoriaLgpd: {
      consentimentoFicha: c.consentimentoFichaLGPD,
      consentimentoContrato: c.consentimentoContratoLGPD
    },
    aceiteContratual,
    integracaoPonto: c.integracaoPonto
  };
}

// ---------------------------------------------------------------------------
// ROTA: API v1 - lista/filtra admissões para integração com sistemas externos
// ---------------------------------------------------------------------------
app.get('/api/v1/admissoes', exigirApiKeyAdmissoes, async (req, res) => {
  try {
  const statusQuery = req.query.status;
  let candidatos = await lerCandidatos();
  let filtroAplicado = null;

  if (statusQuery) {
    const codigo = resolverCodigoStatus(statusQuery);
    if (!codigo) {
      return res.status(400).json({
        erro: 'Status inválido. Use um dos: EM_ANALISE, PENDENTE_ASSINATURA, CONTRATACAO_CONCLUIDA, REPROVADO (ou seu rótulo em português).'
      });
    }
    filtroAplicado = codigo;
    candidatos = candidatos.filter((c) => c.status === codigo);
  }

  const admissoes = candidatos.map(montarRegistroApiAdmissao);

  return res.status(200).json({ total: admissoes.length, filtro: filtroAplicado, admissoes });
  } catch (erro) {
    console.error('Falha ao listar admissões (API v1):', erro.message);
    return res.status(500).json({ erro: 'Falha ao listar admissões.' });
  }
});

function situacaoDocumentoPdf(candidato, tipo, documento) {
  if (documento.arquivo) return 'Enviado';
  if (tipo === 'reservista' && candidato.genero !== 'Masculino') return 'Não exigido';
  if (tipo === 'cpf' && candidato.cpfInclusoNaIdentidade) return 'Não exigido (incluso na Identidade)';
  return 'Pendente';
}

app.get('/api/rh/fichas/:id/pdf', exigirRh, async (req, res) => {
  const { id } = req.params;
  let candidatos;
  try {
    candidatos = await lerCandidatos();
  } catch (erro) {
    console.error('Falha ao buscar candidato para PDF da ficha:', erro.message);
    return res.status(500).json({ erro: 'Falha ao buscar o candidato.' });
  }
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
  try {
  const { id, tipo } = req.params;
  if (!TIPOS_CONTRATO.includes(tipo)) {
    return res.status(400).json({ erro: 'Documento de contrato inválido.' });
  }

  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
  if (candidato.status !== 'PENDENTE_ASSINATURA') {
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
  await salvarCandidatos(candidatos);

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
  } catch (erro) {
    console.error('Falha ao registrar aceite do documento:', erro.message);
    return res.status(500).json({ erro: 'Falha ao registrar o aceite do documento.' });
  }
});

// RH também pode marcar o aceite de um documento em nome do candidato
// (mesmo layout/ação "Aceitar Documento" usado nos demais cards do painel).
app.patch('/api/rh/fichas/:id/contrato/:tipo/aceitar', exigirRh, async (req, res) => {
  try {
  const { id, tipo } = req.params;
  if (!TIPOS_CONTRATO.includes(tipo)) {
    return res.status(400).json({ erro: 'Documento de contrato inválido.' });
  }

  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
  if (candidato.status !== 'PENDENTE_ASSINATURA') {
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
  await salvarCandidatos(candidatos);

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
  } catch (erro) {
    console.error('Falha ao registrar aceite do documento (RH):', erro.message);
    return res.status(500).json({ erro: 'Falha ao registrar o aceite do documento.' });
  }
});

// Conclusão unificada da assinatura digital: só é permitida quando TODOS os
// documentos da lista já foram aceitos individualmente. Grava o log de
// auditoria completo (IP, timestamp ISO, CPF do candidato e hash SHA-256 do
// conteúdo exato das minutas aceitas).
// Base legal citada no log de assinatura eletrônica simples (Momento 3 da
// jornada): validade da assinatura eletrônica (MP nº 2.200-2/2001 e Lei nº
// 14.063/2020) e a base legal do tratamento dos metadados (LGPD, Art. 7º).
const BASE_LEGAL_ASSINATURA_DIGITAL = 'MP nº 2.200-2/2001; Lei nº 14.063/2020; LGPD Art. 7º, II e V';

app.post('/api/candidato/:id/contrato/concluir', async (req, res) => {
  try {
  const { id } = req.params;
  const { consentimentoContratoLGPD } = req.body;
  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
  if (candidato.status !== 'PENDENTE_ASSINATURA') {
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
  await salvarCandidatos(candidatos);

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
  } catch (erro) {
    console.error('Falha ao concluir assinatura digital:', erro.message);
    return res.status(500).json({ erro: 'Falha ao concluir a assinatura digital.' });
  }
});

// RH finaliza o processo: exige a assinatura digital unificada já concluída
// pelo candidato, e move o status geral da ficha para o estado terminal.
app.patch('/api/rh/fichas/:id/contrato/validar', exigirRh, async (req, res) => {
  try {
  const { id } = req.params;
  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
  if (candidato.status !== 'PENDENTE_ASSINATURA') {
    return res.status(400).json({ erro: 'Só é possível validar a contratação de uma ficha aprovada.' });
  }
  if (!candidato.contrato.assinaturaConcluida) {
    return res.status(400).json({ erro: 'Aguardando a conclusão da assinatura digital pelo candidato.' });
  }

  const agora = new Date().toISOString();
  candidato.contrato.validacaoRh = { timestamp: agora, ip: req.ip, validadoPor: req.usuario.id };
  candidato.status = 'CONTRATACAO_CONCLUIDA';
  candidato.atualizadoEm = agora;
  await salvarCandidatos(candidatos);

  registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'contratacao_concluida',
    candidatoId: id,
    timestamp: agora,
    ip: req.ip
  });

  return res.status(200).json({ mensagem: 'Contratação concluída com sucesso!', candidato });
  } catch (erro) {
    console.error('Falha ao validar contratação:', erro.message);
    return res.status(500).json({ erro: 'Falha ao validar a contratação.' });
  }
});

// ---------------------------------------------------------------------------
// CONTA DE RH DE TESTES (MVP/Dev) - semeada de forma idempotente no boot,
// já que o formulário público de registro só cria contas 'candidato'.
// Credenciais documentadas no README.md, apenas para uso em desenvolvimento.
// ---------------------------------------------------------------------------
const EMAIL_RH_TESTE = 'rh@onboarding.local';
const SENHA_RH_TESTE = 'onboarding123';

async function garantirUsuarioRhTeste() {
  const usuarios = await lerUsuarios();
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
  await salvarUsuarios(usuarios);
  console.log('--- Conta de RH de testes criada (MVP/Dev):', EMAIL_RH_TESTE, '---');
}

// Em serverless (Vercel), este arquivo é reavaliado a cada cold start - uma
// falha de disco/rede aqui (ex.: /tmp indisponível, ou o Supabase ainda sem
// as tabelas criadas pelo humano via supabase/schema.sql) não pode derrubar
// o carregamento do módulo inteiro, ou toda requisição àquela instância
// passaria a falhar. Localmente, uma falha aqui é genuinamente grave (impede
// o boot de dados de teste), então o erro ainda é logado bem visível.
// A sequência de boot agora depende de chamadas assíncronas ao Supabase, mas
// "module.exports = app" (mais abaixo) precisa continuar síncrono - por isso
// o boot roda numa IIFE assíncrona "solta" (fire-and-forget), sem bloquear a
// importação do módulo pela Vercel nem pelo "node index.js" local.
(async () => {
  try {
    await garantirUsuarioRhTeste();
    garantirMinutasContrato();
    // Gera a planilha Mestre já no boot, refletindo a carga inicial existente
    // no banco (ex.: a ficha de testes "Maria Gadu"), sem esperar a próxima
    // gravação para o arquivo existir.
    await atualizarPlanilhaMestre();
  } catch (erro) {
    console.error('Falha na inicialização de dados (não impede o boot do servidor):', erro.message);
  }
})();

// Exporta o app Express para a Vercel (função serverless) importar e invocar
// diretamente, sem precisar abrir uma porta TCP própria.
module.exports = app;

// Porta configurável via variável de ambiente PORT (padrão do Node/Express e
// das plataformas de deploy em nuvem, como Render e Railway, que injetam essa
// variável automaticamente). Padrão local: 3001, evitando conflito com outros
// servidores locais, como o do projeto Pré-Vendas na 3000.
// Na Vercel, NODE_ENV já vem como 'production' e a própria plataforma invoca
// o app exportado acima como função serverless - chamar app.listen() lá
// seria redundante (e a Vercel não expõe uma porta TCP tradicional).
const PORTA = process.env.PORT || 3001;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORTA, () => {
    console.log(`Servidor de Onboarding Digital rodando em http://localhost:${PORTA}`);
  });
}
