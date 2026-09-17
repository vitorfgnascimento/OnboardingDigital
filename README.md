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
- **Trilha de auditoria (LGPD)** - toda alteração de status feita pelo RH é registrada em `auditoria.json` (não versionado) com `candidatoId`, status anterior, novo status, timestamp e IP de origem da requisição.

Rotas do backend dedicadas ao painel: `GET /api/rh/fichas` e `PATCH /api/rh/fichas/:id/status`.

Ainda **não implementados** nesta etapa: autenticação do RH (login manual/OAuth), chat entre RH e candidato com reabertura de pendências, e declaração de consentimento do candidato na trilha de auditoria - a auditoria hoje cobre apenas as alterações de status feitas pelo RH.

## Próximas fases do roteiro de desenvolvimento

### Continuação da Etapa 2

- Autenticação e Segurança (login manual e OAuth com Google) para acesso ao Painel do RH.
- Sistema de chat para comunicação direta entre RH e candidato, com reabertura pontual de pendências.
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
