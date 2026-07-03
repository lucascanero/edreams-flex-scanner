// sidepanel.js — orquestrador da varredura.
// Vive aqui (e não no service worker) porque o painel permanece vivo enquanto
// aberto; o SW de MV3 é suspenso e mataria a fila. Consequência: o painel tem
// de ficar aberto durante a varredura.

'use strict';

// ---------------------------------------------------------------- i18n

const I18N = {
  en: {
    from: 'Origin', to: 'Destination', dep_from: 'Departure — from', dep_to: 'to',
    nights_min: 'Nights — min', nights_max: 'max', adults: 'Adults', children: 'Children',
    infants: 'Infants', advanced: 'Advanced', domain: 'Domain', url_template: 'URL template',
    url_tokens: 'tokens: {domain} {from} {to} {dep} {ret} {pax}', delay_min: 'Delay min (s)',
    delay_max: 'Delay max (s)', timeout: 'Timeout/search (s)', stabilization: 'Stabilization (s)',
    stabilization_hint: 'price fixed for N s before accepting', keep_tabs: 'keep tabs open',
    confirms: 'Price confirmations', confirms_hint: 'jump after N equal readings (lower = faster, riskier)',
    price_floor: 'Minimum plausible price (€)',
    price_floor_hint: 'ignores captures below — filters Prime/baggage/insurance',
    btn_start: 'Start scan', btn_pause: 'Pause', btn_stop: 'Cancel',
    debug: 'Capture debug', results: 'Results', all_nights: 'all nights', th_dep: 'out',
    th_ret: 'back', th_nts: 'nts', th_carrier: 'airline', history: 'History', clear: 'clear',
    status_idle: 'idle', status_scanning: 'scanning', status_paused: 'paused',
    status_blocked: 'anti-bot', status_done: 'done', status_cancelled: 'cancelled',
    btn_resume: 'Resume',
    combos: (n, min) => `${n} combinations · ~${min} min`,
    eta: (dur) => `~${dur} remaining`,
    results_meta: (n, best) => `${n} combos · best ${best}€`,
    no_prices: 'no prices captured', nights_opt: (n) => `${n} nights`,
    no_airport: 'no airport found', all_airports: 'all airports',
    fix: 'Fix: ', blocked_warn: 'Possible anti-bot block detected. Scan paused — open eDreams manually, solve the CAPTCHA and resume.',
    err_from: 'origin: 3-letter IATA code', err_to: 'destination: 3-letter IATA code',
    err_dates: 'incomplete date range', err_dates_order: 'start date > end date',
    err_nights: 'invalid nights range', err_delay: 'max delay < min delay'
  },
  pt: {
    from: 'Origem', to: 'Destino', dep_from: 'Partida — de', dep_to: 'até',
    nights_min: 'Noites — mín', nights_max: 'máx', adults: 'Adultos', children: 'Crianças',
    infants: 'Bebés', advanced: 'Avançado', domain: 'Domínio', url_template: 'Template de URL',
    url_tokens: 'tokens: {domain} {from} {to} {dep} {ret} {pax}', delay_min: 'Delay mín (s)',
    delay_max: 'Delay máx (s)', timeout: 'Timeout/pesquisa (s)', stabilization: 'Estabilização (s)',
    stabilization_hint: 'preço fixo por N s antes de aceitar', keep_tabs: 'manter tabs abertas',
    confirms: 'Confirmações de preço', confirms_hint: 'salta após N leituras iguais (menor = mais rápido, mais arriscado)',
    price_floor: 'Preço mínimo plausível (€)',
    price_floor_hint: 'ignora capturas abaixo — filtra Prime/bagagens/seguros',
    btn_start: 'Iniciar varredura', btn_pause: 'Pausar',
    btn_stop: 'Cancelar', debug: 'Debug de capturas', results: 'Resultados',
    all_nights: 'todas as noites', th_dep: 'ida', th_ret: 'volta', th_nts: 'nts',
    th_carrier: 'cia', history: 'Histórico', clear: 'limpar', status_idle: 'parado',
    status_scanning: 'a varrer', status_paused: 'pausado', status_blocked: 'anti-bot',
    status_done: 'concluído', status_cancelled: 'cancelado', btn_resume: 'Retomar',
    combos: (n, min) => `${n} combinações · ~${min} min`,
    eta: (dur) => `~${dur} restantes`,
    results_meta: (n, best) => `${n} combos · melhor ${best}€`,
    no_prices: 'sem preços capturados', nights_opt: (n) => `${n} noites`,
    no_airport: 'nenhum aeroporto encontrado', all_airports: 'todos os aeroportos',
    fix: 'Corrige: ', blocked_warn: 'Possível bloqueio anti-bot detetado. Varredura pausada — abre a eDreams manualmente, resolve o CAPTCHA e retoma.',
    err_from: 'origem: código IATA de 3 letras', err_to: 'destino: código IATA de 3 letras',
    err_dates: 'range de datas incompleto', err_dates_order: 'data inicial > data final',
    err_nights: 'range de noites inválido', err_delay: 'delay máx < delay mín'
  }
};

