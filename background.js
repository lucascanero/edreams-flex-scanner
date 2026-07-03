// Service worker mínimo. Decisão deliberada: a orquestração da fila vive no
// side panel (que fica vivo enquanto aberto), não aqui — service workers MV3
// são suspensos ao fim de ~30s de inatividade e delays de 8–15s entre tabs
// tornariam a fila frágil se dependesse de setTimeout no SW.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('sidePanel behavior:', e));
