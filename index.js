const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();

app.use(express.json());
app.use(express.static('public'));

// Caminho absoluto do arquivo de persistência local (banco de dados simples em JSON)
const ARQUIVO_CANDIDATOS = path.join(__dirname, 'candidatos.json');

// Caminho absoluto da trilha de auditoria (registro imutável de eventos do RH)
const ARQUIVO_AUDITORIA = path.join(__dirname, 'auditoria.json');

// Pasta onde os documentos PDF dos candidatos são armazenados
const PASTA_UPLOADS = path.join(__dirname, 'uploads');

// Garante que a pasta de uploads exista antes de qualquer envio
if (!fs.existsSync(PASTA_UPLOADS)) {
  fs.mkdirSync(PASTA_UPLOADS, { recursive: true });
}

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

  return JSON.parse(conteudo);
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
// REGRAS DE NEGÓCIO DOS DOCUMENTOS
// ---------------------------------------------------------------------------

// Cria a estrutura inicial dos 6 documentos, já aplicando a regra do reservista.
function criarDocumentosIniciais(genero) {
  const documentos = {};

  TIPOS_DOCUMENTO.forEach((tipo) => {
    documentos[tipo] = { arquivo: null, status: 'VERMELHO', atualizadoEm: null };
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
// ROTA: cadastro de nova ficha de candidato (Etapa 1 - Dados Pessoais)
// ---------------------------------------------------------------------------
app.post('/api/candidato', (req, res) => {
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
    genero
  } = req.body;

  if (!nomeCompleto || !cpf || !email) {
    return res.status(400).json({
      erro: 'Campos obrigatórios (Nome, CPF, E-mail) não foram preenchidos.'
    });
  }

  if (genero && !GENEROS_VALIDOS.includes(genero)) {
    return res.status(400).json({ erro: 'Gênero inválido.' });
  }

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
    criadoEm: new Date().toISOString()
  };

  const candidatos = lerCandidatos();
  candidatos.push(novoCandidato);
  salvarCandidatos(candidatos);

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

    // Registra o arquivo enviado e move o documento para "Em Análise" (AMARELO)
    candidato.documentos[tipo] = {
      arquivo: 'uploads/' + req.file.filename,
      status: 'AMARELO',
      atualizadoEm: new Date().toISOString()
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

  // Limpa a referência do documento no candidatos.json (volta a PENDENTE)
  candidato.documentos[tipo] = { arquivo: null, status: 'VERMELHO', atualizadoEm: new Date().toISOString() };

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
app.get('/api/rh/fichas', (req, res) => {
  const candidatos = lerCandidatos();
  return res.status(200).json(candidatos);
});

// Status que o RH pode atribuir a uma ficha pelo Painel de Gestão.
const STATUS_VALIDOS_RH = ['VERMELHO', 'AMARELO', 'VERDE'];

// ---------------------------------------------------------------------------
// ROTA: alteração de status de uma ficha pelo RH, com registro na trilha de
// auditoria (LGPD): quem, quando (timestamp) e de onde (IP) a alteração partiu.
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/status', (req, res) => {
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

// Porta configurável via variável de ambiente PORTA (padrão 3001 - evita
// conflito com outros servidores locais, como o do projeto Pré-Vendas na 3000).
const PORTA = process.env.PORTA || 3001;
app.listen(PORTA, () => {
  console.log(`Servidor de Onboarding Digital rodando em http://localhost:${PORTA}`);
});
