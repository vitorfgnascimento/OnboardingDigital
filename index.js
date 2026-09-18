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

  const errosValidacao = validarDadosPessoais({
    nomeCompleto, dataNascimento, cpf, logradouro, bairro, cep, numero, email, whatsapp, genero
  });

  if (errosValidacao.length) {
    return res.status(400).json({ erro: errosValidacao.join(' ') });
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
    decisaoFinal: null,
    decisaoFinalEm: null,
    mensagens: [],
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
    timestamp: new Date().toISOString()
  };
  candidato.mensagens.push(novaMensagem);
  candidato.atualizadoEm = novaMensagem.timestamp;
  salvarCandidatos(candidatos);

  return res.status(201).json({ mensagem: 'Mensagem enviada.', candidato });
});

// ---------------------------------------------------------------------------
// ROTA: RH marca um documento já enviado como "Com Pendência / Exige Reenvio",
// com justificativa obrigatória. Libera especificamente aquele documento para
// o candidato reenviar, e registra o evento na trilha de auditoria (LGPD).
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/documento/:tipo/pendencia', (req, res) => {
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

// Decisões finais válidas para o processo admissional.
const DECISOES_VALIDAS = ['APROVADO', 'REPROVADO'];

// ---------------------------------------------------------------------------
// ROTA: decisão final do processo (Aprovar/Reprovar), com registro na trilha
// de auditoria. A ficha do candidato passa a ficar travada para edição.
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/decisao', (req, res) => {
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
const ROTULO_STATUS_CSV = { VERMELHO: 'PENDENTE', AMARELO: 'EM ANÁLISE', VERDE: 'APROVADO' };

// Escapa um valor para uma célula de CSV (aspas duplas + delimitador ';').
function paraCelulaCsv(valor) {
  return `"${String(valor == null ? '' : valor).replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// ROTA: exportação do relatório de candidatos em CSV (compatível com Excel)
// ---------------------------------------------------------------------------
app.get('/api/rh/exportar-csv', (req, res) => {
  const { filtro } = req.query;
  let candidatos = lerCandidatos();

  if (filtro === 'PENDENTE') {
    candidatos = candidatos.filter((c) => !c.decisaoFinal);
  } else if (filtro === 'APROVADO' || filtro === 'REPROVADO') {
    candidatos = candidatos.filter((c) => c.decisaoFinal === filtro);
  }

  const cabecalho = ['Nome', 'CPF', 'E-mail', 'Telefone', 'CEP', 'Endereço', 'Data de Submissão', 'Status Atual'];

  const linhas = candidatos.map((c) => {
    const endereco = [c.logradouro, c.numero, c.complemento, c.bairro].filter(Boolean).join(', ');
    const statusTexto = ROTULO_STATUS_CSV[c.status] || c.status || '';
    const statusFinal = c.decisaoFinal ? `${statusTexto} (${c.decisaoFinal})` : statusTexto;

    return [
      c.nomeCompleto,
      c.cpf,
      c.email,
      c.whatsapp,
      c.cep,
      endereco,
      c.criadoEm ? new Date(c.criadoEm).toLocaleString('pt-BR') : '',
      statusFinal
    ].map(paraCelulaCsv).join(';');
  });

  const csv = [cabecalho.map(paraCelulaCsv).join(';'), ...linhas].join('\r\n');
  const conteudo = '﻿' + csv; // BOM: garante acentuação correta ao abrir no Excel

  const dataArquivo = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="candidatos_${dataArquivo}.csv"`);
  return res.status(200).send(conteudo);
});

// Porta configurável via variável de ambiente PORTA (padrão 3001 - evita
// conflito com outros servidores locais, como o do projeto Pré-Vendas na 3000).
const PORTA = process.env.PORTA || 3001;
app.listen(PORTA, () => {
  console.log(`Servidor de Onboarding Digital rodando em http://localhost:${PORTA}`);
});
