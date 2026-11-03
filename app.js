// Dudoo Lite Web — app companheiro. Lê a "foto" que o Dudoo Lite do computador publica e manda comandos
// (concluir tarefa, dar baixa, criar conta...) que o computador aplica quando está aberto.
'use strict';

const CHAVE = 'dudoo-lite-web';
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataBr = (iso) => (iso && iso.length >= 10 ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '');
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

let conexao = null, foto = null, comandos = [], aba = 'hoje', contaAba = 'receber', busca = '', erroRede = '';

function guardar(obj) { try { localStorage.setItem(CHAVE, JSON.stringify(obj)); } catch (e) { /* modo privado */ } }
function ler() { try { return JSON.parse(localStorage.getItem(CHAVE) || '{}'); } catch (e) { return {}; } }

function lerLinkDaUrl() {
  const m = /[#&]c=([^&]+)/.exec(location.hash);
  if (!m) return false;
  return aceitarLink(m[1]);
}
function aceitarLink(texto) {
  try {
    let b = String(texto).trim(); if (b.indexOf('#c=') >= 0) b = b.split('#c=')[1];
    b = b.replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '=';
    const c = JSON.parse(decodeURIComponent(escape(atob(b))));
    if (!c.u || !c.t || !c.k) return false;
    conexao = { u: String(c.u).replace(/\/$/, ''), t: c.t, k: c.k };
    guardar({ conexao, foto: null, comandos: [] });
    history.replaceState(null, '', location.pathname + location.search);
    return true;
  } catch (e) { return false; }
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 3500);
}

