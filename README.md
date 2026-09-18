# OnboardingDigital

**Status do Projeto:** MVP em Desenvolvimento Ativo. Etapa 1 (Jornada e Ficha do Candidato) Concluída. Etapa 2 (Módulo do RH) em andamento.

Sistema de admissão digital para coleta de aceite de documentos trabalhistas, com trilha de auditoria e conformidade com a LGPD.

O projeto centraliza os dados do candidato em uma ficha única e acompanha o andamento do processo admissional por um sistema de cores: vermelho para pendente, amarelo para em análise e verde para aprovado. Isso facilita a leitura rápida de pendências pelo time de RH.

Para cada aceite ou alteração realizada, o sistema registra um log de auditoria imutável, com IP, data e hora e a declaração de consentimento do candidato - atendendo aos requisitos da LGPD.

A interface também foi pensada com acessibilidade em mente, com HTML semântico e suporte a ferramentas de Libras como o VLibras.

## Resumo técnico da Etapa 1

A interface do candidato está funcional, cobrindo:

- **Validações de formulário** - exigência de sobrenome e bloqueio de sequências repetidas de caracteres no nome, validação estrita de e-mail (formato e domínio) e verificação dos campos obrigatórios.
- **Máscaras dinâmicas** - formatação em tempo real de CPF, CEP, telefone/WhatsApp e data de nascimento durante a digitação.
- **Controle de cursor** - as máscaras preservam a posição exata do cursor ao editar ou apagar caracteres no meio do texto.
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
- **Trilha de auditoria (LGPD)** - toda alteração de status, pendência de documento ou decisão final feita pelo RH é registrada em `auditoria.json` (não versionado) com `candidatoId`, dados do evento, timestamp e IP de origem da requisição.
- **Visualização/download de PDFs** - cada documento enviado pode ser aberto/baixado em nova aba; documentos dispensados por regra ou ainda não enviados mostram "Não exigido"/"Pendente".
- **Reabertura pontual de pendências** - o RH marca um documento já enviado como "Com Pendência", com justificativa obrigatória; só aquele documento é liberado para reenvio na Ficha do Candidato (o resto continua travado), e a pendência se encerra automaticamente quando o candidato reenvia o PDF.
- **Chat RH ↔ Candidato** - conversa simples, com histórico persistido junto da ficha (ordenado por data/hora), disponível tanto no Painel do RH quanto na Ficha do Candidato (a partir do primeiro envio).
- **Decisão final do processo** - botões "Aprovar Candidato"/"Reprovar Candidato" no Painel do RH; a Ficha do Candidato exibe um banner de sucesso ou de agradecimento e trava totalmente para edição, sem exceção (nem pendências residuais reabrem campos).
- **Filtros e ordenação** - filtra a lista por decisão (Todos/Aprovados/Reprovados/Pendentes); candidatos ainda não avaliados ficam sempre no topo, com separação visual entre "Novos/Não avaliados" e "Já avaliados".
- **Exportação de relatório em CSV** - botão no cabeçalho da tabela baixa um `.csv` (compatível com Excel, com BOM UTF-8) das fichas, respeitando o filtro de decisão ativo.
- **Impressão/PDF da ficha individual** - cada candidato tem um botão que monta uma versão formatada para impressão (dados pessoais, documentos e declaração de consentimento LGPD com o timestamp real de submissão), usando o "Salvar como PDF" do navegador.

Rotas do backend dedicadas ao painel: `GET /api/rh/fichas`, `PATCH /api/rh/fichas/:id/status`, `PATCH /api/rh/fichas/:id/documento/:tipo/pendencia`, `PATCH /api/rh/fichas/:id/decisao`, `GET /api/rh/exportar-csv` (aceita `?filtro=APROVADO|REPROVADO|PENDENTE`). Rotas compartilhadas com o candidato: `GET /api/candidato/:id` (retorno via link `?id=`) e `POST /api/candidato/:id/mensagens` (chat).

Ainda **não implementados** nesta etapa: autenticação do RH (login manual/OAuth) e declaração de consentimento do candidato na trilha de auditoria - a auditoria hoje cobre apenas as ações do RH (status, pendência, decisão).

## Próximas fases do roteiro de desenvolvimento

### Continuação da Etapa 2

- Autenticação e Segurança (login manual e OAuth com Google) para acesso ao Painel do RH.
- Registro na trilha de auditoria também dos aceites/consentimentos do candidato (hoje ela cobre apenas as ações do RH).

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

Node.js, Express e Multer no backend; HTML5, CSS3 e JavaScript puro (Vanilla JS) no frontend; persistência em arquivo JSON local; Git e GitHub para versionamento.

## Licença

MIT
