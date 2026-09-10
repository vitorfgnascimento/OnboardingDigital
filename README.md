# OnboardingDigital

Sistema de admissão digital para coleta de aceite de documentos trabalhistas, com trilha de auditoria e conformidade com a LGPD.

O projeto centraliza os dados do candidato em uma ficha única e acompanha o andamento do processo admissional por um sistema de cores: vermelho para pendente, amarelo para em análise e verde para aprovado. Isso facilita a leitura rápida de pendências pelo time de RH.

Para cada aceite ou alteração realizada, o sistema registra um log de auditoria imutável, com IP, data e hora e a declaração de consentimento do candidato - atendendo aos requisitos da LGPD.

A interface também foi pensada com acessibilidade em mente, com HTML semântico e suporte a ferramentas de Libras como o VLibras.

Funcionalidades principais:

- Ficha única do candidato, com dados pessoais, endereço, CTPS e contato
- Status visual do processo por cores
- Trilha de auditoria com IP, timestamp e consentimento
- Estrutura acessível, com suporte a Libras

Tecnologias utilizadas: Node.js e Express no backend, HTML, CSS e JavaScript puro no frontend, com Git e GitHub para versionamento.

O projeto está em desenvolvimento, na fase de MVP.

Licença: MIT
