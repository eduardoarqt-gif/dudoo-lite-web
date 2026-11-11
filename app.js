// Dudoo Lite Web — app companheiro. Lê a "foto" que o Dudoo Lite do computador publica e manda comandos
// (concluir tarefa, dar baixa, criar conta...) que o computador aplica quando está aberto.
'use strict';

const CHAVE = 'dudoo-lite-web';
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataBr = (iso) => (iso && iso.length >= 10 ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '');
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

let conexao = null, foto = null, comandos = [], aba = 'hoje', busca = '', erroRede = '';
// Contas (11/11/2026): Empresa/Pessoal, mês, sub-aba, Pessoal liberado (Face ID ou PIN), faturas abertas e baixas pedidas ao computador.
// Pedidos feitos sem internet ficam guardados aqui e seguem sozinhos quando a conexão volta.
const CHAVE_FILA = 'dudoo-lite-web-fila';
let fila = lerChave(CHAVE_FILA) || [];
// Cadastros: busca e ficha aberta.
let buscaCad = '', cadAberto = null, consAberta = null;
let finEscopo = 'empresa', finMes = '', contaAba = 'receber', pessoalLiberado = false, itensAbertos = {}, baixasLocais = {};
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

async function esvaziarFila() {
  if (!conexao) return;
  while (fila.length) {
    try { await relay('POST', 'lite_comando', { tenant: conexao.t, tipo: fila[0].tipo, dados: fila[0].dados }); } catch (e) { return; }
    fila.shift(); gravarChave(CHAVE_FILA, fila);
  }
}

async function atualizar(silencioso) {
  if (!conexao) return;
  await esvaziarFila();
  try {
    const d = await relay('GET', 'lite_snapshot', null, 'tenant=' + encodeURIComponent(conexao.t));
    foto = d.snapshot; comandos = d.comandos || []; erroRede = '';
    if (!comandos.some((c) => c.status === 'pendente' && /_nota$/.test(c.tipo))) overlay = { editadas: {}, novas: [], excluidas: [] };
    limparBaixasLocais();
    guardar({ conexao, foto, comandos, overlay, baixasLocais });
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
  } catch (e) {
    if (e.message !== 'Failed to fetch') { toast(e.message); return false; }
    fila.push({ tipo, dados, quando: Date.now() }); gravarChave(CHAVE_FILA, fila);
    toast('Sem internet: guardei o pedido e envio quando a conexão voltar.');
    desenhar();
    return true;
  }
}

function pendente(tipo, id) { return comandos.some((c) => c.status === 'pendente' && c.tipo === tipo); }

// -- telas ----------------------------------------------------------------

