// Mudança de endereço (27/11/2026): o app do celular passou para https://lite.dudoo.app.br. Este aviso SÓ aparece no endereço antigo (github.io): leva a conexão
// junto no link (no #, que não vai para servidor nenhum), envia antes o que estava na fila e nunca apaga nada do aparelho. "Agora não" continua usando o antigo.
(function () {
  const NOVO = 'https://lite.dudoo.app.br/';
  if (location.hostname !== 'eduardoarqt-gif.github.io') return;
  try { if (sessionStorage.getItem('dudoo-lite-mudanca') === 'depois') return; } catch (e) { /* modo privado */ }

  function linkNovo() {
    let c = null;
    try { c = (JSON.parse(localStorage.getItem('dudoo-lite-web') || '{}') || {}).conexao; } catch (e) { /* sem conexão salva */ }
    if (!c || !c.u || !c.t || !c.k) return NOVO;
    const carga = btoa(unescape(encodeURIComponent(JSON.stringify({ u: c.u, t: c.t, k: c.k }))));
    return NOVO + '#c=' + carga.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function filaPendente() {
    try { return (JSON.parse(localStorage.getItem('dudoo-lite-web-fila') || '[]') || []).length; } catch (e) { return 0; }
  }

  const tela = document.createElement('div');
  tela.id = 'mudanca';
  tela.style.cssText = 'position:fixed;inset:0;z-index:20;background:var(--fundo);overflow:auto;padding:calc(24px + env(safe-area-inset-top,0px)) 16px 24px';
  tela.innerHTML = '<div class="card conectar"><div class="marca">O Dudoo Lite mudou de endereço</div>'
    + '<p>Agora ele abre em <b>lite.dudoo.app.br</b>.</p>'
    + '<p class="m">1. Toque em <b>Abrir no endereço novo</b> (no iPhone, abra no Safari).<br>2. Adicione à tela inicial e apague o ícone antigo.<br>'
    + '3. Ative os avisos de novo. Se o app novo pedir a conexão, cole o link copiado aqui.</p>'
    + '<p class="m" id="mudanca-fila" hidden></p>'
    + '<div class="acoes"><button class="b p" id="mudanca-abrir">Abrir no endereço novo</button><button class="b" id="mudanca-copiar">Copiar link de conexão</button>'
    + '<button class="b" id="mudanca-depois">Agora não</button></div></div>';
  document.body.appendChild(tela);

  async function enviarFila() {                                  // o que foi lançado sem internet sai por aqui antes de trocar de endereço
    try { if (typeof esvaziarFila === 'function') await esvaziarFila(); } catch (e) { /* sem rede: o aviso abaixo explica */ }
    const falta = filaPendente(), aviso = tela.querySelector('#mudanca-fila');
    aviso.hidden = !falta;
    if (falta) aviso.textContent = 'Há ' + falta + ' lançamento(s) ainda não enviado(s). Conecte à internet antes de trocar de endereço.';
    return !falta;
  }
  tela.querySelector('#mudanca-abrir').onclick = async () => { if (await enviarFila()) location.href = linkNovo(); };
  tela.querySelector('#mudanca-copiar').onclick = (ev) => {
    const link = linkNovo(), botao = ev.currentTarget;
    const mostrar = () => window.prompt('Copie o link de conexão:', link);
    if (!navigator.clipboard) return mostrar();
    navigator.clipboard.writeText(link).then(() => { botao.textContent = 'Link copiado'; }).catch(mostrar);
  };
  tela.querySelector('#mudanca-depois').onclick = () => {
    try { sessionStorage.setItem('dudoo-lite-mudanca', 'depois'); } catch (e) { /* modo privado */ }
    tela.remove();
  };
  enviarFila();
})();
