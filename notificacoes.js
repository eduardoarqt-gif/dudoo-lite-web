/* Notificações push do Dudoo Lite Web (24/11/2026). Mesmo contrato do núcleo padrão `notificacoes_push.py`:
   a foto traz `push = {chave_publica, categorias:[{id,rotulo,ligada}], silencio:{ativo,de,ate}, aparelhos}`; o app manda os comandos
   `registrar_push` {inscricao, aparelho}, `preferencias_push` {categorias:{id:bool}, silencio:{...}} e `remover_push` {endpoint}.
   O aviso chega como `{titulo, texto, aba, tag}` (o service worker mostra). No iPhone só funciona com o app na Tela de Início (iOS ≥ 16.4). */
"use strict";

const DudooPush = (() => {
  const suportado = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const instalado = () => window.navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);

  function chaveParaBytes(b64url) {
    const b = String(b64url).replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (String(b64url).length % 4)) % 4);
    return Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  }

  async function inscricaoAtual() {
    if (!suportado()) return null;
    try { return await (await navigator.serviceWorker.ready).pushManager.getSubscription(); } catch (e) { return null; }
  }

  async function situacao() {
    if (!suportado()) return { suportado: false, instalado: instalado(), permissao: "indisponivel", inscrito: false };
    const sub = await inscricaoAtual();
    return { suportado: true, instalado: instalado(), permissao: Notification.permission, inscrito: !!sub };
  }

  /* Pede a permissão (só pode ser chamada por um toque do usuário) e devolve a inscrição pronta pra mandar ao Dudoo. */
  async function ativar(chavePublica) {
    if (!suportado()) throw new Error("Este navegador não oferece notificações.");
    if (!chavePublica) throw new Error("O Dudoo ainda não preparou as notificações. Abra o Dudoo no computador e tente de novo.");
    const permissao = await Notification.requestPermission();
    if (permissao !== "granted") throw new Error("Notificações não liberadas. Ajustes do iPhone → Notificações → Dudoo Lite.");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveParaBytes(chavePublica) });
    return sub.toJSON();
  }

  async function desativar() {
    const sub = await inscricaoAtual();
    if (!sub) return "";
    const endpoint = sub.endpoint;
    try { await sub.unsubscribe(); } catch (e) { /* já saiu */ }
    return endpoint;
  }

  /* Preferências com a escolha local por cima da foto (a foto só reflete a escolha depois que o Dudoo aplica o comando). */
  function mesclar(push, local) {
    const cats = (push.categorias || []).map((c) => ({ ...c, ligada: local.categorias && c.id in local.categorias ? !!local.categorias[c.id] : c.ligada }));
    return { ...push, categorias: cats, silencio: { ...(push.silencio || {}), ...(local.silencio || {}) } };
  }

  const destino = (aba) => ({ leads: "mais" }[aba] || aba || "hoje");

  return { suportado, instalado, situacao, ativar, desativar, mesclar, destino };
})();