async function relay(metodo, nome, corpo, consulta) {
  const url = `${conexao.u}/_functions/${nome}${consulta ? '?' + consulta : ''}`;
  const r = await fetch(url, {
    method: metodo, headers: { 'Content-Type': 'application/json', 'X-Lite-App': conexao.k },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (r.status === 403) throw new Error('Conexão recusada. Gere um link novo no Dudoo Lite (Configurações → Integrações).');
  if (!r.ok) throw new Error('Servidor indisponível (' + r.status + ').');
  return r.json();
}

async function atualizar(silencioso) {
  if (!conexao) return;
  try {
    const d = await relay('GET', 'lite_snapshot', null, 'tenant=' + encodeURIComponent(conexao.t));
    foto = d.snapshot; comandos = d.comandos || []; erroRede = '';
    guardar({ conexao, foto, comandos });
    if (!silencioso) toast('Atualizado');
  } catch (e) {
    erroRede = e.message === 'Failed to fetch' ? 'Sem internet — mostrando os últimos dados.' : e.message;
  }
  desenhar();
}

async function enviar(tipo, dados, msg) {
  try {
    await relay('POST', 'lite_comando', { tenant: conexao.t, tipo, dados });
    toast(msg || 'Enviado. O computador aplica quando o Dudoo Lite estiver aberto.');
    await atualizar(true);
  } catch (e) { toast(e.message === 'Failed to fetch' ? 'Sem internet.' : e.message); }
}

function pendente(tipo, id) { return comandos.some((c) => c.status === 'pendente' && c.tipo === tipo); }

// -- telas ----------------------------------------------------------------

function abasDisponiveis() {
  const m = (foto && foto.modulos) || [];
  const lista = [['hoje', 'Hoje']];
  if (m.includes('agenda')) lista.push(['agenda', 'Agenda']);
  lista.push(['contas', 'Contas']);
  if (m.includes('comercial')) lista.push(['leads', 'Leads']);
  lista.push(['mais', 'Mais']);
  return lista;
}

function desenhar() {
  const palco = $('#palco');
  $('#aviso').hidden = !erroRede; $('#aviso').textContent = erroRede;
  if (!conexao) { $('#abas').innerHTML = ''; return telaConectar(palco); }
  if (!foto) { $('#sub-topo').textContent = 'Conectando…'; palco.innerHTML = '<p class="vazio">Buscando os dados do computador…</p>'; return; }
  $('#sub-topo').textContent = (foto.negocio ? foto.negocio + ' · ' : '') + 'atualizado ' + quando(foto.atualizado_em);
  const abas = abasDisponiveis(); if (!abas.some((a) => a[0] === aba)) aba = 'hoje';
  $('#abas').innerHTML = abas.map(([k, r]) => `<button data-aba="${k}" class="${k === aba ? 'on' : ''}">${r}</button>`).join('');
  palco.innerHTML = ({ hoje: telaHoje, agenda: telaAgenda, contas: telaContas, leads: telaLeads, mais: telaMais })[aba]();
  ligar();
}

function quando(iso) {
  if (!iso) return '—';
  const d = new Date(iso), hoje = new Date();
  const hora = d.toTimeString().slice(0, 5);
  return d.toDateString() === hoje.toDateString() ? 'hoje às ' + hora : dataBr(iso) + ' ' + hora;
}

function telaConectar(palco) {
  $('#sub-topo').textContent = 'Não conectado';
  palco.innerHTML = `<div class="conectar"><h2>Conectar ao Dudoo Lite</h2>
    <p class="m">No computador: Dudoo Lite → Configurações → Integrações → <b>Dudoo Lite Web</b> → “Copiar link de conexão”. Abra o link aqui ou cole abaixo.</p>
    <textarea id="link" rows="4" placeholder="Cole o link de conexão"></textarea>
    <button class="b p" id="conectar">Conectar</button></div>`;
  $('#conectar').onclick = () => {
    if (aceitarLink($('#link').value)) { desenhar(); atualizar(); } else toast('Esse link não parece certo. Copie de novo no computador.');
  };
}

function telaHoje() {
  const hoje = foto.hoje, ag = (foto.agenda || []).filter((e) => e.data === hoje);
  const fin = foto.financeiro || { receber: [], pagar: [] };
  const venc = fin.receber.filter((c) => c.situacao === 'Vencido').length + fin.pagar.filter((c) => c.situacao === 'Vencido').length;
  const fu = foto.leads ? foto.leads.followups_hoje.length : 0;
  const tarefas = foto.tarefas || [];
  const precisa = [];
  if (venc) precisa.push(`${venc} conta(s) vencida(s)`);
  if (fu) precisa.push(`${fu} follow-up(s) de lead hoje`);
  const atras = tarefas.filter((t) => t.prazo && t.prazo <= hoje).length;
  if (atras) precisa.push(`${atras} tarefa(s) com prazo vencido ou para hoje`);
  return `<h2>Precisa de você</h2>${precisa.length ? precisa.map((p) => `<div class="card">${esc(p)}</div>`).join('') : '<div class="vazio">Nada urgente.</div>'}
  <h2>Hoje na agenda</h2>${ag.length ? ag.map(cardAgenda).join('') : '<div class="vazio">Nenhum compromisso hoje.</div>'}
  <h2>Tarefas</h2>${tarefas.length ? tarefas.map(cardTarefa).join('') : '<div class="vazio">Nenhuma tarefa pendente.</div>'}
  <div class="acoes"><button class="b" id="nova-tarefa">+ Nova tarefa</button></div>`;
}

function cardAgenda(e) {
  return `<div class="card"><div class="linha"><div><div class="t">${esc(e.hora)}–${esc(e.fim)} · ${esc(e.titulo)}</div>
    <div class="m">${esc(e.cliente || (e.compromisso ? 'Compromisso' : ''))}${e.status && e.status !== 'Agendado' ? ' · ' + esc(e.status) : ''}</div></div></div></div>`;
}
function cardTarefa(t) {
  
  return `<div class="card"><div class="linha"><div><div class="t">${esc(t.titulo)}</div><div class="m">${t.prazo ? 'Prazo ' + dataBr(t.prazo) : 'Sem prazo'}${t.prioridade ? ' · ' + esc(t.prioridade) : ''}</div></div>
    <button class="b" data-concluir="${esc(t.id)}">Concluir</button></div></div>`;
}

function telaAgenda() {
  const por = {}; (foto.agenda || []).forEach((e) => { (por[e.data] = por[e.data] || []).push(e); });
  const dias = Object.keys(por).sort();
  if (!dias.length) return '<div class="vazio">Nada agendado nos próximos 14 dias.</div>';
  return dias.map((d) => { const dt = new Date(d + 'T12:00:00');
    return `<div class="dia ${d === foto.hoje ? 'hoje' : ''}">${DIAS[dt.getDay()]} ${dataBr(d)}${d === foto.hoje ? ' · hoje' : ''}</div>` + por[d].map(cardAgenda).join(''); }).join('');
}

function telaContas() {
  const fin = foto.financeiro, lista = contaAba === 'receber' ? fin.receber : fin.pagar;
  const total = lista.reduce((s, c) => s + c.valor, 0);
  return `<div class="seg"><button class="b ${contaAba === 'receber' ? 'p' : ''}" data-conta="receber">A receber</button><button class="b ${contaAba === 'pagar' ? 'p' : ''}" data-conta="pagar">A pagar</button></div>
  <div class="card"><div class="linha"><div class="m">Em aberto</div><div class="valor">${brl(total)}</div></div>
  <div class="m">${contaAba === 'receber' ? 'Recebido' : 'Pago'} neste mês: ${brl(contaAba === 'receber' ? fin.recebido_mes : fin.pago_mes)}</div></div>
  ${lista.length ? lista.map((c) => `<div class="card"><div class="linha"><div><div class="t">${esc(c.descricao)}</div>
    <div class="m ${c.situacao === 'Vencido' ? 'vencido' : ''}">${c.situacao === 'Vencido' ? 'Vencida · ' : ''}${dataBr(c.vencimento)}</div></div>
    <div style="text-align:right"><div class="valor">${brl(c.valor)}</div><button class="b" data-baixa="${esc(c.id)}">Dar baixa</button></div></div></div>`).join('') : '<div class="vazio">Nada em aberto.</div>'}
  ${contaAba === 'receber' ? '<div class="acoes"><button class="b" id="nova-conta">+ Nova conta a receber</button></div>' : ''}`;
}

function cartaoLead(l, extra) {
  const tel = String(l.telefone || '').replace(/\D/g, ''), zap = tel ? `https://wa.me/${tel.length <= 11 ? '55' + tel : tel}` : '';
  return `<div class="card"><div class="t">${esc(l.nome)}<span class="pill">${esc(l.etapa)}</span></div>
    <div class="m">${esc(l.proxima_acao || '')}${l.proxima_acao_data ? ' · ' + dataBr(l.proxima_acao_data) : ''}</div>
    <div class="acoes">${zap ? `<a class="b" href="${zap}" target="_blank" rel="noopener">WhatsApp</a>` : ''}${tel ? `<a class="b" href="tel:${tel}">Ligar</a>` : ''}
    ${extra ? `<button class="b" data-contato="${esc(l.id)}">Contato feito</button>` : `<button class="b" data-followup="${esc(l.id)}">Concluir follow-up</button>`}</div></div>`;
}
function telaLeads() {
  const L = foto.leads || { followups_hoje: [], novos_sem_contato: [], sem_movimentacao: [] };
  const bloco = (t, l, extra) => `<h2>${t} (${l.length})</h2>${l.length ? l.map((x) => cartaoLead(x, extra)).join('') : '<div class="vazio">Nenhum.</div>'}`;
  return bloco('Follow-up hoje', L.followups_hoje, false) + bloco('Novos sem contato', L.novos_sem_contato, true) + bloco('Parados', L.sem_movimentacao, true);
}

function telaMais() {
  const q = busca.toLowerCase();
  const cl = (foto.clientes || []).filter((c) => !q || c.nome.toLowerCase().includes(q)).slice(0, 40);
  const termo = (foto.termos && foto.termos.cliente) || 'Clientes';
  const ped = comandos.slice().reverse().slice(0, 8);
  return `<h2>${esc(termo)}</h2><input id="busca" placeholder="Buscar pelo nome" value="${esc(busca)}">
  ${cl.map((c) => { const tel = String(c.telefone || '').replace(/\D/g, ''); return `<div class="card"><div class="t">${esc(c.nome)}</div>
    <div class="m">${esc(c.telefone || '')}${c.email ? ' · ' + esc(c.email) : ''}</div>${tel ? `<div class="acoes"><a class="b" href="tel:${tel}">Ligar</a><a class="b" href="https://wa.me/${tel.length <= 11 ? '55' + tel : tel}" target="_blank" rel="noopener">WhatsApp</a></div>` : ''}</div>`; }).join('') || '<div class="vazio">Ninguém encontrado.</div>'}
  <h2>Pedidos enviados ao computador</h2>${ped.length ? ped.map((c) => `<div class="card"><div class="linha"><div class="t">${esc(c.tipo.replace(/_/g, ' '))}</div><div class="m ${c.status === 'erro' ? 'vencido' : c.status === 'aplicado' ? 'ok' : ''}">${esc(c.status)}</div></div>${c.erro ? `<div class="m">${esc(c.erro)}</div>` : ''}</div>`).join('') : '<div class="vazio">Nenhum.</div>'}
  <h2>Conexão</h2><div class="card"><div class="m">Os dados vêm do Dudoo Lite do computador e só atualizam com ele aberto. Prontuário e documentos não passam por aqui.</div>
  <div class="acoes"><button class="b" id="desconectar">Desconectar este celular</button></div></div>`;
}

// -- eventos --------------------------------------------------------------

function formulario(titulo, campos, ao_enviar) {
  const palco = $('#palco');
  palco.innerHTML = `<h2>${esc(titulo)}</h2>` + campos.map((c) => `<input id="f-${c.id}" placeholder="${esc(c.rotulo)}" ${c.tipo ? `type="${c.tipo}"` : ''} ${c.modo ? `inputmode="${c.modo}"` : ''}>`).join('') +
    '<div class="acoes"><button class="b p" id="f-ok">Enviar</button><button class="b" id="f-cancelar">Cancelar</button></div>';
  $('#f-cancelar').onclick = desenhar;
  $('#f-ok').onclick = () => { const v = {}; campos.forEach((c) => { v[c.id] = $('#f-' + c.id).value.trim(); }); ao_enviar(v); desenhar(); };
}

function ligar() {
  document.querySelectorAll('[data-concluir]').forEach((b) => { b.onclick = () => enviar('concluir_tarefa', { id: b.dataset.concluir }); });
  document.querySelectorAll('[data-baixa]').forEach((b) => { b.onclick = () => enviar(contaAba === 'receber' ? 'baixa_receber' : 'baixa_pagar', { id: b.dataset.baixa }); });
  document.querySelectorAll('[data-contato]').forEach((b) => { b.onclick = () => enviar('registrar_contato_lead', { id: b.dataset.contato }); });
  document.querySelectorAll('[data-followup]').forEach((b) => { b.onclick = () => enviar('concluir_followup_lead', { id: b.dataset.followup }); });
  document.querySelectorAll('[data-conta]').forEach((b) => { b.onclick = () => { contaAba = b.dataset.conta; desenhar(); }; });
  const nt = $('#nova-tarefa'); if (nt) nt.onclick = () => formulario('Nova tarefa', [{ id: 'titulo', rotulo: 'O que precisa ser feito' }, { id: 'prazo', rotulo: 'Prazo', tipo: 'date' }], (v) => v.titulo && enviar('criar_tarefa', v));
  const nc = $('#nova-conta'); if (nc) nc.onclick = () => formulario('Nova conta a receber', [{ id: 'descricao', rotulo: 'Descrição' }, { id: 'valor', rotulo: 'Valor (ex.: 150,00)', modo: 'decimal' }, { id: 'vencimento', rotulo: 'Vencimento', tipo: 'date' }], (v) => v.descricao && v.valor && v.vencimento && enviar('criar_conta_receber', v));
  const bu = $('#busca'); if (bu) bu.oninput = () => { busca = bu.value; const pos = bu.selectionStart; desenhar(); const n = $('#busca'); n.focus(); n.setSelectionRange(pos, pos); };
  const dc = $('#desconectar'); if (dc) dc.onclick = () => { guardar({}); conexao = foto = null; desenhar(); };
}

document.addEventListener('click', (e) => { const b = e.target.closest('[data-aba]'); if (b) { aba = b.dataset.aba; desenhar(); window.scrollTo(0, 0); } });
$('#btn-atualizar').onclick = () => atualizar(false);
document.addEventListener('visibilitychange', () => { if (!document.hidden) atualizar(true); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});

(function iniciar() {
  const salvo = ler();
  if (salvo.conexao) { conexao = salvo.conexao; foto = salvo.foto || null; comandos = salvo.comandos || []; }
  if (lerLinkDaUrl()) { foto = null; comandos = []; }
  desenhar();
  atualizar(true);
})();
