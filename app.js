/* ============================================================
   東大蔵書チェッカー
   - バーコード(EAN-13) → ISBN を取得
   - openBD で書誌・書影（予備: Google Books）
   - 東大OPAC（詳細検索・ISBN索引）へのディープリンクを併設
   ============================================================ */

/* ---------- DOM ---------- */
const $ = id => document.getElementById(id);
const els = {
  viewport:$('viewport'), vpIdle:$('vpIdle'), reader:$('reader'),
  scanBtn:$('scanBtn'), toast:$('toast'),
  zoomRow:$('zoomRow'), zoom:$('zoom'),
  manualInput:$('manualInput'), manualBtn:$('manualBtn'),
  result:$('result'),
  cover:$('cover'), bTitle:$('bTitle'), bAuthor:$('bAuthor'), bPub:$('bPub'), bIsbn:$('bIsbn'),
  actions:$('actions'),
  dbgBtn:$('dbgBtn'), dbgPanel:$('dbgPanel'), dbgLog:$('dbgLog'),
  dbgClear:$('dbgClear'), dbgCopy:$('dbgCopy'), dbgClose:$('dbgClose'),
};

/* ---------- デバッグログ ----------
   ページ読込時から常時バッファに記録し、右下の目立たないボタンでパネル表示/非表示。
   console.log/warn/error と未捕捉エラーも拾う。 */
const dbg = (() => {
  const MAX = 400;
  const buf = [];
  let listEl = null, panelEl = null, open = false;
  const fmt = a => {
    if(a instanceof Error) return a.name + ': ' + a.message + (a.stack ? ('\n' + a.stack) : '');
    if(a && typeof a === 'object'){ try{ return JSON.stringify(a); }catch(e){ return String(a); } }
    return String(a);
  };
  const line = e => `[${e.time}] ${e.level.toUpperCase()} ${e.msg}`;
  function render(){ if(listEl){ listEl.textContent = buf.map(line).join('\n'); listEl.scrollTop = listEl.scrollHeight; } }
  function push(level, args){
    buf.push({ time:new Date().toISOString().slice(11,23), level, msg:Array.from(args).map(fmt).join(' ') });
    if(buf.length > MAX) buf.shift();
    if(open) render();
  }
  return {
    log:(...a)=>push('log',a), warn:(...a)=>push('warn',a), error:(...a)=>push('error',a),
    bind(panel, list){ panelEl=panel; listEl=list; },
    toggle(){ open=!open; if(panelEl) panelEl.hidden=!open; if(open) render(); return open; },
    clear(){ buf.length=0; render(); },
    text(){ return buf.map(line).join('\n'); },
  };
})();
/* console をフック（元の出力は保持）。dbgはconsoleを呼ばないので無限ループしない */
['log','warn','error'].forEach(k => {
  const orig = console[k] ? console[k].bind(console) : ()=>{};
  console[k] = (...a) => { try{ dbg[k](...a); }catch(e){} orig(...a); };
});
window.addEventListener('error', e => dbg.error('window.onerror:', e.message, (e.filename||'')+':'+(e.lineno||'')));
window.addEventListener('unhandledrejection', e => dbg.error('unhandledrejection:', (e.reason && (e.reason.message||e.reason)) || e.reason));

/* ---------- ISBN 正規化・変換 ---------- */
function normalizeIsbn(raw){
  return (raw||'').replace(/[^0-9Xx]/g,'').toUpperCase();
}
function isPriceBarcode(code){ return /^19[12]\d{10}$/.test(code); } // 日本の書籍2段目（価格）バーコード
function isbn13to10(i13){
  if(!/^978\d{10}$/.test(i13)) return null;
  const core = i13.slice(3,12);
  let sum=0; for(let i=0;i<9;i++) sum += (10-i)*parseInt(core[i],10);
  let c = (11 - (sum%11)) % 11;
  return core + (c===10 ? 'X' : String(c));
}
function isbn10to13(i10){
  if(!/^\d{9}[\dX]$/.test(i10)) return null;
  const core = '978' + i10.slice(0,9);
  let sum=0; for(let i=0;i<12;i++){ const d=parseInt(core[i],10); sum += (i%2===0)? d : d*3; }
  const c = (10 - (sum%10)) % 10;
  return core + c;
}
function toIsbn13(code){
  if(/^(978|979)\d{10}$/.test(code)) return code;
  if(/^\d{9}[\dX]$/.test(code)) return isbn10to13(code);
  return null;
}

