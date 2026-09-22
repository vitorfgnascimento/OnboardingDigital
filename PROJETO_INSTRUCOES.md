# Especificação de Arquitetura e Requisitos - Onboarding Digital (MVP)

## 1. Propósito e Objetivo do Projeto

Este projeto consiste no desenvolvimento do Produto Mínimo Viável (MVP) de uma
plataforma de Admissão Digital de Funcionários (Onboarding Digital).

O objetivo principal deste repositório é servir como projeto de destaque no
portfólio do Líder de Projeto no GitHub e LinkedIn, demonstrando competências de:
- Arquitetura de Software e Modelagem de Negócio.
- Engenharia Dirigida por Inteligência Artificial (AI-Assisted Engineering).
- Conformidade Legal e Segurança Jurídica (LGPD e Trilha de Auditoria).
- Acessibilidade Web (ESG / VLibras).
- Prontidão para integração via API REST (Arquitetura B2B).

## 2. Papéis e Responsabilidades no Desenvolvimento

- **LÍDER DE PROJETO E ARQUITETO DE NEGÓCIOS (Vítor):** responsável pela direção
  estratégica, validação das regras de negócio, aprovação das alterações de
  código, controle de escopo e definição de UI/UX.
- **AGENTE EXECUTOR DE CÓDIGO (Claude Code):** responsável pela execução técnica
  das instruções e comandos no terminal, mantendo o código limpo, comentado e
  alinhado aos padrões estabelecidos.

## 3. Tech Stack (Linguagens e Tecnologias Utilizadas)

- **LINGUAGEM PRINCIPAL:** JavaScript (ES6+). Padronização da linguagem em toda
  a stack (Full-Stack JavaScript), permitindo alta performance, ecossistema
  maduro para APIs e fácil integração entre Frontend e Backend.
- **BACKEND (SERVIDOR E API):** Node.js + Express.js + Multer. O Node.js oferece
  uma arquitetura orientada a eventos leve e eficiente. O Express.js é o
  framework padrão para criação de APIs RESTful. O middleware Multer é
  responsável pelo gerenciamento de uploads de PDFs.
- **AUTENTICAÇÃO:** hash de senha com `crypto.scrypt` (nativo do Node, sem
  dependência externa) + tokens de sessão opacos persistidos em
  `sessoes.json`, e `google-auth-library` para validar o ID Token do
  Google Sign-In (OAuth 2.0 / Google Identity Services) no backend.
- **FRONTEND (INTERFACE DE USUÁRIO):** HTML5 + CSS3 + JavaScript puro (Vanilla
  JS). Garante que a aplicação seja extremamente rápida, sem a complexidade
  desnecessária de frameworks pesados no MVP, facilitando a legibilidade do
  código.
- **PERSISTÊNCIA DE DADOS:** arquivos JSON (`candidatos.json`, `usuarios.json`,
  `sessoes.json`, `auditoria.json`) e armazenamento local (`uploads/`).
  Armazenamento em arquivo local para demonstrar manipulação de dados em
  servidor antes da migração para um banco de dados relacional.
- **VERSIONAMENTO:** Git e GitHub. Manutenção de um histórico claro de commits
  e branches para apresentação profissional do repositório.

## 4. Requisitos de Negócio e Jornada do Candidato (Etapa 1 - Concluída)

### A) Ficha Única do Candidato (Dados Pessoais)

Coleta de dados obrigatórios com validações estritas de formulário:
- Nome Completo (validação contra sequências repetidas de caracteres e exigência de sobrenome).
- Data de Nascimento (formato DD/MM/AAAA com navegação contínua).
- CPF (máscara dinâmica e preservação da posição do cursor).
- CEP (máscara dinâmica, com autopreenchimento de endereço via API ViaCEP).
- Endereço Residencial (filtro para aceitar apenas caracteres alfabéticos).
- Número (filtro para aceitar apenas dígitos numéricos).
- Complemento (campo de preenchimento facultativo).
- E-mail de Contato (validação estrita de formato e domínio completo).
- Telefone / WhatsApp (máscara dinâmica).
- Gênero (menu suspenso: Masculino, Feminino, Outro, Prefiro não informar).

