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
// Consultas registradas por aqui e ainda não confirmadas pelo computador (17/11/2026, Eduardo: "adicionei uma consulta mas não apareceu na lista"): ficam na lista
// do paciente como "aguardando o computador" até o Dudoo Lite aplicar. {lote, cmd (id do pedido; vazio se ainda está na fila sem internet), cliente_id, servico, data, quando}
const VERSAO_WEB = '21';   // igual ao número do CACHE em service-worker.js: aparece na aba Mais
const CHAVE_CONSULTAS = 'dudoo-lite-web-consultas';
let consultasLocais = (lerChave(CHAVE_CONSULTAS) || []).filter((c) => Date.now() - (c.quando || 0) < 7 * 86400000);
let ultimoPedido = '';   // id do último pedido aceito pelo servidor (vazio se ficou na fila sem internet)
// Cadastros: busca e ficha aberta.
let buscaCad = '', cadAberto = null, consAberta = null;
let procAberto = null, buscaProc = '', procSituacao = 'andamento';
let escolhendo = null, buscaEsc = '', novaReuniao = null;   // "Iniciar" na Home (17/11/2026): escolhendo = 'consulta' | 'reuniao' (pergunta o paciente/processo); novaReuniao = id do processo com o formulário aberto
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
    try {
      const r = await relay('POST', 'lite_comando', { tenant: conexao.t, tipo: fila[0].tipo, dados: fila[0].dados });
      const lote = fila[0].dados && fila[0].dados.lote, local = lote && consultasLocais.find((c) => c.lote === lote);
      if (local && r && r.id) { local.cmd = r.id; gravarChave(CHAVE_CONSULTAS, consultasLocais); }
    } catch (e) { return; }
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
  if (!novaCons && !novaReuniao) desenhar();   // com o formulário de consulta aberto não redesenha: voltar da câmera/galeria não pode apagar o que foi digitado
}