const COVER_PH = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='62' height='90'%3E%3Crect width='62' height='90' rx='6' fill='%23eceff3'/%3E%3Ctext x='31' y='42' font-family='sans-serif' font-size='9' fill='%23aab4c2' text-anchor='middle'%3ENO%3C/text%3E%3Ctext x='31' y='55' font-family='sans-serif' font-size='9' fill='%23aab4c2' text-anchor='middle'%3EIMAGE%3C/text%3E%3C/svg%3E";

/* ---------- 書誌（openBD, CORS対応なのでfetch可）---------- */
async function fetchBook(isbn13){
  try{
    const r = await fetch('https://api.openbd.jp/v1/get?isbn=' + isbn13);
    const arr = await r.json();
    const s = arr && arr[0] && arr[0].summary;
    if(s) return { title:s.title||'', author:s.author||'', publisher:s.publisher||'', pubdate:s.pubdate||'', cover:s.cover||'' };
  }catch(e){ /* fallthrough */ }
  // 予備：Google Books
  try{
    const r = await fetch('https://www.googleapis.com/books/v1/volumes?q=isbn:' + isbn13);
    const d = await r.json();
    const v = d.items && d.items[0] && d.items[0].volumeInfo;
    if(v) return {
      title:v.title||'', author:(v.authors||[]).join(', '),
      publisher:v.publisher||'', pubdate:v.publishedDate||'',
      cover:(v.imageLinks && (v.imageLinks.thumbnail||v.imageLinks.smallThumbnail)) ? v.imageLinks.thumbnail.replace('http://','https://') : ''
    };
  }catch(e){}
  return null;
}

/* ---------- 書影：複数ソースを順に試す ----------
   openBD/Google Booksはcoverが空のことが多いので、Amazon(ISBN-10=ASIN)も候補に入れる。
   AmazonはカバーがないとHTTP200で1×1の極小GIFを返すため、読み込めても極小なら次の候補へ送る。 */
function coverCandidates(isbn13, book){
  const list = [];
  if(book && book.cover) list.push(book.cover);
  const i10 = isbn13to10(isbn13);
  if(i10) list.push('https://m.media-amazon.com/images/P/' + i10 + '.jpg');
  list.push(COVER_PH);
  return list;
}
function setCover(isbn13, book){
  const cands = coverCandidates(isbn13, book);
  let idx = 0;
  const tryNext = () => {
    if(idx >= cands.length){ els.cover.onerror=null; els.cover.onload=null; els.cover.src = COVER_PH; return; }
    els.cover.src = cands[idx++];
  };
  els.cover.onerror = tryNext;
  els.cover.onload = () => {
    // Amazonの「画像なし」プレースホルダ(1×1)を弾く。プレースホルダ自体(62px)は通す。
    if(els.cover.naturalWidth > 1 && els.cover.naturalHeight > 1) return;
    if(idx < cands.length) tryNext();
  };
  tryNext();
}

