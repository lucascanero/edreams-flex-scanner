// content.js — ISOLATED world.
// Missão única: esperar que a secção "Cheapest / Mais barato" tenha preço,
// empurrá-lo para o painel e seguir. Sem interceção de rede, sem varrer a
// página toda — só a label e o seu subtítulo.

(() => {
  'use strict';

  function safeSend(msg) {
    try {
      if (chrome.runtime?.id) chrome.runtime.sendMessage(msg).catch(() => {});
    } catch { /* painel fechado ou extensão recarregada */ }
  }

  // ---- parsing ----
  // Aceita símbolo antes ou depois e ambos os formatos numéricos:
  //   .pt/.es: "€ 817", "817 €", "1.234,56 €"  (milhares '.', decimais ',')
  //   .com:    "$1,234", "US$1,234.56"          (milhares ',', decimais '.')
  // CRÍTICO: o .com mostra preços em dólares — se só aceitássemos '€' o push
  // nunca disparava e cada pesquisa esperava o hard timeout inteiro (60s).
  function normalizeNumber(raw) {
    raw = raw.replace(/[\s]/g, '').replace(/[.,]+$/, '');
    if (!raw) return null;
    const lastDot = raw.lastIndexOf('.');
    const lastComma = raw.lastIndexOf(',');
    let n;
    if (lastDot !== -1 && lastComma !== -1) {
      // ambos presentes: o que aparece por último é o separador decimal
      const dec = Math.max(lastDot, lastComma);
      n = parseFloat(raw.slice(0, dec).replace(/[.,]/g, '') + '.' + raw.slice(dec + 1));
    } else if (lastComma !== -1 || lastDot !== -1) {
      // só um tipo de separador: é decimal se for único e tiver ≤2 dígitos
      // a seguir ("12.50", "8,5"); senão é de milhares ("1.234", "1,234,567")
      const sep = lastComma !== -1 ? ',' : '.';
      const idx = Math.max(lastDot, lastComma);
      const digitsAfter = raw.length - idx - 1;
      n = raw.indexOf(sep) === idx && digitsAfter <= 2
        ? parseFloat(raw.replace(sep, '.'))
        : parseFloat(raw.split(sep).join(''));
    } else {
      n = parseFloat(raw);
    }
    return isFinite(n) ? n : null;
  }

  function parseMoney(text) {
    const s = String(text);
    const m = s.match(/[€£$]\s*([\d][\d.,\s]*)/) ||
      s.match(/([\d][\d.,\s]*)\s*[€£$]/);
    if (!m) return null;
    const n = normalizeNumber(m[1]);
    return n !== null && n >= 30 && n < 20000 ? n : null;
  }

  const CHEAPEST_RX = /^(cheapest|mais barato|más barato|le moins cher|am günstigsten)$/i;

  // Label "Cheapest"/"Mais barato" → container → subtítulo com preço.
  // Itera TODAS as labels (a página tem 2+: a tab de ordenação E o chip verde
  // no card); a primeira que tiver subtítulo com preço ganha.
  function readCheapest() {
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
          const p = parseMoney(sub.textContent);
          if (p !== null) return p;
        }
        c = c.parentElement;
      }
    }
    return null;
  }

  // ---- deteção de bloqueio ----
  function looksBlocked() {
    const t = (document.title + ' ' + (document.body?.innerText || '').slice(0, 2000)).toLowerCase();
    return /captcha|unusual activity|atividade invulgar|access denied|robot|are you a human|pardon our interruption/.test(t);
  }

  // ---- push loop ----
  // O preço otimista inicial da eDreams é revisto nos primeiros instantes;
  // exigir 2 leituras iguais seguidas (~0.6s com poll de 300ms) filtra isso
  // sem atraso percetível. Depois de enviar, o painel fecha a tab e segue.
  const CONFIRMS_NEEDED = 2;
  let lastVal = null;
  let confirms = 0;
  let sent = false;

  function tick() {
    if (sent) return;
    if (looksBlocked()) {
      sent = true;
      safeSend({ type: 'edfs:blocked', url: location.href });
      return;
    }
    const p = readCheapest();
    if (p === null) return;
    confirms = p === lastVal ? confirms + 1 : 1;
    lastVal = p;
    if (confirms >= CONFIRMS_NEEDED) {
      sent = true;
      safeSend({ type: 'edfs:cheapest', price: p, url: location.href });
    }
  }

  setInterval(tick, 300);

  // ---- leitura on-demand (fallback do painel no timeout) ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'edfs:domScan') {
      sendResponse({ price: readCheapest(), blocked: looksBlocked() });
    }
  });
})();
