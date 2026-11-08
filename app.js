'use strict';

/* =========================================================
   Sítio Fartura — controle de ovinos, caprinos, bovinos e equinos
   Cada celular guarda uma cópia de trabalho (cadastros no localStorage,
   fotos no IndexedDB) e sincroniza com a nuvem (Firebase), que é o backup.
   ========================================================= */

const NOME_SITIO = 'Sítio Fartura';
const LOGO = 'icones/logo.jpg';
// A chave e o nome do banco de fotos continuam os antigos para não perder dados já salvos.
const CHAVE = 'rebanho-v1';
const app = document.getElementById('app');
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));
const agoraISO = () => new Date().toISOString();
const hoje = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};
const fmtData = s => s ? s.split('-').reverse().join('/') : '—';
const fmtHora = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const diasDesde = d => Math.round((new Date(hoje() + 'T12:00') - new Date(d + 'T12:00')) / 864e5);
const haQuanto = d => { const n = diasDesde(d); return n <= 0 ? 'hoje' : n === 1 ? 'ontem' : `há ${n} dias`; };
const num = v => {
  v = String(v ?? '').replace(',', '.').trim();
  return v === '' || isNaN(+v) ? null : +v;
};
const dec = v => v == null ? '' : String(v).replace('.', ',');
const fmtKg = v => v == null ? '—' : dec(v) + ' kg';
// Ordena pelo número do brinco; animais sem brinco vão para o fim.
const ordBrinco = (a, b) => (!a.brinco - !b.brinco) || (a.brinco || '').localeCompare(b.brinco || '', 'pt', { numeric: true });

/* ---------- Banco de dados ---------- */

const TIPOS_PRODUTO = {
  vacina: 'Vacina', vermifugo: 'Vermífugo', vitamina: 'Vitamina',
  antibiotico: 'Antibiótico', remedio: 'Remédio', outro: 'Outro',
  material: 'Material (seringa, agulha…)', // só no almoxarifado, não aparece na vacinação
};
const usadoNaVacina = p => !p.inativo && p.tipo !== 'material';

// Até quantos dias de vida o animal conta como filhote, por espécie.
const FILHOTE_PADRAO = { ovino: 180, caprino: 180, bovino: 365, equino: 365 };

function bancoVazio() {
  // Produtos padrão com código fixo e data antiga: num celular novo ligado à nuvem,
  // eles não duplicam nem passam por cima de alterações feitas no outro celular.
  const t = '2000-01-01T00:00:00.000Z';
  const padrao = [['Vermífugo', 'vermifugo'], ['Vitamina', 'vitamina'],
    ['Antibióticos', 'antibiotico'], ['Vacina clostridiose', 'vacina']];
  return {
    versao: 1,
    config: { filhote: { ...FILHOTE_PADRAO } },
    animais: [],
    produtos: padrao.map(([nome, tipo]) => ({ id: 'padrao-' + tipo, nome, tipo, dose: '', criadoEm: t, atualizadoEm: t })),
    manejos: [],
    aplicacoes: [],
    compras: [],
  };
}

function carregar() {
  try {
    const d = JSON.parse(localStorage.getItem(CHAVE));
    if (d && d.versao) {
      d.config = { ...d.config };
      // Versões antigas tinham um só limite de filhote (ovinos/caprinos).
      const antigo = d.config.diasFilhote;
      d.config.filhote = { ...FILHOTE_PADRAO, ...(antigo ? { ovino: antigo, caprino: antigo } : {}), ...d.config.filhote };
      delete d.config.diasFilhote;
      for (const c of ['animais', 'produtos', 'manejos', 'aplicacoes', 'compras']) d[c] = d[c] || [];
      // O produto padrão "Remédio para diarreia" passou a se chamar "Antibióticos".
      // As aplicações guardam o id do produto, então o histórico já mostra o nome novo.
      for (const p of d.produtos) {
        if (p.nome === 'Remédio para diarreia') {
          Object.assign(p, { nome: 'Antibióticos', tipo: 'antibiotico', atualizadoEm: new Date().toISOString() });
          localStorage.setItem(CHAVE, JSON.stringify(d));
        }
      }
      return d;
    }
  } catch (e) { /* banco corrompido ou vazio */ }
  return bancoVazio();
}

let db = carregar();

function salvar() {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(db));
  } catch (e) {
    alert('Não foi possível salvar no aparelho: ' + e.message);
  }
}

// Exclusão é "lógica" (excluido: true) para que a mesclagem de backups
// entre dois celulares também leve as exclusões.
const lista = col => db[col].filter(x => !x.excluido);
const achar = (col, id) => db[col].find(x => x.id === id && !x.excluido);

function gravar(col, reg) {
  const t = agoraISO();
  reg.atualizadoEm = t;
  if (!reg.id) {
    reg.id = uid();
    reg.criadoEm = t;
    db[col].push(reg);
  }
  salvar();
  enviarNuvem(col, reg);
  return reg;
}

function excluir(col, id) {
  const r = db[col].find(x => x.id === id);
  if (r) {
    r.excluido = true;
    r.atualizadoEm = agoraISO();
    salvar();
    enviarNuvem(col, r);
  }
}

/* ---------- Fotos (IndexedDB) ---------- */

// animalId -> { foto, mini, atualizadoEm }. Foto removida fica com foto: null
// para que a remoção também passe para o outro celular no backup.
const fotos = new Map();
let idb = null;

function carregarFotos() {
  return new Promise(ok => {
    if (!window.indexedDB) return ok();
    const req = indexedDB.open('rebanho-fotos', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('fotos');
    req.onerror = () => ok();
    req.onsuccess = () => {
      idb = req.result;
      const cur = idb.transaction('fotos').objectStore('fotos').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { fotos.set(c.key, c.value); c.continue(); } else ok();
      };
      cur.onerror = () => ok();
    };
  });
}

// Grava só neste celular (usado também quando a foto chega da nuvem).
function gravarFotoLocal(chave, valor) {
  fotos.set(chave, valor);
  if (idb) idb.transaction('fotos', 'readwrite').objectStore('fotos').put(valor, chave);
}

function gravarFoto(chave, valor) {
  gravarFotoLocal(chave, valor);
  enviarNuvem('fotos', { id: chave, ...valor });
}
const fotoDe = id => { const f = fotos.get(id); return f && f.foto ? f : null; };

/* ---------- Nuvem (Firebase) ----------
   Só liga quando firebase-config.js tem a configuração do projeto.
   O celular continua sendo a cópia de trabalho (funciona sem sinal):
   cada gravação é enviada para o Firestore, e o que o outro celular
   grava chega pelo onSnapshot. Em conflito, vale a alteração mais recente
   (atualizadoEm), a mesma regra da mesclagem de backups. */

const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const COLECOES_NUVEM = ['animais', 'produtos', 'manejos', 'aplicacoes', 'compras', 'fotos'];
const nuvem = {
  configurada: !!window.FIREBASE_CONFIG,
  estadoConhecido: false, // já sabemos se há alguém logado?
  usuario: null,
  fs: null, api: null, auth: null, authApi: null,
  pendentes: 0,
  sincronizadas: new Set(), // coleções já comparadas com o servidor nesta sessão
  ultimaSinc: null,
  erro: '',
  cancelar: [],
};

async function iniciarNuvem() {
  if (!nuvem.configurada) return;
  try {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(FIREBASE_SDK + 'firebase-app.js'),
      import(FIREBASE_SDK + 'firebase-auth.js'),
      import(FIREBASE_SDK + 'firebase-firestore.js'),
    ]);
    const fbApp = appMod.initializeApp(window.FIREBASE_CONFIG);
    nuvem.auth = authMod.getAuth(fbApp);
    nuvem.authApi = authMod;
    // Cache no próprio celular: lançamentos feitos sem sinal ficam na fila e sobem sozinhos.
    nuvem.fs = fsMod.initializeFirestore(fbApp, {
      localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() }),
    });
    nuvem.api = fsMod;
    authMod.onAuthStateChanged(nuvem.auth, u => {
      const mudou = (nuvem.usuario && nuvem.usuario.uid) !== (u && u.uid) || !nuvem.estadoConhecido;
      nuvem.usuario = u;
      nuvem.estadoConhecido = true;
      if (u) conectarNuvem(); else desconectarNuvem();
      atualizarStatusNuvem();
      if (mudou) render();
    });
  } catch (e) {
    // Sem internet na primeira abertura: o app segue funcionando no celular.
    nuvem.erro = 'Não foi possível conectar à nuvem agora.';
    nuvem.estadoConhecido = true;
    atualizarStatusNuvem();
  }
}

function conectarNuvem() {
  desconectarNuvem();
  const { collection, onSnapshot } = nuvem.api;
  nuvem.cancelar = COLECOES_NUVEM.map(col => onSnapshot(
    collection(nuvem.fs, col), { includeMetadataChanges: true },
    snap => receberNuvem(col, snap),
    e => { nuvem.erro = mensagemErroNuvem(e); atualizarStatusNuvem(); },
  ));
}

function desconectarNuvem() {
  nuvem.cancelar.forEach(f => f());
  nuvem.cancelar = [];
  nuvem.sincronizadas.clear();
}

// Junta no celular o que veio da nuvem.
function receberNuvem(col, snap) {
  let mudou = false;
  for (const ch of snap.docChanges()) {
    if (ch.type === 'removed') continue;
    const r = ch.doc.data();
    if (col === 'fotos') {
      const atual = fotos.get(ch.doc.id);
      if (!atual || (r.atualizadoEm || '') > (atual.atualizadoEm || '')) { gravarFotoLocal(ch.doc.id, r); mudou = true; }
      continue;
    }
    const i = db[col].findIndex(x => x.id === ch.doc.id);
    if (i < 0) { db[col].push(r); mudou = true; }
    else if ((r.atualizadoEm || '') > (db[col][i].atualizadoEm || '')) { db[col][i] = r; mudou = true; }
  }
  // Primeira resposta do servidor: sobe o que só existe neste celular (ou está mais novo aqui).
  if (!snap.metadata.fromCache && !nuvem.sincronizadas.has(col)) {
    nuvem.sincronizadas.add(col);
    if (subirDiferencas(col, snap)) mudou = true;
  }
  if (!snap.metadata.fromCache) nuvem.ultimaSinc = new Date();
  if (nuvem.erro && !snap.metadata.fromCache) nuvem.erro = '';
  if (mudou) {
    if (col !== 'fotos') salvar();
    agendarRender();
  }
  atualizarStatusNuvem();
}

function subirDiferencas(col, snap) {
  const remotos = new Map(snap.docs.map(d => [d.id, d.data()]));
  let removeuLocal = false;
  if (col === 'fotos') {
    for (const [chave, f] of fotos) {
      const r = remotos.get(chave);
      if (!r || (f.atualizadoEm || '') > (r.atualizadoEm || '')) enviarNuvem('fotos', { id: chave, ...f });
    }
    return false;
  }
  // Produto deste celular com o mesmo nome de um que já está na nuvem (ex.: os dois
  // celulares tinham "Vermífugo" antes da nuvem): usa o da nuvem e passa os
  // lançamentos daqui para ele, em vez de ficar com dois produtos iguais.
  const nome = p => p.nome.trim().toLowerCase();
  const idPorNome = new Map(col !== 'produtos' ? []
    : [...remotos.entries()].filter(([, r]) => !r.excluido).map(([id, r]) => [nome(r), id]));
  for (const reg of [...db[col]]) {
    const r = remotos.get(reg.id);
    if (r && (reg.atualizadoEm || '') <= (r.atualizadoEm || '')) continue;
    const idRemoto = !r && col === 'produtos' && !reg.excluido && idPorNome.get(nome(reg));
    if (idRemoto) {
      for (const ap of db.aplicacoes) {
        if (!ap.produtoIds.includes(reg.id)) continue;
        ap.produtoIds = ap.produtoIds.map(x => x === reg.id ? idRemoto : x);
        ap.atualizadoEm = agoraISO();
        enviarNuvem('aplicacoes', ap);
      }
      if (produtosSel && produtosSel.delete(reg.id)) produtosSel.add(idRemoto);
      db.produtos.splice(db.produtos.indexOf(reg), 1);
      removeuLocal = true;
      continue;
    }
    enviarNuvem(col, reg);
  }
  return removeuLocal;
}

function enviarNuvem(col, reg) {
  if (!nuvem.usuario || !nuvem.api) return;
  const { doc, setDoc } = nuvem.api;
  const dados = JSON.parse(JSON.stringify(reg)); // o Firestore não aceita campos "undefined"
  nuvem.pendentes++;
  atualizarStatusNuvem();
  // A promessa só termina quando o servidor confirma; sem sinal, fica na fila do Firestore.
  setDoc(doc(nuvem.fs, col, String(reg.id)), dados)
    .then(() => { nuvem.ultimaSinc = new Date(); nuvem.erro = ''; })
    .catch(e => { nuvem.erro = mensagemErroNuvem(e); })
    .finally(() => { nuvem.pendentes--; atualizarStatusNuvem(); });
}

function mensagemErroNuvem(e) {
  const c = (e && e.code) || '';
  if (c.includes('permission-denied')) return 'Este login não tem permissão para os dados do sítio.';
  if (c.includes('unavailable')) return 'Sem conexão com a nuvem. Os dados ficam guardados no celular.';
  return 'Erro na nuvem: ' + ((e && e.message) || c);
}

