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
// Notas: filtros, nota aberta no editor (id, 'nova' ou null), rascunho do que está sendo digitado e o que já foi pedido ao computador
// mas ainda não aplicado (aparece na lista mesmo antes do computador aplicar).
let buscaNota = '', catNota = '', cliNota = '', notaAberta = null, rascunho = null, overlay = { editadas: {}, novas: [], excluidas: [] };

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
    if (!comandos.some((c) => c.status === 'pendente' && /_nota$/.test(c.tipo))) overlay = { editadas: {}, novas: [], excluidas: [] };
    guardar({ conexao, foto, comandos, overlay });
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
    return true;
  } catch (e) { toast(e.message === 'Failed to fetch' ? 'Sem internet.' : e.message); return false; }
}

function pendente(tipo, id) { return comandos.some((c) => c.status === 'pendente' && c.tipo === tipo); }

// -- telas ----------------------------------------------------------------

function abasDisponiveis() {
  const m = (foto && foto.modulos) || [];
  const lista = [['hoje', 'Hoje']];
  if (m.includes('agenda')) lista.push(['agenda', 'Agenda']);
  lista.push(['contas', 'Contas']);
  if (m.includes('comercial')) lista.push(['leads', 'Leads']);
  if (m.includes('notas')) lista.push(['notas', 'Notas']);
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
  palco.innerHTML = ({ hoje: telaHoje, agenda: telaAgenda, contas: telaContas, leads: telaLeads, notas: telaNotas, mais: telaMais })[aba]();
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

// -- notas -----------------------------------------------------------------

function notasVisiveis() {
  const ex = new Set(overlay.excluidas || []);
  const base = (foto.notas || []).filter((n) => !ex.has(n.id)).map((n) => (overlay.editadas || {})[n.id] || n);
  return (overlay.novas || []).concat(base).sort((a, b) => String(b.atualizado_em).localeCompare(String(a.atualizado_em)));
}
function tituloNota(t) { const l = String(t || '').split('\n').map((x) => x.trim()).find((x) => x); return (l || 'Nota sem título').slice(0, 80); }
function previaNota(t) { const l = String(t || '').split('\n').map((x) => x.trim()).filter((x) => x); return l.slice(1).join(' ').slice(0, 120); }
function nomeCliente(id) { const c = (foto.clientes || []).find((x) => x.id === id); return c ? c.nome : ''; }

function telaNotas() {
  if (notaAberta) return editorNota();
  const q = buscaNota.toLowerCase();
  const todas = notasVisiveis(), cats = (foto.categorias_notas || []).slice();
  todas.forEach((n) => { if (n.categoria && !cats.includes(n.categoria)) cats.push(n.categoria); });
  const lista = todas.filter((n) => (!catNota || n.categoria === catNota) && (cliNota === '' || (cliNota === '__solta' ? !n.cliente_id : n.cliente_id === cliNota)) &&
    (!q || (n.conteudo + ' ' + n.categoria).toLowerCase().includes(q)));
  const grupos = []; const idx = {};
  lista.forEach((n) => { const k = n.cliente_id || ''; if (!(k in idx)) { idx[k] = grupos.length; grupos.push({ k, itens: [] }); } grupos[idx[k]].itens.push(n); });
  return `<input id="busca-nota" placeholder="Buscar nas notas" value="${esc(buscaNota)}">
  <div class="filtros"><select id="cat-nota"><option value="">Todas as categorias</option>${cats.map((c) => `<option ${c === catNota ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
  <select id="cli-nota"><option value="">Todos os clientes</option><option value="__solta" ${cliNota === '__solta' ? 'selected' : ''}>Só notas soltas</option>${(foto.clientes || []).map((c) => `<option value="${esc(c.id)}" ${c.id === cliNota ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select></div>
  <div class="acoes"><button class="b p" id="nova-nota">+ Nova nota</button></div>
  ${grupos.length ? grupos.map((g) => `<h2>${esc(g.k ? nomeCliente(g.k) || 'Cliente' : 'Notas soltas')} (${g.itens.length})</h2>` + g.itens.map((n) => `<div class="card" data-nota="${esc(n.id)}">
    <div class="t">${esc(tituloNota(n.conteudo))}<span class="pill">${esc(n.categoria)}</span></div>${previaNota(n.conteudo) ? `<div class="m">${esc(previaNota(n.conteudo))}</div>` : ''}
    <div class="m">${esc(quando(n.atualizado_em))}${n.longa ? ' · só leitura (nota longa)' : ''}</div></div>`).join('')).join('') : '<div class="vazio">Nenhuma nota.</div>'}`;
}

function editorNota() {
  const nova = notaAberta === 'nova', n = nova ? null : notasVisiveis().find((x) => x.id === notaAberta);
  if (!nova && !n) { notaAberta = null; return telaNotas(); }
  const r = rascunho || { conteudo: n ? n.conteudo : '', categoria: n ? n.categoria : 'Geral', cliente_id: n ? n.cliente_id : (cliNota && cliNota !== '__solta' ? cliNota : '') };
  const cats = (foto.categorias_notas || ['Geral']).slice(); if (r.categoria && !cats.includes(r.categoria)) cats.push(r.categoria);
  const leitura = !!(n && n.longa);
  return `<h2>${nova ? 'Nova nota' : 'Editar nota'}</h2>
  ${leitura ? '<div class="m">Nota longa: no celular só dá pra ler. Edite no computador.</div>' : ''}
  <textarea id="nota-texto" rows="12" ${leitura ? 'readonly' : ''} placeholder="Escreva aqui">${esc(r.conteudo)}</textarea>
  <input id="nota-cat" list="lista-cats" placeholder="Categoria" value="${esc(r.categoria)}"><datalist id="lista-cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
  <select id="nota-cli"><option value="">Sem cliente (nota solta)</option>${(foto.clientes || []).map((c) => `<option value="${esc(c.id)}" ${c.id === r.cliente_id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select>
  <div class="acoes">${leitura ? '' : '<button class="b p" id="nota-salvar">Salvar</button>'}<button class="b" id="nota-voltar">Voltar</button>${nova ? '' : '<button class="b" id="nota-excluir">Excluir</button>'}</div>`;
}

function guardarRascunho() {
  const t = $('#nota-texto'); if (!t) return;
  rascunho = { conteudo: t.value, categoria: $('#nota-cat').value, cliente_id: $('#nota-cli').value };
}
function fecharNota() { notaAberta = null; rascunho = null; desenhar(); }

async function salvarNota() {
  guardarRascunho(); const r = rascunho, texto = r.conteudo.trim(), cat = (r.categoria || '').trim() || 'Geral';
  if (!texto) { toast('A nota está vazia.'); return; }
  const agora = new Date().toISOString(), antes = JSON.stringify(overlay);
  let tipo, dados;
  if (notaAberta === 'nova') {
    overlay.novas = (overlay.novas || []).concat([{ id: 'novo-' + Date.now(), conteudo: texto, categoria: cat, cliente_id: r.cliente_id, atualizado_em: agora }]);
    tipo = 'criar_nota'; dados = { conteudo: texto, categoria: cat, cliente_id: r.cliente_id };
  } else {
    const n = notasVisiveis().find((x) => x.id === notaAberta), base = ((foto.notas || []).find((x) => x.id === notaAberta) || n || {}).atualizado_em || '';
    overlay.editadas = Object.assign({}, overlay.editadas, { [notaAberta]: Object.assign({}, n, { conteudo: texto, categoria: cat, cliente_id: r.cliente_id, atualizado_em: agora }) });
    tipo = 'editar_nota'; dados = { id: notaAberta, conteudo: texto, categoria: cat, cliente_id: r.cliente_id, base };
  }
  guardar({ conexao, foto, comandos, overlay }); fecharNota();
  if (!(await enviar(tipo, dados))) { overlay = JSON.parse(antes); guardar({ conexao, foto, comandos, overlay }); desenhar(); }   // sem internet: a nota some da lista e o aviso já foi dado
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
  const bn = $('#busca-nota'); if (bn) bn.oninput = () => { buscaNota = bn.value; const pos = bn.selectionStart; desenhar(); const n = $('#busca-nota'); n.focus(); n.setSelectionRange(pos, pos); };
  const cn = $('#cat-nota'); if (cn) cn.onchange = () => { catNota = cn.value; desenhar(); };
  const ln = $('#cli-nota'); if (ln) ln.onchange = () => { cliNota = ln.value; desenhar(); };
  const nn = $('#nova-nota'); if (nn) nn.onclick = () => { notaAberta = 'nova'; rascunho = null; desenhar(); };
  document.querySelectorAll('[data-nota]').forEach((c) => { c.onclick = () => { notaAberta = c.dataset.nota; rascunho = null; desenhar(); window.scrollTo(0, 0); }; });
  ['#nota-texto', '#nota-cat', '#nota-cli'].forEach((id) => { const e = $(id); if (e) { e.oninput = guardarRascunho; e.onchange = guardarRascunho; } });
  const ns = $('#nota-salvar'); if (ns) ns.onclick = salvarNota;
  const nv = $('#nota-voltar'); if (nv) nv.onclick = fecharNota;
  const ne = $('#nota-excluir'); if (ne) ne.onclick = () => {
    if (!confirm('Excluir esta nota?')) return;
    overlay.excluidas = (overlay.excluidas || []).concat([notaAberta]); enviar('excluir_nota', { id: notaAberta }, 'Pedido de exclusão enviado.');
    guardar({ conexao, foto, comandos, overlay }); fecharNota();
  };
  const dc = $('#desconectar'); if (dc) dc.onclick = () => { guardar({}); conexao = foto = null; desenhar(); };
}

document.addEventListener('click', (e) => { const b = e.target.closest('[data-aba]'); if (b) { aba = b.dataset.aba; desenhar(); window.scrollTo(0, 0); } });
$('#btn-atualizar').onclick = () => atualizar(false);
document.addEventListener('visibilitychange', () => { if (!document.hidden) atualizar(true); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});

(function iniciar() {
  const salvo = ler();
  if (salvo.conexao) { conexao = salvo.conexao; foto = salvo.foto || null; comandos = salvo.comandos || []; overlay = salvo.overlay || overlay; }
  if (lerLinkDaUrl()) { foto = null; comandos = []; }
  desenhar();
  atualizar(true);
})();