function abasDisponiveis() {
  const m = (foto && foto.modulos) || [];
  const lista = [['hoje', 'Hoje']];
  if (m.includes('agenda')) lista.push(['agenda', 'Agenda']);
  lista.push(['contas', 'Contas']);
  if (m.includes('cadastros')) lista.push(['cadastros', ((foto.termos && foto.termos.cliente) || 'Cadastros')]);
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
  palco.innerHTML = ({ hoje: telaHoje, agenda: telaAgenda, contas: telaContas, cadastros: telaCadastros, leads: telaLeads, notas: telaNotas, mais: telaMais })[aba]();
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

// -- contas: Empresa e Pessoal, mês a mês ------------------------------------------------------------------------------

const CHAVE_CRED = 'dudoo-lite-web-cred', CHAVE_PIN = 'dudoo-lite-web-pin';
const MESES_NOME = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const rotuloMes = (m) => { const [a, n] = String(m).split('-'); return (MESES_NOME[Number(n) - 1] || m) + ' ' + a; };
const fechada = (i) => i.status === 'paga' || i.status === 'recebida';

// Foto antiga (sem meses): monta a mesma estrutura com o que já veio (só Empresa, só o que está em aberto).
function financeiroDaFoto() {
  const f = foto.financeiro || {};
  if (f.meses && f.empresa) return f;
  const mes = String(foto.hoje || new Date().toISOString()).slice(0, 7);
  const conv = (l) => (l || []).map((c) => ({ id: c.id, descricao: c.descricao, valor: c.valor, venc: c.vencimento, status: c.situacao === 'Vencido' ? 'vencida' : 'aberta', baixa_em: '', tipo: 'conta' }));
  return { mes_atual: mes, meses: [mes], empresa: { por_mes: { [mes]: { a_receber: conv(f.receber), a_pagar: conv(f.pagar) } } }, pessoal: null };
}

// O que o celular já pediu mas o computador ainda não aplicou: a conta aparece como já baixada (ou reaberta) até a foto nova chegar.
function fechadaAgora(i) { const l = baixasLocais[i.id]; return l ? l.acao === 'baixa' : fechada(i); }
function limparBaixasLocais() {
  const f = financeiroDaFoto(), itens = [];
  ['empresa', 'pessoal'].forEach((e) => { const por = f[e] && f[e].por_mes; if (por) Object.keys(por).forEach((m) => itens.push(...por[m].a_receber, ...por[m].a_pagar)); });
  Object.keys(baixasLocais).forEach((id) => {
    const l = baixasLocais[id], i = itens.find((x) => x.id === id);
    if (!i || (Date.now() - l.quando) > 86400000 || fechada(i) === (l.acao === 'baixa')) delete baixasLocais[id];
  });
}

function cartaoConta(i, receber, escopo) {
  const fe = fechadaAgora(i), loc = baixasLocais[i.id];
  const vencida = !fe && i.venc && i.venc < foto.hoje;
  const rotulo = fe ? (receber ? 'Recebida' : 'Paga') + (i.baixa_em && !loc ? ' ' + dataBr(i.baixa_em) : '') : (vencida ? 'Venceu ' : 'Vence ') + dataBr(i.venc);
  const itens = (i.itens || []).length ? `<button class="b" data-itens="${esc(i.id)}">${itensAbertos[i.id] ? '▴ Esconder' : '▾ Ver o que tem dentro'} · ${i.itens.length}</button>
    ${itensAbertos[i.id] ? i.itens.map((x) => `<div class="linha m"><div>${esc(x.nome)}</div><div>${brl(x.valor)}</div></div>`).join('') : ''}` : '';
  const acao = fe
    ? `<div class="linha"><div class="m ok">✓ Baixa registrada${loc ? ' · aguardando o Dudoo' : ''}</div><button class="b" data-desfaz="${esc(i.id)}" data-tipo="${esc(i.tipo)}" data-escopo="${escopo}" data-receber="${receber ? 1 : 0}">Desfazer</button></div>`
    : `<button class="b" data-baixa="${esc(i.id)}" data-tipo="${esc(i.tipo)}" data-escopo="${escopo}" data-receber="${receber ? 1 : 0}">${receber ? 'Dar baixa' : 'Marcar paga'}</button>${loc ? '<span class="m"> aguardando o Dudoo</span>' : ''}`;
  return `<div class="card ${fe ? 'fechada' : ''}"><div class="linha"><div><div class="t">${esc(i.descricao)}</div><div class="m ${vencida ? 'vencido' : ''}">${rotulo}</div></div>
    <div class="valor">${brl(i.valor)}</div></div><div class="acoes">${acao}</div>${itens}</div>`;
}

function bloqueioPessoal() {
  return `<div class="card"><div class="t">Financeiro pessoal protegido</div><div class="m">Libere com a biometria do celular (ou um PIN) para ver.</div>
    <div class="acoes"><button class="b p" id="liberar-pessoal">Liberar</button></div></div>`;
}

function telaContas() {
  const F = financeiroDaFoto(), temPessoal = !!F.pessoal;
  if (finEscopo === 'pessoal' && !temPessoal) finEscopo = 'empresa';
  const meses = F.meses, mes = meses.includes(finMes) ? finMes : (meses.includes(F.mes_atual) ? F.mes_atual : meses[0]);
  finMes = mes;
  const escopoSeg = temPessoal ? `<div class="seg"><button class="b ${finEscopo === 'empresa' ? 'p' : ''}" data-escopo="empresa">${esc(foto.negocio || 'Empresa')}</button><button class="b ${finEscopo === 'pessoal' ? 'p' : ''}" data-escopo="pessoal">Pessoal</button></div>` : '';
  if (finEscopo === 'pessoal' && !pessoalLiberado) return `<h2>Contas</h2>${escopoSeg}${bloqueioPessoal()}`;
  const por = F[finEscopo].por_mes, dm = por[mes] || { a_receber: [], a_pagar: [] }, idx = meses.indexOf(mes);
  const soma = (l, f) => l.filter(f).reduce((t, x) => t + x.valor, 0);
  const aberta = (x) => !fechadaAgora(x), feita = (x) => fechadaAgora(x);
  const subs = [['receber', 'A receber'], ['pagar', 'A pagar'], ['projecao', 'Projeção']];
  let corpo;
  if (contaAba === 'projecao') {
    corpo = meses.map((m) => {
      const d = por[m] || { a_receber: [], a_pagar: [] }, ent = soma(d.a_receber, () => true), sai = soma(d.a_pagar, () => true);
      return `<div class="card"><div class="linha"><div><div class="t">${esc(rotuloMes(m))}</div><div class="m">Entradas ${brl(ent)} · Saídas ${brl(sai)}</div></div>
        <div class="valor ${ent >= sai ? 'ok' : 'vencido'}">${brl(ent - sai)}</div></div></div>`;
    }).join('');
  } else {
    const receber = contaAba === 'receber', lista = receber ? dm.a_receber : dm.a_pagar;
    corpo = (lista.length ? lista.map((i) => cartaoConta(i, receber, finEscopo)).join('') : `<div class="vazio">Nada em ${esc(rotuloMes(mes))}.</div>`) +
      `<div class="acoes"><button class="b" id="nova-conta">+ Nova conta a ${receber ? 'receber' : 'pagar'}</button></div>`;
  }
  return `<h2>Contas</h2>${escopoSeg}
  <div class="mes"><button class="b" data-mes="-1" ${idx <= 0 ? 'disabled' : ''} aria-label="Mês anterior">‹</button>
    <div><b>${esc(rotuloMes(mes))}</b>${mes === F.mes_atual ? '<span class="m"> · mês atual</span>' : ''}</div>
    <button class="b" data-mes="1" ${idx >= meses.length - 1 ? 'disabled' : ''} aria-label="Próximo mês">›</button></div>
  <div class="kpis"><div class="card"><div class="m">A receber</div><div class="valor">${brl(soma(dm.a_receber, aberta))}</div><div class="m">Recebido ${brl(soma(dm.a_receber, feita))}</div></div>
    <div class="card"><div class="m">A pagar</div><div class="valor">${brl(soma(dm.a_pagar, aberta))}</div><div class="m">Pago ${brl(soma(dm.a_pagar, feita))}</div></div></div>
  <div class="seg">${subs.map(([k, n]) => `<button class="b ${contaAba === k ? 'p' : ''}" data-conta="${k}">${n}</button>`).join('')}</div>${corpo}`;
}

// Biometria do celular (Face ID/digital) ou PIN: a mesma proteção do Dudoo Web para o financeiro pessoal. Fica liberado só enquanto o app está na tela.
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const deB64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
const hashPin = async (t) => b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('dudoo-lite:' + t)));
function lerChave(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
function gravarChave(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sem armazenamento */ } }
async function biometriaDisponivel() {
  try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch (e) { return false; }
}
async function desbloquearBiometria() {
  if (!(await biometriaDisponivel())) return false;
  try {
    const desafio = crypto.getRandomValues(new Uint8Array(32)), cred = lerChave(CHAVE_CRED);
    if (!cred) {
      const nova = await navigator.credentials.create({ publicKey: {
        challenge: desafio, rp: { name: 'Dudoo Lite Web' }, user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'dudoo-lite', displayName: 'Dudoo Lite' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' }, timeout: 60000 } });
      gravarChave(CHAVE_CRED, { id: b64(nova.rawId) });
    } else {
      await navigator.credentials.get({ publicKey: { challenge: desafio, timeout: 60000, userVerification: 'required', allowCredentials: [{ type: 'public-key', id: deB64(cred.id) }] } });
    }
    return true;
  } catch (e) { return false; }
}
async function pedirPin() {
  const guardado = lerChave(CHAVE_PIN);
  const digitado = window.prompt(guardado ? 'PIN do financeiro pessoal' : 'Crie um PIN (4 a 6 números) para o financeiro pessoal');
  if (!digitado) return false;
  const h = await hashPin(digitado);
  if (!guardado) { if (!/^\d{4,6}$/.test(digitado)) { toast('Use de 4 a 6 números.'); return false; } gravarChave(CHAVE_PIN, h); return true; }
  return h === guardado;
}
async function liberarPessoal() {
  if ((await desbloquearBiometria()) || (await pedirPin())) { pessoalLiberado = true; desenhar(); } else toast('Não foi possível liberar o financeiro pessoal.');
}

function novaConta() {
  const receber = contaAba === 'receber', escopo = finEscopo, hoje = foto.hoje || new Date().toISOString().slice(0, 10);
  formulario(`Nova conta a ${receber ? 'receber' : 'pagar'} · ${escopo === 'pessoal' ? 'Pessoal' : (foto.negocio || 'Empresa')}`, [
    { id: 'descricao', rotulo: 'Descrição' }, { id: 'valor', rotulo: 'Valor (ex.: 1.500,00)', modo: 'decimal' },
    { id: 'vencimento', rotulo: 'Vencimento', tipo: 'date', padrao: hoje },
    { id: 'parcelas', rotulo: 'Repetir por quantos meses (1 = só uma vez)', tipo: 'number', modo: 'numeric', padrao: '1' },
  ], (v) => {
    const valor = parseFloat(String(v.valor).replace(/\./g, '').replace(',', '.'));
    if (!v.descricao || !(valor > 0) || !v.vencimento) { toast('Preencha descrição, valor e vencimento.'); return; }
    enviar(receber ? 'criar_conta_receber' : 'criar_conta_pagar', { descricao: v.descricao, valor: valor.toFixed(2), vencimento: v.vencimento, parcelas: Math.max(1, parseInt(v.parcelas, 10) || 1), escopo });
  });
}

async function baixar(botao, desfazer) {
  const id = botao.dataset[desfazer ? 'desfaz' : 'baixa'], receber = botao.dataset.receber === '1';
  baixasLocais[id] = { acao: desfazer ? 'desfaz' : 'baixa', quando: Date.now() };
  desenhar();
  const ok = await enviar((desfazer ? 'desfazer_baixa_' : 'baixa_') + (receber ? 'receber' : 'pagar'), { id, tipo: botao.dataset.tipo, escopo: botao.dataset.escopo });
  if (!ok) { delete baixasLocais[id]; desenhar(); }
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
  const ped = comandos.slice().reverse().slice(0, 8);
  return `<h2>Pedidos enviados ao computador</h2>${ped.length ? ped.map((c) => `<div class="card"><div class="linha"><div class="t">${esc(c.tipo.replace(/_/g, ' '))}</div><div class="m ${c.status === 'erro' ? 'vencido' : c.status === 'aplicado' ? 'ok' : ''}">${esc(c.status)}</div></div>${c.erro ? `<div class="m">${esc(c.erro)}</div>` : ''}</div>`).join('') : '<div class="vazio">Nenhum.</div>'}
  <h2>Conexão</h2><div class="card"><div class="m">Os dados vêm do Dudoo Lite do computador: ele envia ao abrir, a cada 5 minutos e ao fechar. Se estiver desligado, o celular mostra o último envio. Prontuário e documentos não passam por aqui.</div>
  <div class="acoes"><button class="b" id="desconectar">Desconectar este celular</button></div></div>`;
}


// -- cadastros: lista e ficha ------------------------------------------------------------------------------------------

const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const foneLink = (t) => { const n = String(t || '').replace(/\D/g, ''); return n ? (n.length <= 11 ? '55' + n : n) : ''; };
const dataLonga = (iso) => (iso && iso.length >= 10 ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '');

function telaCadastros() {
  const plural = (foto.termos && foto.termos.cliente) || 'Cadastros';
  if (cadAberto) { const c = (foto.clientes || []).find((x) => x.id === cadAberto); if (c) return fichaCliente(c); cadAberto = null; }
  const q = semAcento(buscaCad), digitos = q.replace(/\D/g, '');
  const lista = (foto.clientes || []).filter((c) => !q || semAcento(c.nome).includes(q) || (digitos && String(c.telefone || '').replace(/\D/g, '').includes(digitos)));
  return `<h2>${esc(plural)} (${lista.length})</h2><input id="busca-cad" placeholder="Buscar pelo nome ou telefone" value="${esc(buscaCad)}">
  ${lista.slice(0, 60).map((c) => `<div class="card" data-cad="${esc(c.id)}"><div class="linha"><div><div class="t">${esc(c.nome)}${c.status && c.status !== 'Ativo' ? `<span class="pill">${esc(c.status)}</span>` : ''}</div>
    <div class="m">${esc(c.telefone || 'sem telefone')}${c.ficha && c.ficha.atendimentos[0] ? ' · último atendimento ' + dataBr(c.ficha.atendimentos[0].data) : ''}</div></div><div class="m">›</div></div></div>`).join('') || '<div class="vazio">Ninguém encontrado.</div>'}
  ${lista.length > 60 ? `<div class="vazio">Mostrando 60 de ${lista.length}. Use a busca para achar os outros.</div>` : ''}`;
}

function consultaDetalhe(c, a) {
  const k = a.clinico, termos = foto.termos || {};
  const bloco = (titulo, corpo) => `<div class="card"><div class="m">${esc(titulo)}</div><div class="t" style="white-space:pre-wrap;font-weight:400">${corpo}</div></div>`;
  return `<div class="acoes"><button class="b" id="cons-voltar">‹ ${esc(c.nome)}</button></div>
  <h2>${esc(a.servico || termos.atendimento || 'Atendimento')}</h2><div class="m">${dataLonga(a.data)}${a.hora ? ' às ' + esc(a.hora) : ''}</div>
  ${k.obs ? bloco('Observações', esc(k.obs)) : ''}
  ${k.campos.map(([r, t]) => bloco(r, esc(t))).join('')}
  ${k.listas.map(([r, l]) => bloco(r, l.map((x) => '• ' + esc(x)).join('\n'))).join('')}
  ${k.medidas.length ? bloco('Medidas', k.medidas.map(([r, v]) => esc(r) + ': ' + esc(v)).join('\n')) : ''}
  <div class="m" style="margin-top:8px">Somente leitura. Texto resumido; o registro completo, as fotos e os documentos ficam no computador.</div>`;
}

function fichaCliente(c) {
  if (consAberta) { const a = c.ficha && c.ficha.atendimentos.find((x) => x.id === consAberta && x.clinico); if (a) return consultaDetalhe(c, a); consAberta = null; }
  const termos = foto.termos || {}, f = c.ficha, zap = foneLink(c.telefone), tel = String(c.telefone || '').replace(/\D/g, '');
  const linha = (r, v) => (v ? `<div class="linha"><div class="m">${r}</div><div class="t" style="text-align:right">${esc(v)}</div></div>` : '');
  const proximos = (foto.agenda || []).filter((e) => e.cliente_id === c.id && e.data >= foto.hoje);
  const atendimentos = f ? (f.atendimentos.length ? f.atendimentos.map((a) => `<div class="linha"${a.clinico ? ` data-cons="${esc(a.id)}" style="cursor:pointer"` : ''}><div><div class="t">${esc(a.servico || 'Atendimento')}</div><div class="m">${dataLonga(a.data)}${a.hora ? ' às ' + esc(a.hora) : ''}${a.clinico ? ' · ver registro' : ''}</div></div>${a.clinico ? '<div class="m">›</div>' : ''}</div>`).join('<hr>') : '<div class="vazio">Nenhum atendimento lançado.</div>')
    : '<div class="vazio">O histórico deste cadastro está no computador (o celular guarda o dos mais recentes).</div>';
  return `<div class="acoes"><button class="b" id="cad-voltar">‹ ${esc(termos.cliente || 'Cadastros')}</button></div>
  <h2>${esc(c.nome)}${c.status && c.status !== 'Ativo' ? `<span class="pill">${esc(c.status)}</span>` : ''}</h2>
  <div class="card">${linha('Telefone', c.telefone)}${linha('Telefone 2', c.telefone2)}${linha('E-mail', c.email)}${linha('Nascimento', dataLonga(c.nascimento))}${linha('Cidade', c.cidade)}${linha('Instagram', c.instagram)}${linha('Cliente desde', dataLonga(c.desde))}
    ${tel ? `<div class="acoes"><a class="b" href="tel:${tel}">Ligar</a><a class="b" href="https://wa.me/${zap}" target="_blank" rel="noopener">WhatsApp</a>${c.email ? `<a class="b" href="mailto:${esc(c.email)}">E-mail</a>` : ''}</div>` : ''}</div>
  ${proximos.length ? `<h2>Próximos agendamentos</h2>${proximos.map((e) => `<div class="card"><div class="linha"><div class="t">${esc(e.titulo)}</div><div class="m">${dataBr(e.data)} ${esc(e.hora)}</div></div></div>`).join('')}` : ''}
  ${f && f.pacotes.length ? `<h2>Pacotes</h2>${f.pacotes.map((p) => `<div class="card"><div class="linha"><div class="t">${esc(p.nome)}</div><div class="m">${p.usadas} de ${p.total} sessões${p.status === 'concluido' ? ' · concluído' : ''}</div></div></div>`).join('')}` : ''}
  <h2>${esc(termos.atendimento || 'Atendimentos')} recentes${f && f.total > f.atendimentos.length ? ` (${f.atendimentos.length} de ${f.total})` : ''}</h2><div class="card">${atendimentos}</div>
  <div class="m" style="margin-top:8px">${f && f.atendimentos.some((a) => a.clinico) ? 'Toque numa consulta para ver o que foi registrado. Anamnese, alergias, documentos e fotos ficam só no computador.' : 'Só dados de cadastro e histórico. O registro das consultas fica no computador (dá para liberar nas Configurações do Dudoo Lite).'}</div>`;
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
  palco.innerHTML = `<h2>${esc(titulo)}</h2>` + campos.map((c) => `<input id="f-${c.id}" placeholder="${esc(c.rotulo)}" aria-label="${esc(c.rotulo)}" ${c.tipo ? `type="${c.tipo}"` : ''} ${c.modo ? `inputmode="${c.modo}"` : ''} ${c.padrao ? `value="${esc(c.padrao)}"` : ''}>`).join('') +
    '<div class="acoes"><button class="b p" id="f-ok">Enviar</button><button class="b" id="f-cancelar">Cancelar</button></div>';
  $('#f-cancelar').onclick = desenhar;
  $('#f-ok').onclick = () => { const v = {}; campos.forEach((c) => { v[c.id] = $('#f-' + c.id).value.trim(); }); ao_enviar(v); desenhar(); };
}

function ligar() {
  document.querySelectorAll('[data-concluir]').forEach((b) => { b.onclick = () => enviar('concluir_tarefa', { id: b.dataset.concluir }); });
  document.querySelectorAll('[data-baixa]').forEach((b) => { b.onclick = () => baixar(b, false); });
  document.querySelectorAll('[data-desfaz]').forEach((b) => { b.onclick = () => baixar(b, true); });
  document.querySelectorAll('[data-itens]').forEach((b) => { b.onclick = () => { itensAbertos[b.dataset.itens] = !itensAbertos[b.dataset.itens]; desenhar(); }; });
  document.querySelectorAll('[data-escopo]').forEach((b) => { if (!b.dataset.baixa && !b.dataset.desfaz) b.onclick = () => { finEscopo = b.dataset.escopo; desenhar(); }; });
  document.querySelectorAll('[data-mes]').forEach((b) => { b.onclick = () => { const m = financeiroDaFoto().meses, i = m.indexOf(finMes) + Number(b.dataset.mes); if (m[i]) { finMes = m[i]; desenhar(); } }; });
  const lp = $('#liberar-pessoal'); if (lp) lp.onclick = liberarPessoal;
  document.querySelectorAll('[data-contato]').forEach((b) => { b.onclick = () => enviar('registrar_contato_lead', { id: b.dataset.contato }); });
  document.querySelectorAll('[data-followup]').forEach((b) => { b.onclick = () => enviar('concluir_followup_lead', { id: b.dataset.followup }); });
  document.querySelectorAll('[data-conta]').forEach((b) => { b.onclick = () => { contaAba = b.dataset.conta; desenhar(); }; });
  const nt = $('#nova-tarefa'); if (nt) nt.onclick = () => formulario('Nova tarefa', [{ id: 'titulo', rotulo: 'O que precisa ser feito' }, { id: 'prazo', rotulo: 'Prazo', tipo: 'date' }], (v) => v.titulo && enviar('criar_tarefa', v));
  const nc = $('#nova-conta'); if (nc) nc.onclick = novaConta;
  const bc = $('#busca-cad'); if (bc) bc.oninput = () => { buscaCad = bc.value; const pos = bc.selectionStart; desenhar(); const n = $('#busca-cad'); n.focus(); n.setSelectionRange(pos, pos); };
  document.querySelectorAll('[data-cad]').forEach((c) => { c.onclick = () => { cadAberto = c.dataset.cad; consAberta = null; desenhar(); window.scrollTo(0, 0); }; });
  const cv = $('#cad-voltar'); if (cv) cv.onclick = () => { cadAberto = null; consAberta = null; desenhar(); };
  document.querySelectorAll('[data-cons]').forEach((l) => { l.onclick = () => { consAberta = l.dataset.cons; desenhar(); window.scrollTo(0, 0); }; });
  const kv = $('#cons-voltar'); if (kv) kv.onclick = () => { consAberta = null; desenhar(); };
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
window.addEventListener('online', () => atualizar(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) pessoalLiberado = false; else atualizar(true); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});

(function iniciar() {
  const salvo = ler();
  if (salvo.conexao) { conexao = salvo.conexao; foto = salvo.foto || null; comandos = salvo.comandos || []; overlay = salvo.overlay || overlay; baixasLocais = salvo.baixasLocais || {}; }
  if (lerLinkDaUrl()) { foto = null; comandos = []; }
  desenhar();
  atualizar(true);
})();
