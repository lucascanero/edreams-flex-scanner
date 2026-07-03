// interceptor.js — corre no MAIN world da página eDreams.
// Faz monkey-patch de fetch e XMLHttpRequest, tenta extrair itinerários/preços
// de qualquer resposta JSON plausível e envia o resultado compacto para o
// content script (ISOLATED) via window.postMessage.
//
// NOTA DE CALIBRAÇÃO: os nomes exatos dos endpoints e o schema da resposta da
// eDreams NÃO são garantidos. A extração é heurística por desenho: procura
// arrays de objetos com campos de preço. O painel mostra o URL de cada captura
// para que possas confirmar/afinar o padrão em EDFS_CONFIG.urlHint.

(() => {
  'use strict';
  if (window.__EDFS_HOOKED__) return;
  window.__EDFS_HOOKED__ = true;

  const MARK = 'EDFS_PAYLOAD_V1';

  const EDFS_CONFIG = {
    // Respostas cujo URL bata neste padrão são sempre analisadas.
    urlHint: /itinerar|search|result|travel\/service|booking|flight|fare/i,
    // Chaves candidatas a preço.
    priceKey: /^(price|totalprice|sortprice|amount|total|totalamount|minprice|fare|grandtotal)$/i,
    carrierKey: /(marketingcarrier|operatingcarrier|carrier|airline|company|validatingcarrier)/i,
    maxDepth: 9,
    maxCandidates: 12,
    maxBodyBytes: 8 * 1024 * 1024
  };

  // ---------- extração heurística ----------

  function asNumber(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = parseFloat(v.replace(',', '.'));
      if (isFinite(n)) return n;
    }
    return null;
  }

  // Procura um valor de preço num objeto (até profundidade 4).
  function pickPrice(item, depth = 0) {
    if (!item || typeof item !== 'object' || depth > 4) return null;
    for (const [k, v] of Object.entries(item)) {
      if (EDFS_CONFIG.priceKey.test(k)) {
        const direct = asNumber(v);
        if (direct !== null && direct > 5 && direct < 50000) return direct;
        if (v && typeof v === 'object') {
          const amt = asNumber(v.amount ?? v.value ?? v.total);
          if (amt !== null && amt > 5 && amt < 50000) return amt;
        }
      }
    }
    for (const v of Object.values(item)) {
      if (v && typeof v === 'object') {
        const p = pickPrice(v, depth + 1);
        if (p !== null) return p;
      }
    }
    return null;
  }

  function carrierFromValue(v) {
    if (typeof v === 'string') {
      const s = v.trim();
      // aceitar nome (>=2) ou código IATA (2 letras/dígitos)
      if (s.length >= 2 && s.length <= 40) return s;
    }
    if (v && typeof v === 'object') {
      const name = v.name ?? v.marketingName ?? v.displayName ?? v.code ?? v.iata ?? v.iataCode ?? v.id;
      if (typeof name === 'string' && name.trim().length >= 2) return name.trim();
    }
    return null;
  }

  // Procura um preço Prime/membro. A eDreams expõe-o em chaves como
  // "primePrice", "memberPrice", "loggedPrice". Devolve null se não existir.
  function pickPrimePrice(item, depth = 0) {
    if (!item || typeof item !== 'object' || depth > 4) return null;
    for (const [k, v] of Object.entries(item)) {
      if (/prime|member|logged|loyalty/i.test(k) && /price|fare|amount|total/i.test(k)) {
        const direct = asNumber(v);
        if (direct !== null && direct > 5 && direct < 50000) return direct;
        if (v && typeof v === 'object') {
          const amt = asNumber(v.amount ?? v.value ?? v.total);
          if (amt !== null && amt > 5 && amt < 50000) return amt;
        }
      }
    }
    for (const v of Object.values(item)) {
      if (v && typeof v === 'object') {
        const p = pickPrimePrice(v, depth + 1);
        if (p !== null) return p;
      }
    }
    return null;
  }

  function pickCarrier(item, depth = 0) {
    if (!item || typeof item !== 'object' || depth > 5) return null;

    // 1) chave direta de carrier no nível atual
    for (const [k, v] of Object.entries(item)) {
      if (EDFS_CONFIG.carrierKey.test(k)) {
        const c = carrierFromValue(v);
        if (c) return c;
      }
    }

    // 2) dentro de segments/legs: apanhar o carrier do primeiro segmento
    for (const [k, v] of Object.entries(item)) {
      if (/segments?|legs?|flights?|bounds?|sectors?/i.test(k) && Array.isArray(v) && v.length) {
        for (const seg of v) {
          const c = pickCarrier(seg, depth + 1);
          if (c) return c;
        }
      }
    }

    // 3) recursão geral
    for (const v of Object.values(item)) {
      if (v && typeof v === 'object') {
        const c = pickCarrier(v, depth + 1);
        if (c) return c;
      }
    }
    return null;
  }

  function countStops(item, depth = 0) {
    if (!item || typeof item !== 'object' || depth > 4) return null;
    for (const [k, v] of Object.entries(item)) {
      if (/segments?|legs?/i.test(k) && Array.isArray(v) && v.length > 0) {
        // ida+volta: nº médio de segmentos por sentido − 1 é uma aproximação;
        // reportamos segmentos totais e deixamos a interpretação para o painel.
        return v.length;
      }
    }
    for (const v of Object.values(item)) {
      if (v && typeof v === 'object') {
        const s = countStops(v, depth + 1);
        if (s !== null) return s;
      }
    }
    return null;
  }

  // Recolhe todas as listas de objetos com preços e escolhe A MELHOR lista —
  // não o mínimo global. Racional: uma resposta da eDreams tem várias listas
  // com preços (itinerários, mas também bagagens, seguros, Prime ~80€...).
  // Listas de itinerários distinguem-se por: mais itens, preços variados
  // (variância > 0), e presença de carrier/segments nos itens.
  function collectLists(root) {
    const lists = [];
    const summaryPairs = [];
    const seen = new Set();

    (function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > EDFS_CONFIG.maxDepth) return;
      if (seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        if (node.length >= 2 && node.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
          const itemKeys = Object.keys(node[0]).join(',');

          // EXCLUSÕES DURAS (confirmadas em produção via debug):
          // - matriz de datas flexíveis: preços de OUTRAS datas, não desta pesquisa
          // - ofertas de subscrição Prime (renewalPrice/subscriptionPeriod)
          const isMatrix = /matrixrow|matrixcolumn|apparentprice/i.test(itemKeys);
          const isSubscription = /renewalprice|subscriptionperiod|totalcommitment/i.test(itemKeys);

          if (!isMatrix && !isSubscription) {
            const priced = [];
            for (const item of node) {
              const p = pickPrice(item);
              if (p !== null) priced.push({ item, price: p });
            }
            if (priced.length >= Math.max(2, Math.floor(node.length / 2))) {
              // Par resumo [price,type]: é o par Prime/normal da tab
              // "Mais barato" — o mínimo É o valor da tab.
              const keySet = new Set(Object.keys(node[0]).map((k) => k.toLowerCase()));
              if (node.length <= 4 && keySet.has('price') && keySet.has('type') && keySet.size <= 3) {
                const prices = priced.map((x) => x.price);
                summaryPairs.push({ min: Math.min(...prices), max: Math.max(...prices) });
              }

              const prices = priced.map((x) => x.price);
              const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
              const variance = prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length;
              const withCarrier = priced.filter((x) => pickCarrier(x.item)).length;
              const withSegments = priced.filter((x) => countStops(x.item) !== null).length;

              let score = priced.length;
              if (variance > 1) score *= 2;
              if (withCarrier > priced.length / 2) score *= 3;
              if (withSegments > priced.length / 2) score *= 3;

              lists.push({
                priced,
                score,
                meta: {
                  size: priced.length,
                  min: Math.min(...prices),
                  max: Math.max(...prices),
                  variance: Math.round(variance),
                  carrierRatio: +(withCarrier / priced.length).toFixed(2),
                  keys: Object.keys(priced[0].item).slice(0, 8)
                }
              });
            }
          }
        }
        for (const c of node) walk(c, depth + 1);
      } else {
        for (const v of Object.values(node)) walk(v, depth + 1);
      }
    })(root, 0);

    lists.sort((a, b) => b.score - a.score);
    return { lists, summaryPairs };
  }

  function extractCandidates(root) {
    const { lists, summaryPairs } = collectLists(root);
    if (lists.length === 0 && summaryPairs.length === 0) {
      return { candidates: [], listsDebug: [], summaryPair: null };
    }

    let dedup = [];
    if (lists.length > 0) {
      const best = lists[0];
      const out = best.priced.map(({ item, price }) => ({
        price,
        pricePrime: pickPrimePrice(item),
        carrier: pickCarrier(item),
        segments: countStops(item)
      }));

      out.sort((a, b) => a.price - b.price);
      const keys = new Set();
      for (const c of out) {
        const k = `${c.price.toFixed(2)}|${c.carrier ?? ''}`;
        if (!keys.has(k)) {
          keys.add(k);
          dedup.push(c);
        }
        if (dedup.length >= EDFS_CONFIG.maxCandidates) break;
      }
    }

    // O par com menor mínimo é o par Prime/normal da tab "Mais barato".
    const summaryPair = summaryPairs.length
      ? summaryPairs.reduce((a, b) => (a.min <= b.min ? a : b))
      : null;

    const listsDebug = lists.slice(0, 4).map((l) => ({ score: l.score, ...l.meta }));
    return { candidates: dedup, listsDebug, summaryPair };
  }

  function report(url, jsonText) {
    if (!jsonText || jsonText.length > EDFS_CONFIG.maxBodyBytes) return;
    let root;
    try {
      root = JSON.parse(jsonText);
    } catch {
      return;
    }
    const { candidates, listsDebug, summaryPair } = extractCandidates(root);
    if (candidates.length === 0 && !summaryPair) return;
    try {
      window.postMessage(
        {
          mark: MARK,
          url: String(url).slice(0, 500),
          ts: Date.now(),
          candidates,
          listsDebug,
          summaryPair,
          sample: jsonText.slice(0, 1200)
        },
        window.location.origin
      );
    } catch {
      /* payload não clonável — ignorar */
    }
  }

  function shouldInspect(url, contentType) {
    const u = String(url || '');
    if (EDFS_CONFIG.urlHint.test(u)) return true;
    return /json/i.test(String(contentType || ''));
  }

  // ---------- fetch ----------
  // Wrapper deliberadamente NÃO-async: devolve a promise ORIGINAL do fetch.
  // Razões: (1) rejeições de pedidos da própria página (aborts, timeouts)
  // deixam de passar pelo nosso frame e de ser atribuídas à extensão na
  // página de erros do Chrome; (2) a inspeção corre num ramo .then próprio
  // com catch isolado — nunca interfere com o fluxo da página.
  const origFetch = window.fetch;

  function inspectResponse(url, resp) {
    try {
      const ct = resp.headers.get('content-type');
      if (shouldInspect(url, ct) && /json/i.test(ct || '')) {
        resp
          .clone()
          .text()
          .then((t) => report(url, t))
          .catch(() => {});
      }
    } catch {
      /* nunca partir a página */
    }
  }

  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    // Observação isolada: um async IIFE cria uma promise NOVA e independente
    // (não é `p`). O await dentro do try/catch consome qualquer rejeição de `p`
    // sem nunca rejeitar esta promise externa, e sem adicionar handlers à
    // cadeia de `p` que o Chrome atribua ao interceptor. A original `p` é
    // devolvida intacta à página. `.then(()=>{})` no fim garante que esta
    // promise-observadora nunca fica "unhandled".
    (async () => {
      let resp;
      try {
        resp = await p;
      } catch {
        return; // pedido da página falhou — não é problema nosso
      }
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        inspectResponse(url, resp);
      } catch {
        /* nunca partir a página */
      }
    })().then(() => {}, () => {});
    return p;
  };

  // Disfarce mínimo: fetch.toString() volta a reportar [native code].
  // [Limitação conhecida] Function.prototype.toString.call(window.fetch)
  // continua a revelar o patch — isto só cobre o check mais comum.
  try {
    window.fetch.toString = Function.prototype.toString.bind(origFetch);
  } catch {
    /* ambiente restritivo — ignorar */
  }

  // ---------- XHR ----------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__edfs_url = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        const ct = this.getResponseHeader('content-type');
        if (!shouldInspect(this.__edfs_url, ct)) return;
        if (this.responseType === '' || this.responseType === 'text') {
          report(this.__edfs_url, this.responseText);
        } else if (this.responseType === 'json' && this.response) {
          report(this.__edfs_url, JSON.stringify(this.response));
        }
      } catch {
        /* silêncio */
      }
    });
    return origSend.apply(this, args);
  };
})();
