# OnboardingDigital

**Status do Projeto:** MVP em Desenvolvimento Ativo. Etapa 1 (Jornada e Ficha do Candidato) Concluída. Etapa 2 (Módulo do RH) em andamento. Etapa 3 (Documentação, LGPD e Preparação para Deploy) em consolidação.

Sistema de admissão digital para coleta de aceite de documentos trabalhistas, com trilha de auditoria e conformidade com a LGPD.

O projeto centraliza os dados do candidato em uma ficha única e acompanha o andamento do processo admissional por um sistema de cores: vermelho para pendente, amarelo para em análise e verde para aprovado. Isso facilita a leitura rápida de pendências pelo time de RH.

Para cada aceite ou alteração realizada, o sistema registra um log de auditoria imutável, com IP, data e hora - atendendo aos requisitos da LGPD.

A interface também foi pensada com acessibilidade em mente, com HTML semântico e suporte a ferramentas de Libras como o VLibras.

## Arquitetura do Projeto

O MVP é dividido em dois módulos, servidos pelo mesmo backend Express e comunicando-se pela mesma API:

```
public/
  index.html    -> Módulo Candidato: ficha de admissão, upload de documentos, chat, banner de decisão
  rh.html       -> Módulo RH: painel de gestão, pendências, decisão final, exportação e impressão
  testes.html   -> bateria de testes automatizados contra a API em execução

index.js        -> servidor Express único, expõe as rotas dos dois módulos
candidatos.json -> persistência das fichas (não versionado - dados pessoais, LGPD)
auditoria.json  -> trilha de auditoria imutável (não versionado - LGPD)
uploads/        -> PDFs enviados pelos candidatos (não versionado - dados pessoais, LGPD)
```

**Módulo Candidato** (`public/index.html`): formulário de dados pessoais com máscaras e validação estrita, upload dos 6 documentos obrigatórios, envio unificado da ficha, chat com o RH e reabertura pontual de documentos com pendência. Uma ficha já enviada pode ser revisitada pelo link `http://localhost:3001/index.html?id=<candidatoId>`.

> **Nota sobre testes/arquitetura:** o botão "Copiar link" do candidato, no Painel do RH, gera exatamente esse link direto (`?id=<candidatoId>`). É um **recurso utilitário exclusivo da versão MVP/Dev**, pensado para agilizar a validação de testes locais (acessar a ficha de um candidato específico sem precisar procurar o `id` manualmente). Ele **não deve fazer parte do fluxo de produção final**: o lançamento da busca por nome/CPF (ver Etapa 2) cobre essa necessidade de localizar um candidato de forma adequada para uso real, sem depender de compartilhar links com identificadores de ficha.

**Módulo RH** (`public/rh.html`): painel de gestão com cards de resumo, filtros por decisão, alteração de status, abertura de pendências, decisão final (Aprovar/Reprovar), chat, exportação de relatório em CSV e impressão/PDF da ficha individual.

**Backend** (`index.js`): API REST em Express, upload de arquivos com Multer, persistência em arquivos JSON locais (sem banco de dados nesta etapa do MVP).

## Resumo técnico da Etapa 1

A interface do candidato está funcional, cobrindo:

- **Validações de formulário** - exigência de sobrenome e bloqueio de sequências repetidas de caracteres no nome, validação estrita de e-mail (formato e domínio), e verificação de CPF (11 dígitos), CEP (8 dígitos), WhatsApp (10 ou 11 dígitos) e data de nascimento (data de calendário real, não só o formato) tanto no frontend quanto no backend - a ficha não é aceita com nenhum campo obrigatório incompleto.
- **Máscaras dinâmicas** - formatação em tempo real de CPF, CEP, telefone/WhatsApp e data de nascimento durante a digitação, preservando a posição exata do cursor ao editar ou apagar caracteres no meio do texto.
- **Autopreenchimento de endereço via CEP (ViaCEP)** - ao completar o CEP, os campos de Logradouro e Bairro são preenchidos automaticamente pela API pública do ViaCEP; CEP inválido ou falha de rede libera o preenchimento manual com um aviso.
- **Validação estrita de PDF (10 MB)** - o frontend recusa qualquer arquivo acima de 10 MB antes mesmo de enviar (mensagem inline, sem travar a tela), e o backend aplica o mesmo limite via Multer, retornando 400 caso o frontend seja contornado.
- **Manipulação e exclusão de arquivos PDF** - anexo por arrastar-e-soltar em cada documento, exibição do nome do arquivo com botão de exclusão individual e rota de backend que remove o arquivo físico e limpa a referência.
- **Trava de segurança da ficha** - após a submissão unificada, a ficha entra em modo somente leitura: todos os campos, seletores, caixas de seleção e áreas de upload são bloqueados e um aviso confirma que a ficha está em análise pelo RH.

### Regras de negócio da jornada