### B) Barras Interativas e Anexo de Documentos (Accordion)

Interface organizada em barras horizontais extensas na cor verde Intelbras
(`#00A335`) com botões de expansão (setas) e caixas de upload individuais
para arquivos PDF (até 10 MB):
- Identidade (RG) - inclui a caixa de seleção "CPF incluso na Identidade".
- CPF - desabilitado automaticamente caso a opção de CPF incluso no RG seja marcada.
- Comprovante de Residência.
- Comprovante de Escolaridade.
- Certificado de Reservista - exigido para o gênero Masculino; dispensado e
  marcado como Aprovado caso o gênero seja Feminino, Outro ou Prefiro não informar.
- Carteira de Trabalho (CTPS Digital / Física).

### C) Controle de Uploads e Trava de Segurança

- Botão de exclusão individual ("x") ao lado de cada PDF anexado, para fácil substituição.
- Botão de submissão unificado ao final da página ("Concluir e Enviar Admissão Completa").
- Bloqueio de edição dos campos da ficha (modo somente leitura) após a confirmação do envio.

### D) Matriz de Controle de Status (Sistema de Cores)

- **VERMELHO** (`#DC3545`): Pendente / Não Avaliado.
- **AMARELO** (`#FFC107`): Em Análise / Processamento.
- **VERDE** (`#28A745`): usado a nível de documento individual (documento aceito).
- **APROVADO / REPROVADO**: status geral definitivo da ficha, atribuído pelo RH
  na Decisão Final - a partir desse momento a ficha some da aba "Em Análise" e
  passa a existir exclusivamente na aba da decisão correspondente.
- **CONTRATACAO_CONCLUIDA**: status terminal, atribuído após a validação do
  contrato assinado pelo RH (ver seção 6).

## 5. Módulo do RH e Painel de Gestão (Etapa 2 - Concluída)

- Painel de Gestão do RH (`public/rh.html`) com listagem, busca por nome/CPF,
  filtros por aba (Não avaliados / Em Análise / Aprovados / Reprovados),
  cards de resumo estatístico e exportação de relatório em CSV.
- Ações por documento: Aceitar Documento e Marcar Pendência (com
  justificativa obrigatória e reabertura pontual do upload para o candidato).
- Transição automática de status Não avaliado → Em Análise na primeira
  interação do RH com a ficha (visualizar PDF, aceitar/marcar pendência num
  documento, ou responder no chat) - não depende mais de troca manual.
- Decisão Final exclusiva (Aprovar/Reprovar): o status geral da ficha é
  definitivamente alterado para `APROVADO`/`REPROVADO`, a ficha é bloqueada
  para novos envios e some da aba "Em Análise".
- Regra "CPF incluso na Identidade": o card de CPF fica sem ações próprias e o
  seu status (aceito/pendente) é sincronizado automaticamente com o que
  acontece no card da Identidade.
- Sistema de Chat (RH ↔ Candidato) para comunicação direta, com histórico
  ordenado por data/hora.
- Trilha de Auditoria e Conformidade LGPD: todo evento relevante do RH
  (mudança de status, pendência, aceite de documento, decisão final,
  mensagem de chat) é registrado em `auditoria.json` com `timestamp` (ISO) e
  `ip` de origem, em formato *append-only* (nunca sobrescrito).
- Massa de dados de testes: a base local (`candidatos.json`) mantém
  exclusivamente a ficha da candidata fictícia **"Maria Gadu"**, usada para
  validar manualmente o fluxo completo (login, autoavaliação de documentos,
  aprovação, aceite de contrato) sem precisar recriar dados a cada ciclo.

## 6. Módulo de Autenticação e Contratação (Etapa 3 - Em Desenvolvimento)

### A) Autenticação (Login e Registro de Usuários)

- Tela dedicada `public/login.html` com três ações: **Entrar** (e-mail/senha),
  **Criar Conta** (nome, e-mail, senha) e **Entrar com o Google** (OAuth 2.0 /
  Google Identity Services).
