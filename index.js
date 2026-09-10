const express = require('express');
const app = express();

app.use(express.json());
app.use(express.static('public'));

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

  console.log('--- Novo Candidato Recebido ---');
  console.log('Nome:', nomeCompleto);
  console.log('CPF:', cpf);
  console.log('E-mail:', email);

  return res.status(201).json({
    mensagem: 'Ficha do candidato cadastrada com sucesso!',
    candidato: {
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
    }
  });
});

const PORTA = 3000;
app.listen(PORTA, () => {
  console.log(`Servidor de Onboarding Digital rodando em http://localhost:${PORTA}`);
});