function atualizarStatusNuvem() {
  const el = $('#statusNuvem');
  if (!el) return;
  if (!nuvem.configurada || !nuvem.usuario) { el.hidden = true; return; }
  el.hidden = false;
  const [icone, texto] = nuvem.erro ? ['⚠️', nuvem.erro]
    : !navigator.onLine ? ['📴', 'Sem internet. Os lançamentos sobem sozinhos quando o sinal voltar.']
    : nuvem.pendentes ? ['⏳', `Enviando ${nuvem.pendentes} alteração(ões) para a nuvem…`]
    : ['☁️', 'Tudo salvo na nuvem.'];
  el.textContent = icone + (nuvem.pendentes ? ' ' + nuvem.pendentes : '');
  el.title = texto;
  const txt = $('#textoNuvem');
  if (txt) txt.textContent = texto + (nuvem.ultimaSinc ? ` (última conexão às ${fmtHora(nuvem.ultimaSinc.toISOString())})` : '');
  el.onclick = () => toast(texto);
}
window.addEventListener('online', atualizarStatusNuvem);
window.addEventListener('offline', atualizarStatusNuvem);

let renderTimer;
function agendarRender() {
  clearTimeout(renderTimer);
  // Não redesenha com uma janela aberta ou enquanto a pessoa digita.
  renderTimer = setTimeout(() => {
    const digitando = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (!$('#modal').hidden || digitando) return agendarRender();
    if (location.hash.startsWith('#/vacinacao') && typeof atualizarLancar === 'function' && $('#q')) atualizarLancar();
    else render();
  }, 400);
}

/* Tela de entrada (só quando a nuvem está ligada e ninguém entrou neste celular) */
function telaLogin() {
  titulo(NOME_SITIO);
  document.body.classList.add('sem-nav');
  app.innerHTML = `
    <div class="login">
      <img src="${LOGO}" alt="Logo ${NOME_SITIO}">
      <h2>${NOME_SITIO}</h2>
      <p class="dica">Entre com o e-mail e a senha do sítio. Só precisa fazer isso uma vez neste celular.</p>
      <form id="fl" class="form">
        <label>E-mail<input type="email" name="email" autocomplete="username" required></label>
        <label>Senha<input type="password" name="senha" autocomplete="current-password" required></label>
        <button class="btn primario grande">Entrar</button>
        <button type="button" class="btn" id="esqueci">Esqueci a senha</button>
      </form>
      <a class="btn" href="guia.html">❓ Como usar o app (vídeo)</a>
    </div>`;
  const f = $('#fl');
  const { signInWithEmailAndPassword, sendPasswordResetEmail } = nuvem.authApi;
  f.onsubmit = async e => {
    e.preventDefault();
    const b = $('button.primario', f);
    b.disabled = true;
    b.textContent = 'Entrando…';
    try {
      await signInWithEmailAndPassword(nuvem.auth, f.email.value.trim(), f.senha.value);
      toast('Bem-vindo! Os dados vão aparecer em instantes.');
    } catch (err) {
      const c = err.code || '';
      toast(c.includes('network') ? 'Sem internet. Para entrar a primeira vez precisa de sinal.'
        : c.includes('too-many') ? 'Muitas tentativas. Espere alguns minutos.'
        : 'E-mail ou senha errados.');
      b.disabled = false;
      b.textContent = 'Entrar';
    }
  };
  $('#esqueci').onclick = async () => {
    const email = f.email.value.trim();
    if (!email) return toast('Digite o e-mail primeiro.');
    try {
      await sendPasswordResetEmail(nuvem.auth, email);
      toast('Enviamos um e-mail para criar uma nova senha.');
    } catch (err) {
      toast('Não foi possível enviar o e-mail. Confira o endereço.');
    }
  };
}

function sairDaNuvem() {
  if (!confirm('Sair da conta neste celular?\n\nOs dados continuam guardados na nuvem e voltam quando entrar de novo.')) return;
  nuvem.authApi.signOut(nuvem.auth);
}

function reduzir(img, max, qualidade) {
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', qualidade);
}

// Diminui a foto da câmera (vários MB) para ~60 KB, e gera uma miniatura para as listas.
function prepararFoto(arquivo) {
  return new Promise((ok, erro) => {
    const url = URL.createObjectURL(arquivo);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      ok({ foto: reduzir(img, 900, 0.72), mini: reduzir(img, 160, 0.7) });
    };
    img.onerror = () => { URL.revokeObjectURL(url); erro(new Error('imagem inválida')); };
    img.src = url;
  });
}

function campoFoto(atual) {
  return `<label>Foto <small>(opcional)</small></label>
    <div class="foto-campo">
      <img class="foto-grande" data-prev ${atual ? `src="${atual}"` : 'hidden'} alt="Foto do animal">
      <div class="linha-botoes">
        <label class="btn">📷 Tirar foto<input type="file" accept="image/*" capture="environment" hidden data-foto></label>
        <label class="btn">🖼️ Galeria<input type="file" accept="image/*" hidden data-foto></label>
      </div>
      <button type="button" class="btn perigo" data-remover-foto ${atual ? '' : 'hidden'}>Remover foto</button>
    </div>`;
}

// Devolve o estado da foto do formulário: undefined = não mexeu, null = removeu, objeto = foto nova.
function ligarFoto(raiz) {
  const estado = { valor: undefined };
  const prev = $('[data-prev]', raiz), rem = $('[data-remover-foto]', raiz);
  $$('[data-foto]', raiz).forEach(inp => inp.onchange = async () => {
    const arq = inp.files[0];
    inp.value = '';
    if (!arq) return;
    try {
      estado.valor = await prepararFoto(arq);
      prev.src = estado.valor.foto;
      prev.hidden = rem.hidden = false;
    } catch (e) {
      toast('Não foi possível ler a foto.');
    }
  });
  rem.onclick = () => {
    estado.valor = null;
    prev.hidden = rem.hidden = true;
    prev.removeAttribute('src');
  };
  return estado;
}

function salvarFoto(animalId, estado) {
  if (estado.valor === undefined) return;
  gravarFoto(animalId, { ...(estado.valor || { foto: null, mini: null }), atualizadoEm: agoraISO() });
}

/* ---------- Regras dos animais ---------- */

const NOMES = {
  ovino: { F: 'Ovelha', M: 'Carneiro', fF: 'Cordeira', fM: 'Cordeiro' },
  caprino: { F: 'Cabra', M: 'Cabrito', fF: 'Cabritinha', fM: 'Cabritinho' },
  bovino: { F: 'Vaca', M: 'Boi', fF: 'Bezerra', fM: 'Bezerro' },
  equino: { F: 'Égua', M: 'Cavalo', fF: 'Potra', fM: 'Potro' },
};
const ESPECIES = {
  ovino: ['Ovino', '🐑'], caprino: ['Caprino', '🐐'],
  bovino: ['Bovino', '🐄'], equino: ['Equino', '🐎'],
};
const nomeEspecie = a => ESPECIES[a.especie][0];

function idadeDias(a) {
  if (!a.nascimento) return null;
  return Math.floor((Date.now() - new Date(a.nascimento + 'T12:00').getTime()) / 864e5);
}
function idadeTexto(a) {
  const d = idadeDias(a);
  if (d === null) return '';
  if (d < 31) return d + (d === 1 ? ' dia' : ' dias');
  const m = Math.floor(d / 30.44);
  if (m < 12) return m + (m === 1 ? ' mês' : ' meses');
  const anos = Math.floor(m / 12), r = m % 12;
  return anos + (anos === 1 ? ' ano' : ' anos') + (r ? ` e ${r} ${r === 1 ? 'mês' : 'meses'}` : '');
}
const ehFilhote = a => { const d = idadeDias(a); return d !== null && d < db.config.filhote[a.especie]; };
const categoria = a => NOMES[a.especie][(ehFilhote(a) ? 'f' : '') + a.sexo];
const grupo = a => ehFilhote(a) ? 'filhote' : a.especie + a.sexo;
const ativos = () => lista('animais').filter(a => a.situacao === 'ativo');
const mae = a => a.maeId ? achar('animais', a.maeId) : null;

/* ---------- Saída do rebanho (morte, abate, venda) ---------- */

const SITUACAO = { ativo: 'Ativo', morto: 'Morto', abatido: 'Abatido', vendido: 'Vendido' };
const SAIDAS = { morto: ['✝️', 'Morte'], abatido: ['🔪', 'Abate'], vendido: ['💰', 'Venda'] };
const chaveFotoMorte = (id, n) => `${id}:morte${n}`;
const fotosMorte = a => [1, 2].map(n => fotoDe(chaveFotoMorte(a.id, n))).filter(Boolean);

function textoSaida(a) {
  const s = a.saida;
  return `${SAIDAS[a.situacao]?.[1] || SITUACAO[a.situacao]}${s && s.data ? ' em ' + fmtData(s.data) : ''}`;
}

const fmtReal = v => v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Comprador, peso e valores da venda/abate, para mostrar na tela, na ficha e no texto.
function detalhesSaida(a) {
  const s = a.saida || {};
  return [
    ...(s.comprador ? [['Comprador', s.comprador]] : []),
    ...(s.peso != null ? [[a.situacao === 'abatido' ? 'Peso no abate' : 'Peso na venda', fmtKg(s.peso)]] : []),
    ...(s.valorKg != null ? [['Valor por kg', fmtReal(s.valorKg)]] : []),
    ...(s.total != null ? [['Valor total da venda', fmtReal(s.total)]] : []),
  ];
}

function cartaoSaida(a) {
  const fs = fotosMorte(a);
  const det = detalhesSaida(a);
  return `<div class="cartao saida">
    <strong>${SAIDAS[a.situacao]?.[0] || ''} Saiu do rebanho: ${esc(textoSaida(a))}</strong>
    ${det.length ? `<dl class="dados" style="margin-top:8px">${det.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
    ${a.saida && a.saida.obs ? `<p style="margin:6px 0 0">${esc(a.saida.obs)}</p>` : ''}
    ${fs.length ? `<div class="fotos-morte" style="margin-top:10px">${fs.map(f => `<img src="${f.foto}" alt="Foto da morte">`).join('')}</div>` : ''}
    <button class="btn pequeno" id="desfazerSaida" style="margin-top:10px">Desfazer (voltar para ativo)</button>
  </div>`;
}

function registrarSaida(a, tipo) {
  const [icone, nome] = SAIDAS[tipo];
  const caixa = modal(`
    <h3>${icone} ${nome} · ${esc(rotulo(a))}</h3>
    <form id="fs" class="form">
      <label style="margin-top:8px">Data<input type="date" name="data" value="${hoje()}" max="${hoje()}" required></label>
      ${tipo === 'morto' ? `
        <label>Causa / observação <small>(opcional)</small><input name="obs" placeholder="ex.: verminose, picada de cobra"></label>
        <label>Fotos <small>(até 2, opcional)</small></label>
        <div class="fotos-morte">${[1, 2].map(n => `<label class="slot-foto">
          <img data-prev="${n}" hidden alt=""><span>📷 Foto ${n}</span>
          <input type="file" accept="image/*" hidden data-slot="${n}"></label>`).join('')}</div>` : ''}
      ${tipo === 'vendido' ? `
        <label>Comprador<input name="comprador" placeholder="Nome de quem comprou" autocomplete="off"></label>
        <div class="tres">
          <label>Peso (kg)<input name="peso" inputmode="decimal" placeholder="0,0"></label>
          <label>Valor/kg (R$)<input name="valorKg" inputmode="decimal" placeholder="0,00"></label>
          <label>Total<output id="totalVenda" class="total-venda">R$ 0,00</output></label>
        </div>` : ''}
      ${tipo === 'abatido' ? '<label>Peso do animal (kg)<input name="peso" inputmode="decimal" placeholder="0,0"></label>' : ''}
      <button class="btn primario grande">Confirmar ${nome.toLowerCase()}</button>
      <button type="button" class="btn" id="cancelar">Cancelar</button>
    </form>`);
  const f = $('#fs', caixa);
  const novas = {};
  $$('[data-slot]', caixa).forEach(inp => inp.onchange = async () => {
    const arq = inp.files[0];
    inp.value = '';
    if (!arq) return;
    try {
      const n = inp.dataset.slot;
      novas[n] = await prepararFoto(arq);
      const img = $(`[data-prev="${n}"]`, caixa);
      img.src = novas[n].foto;
      img.hidden = false;
      img.nextElementSibling.hidden = true;
    } catch (e) {
      toast('Não foi possível ler a foto.');
    }
  });
  // Valor total da venda = peso × valor por kg, atualizado enquanto digita.
  const totalVenda = () => {
    const peso = num(f.peso.value), valorKg = num(f.valorKg.value);
    return peso != null && valorKg != null ? Math.round(peso * valorKg * 100) / 100 : null;
  };
  if (tipo === 'vendido') f.oninput = () => { $('#totalVenda', caixa).textContent = fmtReal(totalVenda() ?? 0); };
  $('#cancelar', caixa).onclick = fecharModal;
  f.onsubmit = e => {
    e.preventDefault();
    a.situacao = tipo;
    a.saida = { tipo, data: f.data.value, obs: f.obs ? f.obs.value.trim() : '' };
    if (f.peso) a.saida.peso = num(f.peso.value);
    if (tipo === 'vendido') Object.assign(a.saida, { comprador: f.comprador.value.trim(), valorKg: num(f.valorKg.value), total: totalVenda() });
    gravar('animais', a);
    for (const [n, foto] of Object.entries(novas)) gravarFoto(chaveFotoMorte(a.id, n), { ...foto, atualizadoEm: agoraISO() });
    fecharModal();
    toast(`${nome} registrad${tipo === 'abatido' ? 'o' : 'a'} ✔`);
    render();
  };
}

function desfazerSaida(a) {
  if (!confirm(`Voltar ${rotulo(a)} para ativo? O registro de ${textoSaida(a).toLowerCase()} será apagado.`)) return;
  a.situacao = 'ativo';
  a.saida = null;
  gravar('animais', a);
  [1, 2].forEach(n => { if (fotos.has(chaveFotoMorte(a.id, n))) gravarFoto(chaveFotoMorte(a.id, n), { foto: null, mini: null, atualizadoEm: agoraISO() }); });
  toast('Animal voltou para ativo');
  render();
}

function nomeBrinco(a) {
  if (a.brinco) return '#' + a.brinco;
  const m = mae(a);
  return m && m.brinco ? `s/ brinco (mãe #${m.brinco})` : 's/ brinco';
}
const rotulo = a => `${nomeBrinco(a)} ${categoria(a)}${a.marca ? ' · ' + a.marca : ''}`;

const GRUPOS = [
  ['ovinoF', 'Ovelhas'], ['ovinoM', 'Carneiros'], ['caprinoF', 'Cabras'], ['caprinoM', 'Cabritos'],
  ['bovinoF', 'Vacas'], ['bovinoM', 'Bois'], ['equinoF', 'Éguas'], ['equinoM', 'Cavalos'],
  ['filhote', 'Filhotes'],
];

function itemAnimal(a, { tag = 'a', link = '#/animal/' + a.id, extra = '', attrs = '' } = {}) {
  const m = mae(a);
  const f = fotoDe(a.id);
  const det = [
    a.reprodutor ? 'reprodutor' : '',
    a.marca,
    idadeTexto(a),
    !a.brinco && m ? `filho(a) da ${categoria(m).toLowerCase()} ${m.brinco ? '#' + m.brinco : 's/ brinco'}` : '',
    a.situacao !== 'ativo' ? textoSaida(a).toUpperCase() : '',
  ].filter(Boolean).join(' · ');
  const href = tag === 'a' ? `href="${link}"` : 'type="button"';
  return `<${tag} class="item esp-${a.especie} ${a.situacao !== 'ativo' ? 'inativo' : ''}" ${href} ${attrs}>
    ${f ? `<img class="mini" src="${f.mini}" alt="">` : ''}
    <span class="brinco">${a.brinco ? esc(a.brinco) : '—'}</span>
    <span class="info"><strong>${esc(categoria(a))}</strong><small>${esc(det) || '&nbsp;'}</small></span>
    ${extra}
  </${tag}>`;
}

// Todas as aplicações do animal, com a vacinação (manejo) de cada uma.
function historicoDe(a) {
  return lista('aplicacoes').filter(x => x.animalId === a.id)
    .map(x => ({ ...x, m: achar('manejos', x.manejoId) })).filter(x => x.m)
    .sort((x, y) => y.m.data.localeCompare(x.m.data) || y.criadoEm.localeCompare(x.criadoEm));
}

/* ---------- Componentes de tela ---------- */

function titulo(t, voltar = false) {
  $('#titulo').textContent = t;
  document.title = t === NOME_SITIO ? NOME_SITIO : `${t} · ${NOME_SITIO}`;
  $('#voltar').hidden = !voltar;
}
$('#voltar').onclick = () => history.back();

let toastTimer;
function toast(msg, botao, fn) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + (botao ? `<button>${esc(botao)}</button>` : '');
  if (botao) t.querySelector('button').onclick = () => { t.className = ''; fn(); };
  t.className = 'on';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, botao ? 5000 : 2500);
}

