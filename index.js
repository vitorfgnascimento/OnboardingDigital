const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.static('public'));

// Caminho absoluto do arquivo de persistência local (banco de dados simples em JSON)
const ARQUIVO_CANDIDATOS = path.join(__dirname, 'candidatos.json');

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
// ROTA: cadastro de nova ficha de candidato
// ---------------------------------------------------------------------------
app.post('/api/candidato', (req, res) => {
  const {
    nomeCompleto,
    dataNascimento,
    cpf,
    endereco,
    cep,
    numero,
    complemento,
    email,
    whatsapp
  } = req.body;

  if (!nomeCompleto || !cpf || !email) {
    return res.status(400).json({
      erro: 'Campos obrigatórios (Nome, CPF, E-mail) não foram preenchidos.'
    });
  }

  // Monta o registro com ID único, status inicial VERMELHO e data de criação.
  const novoCandidato = {
    id: gerarId(),
    nomeCompleto,
    dataNascimento,
    cpf,
    endereco,
    cep,
    numero,
    complemento,
    email,
    whatsapp,
    status: 'VERMELHO',
    criadoEm: new Date().toISOString()
  };

  // Adiciona o registro à lista existente e persiste no arquivo local.
  const candidatos = lerCandidatos();
  candidatos.push(novoCandidato);
  salvarCandidatos(candidatos);

  console.log('--- Novo Candidato Recebido ---');
  console.log('ID:', novoCandidato.id);
  console.log('Nome:', nomeCompleto);
  console.log('CPF:', cpf);
  console.log('E-mail:', email);

  return res.status(201).json({
    mensagem: 'Ficha do candidato cadastrada com sucesso!',
    candidato: novoCandidato
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
// ROTA: alteração de status do candidato pelo RH (AMARELO ou VERDE)
// ---------------------------------------------------------------------------
app.patch('/api/candidato/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  // O RH só pode mover a ficha para "Em Análise" (AMARELO) ou "Aprovado" (VERDE).
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

const PORTA = 3000;
app.listen(PORTA, () => {
  console.log(`Servidor de Onboarding Digital rodando em http://localhost:${PORTA}`);
});