let LANG = 'en';
const t = (key, ...args) => {
  const v = I18N[LANG][key] ?? I18N.en[key] ?? key;
  return typeof v === 'function' ? v(...args) : v;
};

function applyLang(lang) {
  LANG = I18N[lang] ? lang : 'en';
  document.documentElement.lang = LANG;
  syncDomainForLang(LANG);
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    const str = I18N[LANG][key];
    if (str == null) return;
    // preservar spans-filho (ex: hints dentro de labels): só troca o 1º nó de texto
    const firstText = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    if (firstText && el.children.length) firstText.textContent = str + ' ';
    else el.textContent = str;
  });
  // re-render de partes dinâmicas
  updateComboCount();
  if (typeof renderResults === 'function' && S.results.length) renderResults();
  renderHistory();
}

function syncDomainForLang(lang) {
  const el = $('domain');
  if (!el) return;
  el.value = lang === 'pt' ? 'www.edreams.pt' : 'www.edreams.com';
}

// ---------------------------------------------------------------- constantes

// [SUPOSIÇÃO — CALIBRAR] Formato de URL de pesquisa round-trip da eDreams.
// Se a primeira pesquisa não abrir resultados, faz uma pesquisa manual no
// site, copia o URL e adapta o template no painel (secção Avançado).
// [SUPOSIÇÃO — CALIBRAR] Formato de URL de pesquisa round-trip da eDreams,
// incluindo passageiros. O segmento de passageiros ({pax}) usa o formato
// comum "Nadults_Nchildren_Ninfants" mas NÃO está confirmado para a eDreams —
// se as contagens de passageiros não passarem, ajusta o template manualmente.
const DEFAULT_TEMPLATE =
  'https://{domain}/travel/#results/type=R;dep={dep};from={from};to={to};ret={ret};passengers={pax};collectionmethod=false;airlinescodes=false;internalSearch=false';

// ---------------------------------------------------------------- estado