function modal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="caixa">${html}</div>`;
  m.hidden = false;
  m.onclick = e => { if (e.target === m) fecharModal(); };
  return m.firstElementChild;
}
function fecharModal() {
  const m = $('#modal');
  m.hidden = true;
  m.innerHTML = '';
}

function seg(nome, opcoes, valor) {
  return `<div class="seg" data-nome="${nome}">${opcoes.map(([v, t]) =>
    `<button type="button" data-v="${v}" class="${v === valor ? 'on' : ''}">${t}</button>`).join('')}</div>`;
}
function ligarSeg(raiz, aoMudar) {
  $$('.seg', raiz).forEach(s => s.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('button', s).forEach(x => x.classList.toggle('on', x === b));
    if (aoMudar) aoMudar(s.dataset.nome, b.dataset.v);
  }));
}
const valorSeg = (raiz, nome) => $(`.seg[data-nome="${nome}"] .on`, raiz)?.dataset.v;

// Cabeçalho com logo e nome do sítio, usado nos relatórios (tela e impressão).
const cabecalhoRelatorio = subtitulo => `<div class="relatorio-topo">
  <img src="${LOGO}" alt="Logo ${NOME_SITIO}">
  <div><strong>${NOME_SITIO}</strong><span>${esc(subtitulo)}</span></div>