- Backend (`index.js`) expõe as rotas `POST /api/auth/registrar`,
  `POST /api/auth/login`, `POST /api/auth/google`, `GET /api/auth/sessao` e
  `POST /api/auth/logout`. Senhas nunca são armazenadas em texto puro (hash
  `scrypt` + salt por usuário, em `usuarios.json`, fora do controle de
  versão por conter dado pessoal - LGPD).
- Sessão via token opaco (`Authorization: Bearer <token>`), persistido em
  `sessoes.json` com expiração; o token fica salvo no `localStorage` do
  navegador do usuário.
- **Google Sign-In:** requer que o Líder de Projeto configure um Client ID
  OAuth real no Google Cloud Console e informe-o via variável de ambiente
  `GOOGLE_CLIENT_ID` (ver `.env.example`). Sem essa configuração, o botão
  "Entrar com o Google" permanece visível, porém a autenticação real não pode
  ser validada em ambiente local - trata-se de uma limitação de credenciais,
  não de código.
- **Autopreenchimento da Ficha:** ao acessar `public/index.html` autenticado,
  os campos Nome Completo e E-mail são preenchidos automaticamente a partir
  do perfil da sessão (permanecem editáveis).
- **Vínculo Ficha ↔ Perfil:** toda ficha criada por um candidato autenticado
  grava o campo `usuarioId`, vinculando-a estritamente ao perfil que a
  originou. A rota autenticada `GET /api/auth/minhas-fichas` devolve somente
  as fichas pertencentes ao usuário logado. O acesso direto por link
  (`index.html?id=...`), usado pela funcionalidade "Copiar link" do RH,
  permanece funcional por compatibilidade - é uma simplificação deliberada
  do MVP, documentada aqui.
- **Restrição de Acesso ao Painel do RH:** `public/rh.html` exige uma sessão
  válida do tipo `rh` (papel de usuário `tipo: 'rh'`); sem sessão válida, o
  painel redireciona para `public/login.html`. As rotas administrativas
  (`/api/rh/*`) exigem o mesmo token no header `Authorization` no backend.
  Contas com papel `rh` não são criadas pelo formulário público de registro
  (que sempre cria `tipo: 'candidato'`); uma conta de RH de teste é semeada
  de forma idempotente na inicialização do servidor (credenciais documentadas
  no `README.md`, apenas para uso em ambiente de desenvolvimento).

### B) Aceite Virtual de Contratos por Clique (Assinatura Eletrônica Simples)

- Disponível somente para fichas com status geral `APROVADO`.
- Lista fixa de documentos/contratos (`CONTRATOS_DOCUMENTOS` em `index.js`):
  Contrato de Trabalho (CLT), Termo de Confidencialidade e Política de
  Privacidade e Tratamento de Dados (LGPD) - cada um com sua própria minuta
  em PDF (`GET /api/contrato/minuta/:tipo`).
- Na Ficha do Candidato (`public/index.html`), nova seção **"Etapa Final:
  Aceite Virtual dos Contratos"**, com uma linha por documento: botão
  "Visualizar/Baixar Minuta" e botão "Li e Aceito os Termos" - um clique =
  um aceite (`POST /api/candidato/:id/contrato/:tipo/aceite`), gravando
  `timestamp` (ISO) e `ip` no documento e na trilha de auditoria.
- O botão unificado **"Concluir Assinatura Digital"**
  (`POST /api/candidato/:id/contrato/concluir`) só é liberado quando TODOS
  os documentos da lista já estiverem aceitos; ao confirmar, grava o log de
  auditoria completo com `timestamp` (ISO), `ip`, `cpf` do candidato e um
  hash SHA-256 do conteúdo exato das minutas aceitas (evidência de
  integridade da assinatura eletrônica simples).