const S = {
  queue: [],        // [{from,to,dep,ret,nights,url}]
  idx: 0,
  running: false,
  paused: false,
  stopRequested: false,
  currentTabId: null,
  results: [],      // [{dep,ret,nights,price,carrier,segments,url,source}]
  captures: [],     // capturas da pesquisa corrente
  comboTimes: [],   // tempos reais por combo, para ETA (média móvel)
  sortKey: 'price',
  sortAsc: true
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- helpers

const fmtDate = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const rand = (min, max) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iataOf(id) {
  const el = $(id);
  // preferir o código escolhido no dropdown; senão, extrair 3 letras do texto
  const chosen = el.dataset.iata;
  if (chosen && /^[A-Z]{3}$/.test(chosen)) return chosen;
  const m = (el.value || '').toUpperCase().match(/\b([A-Z]{3})\b/);
  return m ? m[1] : (el.value || '').trim().toUpperCase();
}

function readSettings() {
  return {
    from: iataOf('from'),
    to: iataOf('to'),
    depStart: $('dep-start').value,
    depEnd: $('dep-end').value,
    nightsMin: parseInt($('nights-min').value, 10),
    nightsMax: parseInt($('nights-max').value, 10),
    domain: $('domain').value,
    template: $('url-template').value.trim() || DEFAULT_TEMPLATE,
    delayMin: Math.max(0, parseInt($('delay-min').value, 10) || 0),
    delayMax: Math.max(0, parseInt($('delay-max').value, 10) || 0),
    hardTimeout: (parseInt($('hard-timeout').value, 10) || 60) * 1000,
    stableMs: Math.max(0, (parseInt($('stable-secs').value, 10) || 0) * 1000),
    keepTabs: $('keep-tabs').checked,
    priceFloor: Math.max(0, parseInt($('price-floor').value, 10) || 0),
    adults: Math.max(1, parseInt($('pax-adults').value, 10) || 1),
    children: Math.max(0, parseInt($('pax-children').value, 10) || 0),
    infants: Math.max(0, parseInt($('pax-infants').value, 10) || 0)
  };
}

function validate(cfg) {
  const errs = [];
  if (!/^[A-Z]{3}$/.test(cfg.from)) errs.push(t('err_from'));
  if (!/^[A-Z]{3}$/.test(cfg.to)) errs.push(t('err_to'));
  if (!cfg.depStart || !cfg.depEnd) errs.push(t('err_dates'));
  else if (cfg.depStart > cfg.depEnd) errs.push(t('err_dates_order'));
  if (!(cfg.nightsMin >= 1) || !(cfg.nightsMax >= cfg.nightsMin)) errs.push(t('err_nights'));
  if (cfg.delayMax < cfg.delayMin) errs.push(t('err_delay'));
  return errs;
}

function buildQueue(cfg) {
  const q = [];
  let d = new Date(cfg.depStart + 'T00:00:00');
  const end = new Date(cfg.depEnd + 'T00:00:00');
  while (d <= end) {
    for (let n = cfg.nightsMin; n <= cfg.nightsMax; n++) {
      const dep = fmtDate(d);
      const ret = fmtDate(addDays(d, n));
      const pax = `${cfg.adults}_${cfg.children}_${cfg.infants}`;
      const url = cfg.template
        .replaceAll('{domain}', cfg.domain)
        .replaceAll('{from}', cfg.from)
        .replaceAll('{to}', cfg.to)
        .replaceAll('{dep}', dep)
        .replaceAll('{ret}', ret)
        .replaceAll('{pax}', pax);
      q.push({ from: cfg.from, to: cfg.to, dep, ret, nights: n, url });
    }
    d = addDays(d, 1);
  }
  return q;
}

// ---------------------------------------------------------------- UI

function setStatus(cls, statusKey) {
  const pill = $('status-pill');
  pill.className = `pill ${cls}`;
  pill.dataset.i18n = statusKey; // para re-traduzir ao trocar de idioma
  pill.textContent = t(statusKey);
}

function updateComboCount() {
  const cfg = readSettings();
  const errs = validate(cfg);
  const el = $('combo-count');
  if (errs.length) { el.textContent = ''; return; }
  const q = buildQueue(cfg);
  const est = Math.round((q.length * ((cfg.delayMin + cfg.delayMax) / 2 + 20)) / 60);
  el.textContent = t('combos', q.length, est);
}

function updateProgress() {
  $('progress-label').textContent = `${S.idx} / ${S.queue.length}`;
  const cur = S.queue[S.idx];
  $('progress-current').textContent = cur ? `${cur.dep} → ${cur.ret} (${cur.nights}n)` : '';
  $('bar-fill').style.width = S.queue.length ? `${(S.idx / S.queue.length) * 100}%` : '0%';

  // ETA a partir do tempo REAL medido, não de uma estimativa fixa. Corrige-se
  // sozinho: se as pesquisas estão lentas, o número sobe; se rápidas, desce.
  const times = S.comboTimes || [];
  const remaining = S.queue.length - S.idx;
  const etaEl = $('progress-eta');
  if (etaEl) {
    if (times.length >= 2 && remaining > 0) {
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      etaEl.textContent = t('eta', fmtDuration(avg * remaining));
    } else {
      etaEl.textContent = ''; // ainda sem amostras suficientes para estimar
    }
  }
}

function fmtDuration(ms) {
  if (ms < 60000) return '<1 min';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}min` : `${h}h`;
}

function warn(msg) {
  const el = $('warnings');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function renderHistory() {
  const { history = [] } = await chrome.storage.local.get('history');
  const card = $('history-card');
  const list = $('history-list');
  if (!history.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  list.innerHTML = '';
  history.forEach((h, i) => {
    const li = document.createElement('div');
    li.className = 'history-item';
    const loc = LANG === 'pt' ? 'pt-PT' : 'en-GB';
    const when = new Date(h.ts).toLocaleString(loc, { dateStyle: 'short', timeStyle: 'short' });
    li.innerHTML = `
      <div class="hi-main">
        <span class="hi-route">${h.route}</span>
        <span class="hi-best">${h.best != null ? h.best.toFixed(0) + '\u20ac' : '\u2014'}</span>
      </div>
      <div class="hi-meta">${h.span} \u00b7 ${h.nights}n \u00b7 ${h.pax}pax \u00b7 ${h.combos} combos \u00b7 ${when}</div>
      <div class="hi-actions">
        <button class="ghost small" data-hi-load="${i}">Reabrir</button>
        <button class="ghost small" data-hi-del="${i}">\u00d7</button>
      </div>`;
    list.appendChild(li);
  });
}

async function loadHistoryEntry(i) {
  const { history = [] } = await chrome.storage.local.get('history');
  const h = history[i];
  if (!h) return;
  const c = h.cfg;
  const map = {
    from: c.from, to: c.to, 'dep-start': c.depStart, 'dep-end': c.depEnd,
    'nights-min': c.nightsMin, 'nights-max': c.nightsMax,
    'pax-adults': c.adults, 'pax-children': c.children, 'pax-infants': c.infants,
    domain: c.domain, 'price-floor': c.priceFloor
  };
  for (const [id, v] of Object.entries(map)) {
    const el = $(id);
    if (el && v != null) el.value = v;
  }
  S.results = h.results || [];
  renderResults();
  updateComboCount();
  saveForm();
}

async function deleteHistoryEntry(i) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.splice(i, 1);
  await chrome.storage.local.set({ history });
  renderHistory();
}

function renderResults() {
  const body = $('results-body');
  body.innerHTML = '';
  const filter = $('filter-nights').value;
  let rows = S.results.filter((r) => r.price != null);
  if (filter) rows = rows.filter((r) => String(r.nights) === filter);

  rows.sort((a, b) => {
    const k = S.sortKey;
    const va = a[k], vb = b[k];
    const c = va < vb ? -1 : va > vb ? 1 : 0;
    return S.sortAsc ? c : -c;
  });

  const best = Math.min(...rows.map((r) => r.price));
  for (const r of rows) {
    const tr = document.createElement('tr');
    const stops = r.segments != null ? ` · ${r.segments} seg` : '';
    tr.innerHTML = `
      <td class="price ${r.price === best ? 'best' : ''}" title="fonte: ${r.source}">${r.price.toFixed(0)}</td>
      <td>${r.dep.slice(5)}</td>
      <td>${r.ret.slice(5)}</td>
      <td>${r.nights}</td>
      <td title="${(r.carrier || '') + stops + ' · fonte: ' + r.source}">${(r.carrier || '—').slice(0, 10)}</td>
      <td><a href="#" data-url="${encodeURIComponent(r.url)}" title="abrir pesquisa">↗</a></td>`;
    body.appendChild(tr);
  }

  $('results-meta').textContent = rows.length
    ? t('results_meta', rows.length, best.toFixed(0))
    : t('no_prices');
  $('results-card').classList.remove('hidden');

  // filtro de noites
  const sel = $('filter-nights');
  const nights = [...new Set(S.results.map((r) => r.nights))].sort((a, b) => a - b);
  const current = sel.value;
  sel.innerHTML = `<option value="">${t('all_nights')}</option>` +
    nights.map((n) => `<option value="${n}">${t('nights_opt', n)}</option>`).join('');
  sel.value = current;
}

// ---------------------------------------------------------------- capturas

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !S.running) return;
  if (sender.tab?.id !== S.currentTabId) return;

  if (msg.type === 'edfs:capture') {
    S.captures.push(msg);
    debugLog(msg);
  }
  if (msg.type === 'edfs:cheapest') {
    S.cheapestPush = msg;
    $('capture-info').textContent = `Cheapest: ${msg.price.toFixed(0)}€ (${msg.strategy})`;
  }
  if (msg.type === 'edfs:blocked') {
    S.blockedFlag = true;
  }
});

function debugLog(cap) {
  const combo = S.queue[S.idx];
  const lines = [`── ${combo ? combo.dep + '→' + combo.ret : '?'} @ ${cap.url.slice(0, 100)}`];
  if (cap.summaryPair) {
    lines.push(`   PAR tab: min=${cap.summaryPair.min} max=${cap.summaryPair.max}`);
  }
  lines.push(`   candidatos: ${(cap.candidates || []).map((c) => c.price.toFixed(0) + (c.carrier ? '/' + c.carrier : '')).join(', ')}`);
  for (const l of cap.listsDebug || []) {
    lines.push(`   lista score=${l.score} n=${l.size} min=${l.min.toFixed(0)} max=${l.max.toFixed(0)} var=${l.variance} carriers=${l.carrierRatio} keys=[${l.keys.join(',')}]`);
  }
  const el = $('debug-log');
  el.textContent = (lines.join('\n') + '\n' + el.textContent).slice(0, 12000);
}

function bestOfCaptures(floor) {
  // 1ª preferência: par [price,type] — é o par Prime/normal da tab "Mais
  // barato" vindo da rede; o mínimo É o valor da tab.
  let pairMin = null;
  for (const cap of S.captures) {
    const p = cap.summaryPair;
    if (p && p.min >= floor && (pairMin === null || p.min < pairMin)) pairMin = p.min;
  }
  if (pairMin !== null) return { price: pairMin, source: 'rede/par' };

  // 2ª: mínimo da lista de itinerários (preço sem desconto)
  let best = null;
  for (const cap of S.captures) {
    for (const c of cap.candidates) {
      if (c.price < floor) continue;
      if (!best || c.price < best.price) best = { ...c, source: 'rede' };
    }
  }
  return best;
}

async function readCheapestTab(tabId, floor) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'edfs:domScan' });
    if (resp?.blocked) S.blockedFlag = true;
    const valid = (resp?.prices || []).filter((p) => p >= floor);
    if (valid.length) return { price: valid[0], strategy: resp.strategy };
  } catch { /* tab ainda a carregar */ }
  return null;
}

// ---------------------------------------------------------------- motor

async function runCombo(combo, cfg) {
  S.captures = [];
  S.blockedFlag = false;
  S.cheapestPush = null;

  const tab = await chrome.tabs.create({ url: combo.url, active: false });
  S.currentTabId = tab.id;

  // MODELO PUSH: o content script monitoriza a página e empurra o valor da
  // secção Cheapest quando estável (estabilização vive lá, não aqui). O painel
  // só espera pela mensagem, até ao hard timeout.
  const t0 = Date.now();
  while (Date.now() - t0 < cfg.hardTimeout) {
    if (S.stopRequested || S.blockedFlag) break;
    if (S.cheapestPush && S.cheapestPush.price >= cfg.priceFloor) break;
    await sleep(300);
  }

  let best = null;
  if (S.cheapestPush && S.cheapestPush.price >= cfg.priceFloor) {
    best = { price: S.cheapestPush.price, source: `cheapest/${S.cheapestPush.strategy}` };
  } else if (!S.stopRequested) {
    // última tentativa: leitura on-demand direta
    const read = await readCheapestTab(tab.id, cfg.priceFloor);
    if (read) {
      best = { price: read.price, source: 'cheapest/ondemand' };
    } else {
      const net = bestOfCaptures(cfg.priceFloor);
      if (net) best = { price: net.price, source: net.source };
    }
  }

  // carrier vem sempre da rede (a tab Cheapest não o tem)
  const net = bestOfCaptures(cfg.priceFloor);

  S.results.push({
    dep: combo.dep, ret: combo.ret, nights: combo.nights,
    price: best?.price ?? null,
    carrier: net?.carrier ?? null,
    segments: net?.segments ?? null,
    source: best?.source ?? 'nada',
    url: combo.url
  });

  if (!cfg.keepTabs) {
    try { await chrome.tabs.remove(tab.id); } catch { /* já fechada */ }
  }
  S.currentTabId = null;

  if (S.blockedFlag) {
    S.paused = true;
    setStatus('blocked', 'status_blocked');
    warn(t('blocked_warn'));
  }
}

async function runQueue(cfg) {
  S.running = true;
  S.stopRequested = false;
  setStatus('running', 'status_scanning');
  $('progress').classList.remove('hidden');
  $('btn-start').disabled = true;

  S.comboTimes = [];
  while (S.idx < S.queue.length && !S.stopRequested) {
    if (S.paused) { await sleep(500); continue; }

    const iterStart = Date.now();
    updateProgress();
    await runCombo(S.queue[S.idx], cfg);
    S.idx++;

    let delayMs = 0;
    if (S.idx < S.queue.length && !S.stopRequested) {
      delayMs = rand(cfg.delayMin, cfg.delayMax) * 1000;
    }
    // registar o tempo real desta iteração (trabalho + delay) para o ETA
    S.comboTimes.push(Date.now() - iterStart + delayMs);
    if (S.comboTimes.length > 8) S.comboTimes.shift(); // média móvel curta

    updateProgress();
    renderResults();
    await persist(cfg);

    if (delayMs) await sleep(delayMs);
  }

  S.running = false;
  $('btn-start').disabled = false;
  setStatus('idle', S.stopRequested ? 'status_cancelled' : 'status_done');
  renderResults();

  // Arquivar no histórico apenas varreduras completas com resultados
  if (!S.stopRequested && S.queue.length > 1 && S.results.some((r) => r.price != null)) {
    await archiveToHistory(cfg);
  }
}

async function archiveToHistory(cfg) {
  const { history = [] } = await chrome.storage.local.get('history');
  const priced = S.results.filter((r) => r.price != null);
  const best = priced.length ? Math.min(...priced.map((r) => r.price)) : null;
  history.unshift({
    ts: Date.now(),
    route: `${cfg.from}→${cfg.to}`,
    span: `${cfg.depStart}…${cfg.depEnd}`,
    nights: `${cfg.nightsMin}-${cfg.nightsMax}`,
    pax: `${cfg.adults}+${cfg.children}+${cfg.infants}`,
    combos: S.results.length,
    best,
    cfg,
    results: S.results
  });
  // cap a 20 entradas para não estourar o storage
  await chrome.storage.local.set({ history: history.slice(0, 20) });
  renderHistory();
}

// ---------------------------------------------------------------- persistência

async function persist(cfg) {
  await chrome.storage.local.set({
    lastScan: { ts: Date.now(), cfg, results: S.results, idx: S.idx, total: S.queue.length }
  });
}

async function restore() {
  const { lastScan, savedForm, lang } = await chrome.storage.local.get(['lastScan', 'savedForm', 'lang']);
  const initialLang = lang || 'en';
  $('lang-select').value = initialLang;
  applyLang(initialLang);
  if (savedForm) {
    for (const [id, v] of Object.entries(savedForm)) {
      if (id.startsWith('__')) continue; // metadados, tratados abaixo
      const el = $(id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = v; else el.value = v;
    }
    if (savedForm.__iata_from) $('from').dataset.iata = savedForm.__iata_from;
    if (savedForm.__iata_to) $('to').dataset.iata = savedForm.__iata_to;
  }
  if (!$('url-template').value) $('url-template').value = DEFAULT_TEMPLATE;
  if (lastScan?.results?.length) {
    S.results = lastScan.results;
    renderResults();
    const loc = LANG === 'pt' ? 'pt-PT' : 'en-GB';
    $('results-meta').textContent += ` · ${new Date(lastScan.ts).toLocaleString(loc)}`;
  }
  syncDomainForLang(initialLang);
  updateComboCount();
  saveForm();
}

function saveForm() {
  const ids = ['from', 'to', 'dep-start', 'dep-end', 'nights-min', 'nights-max',
    'pax-adults', 'pax-children', 'pax-infants',
    'domain', 'url-template', 'delay-min', 'delay-max', 'hard-timeout', 'stable-secs', 'confirms', 'keep-tabs', 'price-floor'];
  const savedForm = {};
  for (const id of ids) {
    const el = $(id);
    savedForm[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  savedForm.__iata_from = $('from').dataset.iata || '';
  savedForm.__iata_to = $('to').dataset.iata || '';
  chrome.storage.local.set({ savedForm });
}

// ---------------------------------------------------------------- CSV

function exportCsv() {
  const rows = [['dep', 'ret', 'noites', 'preco', 'companhia', 'segmentos', 'fonte', 'url']];
  for (const r of S.results) {
    rows.push([r.dep, r.ret, r.nights, r.price ?? '', r.carrier ?? '', r.segments ?? '', r.source, r.url]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `edreams-scan-${fmtDate(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------- eventos

$('btn-start').addEventListener('click', async () => {
  const cfg = readSettings();
  const errs = validate(cfg);
  if (errs.length) { warn(t('fix') + errs.join(' · ')); return; }
  $('warnings').classList.add('hidden');
  saveForm();

  S.queue = buildQueue(cfg);
  S.idx = 0;
  S.results = [];
  S.paused = false;
  runQueue(cfg);
});

$('btn-pause').addEventListener('click', () => {
  S.paused = !S.paused;
  $('btn-pause').textContent = S.paused ? t('btn_resume') : t('btn_pause');
  setStatus(S.paused ? 'paused' : 'running', S.paused ? 'status_paused' : 'status_scanning');
});

$('btn-stop').addEventListener('click', () => {
  S.stopRequested = true;
  S.paused = false;
});

$('btn-csv').addEventListener('click', exportCsv);

$('results-body').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-url]');
  if (!a) return;
  e.preventDefault();
  chrome.tabs.create({ url: decodeURIComponent(a.dataset.url), active: true });
});

