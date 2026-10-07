/* Controle de tamanho do texto (A- / A / A+) compartilhado por todas as páginas.
   Carregue SEM defer, dentro do <head>: o tamanho salvo é aplicado antes da
   primeira pintura (evita o "pulo" visual). Os botões são inseridos em todo
   elemento [data-acessibilidade-slot]; sem slot, viram um grupo flutuante.

   Todos os tamanhos de texto do aplicativo usam rem, então escalar o font-size
   da raiz (100% = 16px) amplia a página inteira. */
(function () {
  'use strict';

  var CHAVE = 'onboarding_fonte';
  var PASSOS = [85, 100, 115, 130, 150];
  var raiz = document.documentElement;
  var atual = lerSalvo();
  var avisador = null;
  var grupos = []; // um por slot: { menos, normal, mais }

  function lerSalvo() {
    try {
      var v = parseInt(window.localStorage.getItem(CHAVE), 10);
      if (PASSOS.indexOf(v) !== -1) return v;
    } catch (e) { /* localStorage indisponível: segue com 100% */ }
    return 100;
  }

  function salvar(p) {
    try { window.localStorage.setItem(CHAVE, String(p)); } catch (e) { /* ignora */ }
  }

  function aplicar(p) {
    raiz.style.fontSize = p + '%';
    raiz.setAttribute('data-fonte', String(p));
  }

  aplicar(atual); // imediato, antes de o <body> existir

  function atualizarBotoes() {
    var i = PASSOS.indexOf(atual);
    grupos.forEach(function (g) {
      g.menos.disabled = i <= 0;
      g.mais.disabled = i >= PASSOS.length - 1;
      g.normal.setAttribute('aria-pressed', atual === 100 ? 'true' : 'false');
    });
  }

  function anunciar(texto) {
    if (!avisador) return;
    avisador.textContent = '';
    setTimeout(function () { avisador.textContent = texto; }, 30);
  }

  function avisarMudanca(p) {
    atualizarBotoes();
    anunciar('Texto em ' + p + '%');
    try { window.dispatchEvent(new CustomEvent('onboarding:fonte', { detail: { percentual: p } })); } catch (e) { /* ignora */ }
  }

  function definir(p) {
    if (PASSOS.indexOf(p) === -1) return;
    atual = p;
    aplicar(p);
    salvar(p);
    avisarMudanca(p);
  }

  function passo(delta) {
    var i = PASSOS.indexOf(atual) + delta;
    if (i >= 0 && i < PASSOS.length) definir(PASSOS[i]);
  }

  function criarBotao(classe, texto, rotulo, aoClicar) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'acess-btn ' + classe;
    b.textContent = texto;
    b.setAttribute('aria-label', rotulo);
    b.title = rotulo;
    b.addEventListener('click', aoClicar);
    return b;
  }

  function montarGrupo(slot) {
    var caixa = document.createElement('div');
    caixa.className = 'acess-fonte';
    caixa.setAttribute('role', 'group');
    caixa.setAttribute('aria-label', 'Tamanho do texto');
    caixa.setAttribute('data-ouvir-ignorar', '');
    var g = {
      menos: criarBotao('acess-menos', 'A−', 'Diminuir texto', function () { passo(-1); }),
      normal: criarBotao('acess-normal', 'A', 'Tamanho normal do texto', function () { definir(100); }),
      mais: criarBotao('acess-mais', 'A+', 'Aumentar texto', function () { passo(1); })
    };
    caixa.appendChild(g.menos); caixa.appendChild(g.normal); caixa.appendChild(g.mais);
    slot.insertBefore(caixa, slot.firstChild);
    grupos.push(g);
  }

  function iniciar() {
    avisador = document.createElement('div');
    avisador.className = 'sr-only';
    avisador.setAttribute('role', 'status');
    avisador.setAttribute('aria-live', 'polite');
    avisador.setAttribute('data-ouvir-ignorar', '');
    document.body.appendChild(avisador);

    var slots = Array.prototype.slice.call(document.querySelectorAll('[data-acessibilidade-slot]'));
    if (!slots.length) {
      var flutuante = document.createElement('div');
      flutuante.className = 'grupo-acess flutuante';
      flutuante.setAttribute('data-ouvir-ignorar', '');
      document.body.appendChild(flutuante);
      slots = [flutuante];
    }
    slots.forEach(montarGrupo);
    atualizarBotoes();

    // Sincroniza entre abas/páginas da mesma origem.
    window.addEventListener('storage', function (e) {
      if (e.key !== CHAVE) return;
      var p = lerSalvo();
      if (p === atual) return;
      atual = p;
      aplicar(p);
      avisarMudanca(p);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
