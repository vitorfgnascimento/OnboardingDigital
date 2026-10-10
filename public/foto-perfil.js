/* Foto de perfil compartilhada por ficha.html (candidato) e rh.html (Configurações).
   O recorte e a redução acontecem no navegador: a imagem escolhida vira um
   quadrado de 256x256 em JPEG antes de ser enviada ao servidor. */
(function () {
  'use strict';

  var TIPOS_ACEITOS = ['image/png', 'image/jpeg', 'image/webp'];
  var MAX_BYTES_ORIGEM = 5 * 1024 * 1024;
  var LADO = 256;

  function lerArquivo(arquivo) {
    return new Promise(function (resolve, reject) {
      var leitor = new FileReader();
      leitor.onload = function () { resolve(leitor.result); };
      leitor.onerror = function () { reject(new Error('Não foi possível ler a imagem.')); };
      leitor.readAsDataURL(arquivo);
    });
  }

  function carregarImagem(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Essa imagem não pôde ser aberta. Tente outro arquivo.')); };
      img.src = src;
    });
  }

  // Valida o arquivo e devolve uma data URL JPEG quadrada (recorte central).
  function prepararImagem(arquivo) {
    if (!arquivo) return Promise.reject(new Error('Nenhuma imagem selecionada.'));
    if (TIPOS_ACEITOS.indexOf(arquivo.type) === -1) {
      return Promise.reject(new Error('Escolha uma imagem PNG, JPEG ou WebP.'));
    }
    if (arquivo.size > MAX_BYTES_ORIGEM) {
      return Promise.reject(new Error('A imagem tem mais de 5 MB. Escolha uma menor.'));
    }
    return lerArquivo(arquivo).then(carregarImagem).then(function (img) {
      var lado = Math.min(img.naturalWidth, img.naturalHeight);
      if (!lado) throw new Error('Essa imagem não pôde ser aberta. Tente outro arquivo.');
      var canvas = document.createElement('canvas');
      canvas.width = LADO;
      canvas.height = LADO;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF'; // PNG/WebP transparentes viram fundo branco no JPEG
      ctx.fillRect(0, 0, LADO, LADO);
      ctx.drawImage(img, (img.naturalWidth - lado) / 2, (img.naturalHeight - lado) / 2, lado, lado, 0, 0, LADO, LADO);
      return canvas.toDataURL('image/jpeg', 0.85);
    });
  }

  // Só data URLs de imagem entram em <img src>.
  function srcSeguro(valor) {
    return typeof valor === 'string' && valor.indexOf('data:image/') === 0 ? valor : '';
  }

  window.FotoPerfil = { prepararImagem: prepararImagem, srcSeguro: srcSeguro };
})();