document.querySelectorAll('th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.k;
    if (S.sortKey === k) S.sortAsc = !S.sortAsc;
    else { S.sortKey = k; S.sortAsc = true; }
    renderResults();
  });
});

$('filter-nights').addEventListener('change', renderResults);

$('history-list').addEventListener('click', (e) => {
  const load = e.target.closest('[data-hi-load]');
  const del = e.target.closest('[data-hi-del]');
  if (load) loadHistoryEntry(parseInt(load.dataset.hiLoad, 10));
  if (del) deleteHistoryEntry(parseInt(del.dataset.hiDel, 10));
});

$('btn-clear-history').addEventListener('click', async () => {
  await chrome.storage.local.set({ history: [] });
  renderHistory();
});

['from', 'to', 'dep-start', 'dep-end', 'nights-min', 'nights-max', 'delay-min', 'delay-max',
  'pax-adults', 'pax-children', 'pax-infants']
  .forEach((id) => $(id).addEventListener('input', updateComboCount));

$('lang-select').addEventListener('change', (e) => {
  const lang = e.target.value;
  chrome.storage.local.set({ lang });
  applyLang(lang);
  saveForm();
});

// Versão a partir do manifest — fonte única de verdade, sem hardcode duplo.
try {
  const v = chrome.runtime.getManifest().version;
  if (v) $('app-version').textContent = `v${v}`;
} catch { /* fora do contexto de extensão */ }