</div>`;

function naoEncontrado() {
  titulo('Não encontrado', true);
  app.innerHTML = '<div class="vazio">Registro não encontrado.</div><a class="btn" href="#/inicio">Ir para o início</a>';
}

const nomesProdutos = ids => ids.length ? ids.map(id => db.produtos.find(p => p.id === id)?.nome || '?').join(' + ') : 'nenhum produto';
const manejoAberto = () => lista('manejos').find(m => m.aberto);
const aplicacoesDo = manejoId => lista('aplicacoes').filter(x => x.manejoId === manejoId);
const PUBLICO = { todos: 'Todos', ovino: 'Ovinos', caprino: 'Caprinos', bovino: 'Bovinos', equino: 'Equinos' };

// Produtos usados numa vacinação: quantos animais receberam cada um.
function produtosDoManejo(m) {
  const cont = new Map();
  for (const x of aplicacoesDo(m.id)) for (const p of x.produtoIds) cont.set(p, (cont.get(p) || 0) + 1);
  return [...cont].sort((a, b) => b[1] - a[1]);
}
const resumoProdutos = m => {
  const l = produtosDoManejo(m);
  return l.length ? l.map(([id, n]) => `${nomesProdutos([id])} (${n})`).join(', ') : 'nada lançado ainda';
};

/* ---------- Telas ---------- */

function inicio() {
  titulo(NOME_SITIO);
  const at = ativos();
  const cont = Object.fromEntries(GRUPOS.map(([g]) => [g, 0]));
  at.forEach(a => cont[grupo(a)]++);
  const m = manejoAberto();
  const ultimos = lista('manejos').filter(x => !x.aberto).sort((a, b) => b.data.localeCompare(a.data)).slice(0, 3);
  const falta = faltaComprar();

  app.innerHTML = `
    ${falta.length ? `<a class="cartao lembrete" href="#/almoxarifado">
      🔔 <b>Falta comprar:</b> ${esc(falta.map(c => c.nome).join(', '))}</a>` : ''}
    ${m ? `<a class="cartao destaque" style="display:block;text-decoration:none;color:inherit" href="#/vacinacao">
      <strong>💉 Vacinação em andamento</strong><br>
      <small>${fmtData(m.data)} · ${aplicacoesDo(m.id).length} animais lançados</small><br>
      <span class="btn primario" style="margin-bottom:0">Continuar lançamento</span></a>` : ''}
    <div class="resumo">
      ${GRUPOS.filter(([g]) => cont[g]).map(([g, n]) => `<a href="#/animais/${g}"><b>${cont[g]}</b><span>${n}</span></a>`).join('')}
      <a href="#/animais/todos"><b>${at.length}</b><span>Total ativos</span></a>
    </div>
    ${m ? '' : '<a class="btn primario grande" href="#/vacinacao">💉 Iniciar vacinação</a>'}
    <div class="atalhos">
      <a class="btn" href="#/nascimento"><span>🍼</span>Parto</a>
      <a class="btn" href="#/editar/novo"><span>➕</span>Cadastrar</a>
      <a class="btn" href="#/fichas"><span>📋</span>Fichas</a>
    </div>
    <a class="btn" href="#/almoxarifado">🧰 Almoxarifado${falta.length ? ` (${falta.length} para comprar)` : ''}</a>
    <h2>Últimas vacinações</h2>
    ${ultimos.length ? `<ul class="lista">${ultimos.map(itemManejo).join('')}</ul>` : '<p class="dica">Nenhuma vacinação registrada ainda.</p>'}
  `;
}

function itemManejo(m) {
  const n = aplicacoesDo(m.id).length;
  return `<li><a class="item" href="#/manejo/${m.id}">
    <span class="brinco" style="background:var(--verde-claro);color:var(--verde);font-size:15px">${fmtData(m.data).slice(0, 5)}</span>
    <span class="info"><strong>${n} animais · ${PUBLICO[m.publico]}${m.aberto ? ' · em andamento' : ''}</strong>
    <small>${esc(resumoProdutos(m))}</small></span></a></li>`;
}

/* Lista de animais (usada em "Animais" e em "Fichas") */
let filtroAnimais = 'todos';
const gruposComAnimais = () => {
  const usados = new Set(ativos().map(grupo));
  return GRUPOS.filter(([g]) => usados.has(g) || g === filtroAnimais);
};
function telaLista(filtro, { tituloTela, link, dica = '', cadastrar = true }) {
  if (filtro) filtroAnimais = filtro;
  titulo(tituloTela);
  app.innerHTML = `
    ${dica ? `<p class="dica" style="margin-top:0">${dica}</p>` : ''}
    <input class="busca" id="q" inputmode="numeric" placeholder="Buscar nº do brinco" autocomplete="off">
    <div class="chips" id="filtros" style="margin-bottom:12px">
      ${[['todos', 'Todos'], ...gruposComAnimais(), ['inativos', 'Mortos/abatidos/vendidos']].map(([v, t]) =>
        `<button class="chip ${v === filtroAnimais ? 'on' : ''}" data-v="${v}">${t}</button>`).join('')}
    </div>
    <div id="res"></div>
    ${cadastrar ? '<a class="btn primario" href="#/editar/novo">➕ Cadastrar animal</a>' : ''}`;
  const q = $('#q');
  const desenhar = () => {
    const t = q.value.trim().toLowerCase();
    let l = filtroAnimais === 'inativos'
      ? lista('animais').filter(a => a.situacao !== 'ativo')
      : ativos().filter(a => filtroAnimais === 'todos' || grupo(a) === filtroAnimais);
    if (t) l = l.filter(a => (a.brinco || '').toLowerCase().startsWith(t)
      || (!a.brinco && mae(a)?.brinco?.toLowerCase() === t));
    l.sort(ordBrinco);
    $('#res').innerHTML = `<p class="dica">${l.length} animal(is)</p>` +
      (l.length ? `<ul class="lista">${l.map(a => `<li>${itemAnimal(a, { link: link(a) })}</li>`).join('')}</ul>`
        : '<div class="vazio">Nenhum animal encontrado.</div>');
  };
  q.oninput = desenhar;
  $('#filtros').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    filtroAnimais = b.dataset.v;
    $$('#filtros .chip').forEach(x => x.classList.toggle('on', x === b));
    desenhar();
  };
  desenhar();
}

const animais = filtro => telaLista(filtro, { tituloTela: 'Animais', link: a => '#/animal/' + a.id });
const fichas = filtro => telaLista(filtro, {
  tituloTela: 'Fichas', link: a => '#/ficha/' + a.id, cadastrar: false,
  dica: 'Escolha o animal para ver a ficha completa: dados, pesagens, partos e tudo que ele já recebeu. Dá para imprimir, salvar em PDF ou mandar pelo WhatsApp.',
});

/* Página do animal */
function animal(id) {
  const a = achar('animais', id);
  if (!a) return naoEncontrado();
  titulo(`${nomeBrinco(a)} ${categoria(a)}`, true);
  const m = mae(a);
  const f = fotoDe(a.id);
  const filhos = lista('animais').filter(x => x.maeId === a.id).sort((x, y) => (y.nascimento || '').localeCompare(x.nascimento || ''));
  const aps = historicoDe(a);

  app.innerHTML = `
    ${f ? `<img class="foto-grande" src="${f.foto}" alt="Foto de ${esc(rotulo(a))}">` : ''}
    <div class="cartao">
      <dl class="dados">
        <dt>Brinco</dt><dd>${a.brinco ? esc(a.brinco) : 'sem brinco'}</dd>
        <dt>Espécie</dt><dd>${nomeEspecie(a)}</dd>
        <dt>Sexo</dt><dd>${a.sexo === 'F' ? 'Fêmea' : 'Macho'}</dd>
        ${a.sexo === 'M' ? `<dt>Reprodutor</dt><dd>${a.reprodutor ? 'Sim' : 'Não'}</dd>` : ''}
        <dt>Categoria</dt><dd>${esc(categoria(a))}</dd>
        ${a.marca ? `<dt>Marca/cor</dt><dd>${esc(a.marca)}</dd>` : ''}
        <dt>Nascimento</dt><dd>${fmtData(a.nascimento)}${a.nascimento ? ` (${idadeTexto(a)})` : ''}</dd>
        <dt>Mãe</dt><dd>${m ? `<a href="#/animal/${m.id}">${esc(rotulo(m))}</a>` : '—'}</dd>
        <dt>Situação</dt><dd>${esc(a.situacao === 'ativo' ? 'Ativo' : textoSaida(a))}</dd>
      </dl>
    </div>
    <a class="btn primario" href="#/ficha/${a.id}">📋 Ficha completa / relatório</a>
    <a class="btn" href="#/editar/${a.id}">✏️ Editar${f ? '' : ' / colocar foto'}${a.brinco ? '' : ' / colocar brinco'}</a>
    ${a.sexo === 'F' && a.situacao === 'ativo' && !ehFilhote(a) ? `<a class="btn" href="#/nascimento/${a.id}">🍼 Registrar parto desta ${NOMES[a.especie].F.toLowerCase()}</a>` : ''}
    ${a.situacao === 'ativo'
      ? `<div class="saidas">${Object.entries(SAIDAS).map(([k, [ic, t]]) => `<button class="btn" data-saida="${k}">${ic} ${t}</button>`).join('')}</div>`
      : cartaoSaida(a)}

    ${filhos.length ? `<h2>Filhotes (${filhos.length})</h2><ul class="lista">${filhos.map(x => `<li>${itemAnimal(x)}</li>`).join('')}</ul>` : ''}

    <h2>Últimas aplicações</h2>
    ${aps.length ? `<ul class="lista">${aps.slice(0, 5).map(x => `<li><a class="item" href="#/manejo/${x.m.id}">
      <span class="info"><strong>${fmtData(x.m.data)}</strong><small>${esc(nomesProdutos(x.produtoIds))}${x.peso != null ? ' · ' + fmtKg(x.peso) : ''}${x.obs ? ' · ' + esc(x.obs) : ''}</small></span></a></li>`).join('')}</ul>
      ${aps.length > 5 ? `<a href="#/ficha/${a.id}">Ver todas as ${aps.length} na ficha</a>` : ''}`
      : '<p class="dica">Nenhuma aplicação registrada.</p>'}
  `;
  $$('[data-saida]').forEach(b => b.onclick = () => registrarSaida(a, b.dataset.saida));
  const desf = $('#desfazerSaida');
  if (desf) desf.onclick = () => desfazerSaida(a);
}

/* Ficha completa (relatório) */
function ficha(id) {
  const a = achar('animais', id);
  if (!a) return naoEncontrado();
  titulo('Ficha ' + nomeBrinco(a), true);
  const m = mae(a);
  const f = fotoDe(a.id);
  const aps = historicoDe(a);

  // Último uso e total de cada produto
  const porProduto = new Map();
  for (const x of aps) for (const p of x.produtoIds) {
    const r = porProduto.get(p) || { n: 0, ultima: '' };
    r.n++;
    if (x.m.data > r.ultima) r.ultima = x.m.data;
    porProduto.set(p, r);
  }
  const sanidade = [...porProduto].sort((x, y) => y[1].ultima.localeCompare(x[1].ultima));

  // Pesagens: nascimento + as anotadas nas vacinações
  const pesagens = [
    ...(a.pesoNasc != null ? [{ data: a.nascimento, peso: a.pesoNasc, origem: 'Nascimento' }] : []),
    ...aps.filter(x => x.peso != null).map(x => ({ data: x.m.data, peso: x.peso, origem: 'Vacinação' })),
    ...(a.saida && a.saida.peso != null ? [{ data: a.saida.data, peso: a.saida.peso, origem: SAIDAS[a.situacao]?.[1] || 'Saída' }] : []),
  ].sort((x, y) => (x.data || '').localeCompare(y.data || ''));

  // Partos: filhotes agrupados pela data de nascimento
  const filhos = lista('animais').filter(x => x.maeId === a.id);
  const partos = new Map();
  for (const x of filhos) {
    const k = x.nascimento || '';
    partos.set(k, [...(partos.get(k) || []), x]);
  }
  const listaPartos = [...partos].sort((x, y) => y[0].localeCompare(x[0]));

  const ident = [
    ['Brinco', a.brinco || 'sem brinco'],
    ['Espécie', nomeEspecie(a)],
    ['Sexo', a.sexo === 'F' ? 'Fêmea' : 'Macho'],
    ...(a.sexo === 'M' ? [['Reprodutor', a.reprodutor ? 'Sim' : 'Não']] : []),
    ['Categoria', categoria(a)],
    ...(a.marca ? [['Marca/cor', a.marca]] : []),
    ['Nascimento', fmtData(a.nascimento) + (a.nascimento ? ` (${idadeTexto(a)})` : '')],
    ['Peso ao nascer', fmtKg(a.pesoNasc)],
    ['Mãe', m ? rotulo(m) : '—'],
    ['Situação', a.situacao === 'ativo' ? 'Ativo' : textoSaida(a)],
    ...detalhesSaida(a),
    ...(a.saida && a.saida.obs ? [['Causa / obs. da saída', a.saida.obs]] : []),
    ['Cadastrado em', fmtData((a.criadoEm || '').slice(0, 10))],
    ...(a.obs ? [['Observações', a.obs]] : []),
  ];

  app.innerHTML = `
    <article class="ficha">
      ${cabecalhoRelatorio('Ficha do animal')}
      <header class="ficha-topo">
        ${f ? `<img src="${f.foto}" alt="">` : ''}
        <div>
          <h2>${esc(nomeBrinco(a))} · ${esc(categoria(a))}</h2>
          <p class="dica">${esc([a.marca, idadeTexto(a), a.situacao !== 'ativo' ? textoSaida(a).toUpperCase() : ''].filter(Boolean).join(' · ')) || '&nbsp;'}</p>
        </div>
      </header>

      <section class="cartao">
        <h2>Identificação</h2>
        <dl class="dados">${ident.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      </section>

      ${fotosMorte(a).length ? `<section class="cartao">
        <h2>Fotos da morte</h2>
        <div class="fotos-morte">${fotosMorte(a).map(x => `<img src="${x.foto}" alt="">`).join('')}</div>
      </section>` : ''}

      <section class="cartao">
        <h2>Resumo sanitário</h2>
        ${sanidade.length ? `<table class="tabela">
          <thead><tr><th>Produto</th><th>Última vez</th><th>Vezes</th></tr></thead>
          <tbody>${sanidade.map(([p, r]) => `<tr><td>${esc(nomesProdutos([p]))}</td>
            <td>${fmtData(r.ultima)}<br><small>${haQuanto(r.ultima)}</small></td><td>${r.n}</td></tr>`).join('')}</tbody>
        </table>` : '<p class="dica">Nunca recebeu nenhum produto.</p>'}
      </section>

      <section class="cartao">
        <h2>Pesagens</h2>
        ${pesagens.length ? `<table class="tabela">
          <thead><tr><th>Data</th><th>Peso</th><th>Variação</th></tr></thead>
          <tbody>${pesagens.map((p, i) => {
            const ant = pesagens[i - 1];
            const v = ant ? p.peso - ant.peso : null;
            return `<tr><td>${fmtData(p.data)}<br><small>${p.origem}</small></td><td>${fmtKg(p.peso)}</td>
              <td>${v == null ? '' : (v >= 0 ? '+' : '') + dec(+v.toFixed(1)) + ' kg'}</td></tr>`;
          }).join('')}</tbody>
        </table>` : '<p class="dica">Nenhuma pesagem anotada.</p>'}
      </section>

      ${a.sexo === 'F' ? `<section class="cartao">
        <h2>Partos (${listaPartos.length})</h2>
        ${listaPartos.length ? `<table class="tabela">
          <thead><tr><th>Data</th><th>Filhotes</th></tr></thead>
          <tbody>${listaPartos.map(([d, fs]) => `<tr><td>${fmtData(d)}</td>
            <td>${fs.map(x => `<a href="#/ficha/${x.id}">${esc(NOMES[x.especie]['f' + x.sexo])}${x.brinco ? ' #' + esc(x.brinco) : ''}</a>${x.pesoNasc != null ? ' ' + fmtKg(x.pesoNasc) : ''}${x.situacao !== 'ativo' ? ' (' + esc(textoSaida(x).toLowerCase()) + ')' : ''}`).join('<br>')}</td></tr>`).join('')}</tbody>
        </table>` : '<p class="dica">Nenhum parto registrado.</p>'}
      </section>` : ''}

      <section class="cartao">
        <h2>Histórico completo (${aps.length})</h2>
        ${aps.length ? `<table class="tabela">
          <thead><tr><th>Data</th><th>Recebeu</th><th>Peso / obs.</th></tr></thead>
          <tbody>${aps.map(x => `<tr><td>${fmtData(x.m.data)}</td><td>${esc(nomesProdutos(x.produtoIds))}</td>
            <td>${[x.peso != null ? fmtKg(x.peso) : '', esc(x.obs)].filter(Boolean).join('<br>')}</td></tr>`).join('')}</tbody>
        </table>` : '<p class="dica">Nenhuma aplicação registrada.</p>'}
      </section>

      <p class="dica" style="text-align:center">Ficha gerada em ${fmtData(hoje())} às ${fmtHora(agoraISO())}</p>
    </article>

    <div class="nao-imprimir">
      <button class="btn primario" id="imprimir">🖨️ Imprimir / salvar PDF</button>
      ${navigator.share ? '<button class="btn" id="enviar">📤 Enviar como texto (WhatsApp)</button>' : ''}
      <a class="btn" href="#/animal/${a.id}">Abrir cadastro do animal</a>
    </div>`;

  $('#imprimir').onclick = () => window.print();
  const enviar = $('#enviar');
  if (enviar) enviar.onclick = () => {
    const linhas = [
      `*${NOME_SITIO}*`,
      `*Ficha ${nomeBrinco(a)} ${categoria(a)}*`,
      ...ident.map(([k, v]) => `${k}: ${v}`),
      '',
      '*Resumo sanitário*',
      ...(sanidade.length ? sanidade.map(([p, r]) => `${nomesProdutos([p])}: última em ${fmtData(r.ultima)} (${haQuanto(r.ultima)}), ${r.n}x`) : ['Nunca recebeu nenhum produto.']),
      ...(pesagens.length ? ['', '*Pesagens*', ...pesagens.map(p => `${fmtData(p.data)}: ${fmtKg(p.peso)}`)] : []),
      ...(a.sexo === 'F' && listaPartos.length ? ['', '*Partos*', ...listaPartos.map(([d, fs]) => `${fmtData(d)}: ${fs.length} filhote(s)`)] : []),
      '',
      '*Histórico*',
      ...(aps.length ? aps.map(x => `${fmtData(x.m.data)}: ${nomesProdutos(x.produtoIds)}${x.peso != null ? ' · ' + fmtKg(x.peso) : ''}${x.obs ? ' · ' + x.obs : ''}`) : ['Nenhuma aplicação.']),
    ];
    navigator.share({ title: `Ficha ${nomeBrinco(a)}`, text: linhas.join('\n') }).catch(() => {});
  };
}

/* Cadastro / edição de animal */
function opcoesMae(especie, atualId, selecionada) {
  const maes = ativos().filter(x => x.sexo === 'F' && x.especie === especie && x.id !== atualId && !ehFilhote(x)).sort(ordBrinco);
  return '<option value="">— sem mãe registrada —</option>' +
    maes.map(x => `<option value="${x.id}" ${x.id === selecionada ? 'selected' : ''}>${esc(rotulo(x))}</option>`).join('');
}

function editarAnimal(id) {
  const novo = !id || id === 'novo';
  const a = novo
    ? { especie: 'ovino', sexo: 'F', brinco: '', marca: '', nascimento: '', pesoNasc: null, maeId: '', situacao: 'ativo', obs: '' }
    : achar('animais', id);
  if (!a) return naoEncontrado();
  titulo(novo ? 'Cadastrar animal' : 'Editar ' + nomeBrinco(a), true);

  app.innerHTML = `<form id="f" class="form" autocomplete="off">
    <label>Espécie</label>${seg('especie', Object.entries(ESPECIES).map(([k, [n, ic]]) => [k, `${ic} ${n}`]), a.especie)}
    <label>Sexo</label>${seg('sexo', [['F', 'Fêmea'], ['M', 'Macho']], a.sexo)}
    <div id="campoRepro" ${a.sexo === 'M' ? '' : 'hidden'}>
      <label>Será reprodutor?</label>${seg('reprodutor', [['sim', 'Sim, reprodutor'], ['nao', 'Não']], a.reprodutor ? 'sim' : 'nao')}
    </div>
    <label>Nº do brinco<input name="brinco" value="${esc(a.brinco)}" inputmode="numeric"></label>
    <label>Marca / cor do brinco <small>(opcional — ajuda a diferenciar números repetidos)</small>
      <input name="marca" value="${esc(a.marca)}" placeholder="ex.: brinco amarelo, mancha preta"></label>
    ${campoFoto(fotoDe(a.id)?.foto)}
    <div class="duas">
      <label>Nascimento<input type="date" name="nascimento" value="${a.nascimento || ''}" max="${hoje()}"></label>
      <label>Peso ao nascer (kg)<input name="pesoNasc" inputmode="decimal" value="${dec(a.pesoNasc)}"></label>
    </div>
    <label>Mãe<select name="maeId">${opcoesMae(a.especie, a.id, a.maeId)}</select></label>
    ${novo ? '' : `<label>Situação</label>${seg('situacao', Object.entries(SITUACAO), a.situacao)}`}
    <label>Observações<textarea name="obs" rows="2">${esc(a.obs)}</textarea></label>
    <button class="btn primario grande">Salvar</button>
    ${novo ? '' : '<button type="button" class="btn perigo" id="excluir">Excluir cadastro</button>'}
  </form>`;

  const f = $('#f');
  const foto = ligarFoto(f);
  ligarSeg(f, (nome, v) => {
    if (nome === 'especie') f.maeId.innerHTML = opcoesMae(v, a.id, '');
    if (nome === 'sexo') $('#campoRepro').hidden = v !== 'M';
  });

  f.onsubmit = e => {
    e.preventDefault();
    const dados = {
      especie: valorSeg(f, 'especie'),
      sexo: valorSeg(f, 'sexo'),
      reprodutor: valorSeg(f, 'sexo') === 'M' && valorSeg(f, 'reprodutor') === 'sim',
      brinco: f.brinco.value.trim(),
      marca: f.marca.value.trim(),
      nascimento: f.nascimento.value,
      pesoNasc: num(f.pesoNasc.value),
      maeId: f.maeId.value,
      obs: f.obs.value.trim(),
      situacao: novo ? 'ativo' : valorSeg(f, 'situacao'),
    };
    if (!dados.brinco && !dados.maeId) return toast('Informe o nº do brinco (ou a mãe, se for filhote sem brinco).');
    if (!confirmarDuplicado(dados, a.id)) return;
    // Situação mudada pelo formulário: guarda a data de hoje como data da saída.
    if (!novo && dados.situacao !== a.situacao) {
      dados.saida = dados.situacao === 'ativo' ? null : { tipo: dados.situacao, data: hoje(), obs: '' };
    }
    Object.assign(a, dados);
    gravar('animais', a);
    salvarFoto(a.id, foto);
    toast('Salvo ✔');
    location.replace('#/animal/' + a.id);
  };

  if (!novo) $('#excluir').onclick = () => {
    const n = lista('aplicacoes').filter(x => x.animalId === a.id).length;
    if (!confirm(`Excluir ${rotulo(a)}?${n ? `\nEle tem ${n} aplicação(ões) registradas, que também deixarão de aparecer.` : ''}\n\nSe o animal foi vendido ou morreu, prefira mudar a "Situação".`)) return;
    excluir('animais', a.id);
    toast('Cadastro excluído');
    navegar('#/animais');
  };
}

// Brinco repetido entre espécies é normal (ovelha 12 e cabra 12).
// Na mesma espécie avisamos, mas deixamos salvar.
function confirmarDuplicado(dados, idAtual) {
  if (!dados.brinco) return true;
  const dup = ativos().filter(x => x.id !== idAtual && x.brinco === dados.brinco && x.especie === dados.especie);
  if (!dup.length) return true;
  return confirm(`Já existe ${dup.map(rotulo).join(', ')} com esse número.\n\nSalvar mesmo assim? Dica: preencha "Marca / cor do brinco" ou tire uma foto para diferenciar.`);
}

/* Nascimento */
function nascimento(maeId) {
  const m = maeId ? achar('animais', maeId) : null;
  titulo('Registrar parto', !!maeId);

  if (!m) {
    app.innerHTML = `
      <p class="dica">Digite o brinco da mãe e toque nela.</p>
      <input class="campo-brinco" id="q" inputmode="numeric" placeholder="Brinco da mãe" autocomplete="off">
      <div id="res" style="margin-top:12px"></div>`;
    const q = $('#q');
    const desenhar = () => {
      const t = q.value.trim().toLowerCase();
      if (!t) { $('#res').innerHTML = ''; return; }
      const l = ativos().filter(a => a.sexo === 'F' && !ehFilhote(a) && (a.brinco || '').toLowerCase().startsWith(t))
        .sort((a, b) => (b.brinco.toLowerCase() === t) - (a.brinco.toLowerCase() === t) || ordBrinco(a, b));
      const exato = l.some(a => a.brinco.toLowerCase() === t);
      $('#res').innerHTML = l.map(a => itemAnimal(a, { link: '#/nascimento/' + a.id })).join('') +
        (exato ? '' : `<div class="vazio">Nenhuma fêmea com brinco <b>${esc(q.value.trim())}</b>. Cadastrar a mãe agora:</div>
          <div class="criar">${Object.keys(ESPECIES).map(e => `<button class="btn" data-esp="${e}">${NOMES[e].F} #${esc(q.value.trim())}</button>`).join('')}</div>`);
    };
    q.oninput = desenhar;
    $('#res').onclick = e => {
      const b = e.target.closest('[data-esp]');
      if (!b) return;
      const nova = { especie: b.dataset.esp, sexo: 'F', brinco: q.value.trim(), marca: '', nascimento: '', pesoNasc: null, maeId: '', situacao: 'ativo', obs: '' };
      if (!confirmarDuplicado(nova)) return;
      gravar('animais', nova);
      navegar('#/nascimento/' + nova.id);
    };
    q.focus();
    return;
  }

  const filhos = lista('animais').filter(x => x.maeId === m.id).sort((x, y) => (y.criadoEm || '').localeCompare(x.criadoEm || ''));
  const nomeF = NOMES[m.especie].fF.toLowerCase(), nomeM = NOMES[m.especie].fM.toLowerCase();
  app.innerHTML = `
    <div class="cartao"><small>Mãe</small>${itemAnimal(m)}<a href="#/nascimento" class="dica">Trocar mãe</a></div>
    <form id="f" class="form cartao" autocomplete="off">
      <h2>Filhote</h2>
      <label>Sexo</label>${seg('sexo', [['F', 'Fêmea (' + nomeF + ')'], ['M', 'Macho (' + nomeM + ')']], '')}
      <div class="duas">
        <label>Data do nascimento<input type="date" name="nascimento" value="${hoje()}" max="${hoje()}" required></label>
        <label>Peso (kg)<input name="peso" inputmode="decimal" placeholder="ex.: 3,5"></label>
      </div>
      <label>Nº do brinco <small>(se já tiver)</small><input name="brinco" inputmode="numeric"></label>
      ${campoFoto()}
      <label>Observações<input name="obs" placeholder="ex.: gêmeo, nasceu fraco"></label>
      <button class="btn primario grande">Salvar filhote</button>
    </form>
    ${filhos.length ? `<h2>Filhotes desta mãe (${filhos.length})</h2><ul class="lista">${filhos.map(x => `<li>${itemAnimal(x)}</li>`).join('')}</ul>` : ''}
  `;
  const f = $('#f');
  const foto = ligarFoto(f);
  ligarSeg(f);
  f.onsubmit = e => {
    e.preventDefault();
    const sexo = valorSeg(f, 'sexo');
    if (!sexo) return toast('Escolha o sexo do filhote.');
    const novo = {
      especie: m.especie, sexo, brinco: f.brinco.value.trim(), marca: '',
      nascimento: f.nascimento.value, pesoNasc: num(f.peso.value), maeId: m.id,
      situacao: 'ativo', obs: f.obs.value.trim(),
    };
    if (!confirmarDuplicado(novo)) return;
    gravar('animais', novo);
    salvarFoto(novo.id, foto);
    toast('Filhote salvo ✔ — se for gêmeo, registre o próximo.');
    render();
  };
}

/* Vacinação: marca no topo o que está aplicando e toca no animal para lançar,
   sem janela nem pergunta. Peso/obs. e correções ficam no botão "⋯".
   O dia de vacinação (manejo) é criado sozinho no primeiro lançamento. */
let abaLancar = 'todos';
let especieVacina = 'todos';
let dataVacina = null;
let produtosSel = null; // Set com os produtos marcados no topo da tela

const baseLancar = m => ativos().filter(a => m.publico === 'todos' || a.especie === m.publico);
const baseVacina = () => ativos().filter(a => especieVacina === 'todos' || a.especie === especieVacina);

function garantirManejo() {
  return manejoAberto() || gravar('manejos', {
    data: dataVacina || hoje(), produtoIds: [], publico: 'todos', obs: '', aberto: true,
  });
}

function vacinacao() {
  titulo('Vacinação');
  const m = manejoAberto();
  dataVacina = m ? m.data : dataVacina || hoje();
  const especiesUsadas = Object.keys(ESPECIES).filter(e => ativos().some(a => a.especie === e));
  if (especieVacina !== 'todos' && !especiesUsadas.includes(especieVacina)) especieVacina = 'todos';
  const historico = lista('manejos').filter(x => !x.aberto).sort((a, b) => b.data.localeCompare(a.data));
  const prods = lista('produtos').filter(usadoNaVacina);
  // Na primeira vez, já vem marcado o que o último animal recebeu.
  if (!produtosSel) produtosSel = new Set(m ? ultimoLancado(m) : []);
  for (const id of [...produtosSel]) if (!prods.some(p => p.id === id)) produtosSel.delete(id);

  app.innerHTML = `
    <div class="linha-data">
      <label>Data da vacinação<input type="date" id="dataVacina" value="${dataVacina}" max="${hoje()}"></label>
      <div class="progresso"><div class="barra"><span id="pbar"></span></div><span id="ptxt"></span></div>
    </div>
    ${especiesUsadas.length > 1 ? `<div class="chips" id="especies" style="margin-bottom:8px">
      ${[['todos', 'Todos'], ...especiesUsadas.map(e => [e, `${ESPECIES[e][1]} ${PUBLICO[e]}`])].map(([v, t]) =>
        `<button class="chip ${v === especieVacina ? 'on' : ''}" data-v="${v}">${t}</button>`).join('')}
    </div>` : ''}
    <div class="painel-lancar">
      <div class="aplicando">
        <span>Aplicando agora <small>(toque para marcar)</small></span>
        <div class="chips" id="selProdutos">
          ${prods.map(p => `<button class="chip ${produtosSel.has(p.id) ? 'on' : ''}" data-id="${p.id}">${esc(p.nome)}</button>`).join('')}
        </div>
      </div>
      <input id="q" class="campo-brinco" inputmode="numeric" placeholder="Buscar nº do brinco" autocomplete="off" enterkeyhint="done">
      <div class="abas" id="abas">
        <button data-aba="todos">Todos <b id="nt"></b></button>
        <button data-aba="faltam">Faltam <b id="nf"></b></button>
        <button data-aba="feitos">Feitos <b id="nd"></b></button>
      </div>
    </div>
    <p class="dica" style="margin:0 0 8px">Toque no animal e ele já fica lançado. Use <b>⋯</b> para anotar peso ou observação.</p>
    <div id="res"></div>
    <button class="btn" id="encerrar" style="margin-top:24px" hidden>✅ Encerrar o dia de vacinação</button>
    <a class="btn" href="#/produtos">💊 Ver / cadastrar produtos</a>
    <h2>Histórico</h2>
    ${historico.length ? `<ul class="lista">${historico.map(itemManejo).join('')}</ul>` : '<p class="dica">Nenhuma vacinação encerrada ainda.</p>'}`;

  const q = $('#q');
  q.oninput = atualizarLancar;
  q.onkeydown = e => {
    if (e.key !== 'Enter') return;
    // Enter com um único animal com esse brinco = lança direto
    const t = q.value.trim().toLowerCase();
    const exatos = baseVacina().filter(a => a.brinco && a.brinco.toLowerCase() === t);
    if (exatos.length === 1) lancarRapido(exatos[0].id);
  };
  $('#selProdutos').onclick = e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    b.classList.toggle('on');
    if (b.classList.contains('on')) produtosSel.add(b.dataset.id); else produtosSel.delete(b.dataset.id);
    $('#selProdutos').classList.remove('alerta');
  };
  $('#dataVacina').onchange = e => {
    if (!e.target.value) return;
    dataVacina = e.target.value;
    const aberto = manejoAberto();
    if (aberto) { aberto.data = dataVacina; gravar('manejos', aberto); }
  };
  const esp = $('#especies');
  if (esp) esp.onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    especieVacina = b.dataset.v;
    $$('#especies .chip').forEach(x => x.classList.toggle('on', x === b));
    atualizarLancar();
  };
  $('#abas').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    abaLancar = b.dataset.aba;
    atualizarLancar();
  };
  $('#res').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.animal) lancarRapido(b.dataset.animal);
    else if (b.dataset.detalhe) abrirLancamento(b.dataset.detalhe);
    else if (b.dataset.criar) criarEabrir(b.dataset.criar, q.value.trim());
  };
  $('#encerrar').onclick = () => {
    const m = manejoAberto();
    if (!m) return;
    const faltam = baseLancar(m).length - new Set(aplicacoesDo(m.id).map(x => x.animalId)).size;
    if (!confirm(faltam > 0 ? `${faltam} animal(is) não foram lançados. Encerrar o dia mesmo assim?` : 'Encerrar este dia de vacinação?')) return;
    m.aberto = false;
    gravar('manejos', m);
    toast('Dia de vacinação encerrado ✔');
    navegar('#/manejo/' + m.id);
  };
  atualizarLancar();
}

function atualizarLancar() {
  const m = manejoAberto();
  const q = $('#q');
  if (!q) return;
  const base = baseVacina();
  const aps = m ? aplicacoesDo(m.id) : [];
  const porAnimal = new Map(aps.map(x => [x.animalId, x]));
  const feitos = base.filter(a => porAnimal.has(a.id)).length;

  $('#pbar').style.width = (base.length ? (100 * feitos / base.length) : 0) + '%';
  $('#ptxt').textContent = `${feitos} de ${base.length} lançados`;
  $('#nt').textContent = base.length;
  $('#nf').textContent = base.length - feitos;
  $('#nd').textContent = feitos;
  $$('#abas button').forEach(b => b.classList.toggle('on', b.dataset.aba === abaLancar));
  $('#encerrar').hidden = !m;

  // Animal ainda não lançado: tocar lança na hora; "⋯" abre peso/obs.
  // Animal já lançado: tocar abre para corrigir ou remover.
  const cartao = a => {
    const ap = porAnimal.get(a.id);
    const extra = ap ? `<span class="feito-txt">✔ ${fmtHora(ap.criadoEm)}</span>` : '';
    const recebeu = ap ? `<div class="recebeu">${esc(nomesProdutos(ap.produtoIds))}${ap.peso != null ? ' · ' + fmtKg(ap.peso) : ''}${ap.obs ? ' · ' + esc(ap.obs) : ''}</div>` : '';
    return `<div class="alvo ${ap ? 'feito' : ''}">
      <div class="alvo-linha">
        ${itemAnimal(a, { tag: 'button', extra, attrs: ap ? `data-detalhe="${a.id}"` : `data-animal="${a.id}"` })}
        ${ap ? '' : `<button class="ajustar" data-detalhe="${a.id}" aria-label="Lançar com peso ou observação">⋯</button>`}
      </div>${recebeu}
    </div>`;
  };

  // Animais da aba escolhida; "Feitos" mostra o último lançado primeiro.
  let l = abaLancar === 'faltam' ? base.filter(a => !porAnimal.has(a.id)).sort(ordBrinco)
    : abaLancar === 'feitos' ? base.filter(a => porAnimal.has(a.id))
      .sort((x, y) => porAnimal.get(y.id).criadoEm.localeCompare(porAnimal.get(x.id).criadoEm))
    : [...base].sort(ordBrinco);

  // Busca pelo brinco: exato primeiro, depois filhotes sem brinco dessa mãe, depois os que começam com o número.
  const t = q.value.trim().toLowerCase();
  let criar = '';
  if (t) {
    const maes = new Set(lista('animais').filter(a => (a.brinco || '').toLowerCase() === t).map(a => a.id));
    const nota = a => {
      const b = (a.brinco || '').toLowerCase();
      return b === t ? 0 : !b && maes.has(a.maeId) ? 1 : b && b.startsWith(t) ? 2 : -1;
    };
    l = l.filter(a => nota(a) >= 0).sort((x, y) => nota(x) - nota(y));
    if (!base.some(a => (a.brinco || '').toLowerCase() === t)) {
      const especies = especieVacina === 'todos' ? Object.keys(ESPECIES) : [especieVacina];
      criar = `<div class="vazio">Nenhum animal com brinco <b>${esc(q.value.trim())}</b>. Cadastrar agora:</div>
        <div class="criar">${especies.flatMap(e => ['F', 'M'].map(s =>
          `<button class="btn" data-criar="${e}-${s}">${NOMES[e][s]} #${esc(q.value.trim())}</button>`)).join('')}</div>`;
    }
  }

  const vazio = !base.length ? 'Nenhum animal cadastrado. Use ➕ Cadastrar.'
    : abaLancar === 'faltam' ? '🎉 Todos os animais já foram lançados!'
    : abaLancar === 'feitos' ? 'Nenhum animal lançado ainda.' : '';
  $('#res').innerHTML = l.length ? l.map(cartao).join('') + criar
    : criar || `<div class="vazio">${vazio}</div>`;
}

function criarEabrir(chave, brinco) {
  const [especie, sexo] = chave.split('-');
  const novo = { especie, sexo, brinco, marca: '', nascimento: '', pesoNasc: null, maeId: '', situacao: 'ativo', obs: 'Cadastrado durante a vacinação' };
  if (!confirmarDuplicado(novo)) return;
  gravar('animais', novo);
  lancarRapido(novo.id);
}

// Lança o animal com o que está marcado no topo, sem perguntar nada.
function lancarRapido(animalId) {
  const a = achar('animais', animalId);
  if (!a) return;
  if (!produtosSel || !produtosSel.size) {
    toast('Marque em cima o que está aplicando.');
    $('#selProdutos')?.classList.add('alerta');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const m = manejoAberto();
  if (m && aplicacoesDo(m.id).some(x => x.animalId === animalId)) return abrirLancamento(animalId);
  const novo = gravar('aplicacoes', { manejoId: garantirManejo().id, animalId, produtoIds: [...produtosSel], peso: null, obs: '' });
  toast(`✔ ${nomeBrinco(a)} ${categoria(a)}`, 'Desfazer', () => { excluir('aplicacoes', novo.id); atualizarLancar(); });
  if (navigator.vibrate) navigator.vibrate(40);
  depoisDeLancar();
}

// Limpa a busca e deixa pronto para o próximo animal.
function depoisDeLancar() {
  const q = $('#q');
  if (!q) return;
  const buscando = !!q.value;
  q.value = '';
  atualizarLancar();
  if (buscando) q.focus();
}

// O que o último animal lançado recebeu (para o botão "igual ao anterior").
function ultimoLancado(m, exceto) {
  const ult = aplicacoesDo(m.id).filter(x => x.animalId !== exceto)
    .sort((x, y) => y.atualizadoEm.localeCompare(x.atualizadoEm))[0];
  return ult ? ult.produtoIds.filter(id => achar('produtos', id)) : [];
}

function abrirLancamento(animalId) {
  const m = manejoAberto();
  const a = achar('animais', animalId);
  if (!a) return;
  const ap = m && aplicacoesDo(m.id).find(x => x.animalId === animalId);
  const marcados = new Set(ap ? ap.produtoIds : produtosSel || []);
  const prods = lista('produtos').filter(p => usadoNaVacina(p) || marcados.has(p.id));
  const anterior = ap || !m ? [] : ultimoLancado(m, animalId);
  const ult = historicoDe(a)[0];
  const f = fotoDe(a.id);
  $('#q')?.blur();

  const caixa = modal(`
    <div class="modal-animal">
      ${f ? `<img src="${f.mini}" alt="">` : ''}
      <div><h3>${esc(rotulo(a))}</h3>
      <p class="dica" style="margin:0">${ap ? 'Lançado às ' + fmtHora(ap.criadoEm) + '. Altere ou remova.'
        : ult && (!m || ult.manejoId !== m.id) ? `Última vez: ${fmtData(ult.m.data)} — ${esc(nomesProdutos(ult.produtoIds))}` : 'O que este animal recebeu?'}</p></div>
    </div>
    <form id="fa" class="form">
      <div class="chips grandes" id="prods">
        ${prods.map(p => `<button type="button" class="chip ${marcados.has(p.id) ? 'on' : ''}" data-id="${p.id}">${esc(p.nome)}${p.dose ? `<small>${esc(p.dose)}</small>` : ''}</button>`).join('')}
      </div>
      ${anterior.length ? `<button type="button" class="btn" id="repetir">↺ Igual ao anterior: ${esc(nomesProdutos(anterior))}</button>` : ''}
      <div class="duas">
        <label>Peso (kg)<input name="peso" inputmode="decimal" value="${ap ? dec(ap.peso) : ''}"></label>
        <label>Obs.<input name="obs" value="${esc(ap ? ap.obs : '')}" placeholder="ex.: tosse, magra"></label>
      </div>
      <button class="btn primario grande">${ap ? 'Salvar alteração' : 'Lançar'}</button>
      ${ap ? '<button type="button" class="btn perigo" id="remover">Remover lançamento</button>' : ''}
      <button type="button" class="btn" id="cancelar">Cancelar</button>
    </form>`);
  const fa = $('#fa', caixa);
  $('#prods', caixa).onclick = e => {
    const b = e.target.closest('.chip');
    if (b) b.classList.toggle('on');
  };
  const rep = $('#repetir', caixa);
  if (rep) rep.onclick = () => $$('#prods .chip', caixa).forEach(b => b.classList.toggle('on', anterior.includes(b.dataset.id)));
  $('#cancelar', caixa).onclick = fecharModal;
  if (ap) $('#remover', caixa).onclick = () => {
    excluir('aplicacoes', ap.id);
    fecharModal();
    toast('Lançamento removido');
    atualizarLancar();
  };
  fa.onsubmit = e => {
    e.preventDefault();
    const produtoIds = $$('#prods .chip.on', caixa).map(b => b.dataset.id);
    if (!produtoIds.length) return toast('Marque pelo menos um produto.');
    const dados = { produtoIds, peso: num(fa.peso.value), obs: fa.obs.value.trim() };
    fecharModal();
    if (ap) {
      Object.assign(ap, dados);
      gravar('aplicacoes', ap);
      toast('Alterado ✔');
    } else {
      const novo = gravar('aplicacoes', { manejoId: garantirManejo().id, animalId, ...dados });
      toast('✔ ' + rotulo(a), 'Desfazer', () => { excluir('aplicacoes', novo.id); atualizarLancar(); });
      if (navigator.vibrate) navigator.vibrate(40);
    }
    depoisDeLancar();
  };
}

/* Resumo de uma vacinação */
function manejo(id) {
  const m = achar('manejos', id);
  if (!m) return naoEncontrado();
  titulo('Vacinação ' + fmtData(m.data), true);
  const aps = aplicacoesDo(m.id).map(x => ({ ...x, a: achar('animais', x.animalId) })).filter(x => x.a)
    .sort((x, y) => ordBrinco(x.a, y.a));
  const feitos = new Set(aps.map(x => x.animalId));
  const naoReceberam = baseLancar(m).filter(a => !feitos.has(a.id)).sort(ordBrinco);
  const pesos = aps.filter(x => x.peso != null);
  const media = pesos.length ? (pesos.reduce((s, x) => s + x.peso, 0) / pesos.length).toFixed(1) : null;
  const cont = {};
  aps.forEach(x => { const c = categoria(x.a); cont[c] = (cont[c] || 0) + 1; });
  const prods = produtosDoManejo(m);

  app.innerHTML = `
    ${cabecalhoRelatorio('Relatório de vacinação · ' + fmtData(m.data))}
    <div class="cartao">
      <dl class="dados">
        <dt>Data</dt><dd>${fmtData(m.data)}</dd>
        <dt>Animais</dt><dd>${PUBLICO[m.publico]}</dd>
        <dt>Lançados</dt><dd>${aps.length}${Object.keys(cont).length ? ' (' + Object.entries(cont).map(([c, n]) => `${n} ${c.toLowerCase()}`).join(', ') + ')' : ''}</dd>
        ${media ? `<dt>Peso médio</dt><dd>${dec(media)} kg (${pesos.length} pesado${pesos.length > 1 ? 's' : ''})</dd>` : ''}
        ${m.obs ? `<dt>Obs.</dt><dd>${esc(m.obs)}</dd>` : ''}
        <dt>Situação</dt><dd>${m.aberto ? 'em andamento' : 'encerrada'}</dd>
      </dl>
    </div>
    ${prods.length ? `<div class="cartao"><h2>Produtos usados</h2><dl class="dados">
      ${prods.map(([p, n]) => `<dt>${esc(nomesProdutos([p]))}</dt><dd>${n} animal(is)</dd>`).join('')}</dl></div>` : ''}
    <button class="btn primario" id="imprimir">🖨️ Imprimir / salvar PDF</button>
    ${m.aberto ? '<a class="btn" href="#/vacinacao">Continuar lançamento</a>'
      : `<button class="btn" id="reabrir">Reabrir para lançar mais</button>`}

    <h2>Lançados (${aps.length})</h2>
    ${aps.length ? `<ul class="lista">${aps.map(x => `<li class="alvo-resumo">${itemAnimal(x.a, { link: '#/ficha/' + x.a.id })}
      <div class="recebeu">${esc(nomesProdutos(x.produtoIds))}${x.peso != null ? ' · ' + fmtKg(x.peso) : ''}${x.obs ? ' · ' + esc(x.obs) : ''}</div></li>`).join('')}</ul>`
      : '<p class="dica">Ninguém lançado.</p>'}

    ${naoReceberam.length ? `<h2>Não lançados (${naoReceberam.length})</h2>
      <p class="dica">Animais ativos hoje que não aparecem nesta vacinação.</p>
      <ul class="lista">${naoReceberam.map(a => `<li>${itemAnimal(a)}</li>`).join('')}</ul>` : ''}

    <button class="btn perigo" id="apagar" style="margin-top:24px">Excluir esta vacinação</button>
  `;
  $('#imprimir').onclick = () => window.print();
  const re = $('#reabrir');
  if (re) re.onclick = () => {
    if (manejoAberto()) return toast('Já existe outra vacinação em andamento. Encerre ela primeiro.');
    m.aberto = true;
    gravar('manejos', m);
    navegar('#/vacinacao');
  };
  $('#apagar').onclick = () => {
    if (!confirm(`Excluir a vacinação de ${fmtData(m.data)} com ${aps.length} lançamentos?`)) return;
    aps.forEach(x => excluir('aplicacoes', x.id));
    excluir('manejos', m.id);
    toast('Vacinação excluída');
    navegar('#/vacinacao');
  };
}

/* Produtos */
function produtos() {
  titulo('Produtos', true);
  const l = lista('produtos').sort((a, b) => !!a.inativo - !!b.inativo || a.nome.localeCompare(b.nome));
  app.innerHTML = `
    <p class="dica">Vacinas, vermífugos, vitaminas, antibióticos e remédios que vocês usam. Eles aparecem como opção na hora de lançar cada animal.</p>
    <ul class="lista">${l.map(p => `<li><button class="item ${p.inativo ? 'inativo' : ''}" data-id="${p.id}">
      <span class="info"><strong>${esc(p.nome)}</strong><small>${TIPOS_PRODUTO[p.tipo] || ''}${p.dose ? ' · ' + esc(p.dose) : ''}${p.inativo ? ' · não usa mais' : ''}</small></span>✏️</button></li>`).join('')}</ul>
    <button class="btn primario" id="novo">➕ Novo produto</button>`;
  $('#novo').onclick = () => editarProduto();
  $('.lista').onclick = e => {
    const b = e.target.closest('[data-id]');
    if (b) editarProduto(achar('produtos', b.dataset.id));
  };
}

function editarProduto(p) {
  const novo = !p;
  p = p || { nome: '', tipo: 'vacina', dose: '' };
  const caixa = modal(`
    <h3>${novo ? 'Novo produto' : 'Editar produto'}</h3>
    <form id="fp" class="form">
      <label>Nome<input name="nome" value="${esc(p.nome)}" required placeholder="ex.: Ivomec, ADE, Polivalente"></label>
      <label>Tipo<select name="tipo">${Object.entries(TIPOS_PRODUTO).map(([v, t]) => `<option value="${v}" ${v === p.tipo ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Dose <small>(opcional)</small><input name="dose" value="${esc(p.dose)}" placeholder="ex.: 1 ml / 10 kg"></label>
      ${novo ? '' : `<label class="checks"><label><input type="checkbox" name="inativo" ${p.inativo ? 'checked' : ''}> Não usamos mais (esconde da lista)</label></label>`}
      <button class="btn primario grande">Salvar</button>
      <button type="button" class="btn" id="cancelar">Cancelar</button>
    </form>`);
  const f = $('#fp', caixa);
  $('#cancelar', caixa).onclick = fecharModal;
  f.onsubmit = e => {
    e.preventDefault();
    Object.assign(p, { nome: f.nome.value.trim(), tipo: f.tipo.value, dose: f.dose.value.trim() });
    if (!novo) p.inativo = f.inativo.checked;
    gravar('produtos', p);
    fecharModal();
    render();
  };
  f.nome.focus();
}

/* Mais: backup, planilhas, configurações */
function mais() {
  titulo('Mais');
  const nFotos = [...fotos.values()].filter(f => f.foto).length;
  app.innerHTML = `
    ${botaoInstalar()}
    <a class="btn primario" href="guia.html">❓ Como usar o app (vídeo)</a>
    <a class="btn" href="#/produtos">💊 Produtos (vacinas, vermífugos…)</a>
    <a class="btn" href="#/almoxarifado">🧰 Almoxarifado (o que precisa comprar)</a>

    ${nuvem.configurada ? `<h2>☁️ Nuvem</h2>
    <div class="cartao">
      ${nuvem.usuario ? `<p style="margin-top:0">Conectado como <b>${esc(nuvem.usuario.email)}</b>.</p>
        <p class="dica">Tudo o que é lançado aqui vai sozinho para a nuvem e aparece no outro celular.
        Se este celular quebrar ou for trocado, é só entrar de novo com o mesmo e-mail e senha.</p>
        <p class="dica">Situação: <b id="textoNuvem"></b></p>
        <button class="btn" id="sairNuvem">Sair desta conta neste celular</button>`
      : '<p class="dica" style="margin:0">Conectando à nuvem…</p>'}
    </div>` : ''}

    <h2>Planilhas (Excel)</h2>
    <button class="btn" id="csvAnimais">📄 Animais (.csv)</button>
    <button class="btn" id="csvAplic">📄 Aplicações (.csv)</button>
    <button class="btn" id="csvCompras">📄 Compras do almoxarifado (.csv)</button>

    <h2>Configuração</h2>
    <form class="form cartao" id="cfg">
      <p class="dica" style="margin-top:0">Até quantos dias de vida o animal conta como filhote:</p>
      <div class="duas">${Object.entries(ESPECIES).map(([e]) => `<label style="margin-top:0">${NOMES[e].fM}/${NOMES[e].fF.toLowerCase()}
        <input name="${e}" inputmode="numeric" value="${db.config.filhote[e]}"></label>`).join('')}</div>
      <button class="btn">Salvar</button>
    </form>

    <button class="btn perigo" id="zerar" style="margin-top:24px">Apagar todos os dados deste celular</button>
    <p class="dica" style="text-align:center">${NOME_SITIO} · ${lista('animais').length} animais · ${nFotos} fotos · ${lista('aplicacoes').length} aplicações</p>`;

  ligarInstalar();
  const sair = $('#sairNuvem');
  if (sair) sair.onclick = sairDaNuvem;
  atualizarStatusNuvem();
  $('#csvAnimais').onclick = () => baixar(csvAnimais());
  $('#csvAplic').onclick = () => baixar(csvAplicacoes());
  $('#csvCompras').onclick = () => baixar(csvCompras());
  $('#cfg').onsubmit = e => {
    e.preventDefault();
    const dias = Object.fromEntries(Object.keys(ESPECIES).map(k => [k, parseInt(e.target[k].value, 10)]));
    if (!Object.values(dias).every(d => d > 0)) return toast('Informe um número de dias válido.');
    db.config.filhote = dias;
    salvar();
    toast('Configuração salva ✔');
  };
  $('#zerar').onclick = apagarTudo;
}

// Apagar tudo passa por 4 perguntas, para não acontecer por acidente.
// Em todas, o botão de destaque é o de NÃO apagar.
function apagarTudo() {
  const nFotos = [...fotos.values()].filter(f => f.foto).length;
  const resumo = `${lista('animais').length} animais, ${lista('manejos').length} vacinações, ${lista('aplicacoes').length} aplicações e ${nFotos} fotos`;

  const passo = (n, html, aoContinuar) => {
    const caixa = modal(`
      <p class="dica" style="margin:0 0 4px">Pergunta ${n} de 4</p>
      ${html}
      <button class="btn primario grande" id="naoApagar">Não, manter meus dados</button>
      <button class="btn perigo" id="continuar">${n < 4 ? 'Sim, continuar' : 'Apagar tudo agora'}</button>`);
    $('#naoApagar', caixa).onclick = () => { fecharModal(); toast('Nada foi apagado'); };
    $('#continuar', caixa).onclick = () => aoContinuar(caixa);
    return caixa;
  };

  const pergunta1 = () => passo(1, `<h3>⚠️ Apagar todos os dados deste celular?</h3>
    <p>Isso apaga <b>${resumo}</b>.</p>
    ${nuvem.usuario ? '<p>A nuvem <b>não</b> é apagada: depois, os dados baixam de novo para este celular.</p>' : ''}`, pergunta2);

  const pergunta2 = () => {
    const faltaSubir = nuvem.pendentes > 0 || !navigator.onLine;
    passo(2, nuvem.usuario
      ? `<h3>☁️ A nuvem está em dia?</h3>
        ${faltaSubir
          ? `<p><b>Ainda há alterações que não subiram para a nuvem</b>${nuvem.pendentes ? ` (${nuvem.pendentes})` : ''}. Se apagar agora, elas se perdem.</p>
             <p>Espere ter internet e o ícone ☁️ aparecer no topo.</p>`
          : '<p>Tudo está salvo na nuvem. Depois de apagar, os dados baixam de novo para este celular.</p>'}`
      : `<h3>☁️ Sem nuvem neste celular</h3>
        <p>Este celular não está conectado à nuvem. Depois de apagar, os dados <b>não podem ser recuperados</b>.</p>`, pergunta3);
  };

  const pergunta3 = () => passo(3, `<h3>❗ Tem certeza absoluta?</h3>
    <p>Depois de apagar, <b>não tem como desfazer</b>. Todos os animais, vacinações, partos, vendas e fotos somem deste celular.</p>`, pergunta4);

  const pergunta4 = () => {
    const caixa = passo(4, `<h3>✍️ Última confirmação</h3>
      <p>Digite <b>APAGAR</b> (em letras maiúsculas) para confirmar.</p>
      <input id="palavra" autocomplete="off" autocapitalize="characters" placeholder="APAGAR">`, c => {
        if ($('#palavra', c).value.trim() !== 'APAGAR') return toast('Palavra diferente de APAGAR. Nada foi apagado.');
        db = bancoVazio();
        salvar();
        fotos.clear();
        if (idb) idb.transaction('fotos', 'readwrite').objectStore('fotos').clear();
        fecharModal();
        // Com a nuvem ligada, só este celular foi limpo: recarrega para baixar tudo de novo.
        if (nuvem.usuario) return location.reload();
        toast('Todos os dados foram apagados');
        navegar('#/inicio');
      });
    $('#palavra', caixa).focus();
  };

  pergunta1();
}

function baixar(arquivo) {
  const url = URL.createObjectURL(arquivo);
  const a = Object.assign(document.createElement('a'), { href: url, download: arquivo.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csv(nome, cabecalho, linhas) {
  const cel = v => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const texto = '﻿' + [cabecalho, ...linhas].map(l => l.map(cel).join(';')).join('\r\n');
  return new File([texto], `${nome}-${hoje()}.csv`, { type: 'text/csv' });
}

function csvAnimais() {
  return csv('sitio-fartura-animais',
    ['Brinco', 'Espécie', 'Sexo', 'Reprodutor', 'Categoria', 'Marca/cor', 'Nascimento', 'Peso nasc. (kg)', 'Brinco da mãe', 'Situação', 'Data da saída', 'Causa / obs. da saída', 'Comprador', 'Peso na saída (kg)', 'Valor por kg (R$)', 'Valor total (R$)', 'Obs.'],
    lista('animais').sort(ordBrinco).map(a => [a.brinco, nomeEspecie(a), a.sexo === 'F' ? 'Fêmea' : 'Macho',
      a.sexo === 'M' ? (a.reprodutor ? 'Sim' : 'Não') : '', categoria(a), a.marca, fmtData(a.nascimento), dec(a.pesoNasc), mae(a)?.brinco || '',
      SITUACAO[a.situacao] || a.situacao, a.saida && a.saida.data ? fmtData(a.saida.data) : '', a.saida ? a.saida.obs : '',
      a.saida?.comprador || '', dec(a.saida?.peso), dec(a.saida?.valorKg), dec(a.saida?.total), a.obs]));
}
function csvAplicacoes() {
  const linhas = lista('aplicacoes').map(x => ({ x, m: achar('manejos', x.manejoId), a: achar('animais', x.animalId) }))
    .filter(r => r.m && r.a)
    .sort((r, s) => s.m.data.localeCompare(r.m.data) || ordBrinco(r.a, s.a))
    .map(({ x, m, a }) => [fmtData(m.data), fmtHora(x.criadoEm), a.brinco || '', mae(a)?.brinco || '', categoria(a), a.marca,
      nomesProdutos(x.produtoIds), dec(x.peso), x.obs]);
  return csv('sitio-fartura-aplicacoes', ['Data', 'Hora', 'Brinco', 'Brinco da mãe', 'Categoria', 'Marca/cor', 'Produtos', 'Peso (kg)', 'Obs.'], linhas);
}
function csvCompras() {
  const linhas = lista('compras').filter(c => c.comprado)
    .sort((a, b) => b.compradoEm.localeCompare(a.compradoEm))
    .map(c => [fmtData(diaLocal(c.compradoEm)), c.nome, c.qtdComprada || c.qtd, dec(c.valor), c.loja]);
  return csv('sitio-fartura-compras', ['Data', 'Item', 'Quantidade', 'Valor pago (R$)', 'Onde comprou'], linhas);
}

/* ---------- Instalar o app no celular ---------- */

// O Chrome do Android avisa quando o app pode ser instalado; guardamos esse
// aviso para abrir a janela de instalação quando a pessoa tocar no botão.
let pedidoInstalacao = null;
const appInstalado = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  pedidoInstalacao = e;
});
window.addEventListener('appinstalled', () => {
  pedidoInstalacao = null;
  toast('App instalado ✔ Procure o ícone Sítio Fartura no celular.');
  render();
});

const botaoInstalar = () => appInstalado() ? '' :
  '<p class="instalar-linha"><button class="btn pequeno" id="instalar">📲 Instalar no celular</button></p>';

function ligarInstalar() {
  const b = $('#instalar');
  if (b) b.onclick = instalarApp;
}

async function instalarApp() {
  if (pedidoInstalacao) {
    pedidoInstalacao.prompt();
    const { outcome } = await pedidoInstalacao.userChoice;
    pedidoInstalacao = null;
    if (outcome !== 'accepted') toast('Instalação cancelada');
    return;
  }
  // Sem a janela automática (iPhone, ou navegador que não oferece): mostra o passo a passo.
  const iphone = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const caixa = modal(`
    <div class="modal-animal"><img src="icones/icone-192.png" alt=""><div><h3>Instalar o ${NOME_SITIO}</h3>
      <p class="dica" style="margin:0">Fica um ícone na tela do celular e funciona sem internet.</p></div></div>
    ${iphone ? `<ol class="passos">
        <li>Abra este site no <b>Safari</b>.</li>
        <li>Toque no botão <b>Compartilhar</b> (quadrado com seta para cima ⬆️), embaixo da tela.</li>
        <li>Toque em <b>Adicionar à Tela de Início</b>.</li>
        <li>Toque em <b>Adicionar</b>.</li>
      </ol>` : `<ol class="passos">
        <li>Abra este site no <b>Chrome</b>.</li>
        <li>Toque nos <b>três pontinhos ⋮</b>, no canto de cima.</li>
        <li>Toque em <b>Instalar app</b> ou <b>Adicionar à tela inicial</b>.</li>
        <li>Confirme em <b>Instalar</b>.</li>
      </ol>`}
    <button class="btn primario grande" id="entendi">Entendi</button>`);
  $('#entendi', caixa).onclick = fecharModal;
}

/* ---------- Almoxarifado ----------
   Lista do que está acabando. Enquanto ninguém marcar "Já comprei",
   o app lembra uma vez por dia em cada celular. */

const faltaComprar = () => lista('compras').filter(c => !c.comprado)
  .sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
const diaLocal = iso => {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
let anoAlmox = String(new Date().getFullYear());

function almoxarifado() {
  titulo('Almoxarifado', true);
  const falta = faltaComprar();
  const naLista = new Map(falta.filter(c => c.produtoId).map(c => [c.produtoId, c]));
  const prods = lista('produtos').filter(p => !p.inativo).sort((a, b) => a.nome.localeCompare(b.nome, 'pt'));

  // Compras do ano escolhido, separadas por mês, com o custo
  const comprados = lista('compras').filter(c => c.comprado);
  const anos = [...new Set([String(new Date().getFullYear()), ...comprados.map(c => diaLocal(c.compradoEm).slice(0, 4))])].sort().reverse();
  if (!anos.includes(anoAlmox)) anoAlmox = anos[0];
  const doAno = comprados.filter(c => diaLocal(c.compradoEm).startsWith(anoAlmox))
    .sort((a, b) => b.compradoEm.localeCompare(a.compradoEm));
  const soma = l => l.reduce((s, c) => s + (c.valor || 0), 0);
  const porMes = new Map();
  for (const c of doAno) {
    const m = +diaLocal(c.compradoEm).slice(5, 7) - 1;
    porMes.set(m, [...(porMes.get(m) || []), c]);
  }
  const semValor = doAno.filter(c => c.valor == null).length;

  app.innerHTML = `
    <p class="dica" style="margin-top:0">Toque no produto quando ele estiver acabando. O app lembra <b>uma vez por dia</b>,
      nos dois celulares, até alguém marcar que comprou.</p>

    <h2>🔔 Falta comprar (${falta.length})</h2>
    ${falta.length ? `<ul class="lista">${falta.map(c => `<li class="compra">
        <div class="info"><strong>${esc(c.nome)}</strong>
          <small>${esc([c.qtd ? 'comprar: ' + c.qtd : '', c.obs, 'anotado ' + haQuanto(diaLocal(c.criadoEm))].filter(Boolean).join(' · '))}</small></div>
        <div class="acoes">
          <button class="btn pequeno primario" data-comprei="${c.id}">✅ Comprei</button>
          <button class="btn pequeno" data-tirar="${c.id}" aria-label="Tirar da lista">✕</button>
        </div>
      </li>`).join('')}</ul>` : '<p class="dica">Nada faltando. 👍</p>'}

    <h2>📦 Produtos</h2>
    <p class="dica" style="margin-top:0">Acabou ou está acabando? Toque nele e diga quanto precisa comprar.</p>
    <ul class="lista">${prods.map(p => {
      const c = naLista.get(p.id);
      return `<li><button class="item produto-almox ${c ? 'na-lista' : ''}" data-produto="${p.id}">
        <span class="info"><strong>${esc(p.nome)}</strong><small>${TIPOS_PRODUTO[p.tipo] || ''}${p.dose ? ' · ' + esc(p.dose) : ''}</small></span>
        ${c ? `<span class="selo-falta">na lista${c.qtd ? ': ' + esc(c.qtd) : ''}</span>` : '<span class="seta">›</span>'}
      </button></li>`;
    }).join('')}</ul>
    <div class="linha-botoes">
      <button class="btn" id="novoProduto">➕ Novo produto</button>
      <button class="btn" id="outroItem">📝 Outro item</button>
    </div>

    <h2>📊 Compras e custos</h2>
    <div class="cartao">
      <div class="ano-linha">
        <label>Ano <select id="anoAlmox">${anos.map(a => `<option ${a === anoAlmox ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
        <div class="total-ano"><small>Gasto em ${anoAlmox}</small><b>${fmtReal(soma(doAno))}</b></div>
      </div>
      ${semValor ? `<p class="dica" style="margin:8px 0 0">${semValor} compra(s) sem valor anotado. Toque nelas para colocar o preço.</p>` : ''}
    </div>
    ${doAno.length ? [...porMes.entries()].map(([m, l]) => `
      <details class="mes" ${m === new Date().getMonth() && anoAlmox === String(new Date().getFullYear()) ? 'open' : ''}>
        <summary><span>${MESES[m]}</span><span>${l.length} compra(s) · <b>${fmtReal(soma(l))}</b></span></summary>
        <ul class="lista">${l.map(c => `<li><button class="item" data-compra="${c.id}">
          <span class="info"><strong>${esc(c.nome)}</strong>
            <small>${esc([fmtData(diaLocal(c.compradoEm)), c.qtdComprada || c.qtd, c.loja].filter(Boolean).join(' · '))}</small></span>
          <b class="valor">${c.valor != null ? fmtReal(c.valor) : '—'}</b>
        </button></li>`).join('')}</ul>
      </details>`).join('') : `<p class="dica">Nenhuma compra registrada em ${anoAlmox}.</p>`}`;

  $('#anoAlmox').onchange = e => { anoAlmox = e.target.value; render(); };
  $('#novoProduto').onclick = () => editarProduto();
  $('#outroItem').onclick = () => anotarFalta(null);
  app.onclick = e => {
    const b = e.target.closest('[data-produto],[data-comprei],[data-tirar],[data-compra]');
    if (!b) return;
    if (b.dataset.produto) anotarFalta(achar('produtos', b.dataset.produto));
    else if (b.dataset.comprei) registrarCompra(achar('compras', b.dataset.comprei));
    else if (b.dataset.compra) registrarCompra(achar('compras', b.dataset.compra));
    else {
      const c = achar('compras', b.dataset.tirar);
      excluir('compras', c.id);
      render();
      toast(`${c.nome} saiu da lista`, 'Desfazer', () => { c.excluido = false; gravar('compras', c); render(); });
    }
  };
}

// "Acabou": anota na lista de compras quanto precisa comprar.
function anotarFalta(produto) {
  const ja = produto && faltaComprar().find(c => c.produtoId === produto.id);
  const caixa = modal(`
    <h3>📦 ${produto ? esc(produto.nome) : 'Outro item'}</h3>
    <p class="dica" style="margin-top:0">${ja ? 'Já está na lista de compras. Pode mudar a quantidade.' : 'Acabou ou está acabando? Anote quanto precisa comprar.'}</p>
    <form id="fa" class="form" autocomplete="off">
      ${produto ? '' : '<label>Nome do item<input name="nome" required placeholder="ex.: luva, cal, sal mineral"></label>'}
      <label>Quantidade para comprar<input name="qtd" value="${esc(ja ? ja.qtd : '')}" placeholder="ex.: 2 frascos de 500 ml"></label>
      <label>Obs. <small>(opcional)</small><input name="obs" value="${esc(ja ? ja.obs : '')}" placeholder="ex.: acabou ontem"></label>
      <button class="btn primario grande">${ja ? 'Salvar' : '🔔 Pôr na lista de compras'}</button>
      <button type="button" class="btn" id="cancelar">Cancelar</button>
    </form>`);
  const f = $('#fa', caixa);
  $('#cancelar', caixa).onclick = fecharModal;
  f.onsubmit = e => {
    e.preventDefault();
    const dados = { qtd: f.qtd.value.trim(), obs: f.obs.value.trim() };
    if (ja) gravar('compras', Object.assign(ja, dados));
    else gravar('compras', { nome: produto ? produto.nome : f.nome.value.trim(), produtoId: produto ? produto.id : null, ...dados, comprado: false, compradoEm: null });
    fecharModal();
    toast(ja ? 'Quantidade atualizada' : '🔔 Anotado na lista de compras');
    render();
  };
  (produto ? f.qtd : f.nome).focus();
}

// "Comprei": quantidade, valor pago, data e loja. Também serve para corrigir uma compra já feita.
function registrarCompra(c) {
  const feita = c.comprado;
  const caixa = modal(`
    <h3>✅ ${feita ? 'Compra de' : 'Comprei:'} ${esc(c.nome)}</h3>
    <form id="fb" class="form" autocomplete="off">
      <label>Quantidade comprada<input name="qtd" value="${esc(c.qtdComprada || c.qtd || '')}" placeholder="ex.: 2 frascos"></label>
      <div class="duas">
        <label>Valor pago (R$) <small>(total)</small><input name="valor" inputmode="decimal" value="${c.valor != null ? dec(c.valor.toFixed(2)) : ''}" placeholder="0,00"></label>
        <label>Data<input type="date" name="data" value="${feita ? diaLocal(c.compradoEm) : hoje()}" max="${hoje()}" required></label>
      </div>
      <label>Onde comprou <small>(opcional)</small><input name="loja" value="${esc(c.loja || '')}" placeholder="ex.: Agropecuária Central"></label>
      <button class="btn primario grande">${feita ? 'Salvar' : '✅ Registrar compra'}</button>
      ${feita ? '<button type="button" class="btn" id="voltarLista">↺ Ainda não comprei (voltar para a lista)</button>' : ''}
      <button type="button" class="btn" id="cancelar">Cancelar</button>
    </form>`);
  const f = $('#fb', caixa);
  $('#cancelar', caixa).onclick = fecharModal;
  if (feita) $('#voltarLista', caixa).onclick = () => {
    Object.assign(c, { comprado: false, compradoEm: null });
    gravar('compras', c);
    fecharModal();
    render();
  };
  f.onsubmit = e => {
    e.preventDefault();
    Object.assign(c, {
      comprado: true,
      compradoEm: new Date(f.data.value + 'T12:00').toISOString(),
      qtdComprada: f.qtd.value.trim(),
      valor: num(f.valor.value),
      loja: f.loja.value.trim(),
    });
    gravar('compras', c);
    fecharModal();
    render();
    if (!feita) toast(`✅ ${c.nome} comprado`, 'Desfazer', () => { Object.assign(c, { comprado: false, compradoEm: null }); gravar('compras', c); render(); });
  };
  if (!feita) f.valor.focus();
}

// Uma vez por dia (em cada celular), mostra o que falta comprar.
const CHAVE_LEMBRETE = 'sitio-fartura-lembrete';
function lembreteDoDia() {
  const falta = faltaComprar();
  if (!falta.length || location.hash.startsWith('#/almoxarifado') || !$('#modal').hidden) return;
  let ultimo = null;
  try { ultimo = localStorage.getItem(CHAVE_LEMBRETE); } catch (e) { /* sem armazenamento */ }
  if (ultimo === hoje()) return;
  try { localStorage.setItem(CHAVE_LEMBRETE, hoje()); } catch (e) { /* sem armazenamento */ }
  const caixa = modal(`
    <h3>🔔 Lembrete do almoxarifado</h3>
    <p style="margin-bottom:4px">Falta comprar:</p>
    <ul class="passos">${falta.map(c => `<li><b>${esc(c.nome)}</b>${c.qtd ? ' — ' + esc(c.qtd) : ''}</li>`).join('')}</ul>
    <button class="btn primario grande" id="verAlmox">Ver almoxarifado</button>
    <button class="btn" id="okLembrete">Ok, lembrar amanhã</button>`);
  $('#verAlmox', caixa).onclick = () => navegar('#/almoxarifado');
  $('#okLembrete', caixa).onclick = fecharModal;
}

/* ---------- Rotas ---------- */

const ROTAS = {
  inicio, animais, animal, editar: editarAnimal, nascimento, fichas, ficha,
  vacinacao, lancar: vacinacao, manejo, produtos, mais, almoxarifado,
};
const NAV_DA_ROTA = { animal: 'animais', editar: 'animais', ficha: 'fichas', lancar: 'vacinacao', manejo: 'vacinacao', produtos: 'mais' };

function navegar(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function render() {
  const [, nome = 'inicio', arg] = location.hash.split('/');
  const rota = ROTAS[nome] || inicio;
  fecharModal();
  if (nuvem.configurada && nuvem.estadoConhecido && !nuvem.usuario && nuvem.auth) return telaLogin();
  document.body.classList.remove('sem-nav');
  const nav = nome === 'editar' && arg === 'novo' ? 'cadastrar' : NAV_DA_ROTA[nome] || nome;
  $$('#nav a').forEach(a => a.classList.toggle('ativo', a.dataset.rota === nav));
  app.onclick = null;
  rota(arg && decodeURIComponent(arg));
  window.scrollTo(0, 0);
  lembreteDoDia();
}

window.addEventListener('hashchange', render);
// Se o mesmo app estiver aberto em outra aba, recarrega os dados.
window.addEventListener('storage', e => { if (e.key === CHAVE) { db = carregar(); render(); } });
carregarFotos().then(() => { render(); iniciarNuvem(); });

// Pede ao navegador para não apagar os dados quando o celular estiver com pouco espaço.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
