# OnboardingDigital

**Status do Projeto:** MVP em Desenvolvimento Ativo. Etapa 1 (Jornada e Ficha do Candidato) Concluída.

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

## Próximas fases do roteiro de desenvolvimento

### Etapa 2: Módulo do RH, Painel de Gestão e Trilha de Auditoria LGPD

- Módulo do RH e Painel de Gestão (`/rh.html`).
- Funcionalidade de alteração e homologação de status pelo setor de RH.
- Autenticação e Segurança (login manual e OAuth com Google).
- Sistema de chat para comunicação direta entre RH e candidato, com reabertura pontual de pendências.
- Trilha de Auditoria e Conformidade LGPD (registro de IP e timestamp).

## Tecnologias

Node.js, Express e Multer no backend; HTML5, CSS3 e JavaScript puro (Vanilla JS) no frontend; persistência em arquivo JSON local; Git e GitHub para versionamento.

## Licença

MIT
