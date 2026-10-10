# Roadmap

Melhorias planejadas que ainda não foram feitas.

## URLs amigáveis (sem `.html`)

Hoje cada página é servida pelo nome do arquivo (`/ficha.html` para a ficha do candidato, `/rh.html`, `/login.html`), porque o Express só serve a pasta `public/` e não há rotas que mapeiem outros nomes.

- [ ] Servir a ficha do candidato em `/cadastro`, mantendo `/index.html` (redireciona para `/ficha.html`) funcionando para não quebrar links já enviados (e-mails de ativação, links de retorno `?id=`).
- [ ] Avaliar o mesmo para o painel do RH em `/rh` e para o login em `/login`.
- [ ] Decidir se vale renomear também o arquivo (`ficha.html` → `cadastro.html`). Se sim, atualizar links internos, `vercel.json`, os testes em `public/testes.html` e a rota raiz `/`.
- [ ] Conferir o comportamento na Vercel (a rota `/(.*)` já vai para o `index.js`, então basta registrar as rotas no Express).