/* ---------- 描画 ---------- */
function renderBook(isbn13, book){
  els.bIsbn.innerHTML = `<b>ISBN</b> ${formatIsbn(isbn13)}`;
  setCover(isbn13, book);
  els.cover.alt = (book && book.title) ? book.title : '';
  els.bTitle.textContent  = (book && book.title)  ? book.title  : '（書誌情報なし）';
  els.bAuthor.textContent = (book && book.author) ? book.author : '';
  const pub = book ? [book.publisher, formatPubdate(book.pubdate)].filter(Boolean).join(' ・ ') : '';
  els.bPub.textContent = pub;
}
function formatIsbn(i13){
  if(/^\d{13}$/.test(i13)) return i13.replace(/^(\d{3})(\d{1})(\d{4})(\d{4})(\d{1})$/, '$1-$2-$3-$4-$5');
  return i13;
}
function formatPubdate(p){
  if(!p) return '';
  const m = p.match(/^(\d{4})-?(\d{2})?/);
  if(!m) return p;
  return m[1] + (m[2] ? '.'+m[2] : '');
}
function renderActions(isbn13){
  els.actions.innerHTML='';
  // 東大OPAC（一次情報・詳細検索のISBN索引を名指し）
  els.actions.appendChild(linkBtn(
    'https://opac.dl.itc.u-tokyo.ac.jp/opac/opac_search/?amode=2&smode=1&con1_exp=isbn&kywd1_exp=' + isbn13 + '&dpmc_exp%5B%5D=all',
    '東大OPACで開く', 'primary'
  ));
  // Amazon（本カテゴリをISBNで検索）
  els.actions.appendChild(linkBtn(
    'https://www.amazon.co.jp/s?i=stripbooks&rh=p_66%3A' + isbn13,
    'Amazonで検索', 'amazon'
  ));
}
function linkBtn(href, label, variant){
  const a=document.createElement('a'); a.href=href; a.target='_blank'; a.rel='noopener';
  a.className='linkbtn'+(variant?(' '+variant):'');
  a.innerHTML = `<span>${label}</span><span class="arr">↗</span>`;
  return a;
}

/* ---------- メイン：ISBNを処理 ---------- */
let busy=false;
async function handleIsbn(code){
  const isbn13 = toIsbn13(code);
  if(!isbn13){ showToast('ISBNとして認識できませんでした。978で始まる13桁を読み取ってください。'); return; }
  if(busy) return; busy=true;

  els.result.hidden=false;
  renderBook(isbn13, null);
  renderActions(isbn13);
  els.result.scrollIntoView({behavior:'smooth', block:'start'});

  const book = await fetchBook(isbn13);
  renderBook(isbn13, book);
  busy=false;
}

/* ---------- トースト ---------- */
let toastTimer=null;
function showToast(msg){
  els.toast.textContent=msg; els.toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>els.toast.classList.remove('show'), 3500);
}

