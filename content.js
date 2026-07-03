// content.js — ISOLATED world. Reescrito do zero.
// Missão única: encontrar o valor da secção "Cheapest" e empurrá-lo para o
// painel quando estiver estável. Três estratégias em cascata para robustez.

(() => {
  'use strict';
  const MARK = 'EDFS_PAYLOAD_V1';

  function safeSend(msg) {
    try {
      if (chrome.runtime?.id) chrome.runtime.sendMessage(msg).catch(() => {});
    } catch { /* painel fechado ou extensão recarregada */ }
  }

  // ---- ponte MAIN → panel (interceção de rede, para carrier) ----
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.mark !== MARK) return;
    safeSend({ type: 'edfs:capture', url: d.url, ts: d.ts, candidates: d.candidates, listsDebug: d.listsDebug, summaryPair: d.summaryPair });
  });

  // ---- parsing ----
  // Aceita "€ 817", "817 €" e "817€" (formato das tabs: "24hs 15' - 817 €")
  function parseEuro(text) {
    const s = String(text);
    const m = s.match(/€\s*([\d.\s]+(?:,\d{1,2})?)/) || s.match(/([\d][\d.\s]*(?:,\d{1,2})?)\s*€/);
    if (!m) return null;
    const n = parseFloat(m[1].trim().replace(/[.\s]/g, '').replace(',', '.'));
    return isFinite(n) && n >= 30 && n < 20000 ? n : null;
  }

  const CHEAPEST_RX = /^(cheapest|mais barato|más barato|le moins cher|am günstigsten)$/i;

  // Estratégia A: label textual → container → subtítulo com €.
  // Itera TODAS as labels (a página tem 2+: a tab de ordenação E o chip verde
  // no card); a primeira que tiver subtítulo com preço ganha.
  function readByLabel() {
    const labels = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (el.childElementCount === 0 && CHEAPEST_RX.test((el.textContent || '').trim())) {
        labels.push(el);
      }
    }
    for (const label of labels) {
      let c = label.closest('[class*="container" i]') || label.parentElement;
      for (let i = 0; i < 5 && c; i++) {
        const sub = c.querySelector('[class*="subtitle" i]');
        if (sub) {
          const p = parseEuro(sub.textContent);
          if (p !== null) return { price: p, strategy: 'label' };
        }
        c = c.parentElement;
      }
    }
    return null;
  }

  // Estratégia B: padrão "duração - preço" das tabs de ordenação
  // (ex: "24hs 15' - 817 €"). As 3 tabs (Melhor/Mais barato/Mais rápido) têm
  // este formato; o MÍNIMO delas é o valor da tab Mais barato.
  // NUNCA usar mínimo global da página: a faixa de datas flexíveis mostra
  // preços de OUTRAS datas (foi isso que produziu o 746 fantasma).
  const TAB_PATTERN = /\d+\s*h/i;
  function readByTabPattern() {
    let min = null;
    const els = document.querySelectorAll('div, span');
    for (const el of els) {
      if (el.childElementCount > 0) continue;
      const t = (el.textContent || '').trim();
      if (t.length > 30 || !t.includes('€') || !t.includes('-') || !TAB_PATTERN.test(t)) continue;
      const p = parseEuro(t);
      if (p !== null && (min === null || p < min)) min = p;
    }
    return min !== null ? { price: min, strategy: 'tab-pattern' } : null;
  }

  function readCheapest() {
    return readByLabel() || readByTabPattern();
    // Sem mínimo global como último recurso — se nada bater, o painel cai
    // para o par [price,type] da rede, que é o mesmo valor.
  }

  // ---- deteção de bloqueio ----
  function looksBlocked() {
    const t = (document.title + ' ' + (document.body?.innerText || '').slice(0, 2000)).toLowerCase();
    return /captcha|unusual activity|atividade invulgar|access denied|robot|are you a human|pardon our interruption/.test(t);
  }

  // ---- push loop: monitorizar até estabilizar, depois empurrar ----
  let stableMs = 0;
  try {
    chrome.storage.local.get('savedForm').then((r) => {
      const s = parseInt(r?.savedForm?.['stable-secs'], 10);
      if (s >= 0) stableMs = s * 1000;
    }).catch(() => {});
  } catch { /* sem storage */ }

  let lastVal = null;
  let lastChangeAt = 0;
  let sent = false;

  // Estabilização por CONFIRMAÇÕES consecutivas, não por timer fixo.
  // Antes: esperar o preço ficar inalterado `stableMs` (default 5s).
  // Agora: aceitar assim que o mesmo preço aparece em N leituras seguidas.
  // Com poll a 300ms, N=3 confirma em ~0.6-0.9s — protege contra o valor
  // otimista inicial (que muda entre leituras) mas salta muito mais cedo.
  // `stableMs` continua a valer como TETO de segurança: se o preço nunca
  // confirmar (oscila sempre), empurra o último ao fim de stableMs.
  let confirmsNeeded = 1;
  try {
    chrome.storage.local.get('savedForm').then((r) => {
      const c = parseInt(r?.savedForm?.['confirms'], 10);
      if (c >= 1) confirmsNeeded = c;
    }).catch(() => {});
  } catch { /* sem storage */ }

  let confirms = 0;
  let firstSeenAt = 0;

  function tick() {
    if (sent) return;
    if (looksBlocked()) {
      sent = true;
      safeSend({ type: 'edfs:blocked', url: location.href });
      return;
    }
    const r = readCheapest();
    if (!r) return;
    const now = Date.now();

    if (lastVal === null) {
      lastVal = r.price;
      confirms = 1;
      firstSeenAt = now;
      lastChangeAt = now;
      return;
    }

    if (r.price === lastVal) {
      confirms++;
    } else {
      // preço mudou (revisão da eDreams) — recomeçar contagem
      lastVal = r.price;
      confirms = 1;
      lastChangeAt = now;
    }

    // aceitar por confirmações consecutivas OU por teto de segurança
    if (confirms >= confirmsNeeded || now - firstSeenAt >= stableMs) {
      sent = true;
      safeSend({ type: 'edfs:cheapest', price: r.price, strategy: r.strategy, url: location.href });
    }
  }

  setInterval(tick, 300);

  // navegação por hash (SPA): nova pesquisa na mesma tab → recomeçar
  window.addEventListener('hashchange', () => {
    lastVal = null;
    lastChangeAt = 0;
    confirms = 0;
    firstSeenAt = 0;
    sent = false;
  });

  // ---- leitura on-demand (fallback do painel no timeout) ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'edfs:domScan') {
      const r = readCheapest();
      sendResponse({
        prices: r ? [r.price] : [],
        count: r ? 1 : 0,
        strategy: r?.strategy ?? null,
        blocked: looksBlocked()
      });
      return;
    }
    if (msg?.type === 'edfs:ping') sendResponse({ ok: true });
  });
})();