- Barras expansíveis (accordion) na cor Verde Intelbras (#00A335), uma por documento obrigatório.
- "CPF incluso na Identidade": ao marcar, a barra do CPF é desabilitada e herda o status da Identidade.
- Certificado de Reservista: exigido apenas para o gênero Masculino; nos demais casos a barra é dispensada e marcada automaticamente como Aprovado (verde).

## Resumo técnico da Etapa 2 (em andamento)

O Painel de Gestão do RH (`public/rh.html`) está em construção, cobrindo até aqui:

- **Cards de resumo estatístico** - Total de Fichas, Pendentes, Em Análise e Aprovados, calculados em tempo real a partir das fichas recebidas.
- **Tabela de gestão** - lista as fichas com Nome do Candidato, CPF, Data de Envio e Status Atual.
- **Alteração de status pelo RH** - botões coloridos (vermelho/amarelo/verde) para mover a ficha entre Pendente, Em Análise e Aprovado.
- **Visualização/download de PDFs** - cada documento enviado pode ser aberto/baixado em nova aba; documentos dispensados por regra ou ainda não enviados mostram "Não exigido"/"Pendente".
- **Reabertura pontual de pendências** - o RH marca um documento já enviado como "Com Pendência", com justificativa obrigatória; só aquele documento é liberado para reenvio na Ficha do Candidato (o resto continua travado), e a pendência se encerra automaticamente quando o candidato reenvia o PDF.
- **Chat RH ↔ Candidato** - conversa simples, com histórico persistido junto da ficha (ordenado por data/hora), disponível tanto no Painel do RH quanto na Ficha do Candidato (a partir do primeiro envio); Enter envia a mensagem, Shift+Enter quebra linha.
- **Decisão final do processo** - botões "Aprovar Candidato"/"Reprovar Candidato" no Painel do RH; a Ficha do Candidato exibe um banner de sucesso ou de agradecimento e trava totalmente para edição, sem exceção (nem pendências residuais reabrem campos).
- **Filtros e ordenação** - filtra a lista por decisão (Todos/Aprovados/Reprovados/Pendentes); candidatos ainda não avaliados ficam sempre no topo, com separação visual entre "Novos/Não avaliados" e "Já avaliados".
- **Busca por nome ou CPF** - campo de busca no topo do painel, com filtragem em tempo real (a cada tecla digitada) e combinável com o filtro por decisão ativo.
- **Exportação de relatório em CSV** - botão no cabeçalho da tabela baixa um `.csv` (compatível com Excel, com BOM UTF-8) contendo Nome, CPF, E-mail, Telefone, CEP, Endereço, Data de Submissão e Status Atual, respeitando o filtro de decisão ativo.
- **Relatório individual / impressão em PDF** - cada candidato tem um botão que monta uma versão formatada para impressão (dados pessoais, documentos e declaração de consentimento LGPD com o timestamp real de submissão), usando o "Salvar como PDF" do navegador.
- **Copiar link do candidato** *(recurso MVP/Dev - ver nota na Arquitetura do Projeto)* - botão que copia o link direto da ficha de um candidato para a área de transferência.

Rotas do backend dedicadas ao painel: `GET /api/rh/fichas`, `PATCH /api/rh/fichas/:id/status`, `PATCH /api/rh/fichas/:id/documento/:tipo/pendencia`, `PATCH /api/rh/fichas/:id/decisao`, `GET /api/rh/exportar-csv` (aceita `?filtro=APROVADO|REPROVADO|PENDENTE`). Rotas compartilhadas com o candidato: `GET /api/candidato/:id` (retorno via link `?id=`) e `POST /api/candidato/:id/mensagens` (chat).

Ainda **não implementado** nesta etapa: autenticação do RH (login manual/OAuth) para acesso ao painel.

## Resumo técnico da Etapa 3 (em consolidação)

Foco em documentação, conformidade com a LGPD e preparação para publicar o MVP em um serviço de nuvem:

- **Trilha de auditoria (LGPD) ampliada** - além de alterações de status, pendências de documento e decisão final, agora **toda mensagem de chat** (RH ou candidato) também é registrada em `auditoria.json` com timestamp ISO e IP de origem da requisição; a própria mensagem, em `candidatos.json`, também carrega seu IP de origem.
- **Porta configurável via `PORT`** - o servidor lê `process.env.PORT` (padrão das plataformas de deploy em nuvem, como Render e Railway, que injetam essa variável automaticamente), caindo para `3001` em execução local. Arquivo `.env.example` documenta a variável.
- **README consolidado** - arquitetura completa do projeto, todas as funcionalidades das Etapas 1 e 2 documentadas, e as duas formas de rodar localmente.

## Próximas fases do roteiro de desenvolvimento

- Autenticação e Segurança (login manual e OAuth com Google) para acesso ao Painel do RH.
- Registro na trilha de auditoria também dos aceites/consentimentos do candidato (hoje ela cobre as ações do RH e as mensagens do chat).
- Deploy do MVP em um serviço de nuvem (Render/Railway), usando a variável `PORT` já preparada nesta etapa.

## Como Executar o Projeto Localmente

### Pré-requisitos
- Git instalado na máquina
- Opção 1: Docker e Docker Compose instalados
- Opção 2: Node.js instalado na máquina

### Clonar o repositório

```bash
git clone https://github.com/vitorfgnascimento/OnboardingDigital.git
cd OnboardingDigital
```

### Variáveis de ambiente (opcional)

O projeto roda com valores padrão sem nenhuma configuração adicional. Se quiser customizar a porta, copie `.env.example` para `.env` e ajuste:

```bash
cp .env.example .env
```

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3001` | Porta em que o servidor escuta. Injetada automaticamente por plataformas de deploy em nuvem (Render, Railway, etc.). |

### Opção 1 (Recomendada - Docker)

1. Subir a aplicação em um contêiner:
```bash
docker compose up --build
```

2. Acessar a aplicação no navegador: `http://localhost:3001`

### Opção 2 (Tradicional - Node.js)

1. Instalar as dependências do projeto:
```bash
npm install
```

2. Iniciar o servidor local:
```bash
node index.js
```

3. Acessar a aplicação no navegador: `http://localhost:3001`

## Tecnologias

Node.js, Express e Multer no backend; HTML5, CSS3 e JavaScript puro (Vanilla JS) no frontend; persistência em arquivos JSON locais; Git e GitHub para versionamento; Docker e Docker Compose para conteinerização.

## Licença

MIT
