/* "Ouvir Página": leitura em voz alta do conteúdo principal da página com a
   Web Speech API (pt-BR). Script estático, sem dependências, compartilhado
   entre a ficha do candidato e a tela de login.

   Uso: <script src="/ouvir-pagina.js" defer></script>
   - Se existir um elemento [data-ouvir-pagina-slot], o botão é inserido nele;
     caso contrário, vira um botão flutuante discreto no canto superior direito. */
(function () {
  'use strict';

  var ROTULO_OUVIR = 'Ouvir Página';
  var ROTULO_PARAR = 'Parar leitura';
  // Ícones inline decorativos (traço 1,75, currentColor): o texto do botão é o rótulo.
  var SVG_ABRE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="width:1.25em;height:1.25em;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round;flex:0 0 auto">';
  var ICONE_OUVIR = SVG_ABRE + '<path d="M11 5 6.5 9H3.5v6h3L11 19z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18.2 6.6a7.6 7.6 0 0 1 0 10.8"/></svg>';
  var ICONE_PARAR = SVG_ABRE + '<rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';
  var TAMANHO_BLOCO = 180; // o Chrome corta enunciados longos (~15 s): blocos curtos evitam o bug
  var TAGS_IGNORADAS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, IFRAME: 1, OPTION: 1, SELECT: 1, TEXTAREA: 1, INPUT: 1 };
  var SELETORES_IGNORADOS = '[vw], [data-ouvir-ignorar], #secaoChat, #modalLeitorOverlay, [aria-hidden="true"], [hidden]';

  var suporta = ('speechSynthesis' in window) && ('SpeechSynthesisUtterance' in window);
  var falando = false;
  var sessaoLeitura = 0; // invalida callbacks de leituras canceladas
  var voz = null;
  var botao = null;
  var anunciador = null;

  function escolherVoz() {
    try {
      var lista = window.speechSynthesis.getVoices() || [];
      voz = null;
      for (var i = 0; i < lista.length; i++) {
        if (String(lista[i].lang || '').replace('_', '-').toLowerCase().indexOf('pt-br') === 0) { voz = lista[i]; break; }
      }
    } catch (e) { voz = null; }
  }

  function anunciar(texto) {
    if (!anunciador) return;
    anunciador.textContent = '';
    // Pequeno atraso para o leitor de tela reconhecer a mudança mesmo com texto repetido.
    setTimeout(function () { anunciador.textContent = texto; }, 30);
  }

  function atualizarBotao() {
    if (!botao) return;
    botao.innerHTML = (falando ? ICONE_PARAR : ICONE_OUVIR) + '<span>' + (falando ? ROTULO_PARAR : ROTULO_OUVIR) + '</span>';
    botao.setAttribute('aria-pressed', falando ? 'true' : 'false');
    botao.setAttribute('aria-label', falando ? 'Parar leitura em voz alta' : 'Ouvir Página: ler o conteúdo em voz alta');
  }

  function oculto(el) {
    if (el.closest(SELETORES_IGNORADOS)) return true;
    var estilo = window.getComputedStyle(el);
    return estilo.display === 'none' || estilo.visibility === 'hidden';
  }

  function textoDoRotulo(label) {
    var copia = label.cloneNode(true);
    copia.querySelectorAll('input, select, textarea, button, [aria-hidden="true"], [hidden]').forEach(function (n) { n.remove(); });
    var texto = (copia.textContent || '').replace(/\s*\*+\s*/g, ' ').replace(/\s+/g, ' ').trim();
    var campo = label.control || label.querySelector('input, select, textarea');
    if (texto && campo && campo.required) texto += ', campo obrigatório';
    return texto;
  }

  // Percorre o DOM na ordem natural e devolve um vetor de trechos de texto.
  function coletarTrechos(raiz) {
    var trechos = [];
    var atual = '';

    function fechar() {
      // Símbolos decorativos (setas, checks, bullets) não devem ser lidos em voz alta.
      var t = atual.replace(/[←→↑↓✓✔✕✖✗•★☆▶▼▲]/g, ' ').replace(/\s+/g, ' ').trim();
      if (t) trechos.push(t);
      atual = '';
    }

    function visitar(no) {
      if (no.nodeType === 3) { atual += no.nodeValue; return; }
      if (no.nodeType !== 1 || no === botao || TAGS_IGNORADAS[no.tagName.toUpperCase()]) return;
      if (oculto(no)) return;

      if (no.tagName === 'LABEL') {
        fechar();
        atual = textoDoRotulo(no);
        fechar();
        return;
      }
      var estilo = window.getComputedStyle(no);
      var emLinha = estilo.display.indexOf('inline') === 0;
      if (!emLinha) fechar();
      for (var f = no.firstChild; f; f = f.nextSibling) visitar(f);
      if (!emLinha) fechar();
    }

    visitar(raiz);
    fechar();
    return trechos;
  }

  function dividirLongo(frase) {
    var partes = [];
    var resto = frase;
    while (resto.length > TAMANHO_BLOCO) {
      var corte = -1;
      var janela = resto.slice(0, TAMANHO_BLOCO);
      var m = Math.max(janela.lastIndexOf(', '), janela.lastIndexOf('; '), janela.lastIndexOf(': '));
      corte = m > 60 ? m + 1 : janela.lastIndexOf(' ');
      if (corte <= 0) corte = TAMANHO_BLOCO;
      partes.push(resto.slice(0, corte).trim());
      resto = resto.slice(corte).trim();
    }
    if (resto) partes.push(resto);
    return partes;
  }

  // Junta frases em blocos de até ~TAMANHO_BLOCO caracteres (nunca atravessa trechos).
  function montarBlocos(trechos) {
    var blocos = [];
    trechos.forEach(function (trecho) {
      var t = /[.!?:;,]$/.test(trecho) ? trecho : trecho + '.';
      // Sem lookbehind (não existe em Safari/iOS anteriores ao 16.4): casa cada frase com sua pontuação final.
      // O ponto só encerra a frase quando seguido de espaço/fim (não quebra "13.709/2018").
      var frases = t.match(/[\s\S]+?(?:[.!?]+(?=\s|$)|$)\s*/g) || [t];
      frases = frases.map(function (f) { return f.trim(); }).filter(Boolean);
      var bloco = '';
      frases.forEach(function (frase) {
        dividirLongo(frase).forEach(function (parte) {
          if (bloco && (bloco.length + parte.length + 1) > TAMANHO_BLOCO) { blocos.push(bloco); bloco = ''; }
          bloco = bloco ? bloco + ' ' + parte : parte;
        });
      });
      if (bloco) blocos.push(bloco);
    });
    return blocos;
  }

  function parar(silencioso) {
    sessaoLeitura++;
    var estavaFalando = falando;
    falando = false;
    try { window.speechSynthesis.cancel(); } catch (e) { /* ignora */ }
    atualizarBotao();
    if (estavaFalando && !silencioso) anunciar('Leitura interrompida');
  }

  function iniciar() {
    var raiz = document.querySelector('main') || document.body;
    var blocos = montarBlocos(coletarTrechos(raiz));
    if (!blocos.length) return;

    try { window.speechSynthesis.cancel(); } catch (e) { /* ignora */ }
    var minhaSessao = ++sessaoLeitura;
    falando = true;
    atualizarBotao();
    anunciar('Leitura iniciada');

    blocos.forEach(function (texto, i) {
      var fala = new window.SpeechSynthesisUtterance(texto);
      fala.lang = 'pt-BR';
      if (voz) fala.voice = voz;
      var ultimo = i === blocos.length - 1;
      fala.onend = function () {
        if (minhaSessao !== sessaoLeitura) return;
        if (ultimo) { falando = false; atualizarBotao(); anunciar('Leitura concluída'); }
      };
      fala.onerror = function (ev) {
        if (minhaSessao !== sessaoLeitura) return;
        if (ev && (ev.error === 'canceled' || ev.error === 'interrupted')) return;
        falando = false; atualizarBotao();
      };
      window.speechSynthesis.speak(fala);
    });
  }

  function criarBotao() {
    botao = document.createElement('button');
    botao.type = 'button';
    botao.id = 'btnOuvirPagina';
    botao.className = 'btn-ouvir-pagina';
    botao.setAttribute('data-ouvir-ignorar', '');

    var estilo = document.createElement('style');
    estilo.textContent =
      '.btn-ouvir-pagina{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-height:max(2.5rem,40px);padding:0 1rem;' +
      'font:600 .875rem/1.1 "Figtree",system-ui,"Segoe UI",sans-serif;color:#0F3D2A;background:#fff;border:1px solid #D9D2C5;' +
      'border-radius:999px;cursor:pointer;white-space:nowrap;transition:background-color .15s,border-color .15s}' +
      '.btn-ouvir-pagina:hover{background:#E7F3EA;border-color:#00812a}' +
      '.btn-ouvir-pagina[aria-pressed="true"]{background:#0F3D2A;color:#FBF8F3;border-color:#0F3D2A}' +
      '.btn-ouvir-pagina:focus-visible{outline:3px solid #00A335;outline-offset:2px}' +
      '.btn-ouvir-pagina:disabled{opacity:.55;cursor:not-allowed}' +
      '.btn-ouvir-pagina.flutuante{position:fixed;top:.75rem;right:.75rem;z-index:800}' +
      '.ouvir-pagina-aviso{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}';
    document.head.appendChild(estilo);

    anunciador = document.createElement('div');
    anunciador.className = 'ouvir-pagina-aviso';
    anunciador.setAttribute('role', 'status');
    anunciador.setAttribute('aria-live', 'polite');
    anunciador.setAttribute('data-ouvir-ignorar', '');
    document.body.appendChild(anunciador);

    var slot = document.querySelector('[data-ouvir-pagina-slot]');
    if (slot) slot.appendChild(botao); else { botao.classList.add('flutuante'); document.body.appendChild(botao); }

    atualizarBotao();

    if (!suporta) {
      botao.disabled = true;
      botao.title = 'Seu navegador não suporta leitura em voz alta';
      return;
    }

    botao.addEventListener('click', function () { if (falando) parar(); else iniciar(); });
  }

  function init() {
    criarBotao();
    if (!suporta) return;
    escolherVoz();
    try { window.speechSynthesis.addEventListener('voiceschanged', escolherVoz); } catch (e) { /* ignora */ }
    window.addEventListener('pagehide', function () { parar(true); });
    window.addEventListener('beforeunload', function () { parar(true); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) parar(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