async function enviar(tipo, dados, msg) {
  ultimoPedido = '';
  try {
    const resposta = await relay('POST', 'lite_comando', { tenant: conexao.t, tipo, dados });
    ultimoPedido = (resposta && resposta.id) || '';
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
  lista.push(['contas', 'Financeiro']);
  if (m.includes('cadastros')) lista.push(['cadastros', ((foto.termos && foto.termos.cliente) || 'Cadastros')]);
  if (m.includes('processos') && foto.processos) lista.push(['processos', 'Processos']);
  if (m.includes('notas')) lista.push(['notas', 'Notas']);
  lista.push(['mais', 'Mais']);
  return lista;
}

function desenhar() {
  const palco = $('#palco');
  $('#aviso').hidden = !erroRede; $('#aviso').textContent = erroRede;
  if (!conexao) { $('#abas').innerHTML = ''; return telaConectar(palco); }
  if (!foto) { $('#sub-topo').textContent = 'Conectando…'; palco.innerHTML = '<p class="vazio">Buscando os dados do computador…</p>'; return; }
  if (foto.modo === 'atendente') return desenharAtendente();
  $('#sub-topo').textContent = (foto.negocio ? foto.negocio + ' · ' : '') + 'atualizado ' + quando(foto.atualizado_em);
  const abas = abasDisponiveis(); if (!abas.some((a) => a[0] === aba)) aba = 'hoje';
  $('#abas').innerHTML = abas.map(([k, r]) => `<button data-aba="${k}" class="${k === aba || (k === 'mais' && aba === 'leads') ? 'on' : ''}">${r}</button>`).join('');
  palco.innerHTML = ({ hoje: telaHoje, agenda: telaAgenda, contas: telaContas, cadastros: telaCadastros, processos: telaProcessos, leads: telaLeads, notas: telaNotas, mais: telaMais })[aba]();
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

// Reunião no celular: com processo (advocacia) ou, nos negócios sem processos (festas...), com o cliente (vira nota "Reunião").
function reuniaoDeProcesso() { return !!foto.reuniao_celular; }
function temReuniao() { return reuniaoDeProcesso() ? (foto.processos || []).length > 0 : !!foto.reuniao_cliente_celular && (foto.clientes || []).length > 0; }

function botoesIniciar() {
  const termos = foto.termos || {}, rotulo = String(termos.atendimento_um || 'consulta').toLowerCase();
  return `${foto.consulta_celular && (foto.clientes || []).length ? `<button class="b p" id="iniciar-consulta">+ Iniciar ${esc(rotulo)}</button>` : ''}${temReuniao() ? '<button class="b p" id="iniciar-reuniao">+ Iniciar reunião</button>' : ''}`;
}

// Pergunta a quem vincular: o paciente (consulta) ou o processo (reunião); escolhido, abre o formulário.
function telaEscolher() {
  const reuniao = escolhendo === 'reuniao' && reuniaoDeProcesso(), q = semAcento(buscaEsc), digitos = q.replace(/\D/g, '');
  const termos = foto.termos || {}, cliente = termos.cliente_um || 'Cadastro', reuniaoCliente = escolhendo === 'reuniao' && !reuniao;
  const lista = reuniao
    ? (foto.processos || []).filter((p) => !p.encerrado && (!q || semAcento([p.apelido, p.numero, p.cliente, p.tribunal].join(' ')).includes(q)))
    : (foto.clientes || []).filter((c) => !q || semAcento(c.nome).includes(q) || (digitos && String(c.telefone || '').replace(/\D/g, '').includes(digitos)));
  const linhas = reuniao
    ? lista.slice(0, 60).map((p) => `<div class="card" data-esc="${esc(p.id)}"><div class="linha"><div><div class="t">${esc(p.apelido)}</div><div class="m">${esc(p.cliente)}${p.numero ? ' · ' + esc(p.numero) : ''}</div></div><div class="m">›</div></div></div>`)
    : lista.slice(0, 60).map((c) => `<div class="card" data-esc="${esc(c.id)}"><div class="linha"><div><div class="t">${esc(c.nome)}</div><div class="m">${esc(c.telefone || 'sem telefone')}</div></div><div class="m">›</div></div></div>`);
  return `<div class="acoes"><button class="b" id="esc-voltar">‹ Voltar</button></div>
  <h2>${reuniao ? 'Reunião de qual processo?' : reuniaoCliente ? 'Reunião com qual ' + esc(cliente.toLowerCase()) + '?' : esc(termos.atendimento_um || 'Consulta') + ' de qual ' + esc(cliente.toLowerCase()) + '?'}</h2>
  <input id="busca-esc" placeholder="${reuniao ? 'Buscar por número, parte ou tribunal' : 'Buscar pelo nome ou telefone'}" value="${esc(buscaEsc)}">
  ${linhas.join('') || `<div class="vazio">${reuniao ? 'Nenhum processo em andamento encontrado.' : 'Ninguém encontrado.'}</div>`}
  ${lista.length > 60 ? `<div class="vazio">Mostrando 60 de ${lista.length}. Use a busca para achar os outros.</div>` : ''}`;
}

function formReuniao(p) {
  const porProcesso = reuniaoDeProcesso();
  return `<div class="acoes"><button class="b" id="reu-voltar">‹ ${esc(porProcesso ? p.apelido : p.nome)}</button></div>
  <h2>Nova reunião</h2>
  <div class="m">${esc(porProcesso ? [p.cliente, p.numero].filter(Boolean).join(' · ') : (p.telefone || ''))}</div>
  <div class="m">${porProcesso ? 'Fica registrada no processo, no computador, quando o Dudoo Lite abrir. A pauta e o cronômetro ao vivo ficam no computador.' : 'Fica salva como nota da categoria Reunião, ligada ao cadastro, no computador e no celular quando o Dudoo Lite abrir.'}</div>
  <input id="reu-titulo" placeholder="Título da reunião (ex.: Alinhamento com o cliente)" aria-label="Título da reunião">
  <textarea id="reu-anot" rows="8" placeholder="Anotações da reunião" aria-label="Anotações da reunião"></textarea>
  <div class="acoes"><button class="b p" id="reu-salvar">Salvar reunião</button><button class="b" id="reu-cancelar">Cancelar</button></div>`;
}

function telaHoje() {
  if (novaReuniao) { const p = (reuniaoDeProcesso() ? (foto.processos || []) : (foto.clientes || [])).find((x) => x.id === novaReuniao); if (p) return formReuniao(p); novaReuniao = null; }
  if (escolhendo) return telaEscolher();
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
  const iniciar = botoesIniciar();
  return `${iniciar ? `<div class="acoes">${iniciar}</div>` : ''}<h2>Precisa de você</h2>${precisa.length ? precisa.map((p) => `<div class="card">${esc(p)}</div>`).join('') : '<div class="vazio">Nada urgente.</div>'}
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
  return `<div class="card"><div class="t">Financeiro protegido</div><div class="m">Libere com Face ID / digital do celular (ou um PIN) para ver os valores.</div>
    <div class="acoes"><button class="b p" id="liberar-pessoal">Liberar</button></div></div>`;
}

function telaContas() {
  const F = financeiroDaFoto(), temPessoal = !!F.pessoal;
  if (finEscopo === 'pessoal' && !temPessoal) finEscopo = 'empresa';
  const meses = F.meses, mes = meses.includes(finMes) ? finMes : (meses.includes(F.mes_atual) ? F.mes_atual : meses[0]);
  finMes = mes;
  const escopoSeg = temPessoal ? `<div class="seg"><button class="b ${finEscopo === 'empresa' ? 'p' : ''}" data-escopo="empresa">${esc(foto.negocio || 'Empresa')}</button><button class="b ${finEscopo === 'pessoal' ? 'p' : ''}" data-escopo="pessoal">Pessoal</button></div>` : '';
  if (!pessoalLiberado) return `<h2>Financeiro</h2>${bloqueioPessoal()}`;      // 23/11/2026: o Financeiro todo (empresa e pessoal) pede Face ID/digital ou PIN, como no Dudoo Arq
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
  return `<h2>Financeiro</h2>${escopoSeg}
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
  const digitado = window.prompt(guardado ? 'PIN do financeiro' : 'Crie um PIN (4 a 6 números) para o financeiro');
  if (!digitado) return false;
  const h = await hashPin(digitado);
  if (!guardado) { if (!/^\d{4,6}$/.test(digitado)) { toast('Use de 4 a 6 números.'); return false; } gravarChave(CHAVE_PIN, h); return true; }
  return h === guardado;
}
async function liberarPessoal() {
  if ((await desbloquearBiometria()) || (await pedirPin())) { pessoalLiberado = true; desenhar(); } else toast('Não foi possível liberar o financeiro.');
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
  const voltar = '<div class="acoes"><button class="b" data-aba="mais">‹ Mais</button></div>';
  const bloco = (t, l, extra) => `<h2>${t} (${l.length})</h2>${l.length ? l.map((x) => cartaoLead(x, extra)).join('') : '<div class="vazio">Nenhum.</div>'}`;
  return voltar + bloco('Follow-up hoje', L.followups_hoje, false) + bloco('Novos sem contato', L.novos_sem_contato, true) + bloco('Parados', L.sem_movimentacao, true);
}

// "O que você fez por aqui" (23/11/2026, Eduardo: a lista com o nome técnico do pedido ninguém entende): cada pedido em palavras simples, com o paciente quando se sabe,
// e o estado dito por extenso — já está no computador, esperando o computador abrir, ou não foi aplicado (e por quê).
const NOME_PEDIDO = {
  registrar_consulta: 'Consulta', editar_consulta: 'Edição de consulta', enviar_foto_cliente: 'Foto de paciente', registrar_reuniao: 'Reunião',
  criar_tarefa: 'Nova tarefa', concluir_tarefa: 'Tarefa concluída', criar_nota: 'Nova nota', editar_nota: 'Nota editada', excluir_nota: 'Nota excluída',
  baixa_receber: 'Recebimento marcado', baixa_pagar: 'Pagamento marcado', desfazer_baixa_receber: 'Recebimento desfeito', desfazer_baixa_pagar: 'Pagamento desfeito',
  criar_conta_receber: 'Nova conta a receber', criar_conta_pagar: 'Nova conta a pagar', registrar_contato_lead: 'Contato com lead', concluir_followup_lead: 'Follow-up concluído',
  lancar_atendimento: 'Atendimento lançado', marcar_atendido: 'Atendimento marcado como feito',
};
const ESTADO_PEDIDO = { aplicado: ['Já está no computador', 'ok'], pendente: ['Esperando o computador abrir', ''], erro: ['O computador não aplicou', 'vencido'] };
function blocoPedidos(ped) {
  const titulo = '<h2>O que você fez por aqui</h2><div class="m">Tudo o que foi enviado pelo celular. Entra no computador quando o Dudoo Lite está aberto.</div>';
  if (!ped.length) return titulo + '<div class="vazio">Nada enviado ainda.</div>';
  const linhas = ped.map((c) => {
    const local = consultasLocais.find((x) => x.cmd === c.id), cli = local && (foto.clientes || []).find((x) => x.id === local.cliente_id);
    const detalhe = local ? [cli && cli.nome, local.servico].filter(Boolean).join(' · ') : '';
    const [texto, cor] = ESTADO_PEDIDO[c.status] || [String(c.status || ''), ''];
    return `<div class="card"><div class="linha"><div><div class="t">${esc(NOME_PEDIDO[c.tipo] || String(c.tipo || '').replace(/_/g, ' '))}</div>${detalhe ? `<div class="m">${esc(detalhe)}</div>` : ''}</div><div class="m ${cor}" style="text-align:right">${texto}</div></div>${c.erro ? `<div class="m vencido">${esc(c.erro)}</div>` : ''}</div>`;
  }).join('');
  return titulo + linhas;
}

function telaMais() {
  const ped = comandos.slice().reverse().slice(0, 8);
  const L = foto.leads, fu = L ? L.followups_hoje.length : 0, novos = L ? L.novos_sem_contato.length : 0;
  const leads = ((foto.modulos || []).includes('comercial')) ? `<div class="card" data-aba="leads"><div class="linha"><div><div class="t">Leads</div><div class="m">${fu} follow-up(s) hoje · ${novos} novo(s) sem contato</div></div><div class="m">›</div></div></div>` : '';
  return `${leads}${blocoPedidos(ped)}
  <h2>Conexão</h2><div class="card"><div class="m">Os dados vêm do Dudoo Lite do computador: ele envia ao abrir, a cada 5 minutos e ao fechar. Se estiver desligado, o celular mostra o último envio. Prontuário e documentos não passam por aqui.</div>
  <div class="m" style="margin-top:8px">App do celular: versão ${VERSAO_WEB} · Dudoo Lite do computador: v${esc(foto.versao_app || '—')}</div>
  <div class="acoes"><button class="b" id="desconectar">Desconectar este celular</button></div></div>`;
}


// -- processos: lista e linha do tempo (advocacia) ---------------------------------------------------------------------

const COR_ETIQUETA = { vermelho: 'var(--erro)', amarelo: 'var(--alerta)', verde: 'var(--ok)', azul: '#4F7391', cinza: 'var(--suave)' };
const bolinha = (e) => `<span class="bola" style="background:${COR_ETIQUETA[e] || 'var(--suave)'}"></span>`;
const diasTxt = (n) => (n === 1 ? '1 dia' : n + ' dias');

function linhaDoTempo(p) {
  const passos = (p.fases || []).map((f) => {
    const estado = f.atual ? (p.encerrado ? 'fim' : 'atual') : 'feito';
    const datas = f.atual ? `desde ${dataLonga(f.entrada)}` : `${dataLonga(f.entrada)} → ${dataLonga(f.saida)}`;
    const quem = f.segurando && f.segurando !== '—' ? ` · com ${esc(f.segurando)}` : '';
    return `<li class="${estado}"><span class="no"></span><div class="t">${esc(f.rotulo)}</div><div class="m">${datas} · ${diasTxt(f.dias)}${quem}</div></li>`;
  });
  if (!p.encerrado) passos.push('<li class="falta"><span class="no"></span><div class="t">Encerrado</div><div class="m">ainda não</div></li>');
  return `<ol class="tl">${passos.join('')}</ol>`;
}

function fichaProcesso(p) {
  const alertas = (p.alertas || []).map((a) => `<div class="m ${a.nivel === 'vencido' || a.nivel === 'hoje' ? 'vencido' : ''}">${esc(a.texto)}</div>`).join('');
  const prazos = (p.prazos || []).map((x) => `<div class="linha"><div class="t">${esc(x.titulo || 'Prazo')}</div><div class="m">${dataLonga(x.prazo)}</div></div>`).join('');
  const auds = (p.audiencias || []).map((x) => `<div class="linha"><div class="t">${esc(x.tipo || 'Audiência')}</div><div class="m">${dataLonga(x.data)}${x.hora ? ' às ' + esc(x.hora) : ''}</div></div>`).join('');
  return `<div class="acoes"><button class="b" id="proc-voltar">‹ Processos</button></div>
  <h2>${bolinha(p.etiqueta)} ${esc(p.apelido)}</h2>
  <div class="m">${esc([p.numero, p.tipo, p.tribunal, p.comarca].filter(Boolean).join(' · '))}</div>
  <div class="m">${esc([p.cliente, p.parte_contraria ? 'contra ' + p.parte_contraria : ''].filter(Boolean).join(' · '))}</div>
  <div class="card" style="margin-top:10px"><div class="t">${esc(p.etapa)}${p.encerrado && p.resultado ? ' · ' + esc(p.resultado) : ''}</div>
    <div class="m">${p.encerrado ? 'Durou ' + diasTxt(p.dias_total) : 'Com ' + esc(p.segurando) + ' há ' + diasTxt(p.dias_na_etapa) + ' · ' + diasTxt(p.dias_total) + ' no total'}</div>${alertas}</div>
  <h2>Acompanhamento</h2>${linhaDoTempo(p)}
  ${prazos ? `<h2>Prazos em aberto</h2><div class="card">${prazos}</div>` : ''}
  ${auds ? `<h2>Audiências</h2><div class="card">${auds}</div>` : ''}
  <div class="m" style="margin-top:8px">Somente leitura. Documentos, peças e o restante ficam no computador.</div>`;
}

function telaProcessos() {
  if (procAberto) { const p = (foto.processos || []).find((x) => x.id === procAberto); if (p) return fichaProcesso(p); procAberto = null; }
  const q = semAcento(buscaProc);
  const lista = (foto.processos || []).filter((p) => (procSituacao === 'todos' || (procSituacao === 'encerrados') === p.encerrado)
    && (!q || semAcento([p.apelido, p.numero, p.cliente, p.tribunal, p.parte_contraria].join(' ')).includes(q)));
  const aba = (k, r) => `<button class="b ${procSituacao === k ? 'on' : ''}" data-procsit="${k}">${r}</button>`;
  return `<h2>Processos (${lista.length})</h2><input id="busca-proc" placeholder="Buscar por número, parte ou tribunal" value="${esc(buscaProc)}">
  <div class="acoes">${aba('andamento', 'Em andamento')}${aba('encerrados', 'Encerrados')}${aba('todos', 'Todos')}</div>
  <div class="m legenda">${bolinha('vermelho')} prazo vencido ou hoje ${bolinha('amarelo')} com o escritório ${bolinha('verde')} aguardando ${bolinha('cinza')} encerrado</div>
  ${lista.map((p) => `<div class="card" data-proc="${esc(p.id)}"><div class="linha"><div><div class="t">${bolinha(p.etiqueta)} ${esc(p.apelido)}</div>
    <div class="m">${esc(p.cliente)}${p.numero ? ' · ' + esc(p.numero) : ''}</div><div class="m">${esc(p.etapa)}${p.encerrado ? '' : ' · com ' + esc(p.segurando) + ' há ' + diasTxt(p.dias_na_etapa)}</div></div><div class="m">›</div></div></div>`).join('') || '<div class="vazio">Nenhum processo.</div>'}`;
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
  <div class="m" style="margin-top:8px">${typeof k.obs_bruta === 'string' && foto.consulta_celular ? '' : 'Somente leitura. '}Texto resumido; o registro completo, as fotos e os documentos ficam no computador.</div>
  ${typeof k.obs_bruta === 'string' && foto.consulta_celular ? (editandoCons
    ? `<textarea id="cons-obs-edit" rows="7" aria-label="Observações da consulta">${esc(k.obs_bruta)}</textarea><div class="acoes"><button class="b p" id="cons-obs-salvar">Salvar</button><button class="b" id="cons-obs-cancelar">Cancelar</button></div>`
    : '<div class="acoes"><button class="b" id="cons-obs-editar">Editar observações</button></div>') : ''}`;
}

let aguardAberta = null, editandoCons = false;   // consulta aguardando o computador aberta / edição das observações de uma consulta
let novaCons = null;   // id do cadastro com a consulta nova aberta (formulário), só saúde
let consFotos = [];    // fotos anexadas à consulta em andamento (arquivos escolhidos; reduzidas só no envio)
const MAX_FOTOS_CONSULTA = 8;

const NOME_AVULSO = 'Atendimento avulso';

// Consulta no celular, enxuta (17/11/2026): procedimento (ou atendimento avulso, sem serviço), data, UM campo para o que foi falado e fotos.
// Os campos clínicos completos, as medidas e os indicadores ficam no computador.
function formConsulta(c) {
  const K = foto.consulta_celular || { campos: [], medidas: [], servicos: [] }, hoje = foto.hoje;
  return `<div class="acoes"><button class="b" id="cons-nova-voltar">‹ ${esc(c.nome)}</button></div>
  <h2>Nova consulta</h2>
  <div class="m">Fica salva no celular e no computador quando o Dudoo Lite abrir.</div>
  <label class="m" for="cn-servico">Motivo / procedimento</label>
  <select id="cn-servico" aria-label="Motivo da consulta"><option value="">${NOME_AVULSO} (sem serviço)</option>${K.servicos.map((v) => `<option value="${esc(v.id)}">${esc(v.nome)}</option>`).join('')}</select>
  <label class="m" for="cn-data">Data</label>
  <input id="cn-data" type="date" value="${esc(hoje)}" aria-label="Data">
  <textarea id="cn-obs" rows="7" placeholder="O que foi falado na sessão" aria-label="O que foi falado na sessão"></textarea>
  <div class="acoes"><button class="b" id="cn-fotos-btn">Anexar fotos</button><input type="file" id="cn-fotos-arq" accept="image/*" multiple hidden></div>
  <div class="m" id="cn-fotos-info">${consFotos.length ? consFotos.length + ' foto(s) anexada(s)' : 'Nenhuma foto anexada.'} As fotos enviadas pelo celular chegam com qualidade reduzida; para manter a original, coloque direto no Dudoo Lite do computador.</div>
  <div class="acoes"><button class="b p" id="cn-salvar">Salvar consulta</button><button class="b" id="cn-cancelar">Cancelar</button></div>`;
}

// As consultas deste paciente que o celular mandou e o computador ainda não aplicou (ou recusou). Aplicada: some daqui, porque já está na lista do computador.
function consultasAguardando(clienteId) {
  const saida = [], antes = consultasLocais.length;
  consultasLocais = consultasLocais.filter((x) => {
    if (!x.cmd) return true;                                   // ainda na fila do celular (sem internet)
    const c = comandos.find((k) => k.id === x.cmd);
    const cli = (foto.clientes || []).find((k) => k.id === x.cliente_id), jaNaLista = !!(cli && cli.ficha && cli.ficha.total > (x.antes || 0));   // a consulta já está na lista que veio do computador
    if (c && c.status === 'erro') return true;                    // o computador recusou: continua aparecendo, com o motivo
    if (jaNaLista) return false;
    return Date.now() - (x.quando || 0) < 7 * 86400000;           // aplicada ou não, fica visível até aparecer na lista do computador
  });
  if (consultasLocais.length !== antes) gravarChave(CHAVE_CONSULTAS, consultasLocais);
  consultasLocais.filter((x) => x.cliente_id === clienteId).forEach((x) => {
    const c = x.cmd ? comandos.find((k) => k.id === x.cmd) : null;
    saida.push({ ...x, erro: c && c.status === 'erro' ? (c.erro || 'erro') : '' });
  });
  return saida.reverse();
}

function fichaCliente(c) {
  if (novaCons === c.id && foto.consulta_celular) return formConsulta(c);
  novaCons = null;
  if (aguardAberta) {          // consulta já feita no celular, ainda esperando o computador: dá pra abrir e ler o que foi escrito
    const x = consultasLocais.find((k) => k.lote === aguardAberta);
    if (x) return `<div class="acoes"><button class="b" id="aguard-voltar">‹ ${esc(c.nome)}</button></div>
  <h2>${esc(x.servico || 'Consulta')}</h2><div class="m">${dataLonga(x.data)} · aguardando o computador</div>
  <div class="card"><div class="m">Observações</div><div class="t" style="white-space:pre-wrap;font-weight:400">${esc(x.obs || '(só fotos)')}</div></div>
  <div class="m" style="margin-top:8px">Quando o Dudoo Lite abrir no computador ela entra na lista de consultas e aí dá para editar por aqui.</div>`;
    aguardAberta = null;
  }
  if (consAberta) { const a = c.ficha && c.ficha.atendimentos.find((x) => x.id === consAberta && x.clinico); if (a) return consultaDetalhe(c, a); consAberta = null; }
  const termos = foto.termos || {}, f = c.ficha, zap = foneLink(c.telefone), tel = String(c.telefone || '').replace(/\D/g, '');
  const linha = (r, v) => (v ? `<div class="linha"><div class="m">${r}</div><div class="t" style="text-align:right">${esc(v)}</div></div>` : '');
  const proximos = (foto.agenda || []).filter((e) => e.cliente_id === c.id && e.data >= foto.hoje);
  const aguardando = consultasAguardando(c.id).map((x) => `<div class="linha" data-aguard="${esc(x.lote)}" style="cursor:pointer"><div><div class="t">${esc(x.servico || 'Consulta')}</div><div class="m ${x.erro ? 'vencido' : ''}">${dataLonga(x.data)} · ${x.erro ? 'o computador não aplicou: ' + esc(x.erro) : 'aguardando o computador'}</div></div></div>`).join('<hr>');
  const atendimentos = f ? (aguardando ? aguardando + (f.atendimentos.length ? '<hr>' : '') : '') + (f.atendimentos.length ? f.atendimentos.map((a) => `<div class="linha"${a.clinico ? ` data-cons="${esc(a.id)}" style="cursor:pointer"` : ''}><div><div class="t">${esc(a.servico || 'Atendimento')}</div><div class="m">${dataLonga(a.data)}${a.hora ? ' às ' + esc(a.hora) : ''}${a.clinico ? ' · ver registro' : ''}</div></div>${a.clinico ? '<div class="m">›</div>' : ''}</div>`).join('<hr>') : (aguardando ? '' : '<div class="vazio">Nenhum atendimento lançado.</div>'))
    : '<div class="vazio">O histórico deste cadastro está no computador (o celular guarda o dos mais recentes).</div>';
  return `<div class="acoes"><button class="b" id="cad-voltar">‹ ${esc(termos.cliente || 'Cadastros')}</button></div>
  <h2>${esc(c.nome)}${c.status && c.status !== 'Ativo' ? `<span class="pill">${esc(c.status)}</span>` : ''}</h2>
  <div class="card">${linha('Telefone', c.telefone)}${linha('Telefone 2', c.telefone2)}${linha('E-mail', c.email)}${linha('Nascimento', dataLonga(c.nascimento))}${linha('Cidade', c.cidade)}${linha('Instagram', c.instagram)}${linha('Cliente desde', dataLonga(c.desde))}
    ${tel ? `<div class="acoes"><a class="b" href="tel:${tel}">Ligar</a><a class="b" href="https://wa.me/${zap}" target="_blank" rel="noopener">WhatsApp</a>${c.email ? `<a class="b" href="mailto:${esc(c.email)}">E-mail</a>` : ''}</div>` : ''}</div>
  ${(foto.fotos_celular || foto.consulta_celular) ? `<div class="acoes">${foto.consulta_celular ? '<button class="b p" id="cad-consulta">Nova consulta</button>' : ''}${foto.fotos_celular ? '<button class="b" id="cad-foto">Adicionar foto</button><input type="file" id="cad-foto-arq" accept="image/*" hidden>' : ''}</div>${foto.fotos_celular ? '<div class="m">Aviso: as fotos enviadas pelo celular chegam com qualidade reduzida. Para manter a qualidade original (antes e depois, por exemplo), coloque a foto direto no Dudoo Lite do computador.</div>' : ''}` : ''}
  ${proximos.length ? `<h2>Próximos agendamentos</h2>${proximos.map((e) => `<div class="card"><div class="linha"><div class="t">${esc(e.titulo)}</div><div class="m">${dataBr(e.data)} ${esc(e.hora)}</div></div></div>`).join('')}` : ''}
  ${f && f.pacotes.length ? `<h2>Pacotes</h2>${f.pacotes.map((p) => `<div class="card"><div class="linha"><div class="t">${esc(p.nome)}</div><div class="m">${p.usadas} de ${p.total} sessões${p.status === 'concluido' ? ' · concluído' : ''}</div></div></div>`).join('')}` : ''}
  <h2>${esc(termos.atendimento || 'Atendimentos')} recentes${f && f.total > f.atendimentos.length ? ` (${f.atendimentos.length} de ${f.total})` : ''}</h2><div class="card">${atendimentos}</div>
  <div class="m" style="margin-top:8px">${f && f.atendimentos.some((a) => a.clinico) ? 'Toque em um item da lista para ver o que foi registrado. Anamnese, alergias e documentos ficam só no computador.' : 'Só dados de cadastro e histórico. O registro dos atendimentos fica no computador (dá para liberar nas Configurações do Dudoo Lite).'}</div>`;
}

// -- notas -----------------------------------------------------------------

// -- fotos do celular para a ficha ---------------------------------------------------------------------------------------

const LIMITE_FOTO_B64 = 380000;   // o servidor aceita ~500 KB por item: a foto é reduzida até caber

function reduzirFoto(arquivo) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(arquivo), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let lado = 1600, q = 0.8;
      for (let i = 0; i < 8; i++) {
        const f = Math.min(1, lado / Math.max(img.width, img.height)), cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.width * f)); cv.height = Math.max(1, Math.round(img.height * f));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        const b64 = cv.toDataURL('image/jpeg', q).split(',')[1] || '';
        if (b64.length <= LIMITE_FOTO_B64) return resolve(b64);
        if (q > 0.55) q -= 0.1; else lado = Math.round(lado * 0.8);
      }
      reject(new Error('Não consegui reduzir essa foto.'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não consegui abrir essa foto.')); };
    img.src = url;
  });
}

async function enviarFotoCliente(clienteId, arquivo, lote, silencioso) {
  if (!arquivo) return false;
  if (!silencioso) toast('Preparando a foto…');
  try {
    const imagem = await reduzirFoto(arquivo);
    await relay('POST', 'lite_comando', { tenant: conexao.t, tipo: 'enviar_foto_cliente', dados: { cliente_id: clienteId, imagem, data: foto.hoje, lote: lote || '' } });
    if (!silencioso) { toast('Foto enviada com qualidade reduzida. Entra na ficha quando o Dudoo Lite abrir no computador.'); await atualizar(true); }
    return true;
  } catch (e) {
    toast(e.message === 'Failed to fetch' ? 'Sem internet: a foto não foi enviada. Tente de novo.' : e.message);
    return false;
  }
}

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

// -- modo atendente (link individual): só a agenda e o lançamento do atendimento/cobrança ----------------------------------

const CHAVE_LANCADOS = 'dudoo-lite-web-lancados';
let lancados = lerChave(CHAVE_LANCADOS) || {};     // horários já lançados por aqui e ainda não confirmados pelo computador
let lanc = null, avBusca = '', avCliente = '', avServico = '';
const numero = (t) => parseFloat(String(t || '').replace(/\./g, '').replace(',', '.')) || 0;

function desenharAtendente() {
  const palco = $('#palco'), termos = foto.termos || {};
  $('#sub-topo').textContent = ((foto.colaborador && foto.colaborador.nome) || '') + (foto.negocio ? ' · ' + foto.negocio : '') + ' · atualizado ' + quando(foto.atualizado_em);
  Object.keys(lancados).forEach((id) => { const e = (foto.agenda || []).find((x) => x.id === id); if (!e || e.status === 'Concluído' || Date.now() - lancados[id] > 86400000) delete lancados[id]; });
  const perm = foto.permissoes || { ver_agenda: true, editar_agendamentos: true, ver_financeiro: false };
  const abas = [];
  if (perm.ver_agenda) abas.push(['agenda', 'Agenda']);
  if (perm.editar_agendamentos) abas.push(['lancar', 'Lançar']);
  if (perm.ver_financeiro && foto.meu_mes) abas.push(['minhas', 'Meu mês']);
  abas.push(['mais', 'Mais']);
  if (!abas.some((a) => a[0] === aba)) aba = 'agenda';
  $('#abas').innerHTML = abas.map(([k, r]) => `<button data-aba="${k}" class="${k === aba ? 'on' : ''}">${r}</button>`).join('');
  if (!perm.editar_agendamentos) lanc = null;
  palco.innerHTML = lanc ? formLancamento() : ({ agenda: telaAgendaAtendente, lancar: telaLancarAvulso, minhas: telaMeuMes, mais: telaMaisAtendente })[aba]();
  ligarAtendente();
}

function telaMeuMes() {
  const f = foto.meu_mes || {};
  return `<h2>Meu mês · ${esc(f.mes || '')}</h2>
  <div class="card"><div class="linha"><div class="m">Comissão</div><div class="valor">${brl(f.comissao || 0)}</div></div></div>
  <div class="card"><div class="linha"><div class="m">Total atendido</div><div class="valor">${brl(f.valor || 0)}</div></div>
  <div class="m">${f.atendimentos || 0} lançado(s) neste mês</div></div>`;
}

function cardAtendente(e) {
  const feito = e.status === 'Concluído', enviado = !!lancados[e.id];
  const podeEditar = !foto.permissoes || foto.permissoes.editar_agendamentos;
  const acao = !podeEditar ? '' : feito ? '<div class="m ok">✓ Lançado</div>' : enviado ? '<div class="m ok">✓ Enviado ao computador</div>' : `<button class="b p" data-lancar="${esc(e.id)}">Lançar</button>`;
  return `<div class="card ${feito || enviado ? 'fechada' : ''}"><div class="linha"><div><div class="t">${esc(e.hora)} · ${esc(e.titulo)}</div>
    <div class="m">${esc(e.cliente)}${e.valor ? ' · ' + brl(e.valor) : ''}</div></div>${acao}</div></div>`;
}

function telaAgendaAtendente() {
  const por = {}; (foto.agenda || []).forEach((e) => { (por[e.data] = por[e.data] || []).push(e); });
  const dias = Object.keys(por).sort();
  if (!dias.length) return `<div class="vazio">Nada marcado para os próximos dias.</div><div class="acoes"><button class="b p" data-aba="lancar">Lançar sem horário</button></div>`;
  return dias.map((d) => { const dt = new Date(d + 'T12:00:00');
    return `<div class="dia ${d === foto.hoje ? 'hoje' : ''}">${DIAS[dt.getDay()]} ${dataBr(d)}${d === foto.hoje ? ' · hoje' : ''}</div>` + por[d].map(cardAtendente).join(''); }).join('');
}

function telaLancarAvulso() {
  const termos = foto.termos || {}, q = semAcento(avBusca);
  const lista = (foto.clientes || []).filter((c) => !q || semAcento(c.nome).includes(q)).slice(0, 8);
  const cli = (foto.clientes || []).find((c) => c.id === avCliente);
  return `<h2>Lançar sem horário</h2>
  <div class="m">Para quem chegou sem marcar. Escolha ${esc((termos.cliente_um || 'o cadastro').toLowerCase())} e o serviço.</div>
  ${cli ? `<div class="card"><div class="linha"><div class="t">${esc(cli.nome)}</div><button class="b" id="av-trocar">Trocar</button></div></div>`
      : `<input id="av-busca" placeholder="Buscar pelo nome" value="${esc(avBusca)}">${lista.map((c) => `<div class="card" data-avcli="${esc(c.id)}"><div class="t">${esc(c.nome)}</div></div>`).join('') || '<div class="vazio">Ninguém encontrado.</div>'}`}
  ${cli ? `<select id="av-servico"><option value="">Escolha o serviço</option>${(foto.servicos || []).map((sv) => `<option value="${esc(sv.id)}" ${sv.id === avServico ? 'selected' : ''}>${esc(sv.nome)}${sv.preco ? ' · ' + brl(sv.preco) : ''}</option>`).join('')}</select>
    <div class="acoes"><button class="b p" id="av-seguir">Continuar</button></div>` : ''}`;
}

function telaMaisAtendente() {
  const ped = comandos.slice().reverse().slice(0, 8);
  return `${blocoPedidos(ped)}
  <h2>Conexão</h2><div class="card"><div class="m">Este acesso mostra só o que foi liberado para você (agenda, lançamento e o seu mês). O computador aplica o que você enviar quando o Dudoo Lite estiver aberto; se estiver fechado, o pedido espera na fila.</div>
  <div class="acoes"><button class="b" id="desconectar">Desconectar este celular</button></div></div>`;
}

function formLancamento() {
  const P = foto.pagamento || { formas: ['PIX'], parceladas: [], padrao_recebido: false }, L = lanc;
  return `<div class="acoes"><button class="b" id="l-voltar">‹ Voltar</button></div>
  <h2>${esc(L.titulo)}</h2><div class="m">${esc(L.cliente)}${L.hora ? ' · ' + esc(L.hora) : ''}</div>
  ${L.preco > 0 ? `<div class="card"><div class="linha"><div class="m">Valor</div><div class="valor">${brl(L.preco)}</div></div></div>` : '<input id="l-valor" inputmode="decimal" placeholder="Valor (R$)" aria-label="Valor">'}
  <div class="m">Desconto (opcional)</div>
  <div class="filtros"><input id="l-desc" inputmode="decimal" placeholder="0" aria-label="Desconto"><select id="l-dtipo" aria-label="Tipo do desconto"><option value="valor">em R$</option><option value="percentual">em %</option></select></div>
  <select id="l-forma" aria-label="Forma de pagamento">${P.formas.map((f) => `<option>${esc(f)}</option>`).join('')}</select>
  <input id="l-parc" type="number" inputmode="numeric" min="1" max="12" value="1" aria-label="Parcelas" placeholder="Parcelas" hidden>
  <div class="seg"><button class="b ${L.rec ? 'p' : ''}" data-rec="1">Já recebido</button><button class="b ${L.rec ? '' : 'p'}" data-rec="0">A receber</button></div>
  <div class="card"><div class="linha"><div class="m">Total</div><div class="valor" id="l-total"></div></div></div>
  <div class="acoes"><button class="b p" id="l-ok">Lançar</button>${L.agId ? '<button class="b" id="l-atendido">Só marcar como atendido</button>' : ''}</div>`;
}

function totalLanc() {
  const bruto = lanc.preco > 0 ? lanc.preco : numero(($('#l-valor') || {}).value), d = numero($('#l-desc').value);
  const tot = $('#l-dtipo').value === 'percentual' ? bruto - bruto * d / 100 : bruto - d;
  $('#l-total').textContent = brl(Math.max(0, tot));
  return { bruto, d, valido: d >= 0 && (($('#l-dtipo').value === 'percentual') ? d <= 100 : d <= bruto) };
}

function abrirLancamento(dados) { lanc = Object.assign({ rec: !!(foto.pagamento && foto.pagamento.padrao_recebido) }, dados); desenhar(); window.scrollTo(0, 0); }

async function enviarLancamento(soAtendido) {
  const t = totalLanc();
  if (!soAtendido && !t.valido) { toast('O desconto não pode ser maior que o valor.'); return; }
  if (!soAtendido && !(t.bruto > 0)) { toast('Informe o valor.'); return; }
  const L = lanc, dados = soAtendido ? { agendamento_id: L.agId } : {
    agendamento_id: L.agId || '', cliente_id: L.clienteId || '', servico_id: L.servicoId || '', valor: L.preco > 0 ? '' : String(t.bruto),
    desconto: String(t.d || 0), desconto_tipo: $('#l-dtipo').value, forma_pagamento: $('#l-forma').value,
    parcelas: Math.max(1, parseInt($('#l-parc').value, 10) || 1), recebido: !!L.rec,
  };
  $('#l-ok').disabled = true;
  const ok = await enviar(soAtendido ? 'marcar_atendido' : 'lancar_atendimento', dados, 'Enviado. Aparece como lançado quando o computador aplicar.');
  if (!ok) { desenhar(); return; }
  if (L.agId) { lancados[L.agId] = Date.now(); gravarChave(CHAVE_LANCADOS, lancados); } else { avCliente = ''; avServico = ''; avBusca = ''; }
  lanc = null; desenhar();
}

function ligarAtendente() {
  document.querySelectorAll('[data-lancar]').forEach((b) => { b.onclick = () => {
    const e = (foto.agenda || []).find((x) => x.id === b.dataset.lancar); if (!e) return;
    abrirLancamento({ agId: e.id, titulo: e.titulo, cliente: e.cliente, hora: e.hora, preco: e.valor || 0 });
  }; });
  const bb = $('#av-busca'); if (bb) bb.oninput = () => { avBusca = bb.value; const pos = bb.selectionStart; desenhar(); const n = $('#av-busca'); n.focus(); n.setSelectionRange(pos, pos); };
  document.querySelectorAll('[data-avcli]').forEach((c) => { c.onclick = () => { avCliente = c.dataset.avcli; desenhar(); }; });
  const at = $('#av-trocar'); if (at) at.onclick = () => { avCliente = ''; avServico = ''; desenhar(); };
  const sv = $('#av-servico'); if (sv) sv.onchange = () => { avServico = sv.value; };
  const sg = $('#av-seguir'); if (sg) sg.onclick = () => {
    const servico = (foto.servicos || []).find((x) => x.id === ($('#av-servico').value)), cli = (foto.clientes || []).find((c) => c.id === avCliente);
    if (!servico || !cli) { toast('Escolha o serviço.'); return; }
    abrirLancamento({ clienteId: cli.id, cliente: cli.nome, servicoId: servico.id, titulo: servico.nome, preco: servico.preco || 0 });
  };
  const dc = $('#desconectar'); if (dc) dc.onclick = () => { guardar({}); conexao = foto = null; lanc = null; desenhar(); };
  if (!lanc || !$('#l-ok')) return;
  const P = foto.pagamento || { parceladas: [] }, forma = $('#l-forma'), parc = $('#l-parc');
  const mostrarParcelas = () => { parc.hidden = !P.parceladas.includes(forma.value); };
  forma.onchange = mostrarParcelas; mostrarParcelas();
  ['#l-desc', '#l-dtipo', '#l-valor'].forEach((id) => { const e = $(id); if (e) { e.oninput = totalLanc; e.onchange = totalLanc; } });
  document.querySelectorAll('[data-rec]').forEach((b) => { b.onclick = () => { lanc.rec = b.dataset.rec === '1'; document.querySelectorAll('[data-rec]').forEach((x) => x.classList.toggle('p', x === b)); }; });
  $('#l-voltar').onclick = () => { lanc = null; desenhar(); };
  $('#l-ok').onclick = () => enviarLancamento(false);
  const la = $('#l-atendido'); if (la) la.onclick = () => enviarLancamento(true);
  totalLanc();
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
  const bp = $('#busca-proc'); if (bp) bp.oninput = () => { buscaProc = bp.value; const pos = bp.selectionStart; desenhar(); const n = $('#busca-proc'); n.focus(); n.setSelectionRange(pos, pos); };
  document.querySelectorAll('[data-procsit]').forEach((b) => { b.onclick = () => { procSituacao = b.dataset.procsit; desenhar(); }; });
  document.querySelectorAll('[data-proc]').forEach((c) => { c.onclick = () => { procAberto = c.dataset.proc; desenhar(); window.scrollTo(0, 0); }; });
  const pv = $('#proc-voltar'); if (pv) pv.onclick = () => { procAberto = null; desenhar(); };
  const cv = $('#cad-voltar'); if (cv) cv.onclick = () => { cadAberto = null; consAberta = null; desenhar(); };
  const bf = $('#cad-foto'), af = $('#cad-foto-arq');
  if (bf && af) { bf.onclick = () => af.click(); af.onchange = () => { const a = af.files && af.files[0]; af.value = ''; enviarFotoCliente(cadAberto, a); }; }
  const ic = $('#iniciar-consulta'); if (ic) ic.onclick = () => { escolhendo = 'consulta'; buscaEsc = ''; desenhar(); window.scrollTo(0, 0); };
  const ir = $('#iniciar-reuniao'); if (ir) ir.onclick = () => { escolhendo = 'reuniao'; buscaEsc = ''; desenhar(); window.scrollTo(0, 0); };
  const be = $('#busca-esc'); if (be) be.oninput = () => { buscaEsc = be.value; const pos = be.selectionStart; desenhar(); const n = $('#busca-esc'); n.focus(); n.setSelectionRange(pos, pos); };
  const ev = $('#esc-voltar'); if (ev) ev.onclick = () => { escolhendo = null; buscaEsc = ''; desenhar(); };
  document.querySelectorAll('[data-esc]').forEach((c) => { c.onclick = () => {
    const id = c.dataset.esc, tipo = escolhendo; escolhendo = null; buscaEsc = '';
    if (tipo === 'reuniao') { novaReuniao = id; desenhar(); } else { aba = 'cadastros'; cadAberto = id; consAberta = null; novaCons = id; desenhar(); }   // consulta: abre o formulário já no paciente escolhido
    window.scrollTo(0, 0);
  }; });
  const rv = $('#reu-voltar'), rc = $('#reu-cancelar'); if (rv) rv.onclick = () => { novaReuniao = null; desenhar(); }; if (rc) rc.onclick = () => { novaReuniao = null; desenhar(); };
  const rs = $('#reu-salvar'); if (rs) rs.onclick = async () => {
    const anot = $('#reu-anot').value.trim();
    if (!anot) { toast('Escreva as anotações da reunião.'); return; }
    rs.disabled = true;
    const porProcesso = reuniaoDeProcesso(), titulo = $('#reu-titulo').value.trim();
    const ok = await enviar('registrar_reuniao', porProcesso ? { processo_id: novaReuniao, titulo, anotacoes: anot } : { cliente_id: novaReuniao, titulo, anotacoes: anot },
      porProcesso ? 'Reunião guardada. Entra no processo quando o Dudoo Lite abrir.' : 'Reunião guardada. Entra nas notas quando o Dudoo Lite abrir.');
    if (ok) novaReuniao = null; else rs.disabled = false;
    desenhar();
  };
  const bco = $('#cad-consulta'); if (bco) bco.onclick = () => { novaCons = cadAberto; desenhar(); window.scrollTo(0, 0); };
  const cnv = $('#cons-nova-voltar'); if (cnv) cnv.onclick = () => { novaCons = null; consFotos = []; desenhar(); };
  const cnc = $('#cn-cancelar'); if (cnc) cnc.onclick = () => { novaCons = null; consFotos = []; desenhar(); };
  const cfb = $('#cn-fotos-btn'), cfa = $('#cn-fotos-arq');
  if (cfb && cfa) {
    cfb.onclick = () => cfa.click();
    cfa.onchange = () => {
      consFotos = consFotos.concat(Array.from(cfa.files || [])).slice(0, MAX_FOTOS_CONSULTA); cfa.value = '';
      $('#cn-fotos-info').textContent = consFotos.length + ' foto(s) anexada(s) (máximo ' + MAX_FOTOS_CONSULTA + '). As fotos enviadas pelo celular chegam com qualidade reduzida; para manter a original, coloque direto no Dudoo Lite do computador.';
    };
  }
  const cns = $('#cn-salvar'); if (cns) cns.onclick = async () => {
    const obs = $('#cn-obs').value.trim();
    if (!obs && !consFotos.length) { toast('Escreva o que foi falado ou anexe uma foto.'); return; }
    cns.disabled = true;
    const lote = Math.random().toString(16).slice(2, 12) + Date.now().toString(16), clienteId = cadAberto, anexos = consFotos.slice();
    const sel = $('#cn-servico'), servicoId = sel ? sel.value : '', nomeServico = servicoId && sel.options && sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : NOME_AVULSO, dataConsulta = $('#cn-data').value || foto.hoje;
    const ok = await enviar('registrar_consulta', { cliente_id: clienteId, servico_id: servicoId, data: dataConsulta, observacoes: obs, lote },
      'Consulta guardada. Entra no computador quando o Dudoo Lite abrir.');
    if (ok) {
      const fi = (foto.clientes || []).find((x) => x.id === clienteId);
      consultasLocais.push({ lote, cmd: ultimoPedido, cliente_id: clienteId, servico: nomeServico, data: dataConsulta, obs, antes: (fi && fi.ficha ? fi.ficha.total : 0), quando: Date.now() });
      gravarChave(CHAVE_CONSULTAS, consultasLocais);
      novaCons = null; consFotos = [];
      if (anexos.length) {
        toast('Enviando ' + anexos.length + ' foto(s) da consulta…');
        let enviadas = 0;
        for (const a of anexos) { if (await enviarFotoCliente(clienteId, a, lote, true)) enviadas++; else break; }
        toast(enviadas === anexos.length ? 'Consulta e fotos enviadas (fotos com qualidade reduzida).' : 'Consulta enviada, mas só ' + enviadas + ' de ' + anexos.length + ' foto(s) foram. Envie o resto pela ficha.');
        await atualizar(true);
      }
    }
    desenhar();
  };
  document.querySelectorAll('[data-cons]').forEach((l) => { l.onclick = () => { consAberta = l.dataset.cons; desenhar(); window.scrollTo(0, 0); }; });
  document.querySelectorAll('[data-aguard]').forEach((l) => { l.onclick = () => { aguardAberta = l.dataset.aguard; desenhar(); window.scrollTo(0, 0); }; });
  const av = $('#aguard-voltar'); if (av) av.onclick = () => { aguardAberta = null; desenhar(); };
  const kv = $('#cons-voltar'); if (kv) kv.onclick = () => { consAberta = null; editandoCons = false; desenhar(); };
  const coe = $('#cons-obs-editar'); if (coe) coe.onclick = () => { editandoCons = true; desenhar(); };
  const coc = $('#cons-obs-cancelar'); if (coc) coc.onclick = () => { editandoCons = false; desenhar(); };
  const cos = $('#cons-obs-salvar'); if (cos) cos.onclick = async () => {
    const texto = $('#cons-obs-edit').value.trim(), cli = (foto.clientes || []).find((x) => x.id === cadAberto);
    const at = cli && cli.ficha && cli.ficha.atendimentos.find((x) => x.id === consAberta);
    if (!at || !at.clinico) return;
    cos.disabled = true;
    const base = at.clinico.obs_bruta, antes = { obs: at.clinico.obs, bruta: at.clinico.obs_bruta };
    at.clinico.obs = texto; at.clinico.obs_bruta = texto; guardar({ conexao, foto, comandos, overlay });     // já aparece editada; a foto nova do computador confirma
    editandoCons = false;
    if (!(await enviar('editar_consulta', { id: consAberta, observacoes: texto, base }, 'Edição guardada. Entra no computador quando o Dudoo Lite abrir.'))) { at.clinico.obs = antes.obs; at.clinico.obs_bruta = antes.bruta; guardar({ conexao, foto, comandos, overlay }); }
    desenhar();
  };
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

// Tocar numa aba (também na que já está aberta) volta para a tela inicial dela (17/11/2026, Eduardo): fecha a ficha, a consulta, o processo, a nota
// e a escolha do "Iniciar" que estavam abertas por dentro.
function irParaAba(k) {
  aba = k; lanc = null; escolhendo = null; novaReuniao = null;
  cadAberto = null; consAberta = null; novaCons = null; consFotos = []; procAberto = null; notaAberta = null; rascunho = null;
  desenhar(); window.scrollTo(0, 0);
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-aba]'); if (b) irParaAba(b.dataset.aba); });
$('#btn-atualizar').onclick = () => atualizar(false);
window.addEventListener('online', () => atualizar(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) pessoalLiberado = false; else atualizar(true); });
if ('serviceWorker' in navigator) {
  const tinhaControle = !!navigator.serviceWorker.controller;      // só recarrega quando é ATUALIZAÇÃO (não na primeira instalação)
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (tinhaControle) location.reload(); });
  navigator.serviceWorker.register('service-worker.js').then((r) => r.update()).catch(() => {});
}

(function iniciar() {
  const salvo = ler();
  if (salvo.conexao) { conexao = salvo.conexao; foto = salvo.foto || null; comandos = salvo.comandos || []; overlay = salvo.overlay || overlay; baixasLocais = salvo.baixasLocais || {}; }
  if (lerLinkDaUrl()) { foto = null; comandos = []; }
  desenhar();
  atualizar(true);
})();