- No Painel do RH (`public/rh.html`), dentro do painel de detalhes da ficha
  aprovada, novo card **"Contrato de Trabalho - Aceite Digital"**, no mesmo
  layout dos cards de documento (`Visualizar/Baixar PDF` + `Aceitar
  Documento` ou o indicador **"✓ Assinado via Aceite Digital"**) - o RH
  também pode aceitar um documento em nome do candidato
  (`PATCH /api/rh/fichas/:id/contrato/:tipo/aceitar`). O botão **"Validar
  Contratação"** (`PATCH /api/rh/fichas/:id/contrato/validar`) só aparece
  após a assinatura digital unificada estar concluída, e move o status geral
  da ficha para o estado terminal `CONTRATACAO_CONCLUIDA`.

## 7. Conformidade Total com a LGPD nos 3 Momentos da Jornada

Cobertura de consentimento formal e trilha de auditoria nos três pontos
obrigatórios de coleta/tratamento de dados pessoais da jornada:

- **Momento 1 - Criação de Conta** (`public/login.html`): a aba "Criar Conta"
  exige o aceite de um checkbox ("Declaro que li e aceito os Termos de Uso e
  a Política de Privacidade...") antes de liberar o botão de cadastro; o
  backend recusa o registro sem esse aceite (`POST /api/auth/registrar`) e
  grava `consentimentoCadastro: { aceito, timestamp, ip, versaoTermo }` no
  usuário, além de um evento `consentimento_cadastro` na auditoria.
- **Momento 2 - Envio da Ficha e Documentos** (`public/index.html`): card
  destacado com o Termo de Consentimento (Art. 7º e 11º da LGPD) e checkbox
  obrigatório imediatamente acima do botão "Concluir e Enviar Admissão
  Completa", que só é liberado após o aceite. O backend recusa a criação da
  ficha sem `consentimentoLGPD: true` (`POST /api/candidato`) e grava
  `consentimentoFichaLGPD: { aceito, dataHora, ip, versaoTermo, finalidade }`
  na própria ficha, além de um evento `consentimento_ficha_lgpd` na
  auditoria.
- **Momento 3 - Assinatura Eletrônica do Contrato** (`public/index.html`):
  cláusula sobre a validade da assinatura eletrônica (MP nº 2.200-2/2001 e
  Lei nº 14.063/2020) e checkbox de ciência ao lado dos documentos do
  contrato, que bloqueia o botão "Concluir Assinatura Digital" até ser
  marcado. O backend recusa a conclusão sem `consentimentoContratoLGPD: true`
  (`POST /api/candidato/:id/contrato/concluir`) e grava
  `consentimentoContratoLGPD: { aceito, dataHora, ip, hashDocumentos,
  baseLegal }` na ficha.
- **Exibição da Trilha de Auditoria no Painel do RH** (`public/rh.html`):
  card **"Trilha de Auditoria e Conformidade LGPD"** na ficha expandida,
  mostrando o status dos dois consentimentos (ficha e contrato) com
  data/hora e IP, e o botão **"Visualizar Log de Auditoria"**
  (`GET /api/rh/fichas/:id/auditoria`) que exibe o JSON bruto de todos os
  eventos daquela ficha, para consulta em fiscalizações trabalhistas.

## 8. Regras de Execução de Código para o Claude Code

- As alterações de código devem ser executadas com base nas instruções
  diretas dos prompts fornecidos pelo Líder de Projeto.
- Os arquivos devem seguir a estrutura de diretórios do projeto:
  ```
  /public          (arquivos estáticos HTML, CSS e JS)
    login.html     (autenticação: entrar / criar conta / Google)
    index.html     (ficha do candidato + aceite de contrato)
    rh.html        (painel de gestão do RH, acesso restrito)
    testes.html    (suíte de testes de API)
  /uploads         (armazenamento dos arquivos PDF enviados, incl. contratos assinados)
  index.js         (servidor Node.js e rotas da API)
  candidatos.json  (base de dados de fichas, fora do controle de versão - LGPD)
  usuarios.json    (base de dados de contas de usuário, fora do controle de versão - LGPD)
  sessoes.json     (tokens de sessão ativos, fora do controle de versão)
  auditoria.json   (trilha de auditoria append-only, fora do controle de versão - LGPD)
  package.json     (gerenciamento de dependências)
  ```
- Manter comentários descritivos no código em português, apenas onde o
  "porquê" não for óbvio a partir do próprio código.