// ---------------------------------------------------------------- airport combobox

function setupAirportCombo(inputId, listId) {
  const input = $(inputId);
  const list = $(listId);
  const AIRPORTS = window.EDFS_AIRPORTS || [];
  let activeIdx = -1;
  let current = [];

  const METROS = window.EDFS_METROS || {};

  // Constrói entradas metropolitanas ("all airports") que batem com a query.
  // Formato de retorno alinhado com aeroportos mas com flag metro:true.
  function metroMatches(q) {
    const out = [];
    for (const [code, m] of Object.entries(METROS)) {
      const city = m.city.toUpperCase();
      if (code === q || code.startsWith(q) || city.startsWith(q) || city.includes(q)) {
        out.push({ metro: true, code, city: m.city, country: m.country, airports: m.airports });
      }
    }
    return out;
  }

  function search(q) {
    q = q.trim().toUpperCase();
    if (!q) return [];
    const starts = [];
    const contains = [];
    for (const a of AIRPORTS) {
      const iata = a[0];
      const city = a[1].toUpperCase();
      const alias = (a[4] || '').toUpperCase();
      if (iata === q) { starts.unshift(a); continue; }
      if (iata.startsWith(q) || city.startsWith(q) || alias.startsWith(q)) starts.push(a);
      else if (city.includes(q) || alias.includes(q) || a[3].toUpperCase().includes(q)) contains.push(a);
      if (starts.length + contains.length >= 40) break;
    }
    // metros primeiro (a opção "todos os aeroportos" no topo, como o eDreams)
    return [...metroMatches(q), ...starts, ...contains].slice(0, 8);
  }

  function render(items) {
    current = items;
    activeIdx = -1;
    if (!items.length) {
      list.innerHTML = `<div class="combo-empty">${t('no_airport')}</div>`;
      list.classList.add('open');
      input.setAttribute('aria-expanded', 'true');
      return;
    }
    list.innerHTML = items.map((a, i) => {
      if (a.metro) {
        return `<div class="combo-opt metro" role="option" data-i="${i}" data-iata="${a.code}">
          <span class="iata">${a.code}</span>
          <span class="city">${a.city} <em>${t('all_airports')}</em></span>
          <span class="country">${a.airports.join(' ')}</span>
        </div>`;
      }
      return `<div class="combo-opt" role="option" data-i="${i}" data-iata="${a[0]}">
        <span class="iata">${a[0]}</span>
        <span class="city">${a[1]}</span>
        <span class="country">${a[2]}</span>
      </div>`;
    }).join('');
    list.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
  }

  function close() {
    list.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
    activeIdx = -1;
  }

  function choose(a) {
    if (a.metro) {
      input.value = `${a.code} · ${a.city} (${t('all_airports')})`;
      input.dataset.iata = a.code;
    } else {
      input.value = `${a[0]} · ${a[1]}`;
      input.dataset.iata = a[0];
    }
    close();
    updateComboCount();
    saveForm();
  }

  input.addEventListener('input', () => {
    input.dataset.iata = ''; // texto editado à mão invalida a escolha anterior
    const items = search(input.value);
    if (input.value.trim()) render(items); else close();
  });

  input.addEventListener('keydown', (e) => {
    if (!list.classList.contains('open')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, current.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); }
    else if (e.key === 'Enter') {
      if (activeIdx >= 0 && current[activeIdx]) { e.preventDefault(); choose(current[activeIdx]); }
      return;
    } else if (e.key === 'Escape') { close(); return; }
    else return;
    [...list.querySelectorAll('.combo-opt')].forEach((el, i) =>
      el.classList.toggle('active', i === activeIdx));
    const act = list.querySelector('.combo-opt.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  });

  list.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.combo-opt');
    if (!opt) return;
    e.preventDefault();
    choose(current[parseInt(opt.dataset.i, 10)]);
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
}

// ---------------------------------------------------------------- init

setupAirportCombo('from', 'from-list');
setupAirportCombo('to', 'to-list');

restore();
renderHistory();
