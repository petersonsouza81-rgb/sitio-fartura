// Guarda os arquivos do app no celular para funcionar sem internet no curral.
// Ao mudar qualquer arquivo do app, aumente a VERSAO para os celulares baixarem a nova.
const VERSAO = 'rebanho-v19';
const ARQUIVOS = [
  './', 'index.html', 'style.css', 'app.js', 'firebase-config.js', 'manifest.webmanifest',
  'icones/logo.jpg', 'icones/icone-192.png', 'icones/icone-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Tenta a internet primeiro (pega atualizações); sem sinal, usa a cópia guardada.
// Só cuida dos arquivos do app e do código do Firebase (gstatic.com): a conexão
// com o banco de dados da nuvem passa direto, senão ela trava.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin && url.hostname !== 'www.gstatic.com') return;
  // O guia (vídeo e fotos) não fica guardado: o vídeo é grande e carrega aos pedaços.
  if (url.pathname.includes('/guia/')) return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copia = r.clone();
        caches.open(VERSAO).then(c => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./')))
  );
});