/* ---------- カメラ / バーコード ---------- */
let html5Qr=null, scanning=false;
async function startScan(){
  if(scanning){ await stopScan(); return; }
  if(typeof Html5Qrcode === 'undefined'){ dbg.error('Html5Qrcode 未読込'); showToast('読取ライブラリを読み込めません。通信環境をご確認ください。'); return; }
  const fmts = (window.Html5QrcodeSupportedFormats)
    ? [Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8, Html5QrcodeSupportedFormats.UPC_A]
    : undefined;
  els.vpIdle.style.display='none';
  els.viewport.classList.remove('idle'); els.viewport.classList.add('scanning');
  els.scanBtn.textContent='読み取りを止める';
  window.scrollTo({top:0, behavior:'smooth'});

  // 1Dバーコード向けに「広く・低め」の走査領域（ビューファインダ幅に追従）
  const config = { fps:10, qrbox:(w,h)=>{ const ww=Math.round(Math.min(w,520)*0.9); return { width:ww, height:Math.round(ww*0.45) }; }, aspectRatio:1.6 };
  // まず高解像度（バー1本あたりの画素を確保）、失敗したら以前から動く最小構成にフォールバック
  const attempts = [
    { facingMode:'environment', width:{ideal:1920}, height:{ideal:1080}, advanced:[{focusMode:'continuous'}] },
    { facingMode:'environment' },
  ];
  for(let i=0;i<attempts.length;i++){
    try{
      dbg.log('camera start 試行', i+1, attempts[i]);
      html5Qr = new Html5Qrcode('reader', fmts ? { formatsToSupport: fmts, verbose:false } : { verbose:false });
      await html5Qr.start(attempts[i], config, onScan, ()=>{});
      scanning=true;
      dbg.log('camera 起動成功 (試行', i+1, ')');
      setupZoom();
      return;
    }catch(e){
      dbg.error('camera start 失敗 (試行'+(i+1)+'):', e);
      try{ await html5Qr.clear(); }catch(_){}
      html5Qr=null;
      if(e && e.name === 'NotAllowedError'){ break; } // 権限拒否は再試行しても無駄
    }
  }
  // 全試行が失敗
  scanning=false; els.scanBtn.textContent='カメラで読み取る';
  els.viewport.classList.remove('scanning'); els.viewport.classList.add('idle'); els.vpIdle.style.display='flex';
  showToast('カメラを起動できませんでした。HTTPS環境とカメラ許可が必要です。');
}
/* ---------- ズーム（対応端末のみ）---------- */
function setupZoom(){
  els.zoomRow.hidden = true;
  try{
    const caps = html5Qr.getRunningTrackCapabilities();
    dbg.log('track capabilities:', caps);
    const z = caps && caps.zoom;
    if(!z || !z.max){ dbg.log('zoom 非対応'); return; } // 非対応端末はスライダーを出さない
    const min = z.min || 1, max = z.max, step = z.step || 0.1;
    const init = Math.min(max, Math.max(min, 2));      // 既定2x（端末上限でクランプ）
    els.zoom.min = min; els.zoom.max = max; els.zoom.step = step; els.zoom.value = init;
    els.zoomRow.hidden = false;
    html5Qr.applyVideoConstraints({ advanced:[{ zoom: init }] }).catch(()=>{});
  }catch(e){ els.zoomRow.hidden = true; }
}
async function stopScan(){
  if(html5Qr && scanning){ try{ await html5Qr.stop(); }catch(e){} try{ await html5Qr.clear(); }catch(e){} }
  scanning=false; html5Qr=null;
  els.zoomRow.hidden = true;
  els.viewport.classList.remove('scanning'); els.viewport.classList.add('idle');
  els.vpIdle.style.display='flex'; els.scanBtn.textContent='カメラで読み取る';
}
async function onScan(text){
  const code = normalizeIsbn(text);
  if(isPriceBarcode(code)){ showToast('価格バーコードです。上段（978で始まる）ISBNを読み取ってください。'); return; }
  if(!toIsbn13(code)){ return; } // ノイズは無視して読み取り継続
  await stopScan();
  handleIsbn(code);
}

/* ---------- イベント ---------- */
els.scanBtn.addEventListener('click', startScan);
els.zoom.addEventListener('input', () => {
  if(html5Qr) html5Qr.applyVideoConstraints({ advanced:[{ zoom: Number(els.zoom.value) }] }).catch(()=>{});
});
els.manualBtn.addEventListener('click', () => {
  const code = normalizeIsbn(els.manualInput.value);
  if(isPriceBarcode(code)){ showToast('価格バーコードです。ISBN（978始まり）を入力してください。'); return; }
  handleIsbn(code);
});
els.manualInput.addEventListener('keydown', e => { if(e.key==='Enter') els.manualBtn.click(); });
window.addEventListener('pagehide', stopScan);

/* ---------- デバッグパネル ---------- */
dbg.bind(els.dbgPanel, els.dbgLog);
els.dbgBtn.addEventListener('click', () => dbg.toggle());
els.dbgClose.addEventListener('click', () => dbg.toggle());
els.dbgClear.addEventListener('click', () => dbg.clear());
els.dbgCopy.addEventListener('click', async () => {
  const t = dbg.text();
  try{ await navigator.clipboard.writeText(t); showToast('ログをコピーしました'); }
  catch(e){ showToast('コピーできませんでした'); }
});
dbg.log('起動', navigator.userAgent);
