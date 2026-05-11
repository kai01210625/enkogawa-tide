// ============================================================
// 猿猴川 潮汐ログ — Enko-river Chinu Tide Logger
// ============================================================

const STORAGE = {
  HITS: 'ekg_hits_v1',
  TIDE: 'ekg_tide_v1', // {year: {dateStr: {hourly:[24], high:[{time,level}], low:[]}}}
  SESSIONS: 'ekg_sessions_v1', // 投入セッション(連続区間×1ルアー)
};

// ---------- state ----------
const state = {
  date: todayStr(),
  hits: loadHits(),
  tide: loadTide(),
  sessions: loadSessions(),
  chart: null,
  wakeLock: null,
  wakeLockRequested: false,
};

// ============================================================
// Wake Lock (画面スリープ防止)
// ============================================================
async function requestWakeLock(){
  if(!('wakeLock' in navigator)) return false;
  try{
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', ()=>{
      // 解放時は wakeLockRequested は維持(visibilitychangeで自動再取得)
    });
    return true;
  }catch(e){
    return false;
  }
}

async function toggleWakeLock(){
  const btn = document.getElementById('wakeLockToggle');
  if(state.wakeLockRequested){
    state.wakeLockRequested = false;
    if(state.wakeLock){
      try{ await state.wakeLock.release(); }catch(e){}
      state.wakeLock = null;
    }
    btn.textContent = '🔓';
    btn.classList.remove('on');
    toast('スリープ防止 OFF');
  } else {
    if(!('wakeLock' in navigator)){
      toast('この端末は非対応です');
      return;
    }
    const ok = await requestWakeLock();
    if(ok){
      state.wakeLockRequested = true;
      btn.textContent = '🔒';
      btn.classList.add('on');
      toast('スリープ防止 ON');
    } else {
      toast('スリープ防止の取得失敗');
    }
  }
}

// ---------- utils ----------
function todayStr(){
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function pad(n){return String(n).padStart(2,'0')}
function loadHits(){
  try{return JSON.parse(localStorage.getItem(STORAGE.HITS) || '[]')}catch{return []}
}
function saveHits(){localStorage.setItem(STORAGE.HITS, JSON.stringify(state.hits))}
function loadTide(){
  try{return JSON.parse(localStorage.getItem(STORAGE.TIDE) || '{}')}catch{return {}}
}
function saveTide(){localStorage.setItem(STORAGE.TIDE, JSON.stringify(state.tide))}
function loadSessions(){
  try{return JSON.parse(localStorage.getItem(STORAGE.SESSIONS) || '[]')}catch{return []}
}
function saveSessions(){localStorage.setItem(STORAGE.SESSIONS, JSON.stringify(state.sessions))}

function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,7)}

function nowHM(){
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>t.classList.remove('show'), 1800);
}

// ============================================================
// セッション(投入区間)操作
// ============================================================
// セッションは「ルアー1つ・連続した投入区間」を1レコードとする
// {id, date, color, startTime:'HH:MM', endTime:'HH:MM'|null, memo, active:bool}
// active=true は進行中(endTime未設定)

function getActiveSession(){
  return state.sessions.find(s => s.active);
}

function getSessionsForDate(d){
  return state.sessions.filter(s => s.date === d)
    .sort((a,b)=>a.startTime.localeCompare(b.startTime));
}

// 与えられた時刻(HH:MM)を含むセッションを探す(その日付の中で)
function findSessionAt(date, time){
  const t = time;
  return state.sessions.find(s => {
    if(s.date !== date) return false;
    if(s.startTime > t) return false;
    const end = s.endTime || '23:59';
    return end >= t;
  });
}

// セッションを開始(進行中があれば自動で終了)
function startSession(color, startTime){
  const t = startTime || nowHM();
  // 既存の進行中セッションを終了させる
  const active = getActiveSession();
  if(active){
    active.endTime = t;
    active.active = false;
  }
  const s = {
    id: uid(),
    date: state.date,
    color: color || '',
    startTime: t,
    endTime: null,
    memo: '',
    active: true,
  };
  state.sessions.push(s);
  saveSessions();
  return s;
}

function endActiveSession(endTime){
  const active = getActiveSession();
  if(!active) return null;
  active.endTime = endTime || nowHM();
  active.active = false;
  saveSessions();
  return active;
}

// セッションの分数を計算
function sessionMinutes(s){
  if(!s.endTime) return 0;
  const toMin = (t)=>{const [h,m]=t.split(':').map(Number); return h*60+m};
  return Math.max(0, toMin(s.endTime) - toMin(s.startTime));
}

// 日付の総釣行時間(分)
function totalMinutesForDate(d){
  return getSessionsForDate(d).reduce((sum,s) => sum + sessionMinutes(s), 0);
}


// フォーマット (1日1行):
//   col 1-72  : 24時間 × 3バイト  毎時潮位(cm)
//   col 73-74 : YY (年下2桁)
//   col 75-76 : MM
//   col 77-78 : DD
//   col 79-80 : 地点記号 (2文字)
//   col 81-108: 満潮(時2 分2 潮位3)×4
//   col 109-end: 干潮(時2 分2 潮位3)×4
// 満干潮が無い枠は 9999999 (時刻9999, 潮位999)
// ============================================================
function parseJMATideText(text){
  const lines = text.split(/\r?\n/).filter(l => l.length >= 78);
  const result = {};
  for(const line of lines){
    const hourly = [];
    for(let h=0; h<24; h++){
      const s = line.substr(h*3, 3).trim();
      hourly.push(s ? parseInt(s,10) : null);
    }
    const yy = line.substr(72,2);
    const mm = line.substr(74,2);
    const dd = line.substr(76,2);
    if(!/^\d{2}$/.test(yy) || !/^\d{2}$/.test(mm) || !/^\d{2}$/.test(dd)) continue;

    const year = parseInt(yy,10) + 2000; // 2000+ assumption
    const dateStr = `${year}-${mm}-${dd}`;

    // 満潮 (4セット)
    const highs = [];
    for(let i=0;i<4;i++){
      const off = 80 + i*7;
      if(line.length < off+7) break;
      const hh = line.substr(off,2).trim();
      const mn = line.substr(off+2,2).trim();
      const lv = line.substr(off+4,3).trim();
      if(hh==='99' || hh==='' || !hh) continue;
      const hi = parseInt(hh,10), mi = parseInt(mn,10), li = parseInt(lv,10);
      if(isNaN(hi)||hi>=99) continue;
      highs.push({time:`${pad(hi)}:${pad(mi)}`, level:li});
    }
    // 干潮 (4セット, 開始は col 109 = index 108)
    const lows = [];
    for(let i=0;i<4;i++){
      const off = 108 + i*7;
      if(line.length < off+7) break;
      const hh = line.substr(off,2).trim();
      const mn = line.substr(off+2,2).trim();
      const lv = line.substr(off+4,3).trim();
      if(hh==='99' || hh==='' || !hh) continue;
      const hi = parseInt(hh,10), mi = parseInt(mn,10), li = parseInt(lv,10);
      if(isNaN(hi)||hi>=99) continue;
      lows.push({time:`${pad(hi)}:${pad(mi)}`, level:li});
    }

    result[dateStr] = {hourly, high:highs, low:lows};
  }
  return result;
}

// ============================================================
// 自動取得 (CORS 制限あり)
// ============================================================
async function fetchJMATide(year){
  // 気象庁の年次テキスト: https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/{YYYY}/Q8.txt
  // CORS が許可されていないため、CORS プロキシ経由を試行
  const baseUrl = `https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/${year}/Q8.txt`;
  // 公開 CORS プロキシ (フォールバック)
  const proxies = [
    `https://corsproxy.io/?${encodeURIComponent(baseUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(baseUrl)}`,
  ];
  for(const url of proxies){
    try{
      const r = await fetch(url, {method:'GET'});
      if(!r.ok) continue;
      const txt = await r.text();
      if(txt.length > 1000 && /\d/.test(txt)) return txt;
    }catch(e){/* try next */}
  }
  throw new Error('取得失敗 (CORS)');
}

// ============================================================
// チャート描画
// ============================================================
function renderChart(){
  const dateStr = state.date;
  const tideData = state.tide[dateStr];
  const empty = document.getElementById('chartEmpty');
  const canvas = document.getElementById('chart');

  if(state.chart){state.chart.destroy(); state.chart=null}

  if(!tideData){
    empty.style.display = 'grid';
    return;
  }
  empty.style.display = 'none';

  // 0:00 - 24:00 の毎時データ + 24時の点 (翌日0時で補完)
  const hourlyLabels = Array.from({length:24}, (_,i)=>`${pad(i)}:00`);
  const hourlyData = tideData.hourly;

  // ヒット点を散布データ化 (x=hour decimal, y=interpolated tide level)
  const dayHits = state.hits.filter(h => h.date === dateStr);
  const hitPoints = dayHits.map(h => {
    const [hh,mm] = h.time.split(':').map(Number);
    const x = hh + mm/60;
    const y = interpolateTide(hourlyData, x);
    return {x, y, hit:h};
  });

  const ctx = canvas.getContext('2d');
  Chart.defaults.color = '#ebe3d0';
  Chart.defaults.font.family = "'JetBrains Mono', monospace";
  Chart.defaults.font.size = 10;

  state.chart = new Chart(ctx, {
    type:'line',
    plugins:[sessionBandsPlugin],
    data:{
      labels: hourlyLabels,
      datasets:[
        {
          label:'潮位',
          data: hourlyData,
          borderColor:'#7fb8e0',
          backgroundColor: (ctx)=>{
            const chart = ctx.chart;
            const {ctx:c, chartArea} = chart;
            if(!chartArea) return 'rgba(127,184,224,.15)';
            const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            g.addColorStop(0, 'rgba(127,184,224,.45)');
            g.addColorStop(1, 'rgba(127,184,224,.02)');
            return g;
          },
          borderWidth:2,
          tension:.45,
          fill:true,
          pointRadius:0,
          pointHoverRadius:4,
          pointHoverBackgroundColor:'#c8a85a',
          spanGaps:true,
        },
        {
          label:'HIT',
          data: hitPoints,
          type:'scatter',
          backgroundColor:'#c8392e',
          borderColor:'#f5efe0',
          borderWidth:1.5,
          pointRadius:7,
          pointHoverRadius:10,
          pointStyle:'circle',
          showLine:false,
        }
      ]
    },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      aspectRatio:1.6,
      interaction:{mode:'nearest', intersect:false},
      plugins:{
        legend:{display:false},
        sessionBands:{
          sessions: getSessionsForDate(dateStr),
        },
        tooltip:{
          backgroundColor:'rgba(12,35,64,.95)',
          borderColor:'#c8a85a',borderWidth:1,
          titleFont:{family:"'Shippori Mincho', serif", size:12, weight:'bold'},
          bodyFont:{family:"'JetBrains Mono', monospace", size:11},
          padding:10,
          callbacks:{
            title:(items)=>{
              const it = items[0];
              if(it.dataset.label==='HIT'){
                const p = it.raw;
                return `HIT ${p.hit.time}`;
              }
              return `${it.label}`;
            },
            label:(it)=>{
              if(it.dataset.label==='HIT'){
                const h = it.raw.hit;
                const parts = [`潮位 ${Math.round(it.raw.y)}cm`];
                if(h.color) parts.push(`色:${h.color}`);
                if(h.size) parts.push(`${h.size}cm`);
                if(h.memo) parts.push(h.memo);
                return parts;
              }
              return `${it.parsed.y} cm`;
            }
          }
        }
      },
      scales:{
        x:{
          grid:{color:'rgba(245,239,224,.06)', drawTicks:false},
          ticks:{
            maxRotation:0, autoSkip:true, maxTicksLimit:7,
            color:'#ebe3d0'
          },
          border:{color:'rgba(245,239,224,.2)'}
        },
        y:{
          grid:{color:'rgba(245,239,224,.06)'},
          ticks:{
            color:'#ebe3d0',
            callback:(v)=>`${v}`
          },
          border:{color:'rgba(245,239,224,.2)'},
          title:{display:true, text:'潮位 (cm)', color:'#c8a85a', font:{size:9, weight:'bold'}}
        }
      },
      animation:{duration:500, easing:'easeOutQuart'}
    }
  });
}

function interpolateTide(hourly, x){
  if(!hourly) return 0;
  const i = Math.floor(x);
  const f = x - i;
  const a = hourly[i] ?? 0;
  const b = (i+1<24 ? hourly[i+1] : hourly[23]) ?? a;
  return a + (b-a)*f;
}

// 色名から表示色(SVG/Canvas用RGB)へのマッピング
const COLOR_MAP = {
  '赤':       'rgba(200,57,46,0.18)',
  'ピンク':   'rgba(232,126,180,0.18)',
  'オレンジ': 'rgba(232,150,60,0.18)',
  'チャート': 'rgba(220,220,80,0.18)',
  'ナチュラル':'rgba(200,168,90,0.18)',
  'クリア':   'rgba(180,210,230,0.15)',
  '黒':       'rgba(80,80,90,0.30)',
  'その他':   'rgba(150,150,150,0.18)',
};
function colorFor(name){return COLOR_MAP[name] || 'rgba(200,168,90,0.18)'}
const COLOR_MAP_SOLID = {
  '赤':       '#c8392e',
  'ピンク':   '#e87eb4',
  'オレンジ': '#e8963c',
  'チャート': '#dcdc50',
  'ナチュラル':'#c8a85a',
  'クリア':   '#b4d2e6',
  '黒':       '#505060',
  'その他':   '#969696',
};

// Chart.js プラグイン: セッション帯を背景に描画
const sessionBandsPlugin = {
  id: 'sessionBands',
  beforeDatasetsDraw(chart, _args, opts){
    const sessions = opts.sessions || [];
    if(sessions.length === 0) return;
    const {ctx, chartArea, scales} = chart;
    const xScale = scales.x;
    if(!xScale) return;

    ctx.save();
    sessions.forEach(s => {
      const [sh,sm] = s.startTime.split(':').map(Number);
      const startX = sh + sm/60;
      let endX;
      if(s.endTime){
        const [eh,em] = s.endTime.split(':').map(Number);
        endX = eh + em/60;
      } else {
        // 進行中: 現時刻まで
        const now = new Date();
        endX = now.getHours() + now.getMinutes()/60;
      }
      // x軸のラベル(カテゴリスケール)を使っているので位置計算
      const xStart = xScale.getPixelForValue(Math.floor(startX)) + (startX - Math.floor(startX)) * (xScale.getPixelForValue(1) - xScale.getPixelForValue(0));
      const xEnd = xScale.getPixelForValue(Math.floor(endX)) + (endX - Math.floor(endX)) * (xScale.getPixelForValue(1) - xScale.getPixelForValue(0));
      ctx.fillStyle = colorFor(s.color);
      ctx.fillRect(xStart, chartArea.top, xEnd - xStart, chartArea.bottom - chartArea.top);

      // 上端に色名を小さく
      ctx.fillStyle = COLOR_MAP_SOLID[s.color] || '#c8a85a';
      ctx.font = '600 9px JetBrains Mono';
      ctx.textBaseline = 'top';
      ctx.fillText(s.color || '?', xStart + 3, chartArea.top + 3);
    });
    ctx.restore();
  }
};

// ============================================================
// UI レンダリング
// ============================================================
function renderInfo(){
  const dateStr = state.date;
  const td = state.tide[dateStr];
  const highEl = document.getElementById('info-high');
  const lowEl = document.getElementById('info-low');
  const hitsEl = document.getElementById('info-hits');

  if(td){
    highEl.innerHTML = td.high.length
      ? td.high.map(h=>`${h.time}<br>${h.level}cm`).join('<br>')
      : '—';
    lowEl.innerHTML = td.low.length
      ? td.low.map(h=>`${h.time}<br>${h.level}cm`).join('<br>')
      : '—';
  } else {
    highEl.textContent = '—';
    lowEl.textContent = '—';
  }
  const todayHits = state.hits.filter(h=>h.date===dateStr).length;
  const totalMin = totalMinutesForDate(dateStr);
  if(totalMin > 0){
    const rate = (todayHits / (totalMin/60)).toFixed(2);
    hitsEl.innerHTML = `<b style="color:var(--vermilion)">${todayHits}</b><br><span style="font-size:9px">${totalMin}分<br>${rate}/h</span>`;
  } else {
    hitsEl.innerHTML = `<b style="color:var(--vermilion);font-size:18px">${todayHits}</b><br><span style="font-size:9px;opacity:.5">投入未記録</span>`;
  }
}

function renderList(){
  const list = document.getElementById('hitList');
  const dayHits = state.hits
    .filter(h=>h.date===state.date)
    .sort((a,b)=>a.time.localeCompare(b.time));

  if(dayHits.length===0){
    list.innerHTML = `<div class="empty-list">この日の記録はありません<br>＋HIT 記録ボタンで追加</div>`;
    return;
  }

  list.innerHTML = dayHits.map(h=>{
    const td = state.tide[state.date];
    const [hh,mm] = h.time.split(':').map(Number);
    const level = td ? Math.round(interpolateTide(td.hourly, hh+mm/60)) : null;
    const meta = [
      level!==null ? `<b>潮位${level}cm</b>` : '',
      h.color ? `色:${h.color}` : '',
      h.size ? `${h.size}cm` : '',
      h.weather || '',
      h.memo || '',
    ].filter(Boolean).join(' / ');
    return `
      <div class="hit-card">
        <div class="time">${h.time}</div>
        <div class="meta">${meta || '<span style="opacity:.5">詳細なし</span>'}</div>
        <button class="del-btn" data-id="${h.id}" aria-label="削除">✕</button>
      </div>`;
  }).join('');

  list.querySelectorAll('.del-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.dataset.id;
      if(confirm('この記録を削除しますか?')){
        state.hits = state.hits.filter(h=>h.id!==id);
        saveHits();
        renderAll();
      }
    });
  });
}

function renderStats(){
  const stats = document.getElementById('stats');
  const total = state.hits.length;
  if(total===0){
    stats.textContent = 'まだ記録がありません';
    return;
  }
  // 色別
  const byColor = {};
  state.hits.forEach(h=>{
    const c = h.color || '未記入';
    byColor[c] = (byColor[c]||0)+1;
  });
  // 潮位帯別 (潮位データがある記録のみ)
  const byTideBand = {'<100':0,'100-150':0,'150-200':0,'200-250':0,'250-300':0,'>=300':0};
  let withTide = 0;
  state.hits.forEach(h=>{
    const td = state.tide[h.date];
    if(!td) return;
    const [hh,mm] = h.time.split(':').map(Number);
    const lv = interpolateTide(td.hourly, hh+mm/60);
    withTide++;
    if(lv<100) byTideBand['<100']++;
    else if(lv<150) byTideBand['100-150']++;
    else if(lv<200) byTideBand['150-200']++;
    else if(lv<250) byTideBand['200-250']++;
    else if(lv<300) byTideBand['250-300']++;
    else byTideBand['>=300']++;
  });

  const colorRows = Object.entries(byColor).sort((a,b)=>b[1]-a[1])
    .map(([k,v])=>`  ${k.padEnd(8,'　')} ${String(v).padStart(3)}　${'■'.repeat(Math.min(v,12))}`).join('<br>');
  const bandRows = Object.entries(byTideBand)
    .map(([k,v])=>`  ${k.padEnd(8,' ')} ${String(v).padStart(3)}　${'■'.repeat(Math.min(v,12))}`).join('<br>');

  stats.innerHTML = `
<span style="color:#c8a85a">▼ 総記録数</span><br>
  ${total} HIT (潮位データあり: ${withTide})<br><br>
<span style="color:#c8a85a">▼ ルアー色別</span><br>
${colorRows}<br><br>
<span style="color:#c8a85a">▼ 潮位帯別 (cm)</span><br>
${bandRows}
  `;
}

function renderAll(){
  renderChart();
  renderInfo();
  renderList();
  renderSessionBar();
  renderSessionPanel();
  renderStats();
}

// ============================================================
// セッションバー(画面上部、進行中表示)
// ============================================================
function renderSessionBar(){
  const empty = document.getElementById('sessionEmpty');
  const active = document.getElementById('sessionActive');
  const hitSub = document.getElementById('hitSub');
  const activeSession = getActiveSession();
  if(activeSession){
    empty.style.display = 'none';
    active.style.display = 'flex';
    document.getElementById('activeColor').textContent = activeSession.color || '未設定';
    document.getElementById('activeTime').textContent = `${activeSession.startTime} 開始`;
    updateSessionElapsed(); // 経過時間更新
    if(hitSub) hitSub.textContent = `${activeSession.color} 投入中`;
  } else {
    empty.style.display = 'flex';
    active.style.display = 'none';
    if(hitSub) hitSub.textContent = 'タップで記録';
  }
}

// 経過時間を毎秒更新するタイマー
function updateSessionElapsed(){
  const active = getActiveSession();
  const el = document.getElementById('activeElapsed');
  if(!el) return;
  if(!active){el.textContent = ''; return}
  const [sh,sm] = active.startTime.split(':').map(Number);
  const now = new Date();
  // 日付をまたぐケースは考慮しない (釣行は同日内)
  const startMin = sh*60 + sm;
  const nowMin = now.getHours()*60 + now.getMinutes();
  const diff = Math.max(0, nowMin - startMin);
  const h = Math.floor(diff/60);
  const m = diff % 60;
  el.textContent = h > 0 ? `${h}時間${pad(m)}分` : `${m}分`;
}

// 1秒ごとに経過時間更新 (進行中のときのみ)
setInterval(()=>{
  if(getActiveSession()){
    updateSessionElapsed();
  }
}, 30000); // 30秒ごと(電池節約)

// ============================================================
// セッションパネル(投入タブ)
// ============================================================
function renderSessionPanel(){
  const dateStr = state.date;
  const sessions = getSessionsForDate(dateStr);
  const dayHits = state.hits.filter(h=>h.date===dateStr);

  // サマリ
  const totalMin = sessions.reduce((s,x)=>s+sessionMinutes(x), 0);
  const totalHits = dayHits.length;
  const rate = totalMin > 0 ? (totalHits / (totalMin/60)).toFixed(2) : '—';
  document.getElementById('sessionSummary').innerHTML = `
    <div class="cell">
      <div class="label">セッション</div>
      <div class="val">${sessions.length}</div>
    </div>
    <div class="cell">
      <div class="label">投入時間</div>
      <div class="val">${totalMin}<span style="font-size:9px;opacity:.6">分</span></div>
    </div>
    <div class="cell">
      <div class="label">時間あたりHIT</div>
      <div class="val">${rate}<span style="font-size:9px;opacity:.6">/h</span></div>
    </div>
  `;

  // 一覧
  const list = document.getElementById('sessionList');
  if(sessions.length === 0){
    list.innerHTML = `<div class="empty-list" style="padding:20px">セッション未登録<br><span style="font-size:10px">「投入開始」または手動追加</span></div>`;
    return;
  }
  list.innerHTML = sessions.map(s => {
    const inSession = (h)=> {
      if(h.date !== s.date) return false;
      if(h.time < s.startTime) return false;
      const end = s.endTime || '23:59';
      return h.time <= end;
    };
    const sHits = dayHits.filter(inSession).length;
    const mins = sessionMinutes(s);
    const sRate = mins > 0 ? (sHits/(mins/60)).toFixed(2) : '—';
    const range = s.endTime ? `${s.startTime}〜${s.endTime}` : `${s.startTime}〜進行中`;
    return `
      <div class="session-card ${s.active?'active':''}">
        <div class="s-time">${range}</div>
        <div class="s-color">${s.color || '?'}</div>
        <div class="s-stat">${mins}分<br><b>${sHits}</b>HIT (${sRate}/h)</div>
        <button class="del-btn" data-sid="${s.id}" aria-label="削除">✕</button>
      </div>`;
  }).join('');

  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', ()=>{
      const id = btn.dataset.sid;
      if(confirm('このセッションを削除しますか?')){
        state.sessions = state.sessions.filter(s=>s.id!==id);
        saveSessions();
        renderAll();
      }
    });
  });
}

// ============================================================
// イベント登録
// ============================================================
function initEvents(){
  // 屋外モードトグル
  const outdoorBtn = document.getElementById('outdoorToggle');
  const savedOutdoor = localStorage.getItem('ekg_outdoor_v1') === '1';
  if(savedOutdoor){
    document.body.classList.add('outdoor');
    outdoorBtn.classList.add('on');
  }
  outdoorBtn.addEventListener('click', ()=>{
    const on = document.body.classList.toggle('outdoor');
    outdoorBtn.classList.toggle('on', on);
    localStorage.setItem('ekg_outdoor_v1', on ? '1' : '0');
    // チャートの再描画(色変更を反映)
    if(state.chart){renderChart()}
    toast(on ? '屋外モード ON' : '屋外モード OFF');
  });

  // Wake Lock (スリープ防止)
  const wakeBtn = document.getElementById('wakeLockToggle');
  wakeBtn.addEventListener('click', toggleWakeLock);
  // ページ復帰時にWake Lockを再取得
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'visible' && state.wakeLockRequested){
      requestWakeLock();
    }
  });

  // 日付ナビ
  const dp = document.getElementById('datePicker');
  dp.value = state.date;
  dp.addEventListener('change', ()=>{state.date = dp.value; renderAll()});
  document.getElementById('prevDay').addEventListener('click', ()=>shiftDay(-1));
  document.getElementById('nextDay').addEventListener('click', ()=>shiftDay(1));
  document.getElementById('todayBtn').addEventListener('click', ()=>{
    state.date = todayStr();
    dp.value = state.date;
    renderAll();
  });

  // HIT ボタン (誤タップ防止 + 強化フィードバック)
  const hitBtn = document.getElementById('hitBtn');
  let lastHitTime = 0;
  hitBtn.addEventListener('click', ()=>{
    // 1秒以内の連打を無視 (誤タップ防止)
    const now = Date.now();
    if(now - lastHitTime < 1000){
      toast('短時間の連打を無視');
      return;
    }
    lastHitTime = now;

    // 進行中セッションがあれば色を自動継承
    const activeSession = getActiveSession();
    const inferredColor = activeSession && activeSession.date === state.date ? activeSession.color : '';
    const hit = {
      id: uid(),
      date: state.date,
      time: nowHM(),
      color: inferredColor, size: null, weather: '', memo: '',
      createdAt: Date.now(),
    };
    state.hits.push(hit);
    saveHits();
    renderAll();
    hitBtn.classList.remove('flash'); void hitBtn.offsetWidth; hitBtn.classList.add('flash');
    // 強めのバイブパターン (釣りグローブで気付くため)
    if(navigator.vibrate) navigator.vibrate([60, 30, 80]);
    const msg = inferredColor ? `HIT記録 ${hit.time} (${inferredColor})` : `HIT記録 ${hit.time}`;
    toast(msg);
  });

  // 詳細入力
  document.getElementById('f-time').value = nowHM();
  document.getElementById('addDetailed').addEventListener('click', ()=>{
    const t = document.getElementById('f-time').value;
    if(!t){alert('時刻を入力'); return}
    const hit = {
      id: uid(),
      date: state.date,
      time: t,
      color: document.getElementById('f-color').value,
      size: parseFloat(document.getElementById('f-size').value) || null,
      weather: document.getElementById('f-weather').value,
      memo: document.getElementById('f-memo').value.trim(),
      createdAt: Date.now(),
    };
    state.hits.push(hit);
    saveHits();
    renderAll();
    // フォームリセット
    document.getElementById('f-size').value='';
    document.getElementById('f-memo').value='';
    document.getElementById('f-time').value = nowHM();
    // 記録タブへ
    switchPanel('list');
    toast('詳細を記録しました');
  });

  // タブ
  document.querySelectorAll('.tab').forEach(t=>{
    t.addEventListener('click', ()=>switchPanel(t.dataset.panel));
  });

  // ============== セッション関連 ==============
  // 投入開始(空状態) → ルアー選択 → セッション開始
  document.getElementById('startSessionBtn').addEventListener('click', ()=>{
    openLurePicker('ルアー色を選択', (color)=>{
      startSession(color);
      renderAll();
      toast(`${color} 投入開始`);
    });
  });
  // ルアー変更 → 既存セッション終了 + 新セッション開始
  document.getElementById('changeLureBtn').addEventListener('click', ()=>{
    const cur = getActiveSession();
    openLurePicker('ルアーを変更', (color)=>{
      // 現セッションをいま終了 → 同時刻で新セッション開始
      startSession(color); // 内部で既存をend
      renderAll();
      toast(`${color} に変更`);
    });
  });
  // 終了
  document.getElementById('stopSessionBtn').addEventListener('click', ()=>{
    const s = endActiveSession();
    if(s){
      renderAll();
      toast(`投入終了 (${sessionMinutes(s)}分)`);
    }
  });
  // ルアー選択モーダルのキャンセル
  document.getElementById('lurePickerClose').addEventListener('click', closeLurePicker);
  document.getElementById('lurePicker').addEventListener('click', (e)=>{
    if(e.target.id === 'lurePicker') closeLurePicker();
  });

  // 手動セッション追加
  document.getElementById('s-start').value = nowHM();
  document.getElementById('addSessionBtn').addEventListener('click', ()=>{
    const start = document.getElementById('s-start').value;
    const end = document.getElementById('s-end').value;
    const color = document.getElementById('s-color').value;
    if(!start || !end){alert('開始・終了時刻を入力してください'); return}
    if(end <= start){alert('終了時刻は開始より後にしてください'); return}
    const s = {
      id: uid(), date: state.date, color,
      startTime: start, endTime: end, memo:'', active:false,
    };
    state.sessions.push(s);
    saveSessions();
    renderAll();
    document.getElementById('s-end').value = '';
    toast('セッションを追加');
  });
  // ============================================

  // データ取得
  document.getElementById('fetchTide').addEventListener('click', tryFetchTide);
  document.getElementById('showPaste').addEventListener('click', ()=>{
    const a = document.getElementById('pasteArea');
    a.style.display = a.style.display==='none' ? 'block' : 'none';
  });
  document.getElementById('parsePaste').addEventListener('click', ()=>{
    const txt = document.getElementById('pasteBox').value;
    const parsed = parseJMATideText(txt);
    const keys = Object.keys(parsed);
    if(keys.length===0){
      showStatus('err', 'パースできませんでした。フォーマットを確認してください。');
      return;
    }
    Object.assign(state.tide, parsed);
    saveTide();
    showStatus('ok', `${keys.length}日分の潮位データを取込みました (${keys[0]} 〜 ${keys[keys.length-1]})`);
    document.getElementById('pasteBox').value='';
    renderAll();
  });

  // エクスポート
  document.getElementById('exportXLSX').addEventListener('click', exportXLSX);
  document.getElementById('exportCSV').addEventListener('click', exportCSV);
  document.getElementById('exportJSON').addEventListener('click', exportJSON);
  document.getElementById('importBtn').addEventListener('click', ()=>document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', importJSON);

  // 削除
  document.getElementById('clearAll').addEventListener('click', ()=>{
    if(confirm('全てのヒット記録・投入セッション・潮位データを削除します。元に戻せません。')){
      if(confirm('本当に削除しますか?')){
        state.hits = []; state.tide = {}; state.sessions = [];
        saveHits(); saveTide(); saveSessions();
        renderAll();
        toast('全データを削除しました');
      }
    }
  });
}

function shiftDay(d){
  const [y,m,day] = state.date.split('-').map(Number);
  const dt = new Date(y, m-1, day);
  dt.setDate(dt.getDate()+d);
  state.date = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`;
  document.getElementById('datePicker').value = state.date;
  renderAll();
}

function switchPanel(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.panel===name));
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active', p.id==='panel-'+name));
}

// ============================================================
// ルアー選択モーダル
// ============================================================
const LURE_COLORS = ['赤','ピンク','オレンジ','チャート','ナチュラル','クリア','黒','その他'];
let _lureCallback = null;

function openLurePicker(title, callback){
  document.getElementById('lurePickerTitle').textContent = title;
  const grid = document.getElementById('lureGrid');
  grid.innerHTML = LURE_COLORS.map(c => {
    const swatch = COLOR_MAP_SOLID[c] || '#c8a85a';
    return `<button data-color="${c}" style="--swatch:${swatch}">${c}</button>`;
  }).join('');
  grid.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', ()=>{
      closeLurePicker();
      if(navigator.vibrate) navigator.vibrate(20);
      callback(b.dataset.color);
    });
  });
  _lureCallback = callback;
  document.getElementById('lurePicker').classList.add('show');
}

function closeLurePicker(){
  document.getElementById('lurePicker').classList.remove('show');
  _lureCallback = null;
}

function showStatus(kind, msg){
  const s = document.getElementById('fetchStatus');
  s.className = 'status show '+kind;
  s.textContent = msg;
  setTimeout(()=>s.classList.remove('show'), 6000);
}

async function tryFetchTide(){
  const year = parseInt(state.date.slice(0,4), 10);
  showStatus('ok', `${year}年の潮位データを取得中…`);
  try{
    const txt = await fetchJMATide(year);
    const parsed = parseJMATideText(txt);
    const keys = Object.keys(parsed);
    if(keys.length===0) throw new Error('パース失敗');
    Object.assign(state.tide, parsed);
    saveTide();
    showStatus('ok', `${keys.length}日分の潮位データを取得しました`);
    renderAll();
  }catch(e){
    showStatus('err', '自動取得に失敗しました。「テキスト貼付け」をご利用ください。');
  }
}

// ============================================================
// Excel エクスポート (相関分析向け・複数シート構成)
//   Sheet 1: Hits_Raw       — 全ヒット記録 + 計算列 (潮位、上げ下げ、満潮からの時間など)
//   Sheet 2: Tide_Hourly    — 日付×時間の毎時潮位マトリクス
//   Sheet 3: Tide_HighLow   — 日付ごとの満干潮時刻・潮位
//   Sheet 4: Crosstab_Color_TideBand — 色×潮位帯のクロス集計 (COUNTIFS動的計算)
//   Sheet 5: Crosstab_Color_Phase    — 色×潮汐位相 (上げ/下げ) のクロス集計
//   Sheet 6: Summary        — 概要統計
//   Sheet 7: README         — 列定義・分析ヒント
// ============================================================
function exportXLSX(){
  if(typeof XLSX === 'undefined'){
    alert('Excelライブラリ(SheetJS)が読み込まれていません。通信環境を確認してください。');
    return;
  }
  if(state.hits.length === 0 && state.sessions.length === 0){
    alert('記録がありません');
    return;
  }

  const wb = XLSX.utils.book_new();
  const sortedHits = [...state.hits].sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));

  // ---------- 各ヒットの潮汐コンテキスト計算 ----------
  function tideContext(h){
    const td = state.tide[h.date];
    if(!td) return {tide:'', phase:'', deltaPrev:'', deltaNext:'', minutesFromHigh:'', minutesFromLow:''};
    const [hh,mm] = h.time.split(':').map(Number);
    const x = hh + mm/60;
    const tide = Math.round(interpolateTide(td.hourly, x));

    // 上げ/下げ判定 (前後30分の潮位差で判定)
    const before = interpolateTide(td.hourly, Math.max(0, x-0.5));
    const after = interpolateTide(td.hourly, Math.min(23.99, x+0.5));
    let phase = '';
    if(after > before + 1) phase = '上げ';
    else if(after < before - 1) phase = '下げ';
    else phase = '転流';

    // 直近の満潮/干潮からの分数
    const toMin = (t)=>{const [a,b]=t.split(':').map(Number); return a*60+b};
    const hitMin = hh*60+mm;
    let minHigh = '', minLow = '';
    if(td.high && td.high.length){
      const diffs = td.high.map(p => hitMin - toMin(p.time));
      minHigh = diffs.reduce((a,b)=>Math.abs(a)<Math.abs(b)?a:b);
    }
    if(td.low && td.low.length){
      const diffs = td.low.map(p => hitMin - toMin(p.time));
      minLow = diffs.reduce((a,b)=>Math.abs(a)<Math.abs(b)?a:b);
    }

    return {tide, phase,
      minutesFromHigh: minHigh,
      minutesFromLow: minLow,
    };
  }

  // ---------- Sheet 1: Hits_Raw ----------
  const rawHeader = [
    'date', 'time', 'hour_decimal', 'tide_cm', 'phase', 'min_from_high', 'min_from_low',
    'color', 'size_cm', 'weather', 'memo',
    'day_of_week', 'month', 'year'
  ];
  const rawRows = sortedHits.map(h => {
    const [hh,mm] = h.time.split(':').map(Number);
    const ctx = tideContext(h);
    const d = new Date(h.date + 'T00:00:00');
    const dow = ['日','月','火','水','木','金','土'][d.getDay()];
    return [
      h.date,
      h.time,
      +(hh + mm/60).toFixed(3),
      ctx.tide,
      ctx.phase,
      ctx.minutesFromHigh,
      ctx.minutesFromLow,
      h.color || '',
      h.size || '',
      h.weather || '',
      h.memo || '',
      dow,
      d.getMonth()+1,
      d.getFullYear(),
    ];
  });
  const wsRaw = XLSX.utils.aoa_to_sheet([rawHeader, ...rawRows]);
  // 列幅
  wsRaw['!cols'] = [
    {wch:12},{wch:8},{wch:10},{wch:9},{wch:8},{wch:13},{wch:13},
    {wch:10},{wch:9},{wch:8},{wch:24},{wch:6},{wch:6},{wch:6}
  ];
  // ヘッダーフリーズ
  wsRaw['!freeze'] = {xSplit:0, ySplit:1};
  XLSX.utils.book_append_sheet(wb, wsRaw, 'Hits_Raw');

  // ---------- Sheet 2: Tide_Hourly ----------
  const tideDates = Object.keys(state.tide).sort();
  if(tideDates.length > 0){
    const hourHeader = ['date', ...Array.from({length:24},(_,i)=>`h${pad(i)}`)];
    const tideRows = tideDates.map(d => [d, ...state.tide[d].hourly.map(v=>v??'')]);
    const wsTide = XLSX.utils.aoa_to_sheet([hourHeader, ...tideRows]);
    wsTide['!cols'] = [{wch:12}, ...Array(24).fill({wch:5})];
    wsTide['!freeze'] = {xSplit:1, ySplit:1};
    XLSX.utils.book_append_sheet(wb, wsTide, 'Tide_Hourly');

    // ---------- Sheet 3: Tide_HighLow ----------
    const hlHeader = ['date','high1_time','high1_cm','high2_time','high2_cm','low1_time','low1_cm','low2_time','low2_cm','range_cm'];
    const hlRows = tideDates.map(d => {
      const td = state.tide[d];
      const h1 = td.high[0]||{}, h2 = td.high[1]||{}, l1 = td.low[0]||{}, l2 = td.low[1]||{};
      const maxH = Math.max(...(td.high.map(h=>h.level).concat([0])));
      const minL = Math.min(...(td.low.map(h=>h.level).concat([9999])));
      const range = (maxH > 0 && minL < 9999) ? maxH - minL : '';
      return [d, h1.time||'', h1.level||'', h2.time||'', h2.level||'', l1.time||'', l1.level||'', l2.time||'', l2.level||'', range];
    });
    const wsHL = XLSX.utils.aoa_to_sheet([hlHeader, ...hlRows]);
    wsHL['!cols'] = [{wch:12},{wch:10},{wch:8},{wch:10},{wch:8},{wch:10},{wch:8},{wch:10},{wch:8},{wch:10}];
    wsHL['!freeze'] = {xSplit:1, ySplit:1};
    XLSX.utils.book_append_sheet(wb, wsHL, 'Tide_HighLow');
  }

  // ---------- Sheet 4: Crosstab Color × TideBand (COUNTIFS で動的) ----------
  const colors = [...new Set(sortedHits.map(h => h.color || '未記入'))];
  const bands = [
    {label:'<100', min:-9999, max:99.999},
    {label:'100-149', min:100, max:149.999},
    {label:'150-199', min:150, max:199.999},
    {label:'200-249', min:200, max:249.999},
    {label:'250-299', min:250, max:299.999},
    {label:'≥300', min:300, max:9999},
  ];
  // Hits_Raw のシート参照: D列=tide_cm, H列=color
  const rawSheetRef = `Hits_Raw!`;
  const lastRow = sortedHits.length + 1; // ヘッダー+データ行
  const ctHeader = ['color \\ tide(cm)', ...bands.map(b=>b.label), '計'];
  const ctRows = colors.map(c => {
    const row = [c];
    bands.forEach(b => {
      // COUNTIFS(色列, c, 潮位列, ">="&min, 潮位列, "<="&max)
      const colorMatch = c==='未記入' ? '""' : `"${c}"`;
      const formula = `COUNTIFS(${rawSheetRef}H2:H${lastRow},${colorMatch},${rawSheetRef}D2:D${lastRow},">=${b.min}",${rawSheetRef}D2:D${lastRow},"<=${b.max}")`;
      row.push({t:'n', v:0, f: formula});
    });
    // 行計は後でセルアドレスベースで埋める
    row.push(0);
    return row;
  });
  // 列計の行
  const totalRow = ['計'];
  bands.forEach(()=> totalRow.push(0));
  totalRow.push(0);

  const ctData = [ctHeader, ...ctRows, totalRow];
  const wsCT = XLSX.utils.aoa_to_sheet(ctData);
  // 行計・列計をセルアドレスベースで埋める
  const numBands = bands.length;
  const totalColIdx = numBands + 1; // 0-indexed: 色, b1, b2, ..., 計
  const totalColLetter = XLSX.utils.encode_col(totalColIdx);
  colors.forEach((c, i) => {
    const r = i + 2; // 1-indexed Excel row (header=1)
    const startCol = XLSX.utils.encode_col(1);
    const endCol = XLSX.utils.encode_col(numBands);
    const addr = `${totalColLetter}${r}`;
    wsCT[addr] = {t:'n', v:0, f: `SUM(${startCol}${r}:${endCol}${r})`};
  });
  const totalRowIdx = colors.length + 2;
  for(let j=1; j<=numBands; j++){
    const col = XLSX.utils.encode_col(j);
    const addr = `${col}${totalRowIdx}`;
    wsCT[addr] = {t:'n', v:0, f: `SUM(${col}2:${col}${totalRowIdx-1})`};
  }
  // 全体計
  const totalAddr = `${totalColLetter}${totalRowIdx}`;
  wsCT[totalAddr] = {t:'n', v:0, f: `SUM(B2:${XLSX.utils.encode_col(numBands)}${totalRowIdx-1})`};

  wsCT['!cols'] = [{wch:14}, ...Array(numBands).fill({wch:11}), {wch:8}];
  XLSX.utils.book_append_sheet(wb, wsCT, 'Crosstab_Color_Tide');

  // ---------- Sheet 5: Crosstab Color × Phase ----------
  const phases = ['上げ','下げ','転流'];
  const ctpHeader = ['color \\ 位相', ...phases, '計'];
  const ctpData = [ctpHeader];
  colors.forEach(c => {
    const row = [c];
    phases.forEach(p => {
      const colorMatch = c==='未記入' ? '""' : `"${c}"`;
      const f = `COUNTIFS(${rawSheetRef}H2:H${lastRow},${colorMatch},${rawSheetRef}E2:E${lastRow},"${p}")`;
      row.push({t:'n', v:0, f});
    });
    row.push(0);
    ctpData.push(row);
  });
  ctpData.push(['計', ...phases.map(()=>0), 0]);
  const wsCTP = XLSX.utils.aoa_to_sheet(ctpData);
  const numPhases = phases.length;
  const totalColLetterP = XLSX.utils.encode_col(numPhases+1);
  colors.forEach((c,i)=>{
    const r = i+2;
    const startCol = XLSX.utils.encode_col(1);
    const endCol = XLSX.utils.encode_col(numPhases);
    wsCTP[`${totalColLetterP}${r}`] = {t:'n', v:0, f:`SUM(${startCol}${r}:${endCol}${r})`};
  });
  const totalRowIdxP = colors.length + 2;
  for(let j=1; j<=numPhases; j++){
    const col = XLSX.utils.encode_col(j);
    wsCTP[`${col}${totalRowIdxP}`] = {t:'n', v:0, f:`SUM(${col}2:${col}${totalRowIdxP-1})`};
  }
  wsCTP[`${totalColLetterP}${totalRowIdxP}`] = {t:'n', v:0, f:`SUM(B2:${XLSX.utils.encode_col(numPhases)}${totalRowIdxP-1})`};

  wsCTP['!cols'] = [{wch:14}, ...Array(numPhases).fill({wch:9}), {wch:8}];
  XLSX.utils.book_append_sheet(wb, wsCTP, 'Crosstab_Color_Phase');

  // ---------- Sheet 6: Summary ----------
  const summaryData = [
    ['項目', '値', '備考'],
    ['総ヒット数', {t:'n', v:0, f:`COUNTA(${rawSheetRef}A2:A${lastRow})`}, '生データの行数'],
    ['潮位データあり', {t:'n', v:0, f:`COUNTIF(${rawSheetRef}D2:D${lastRow},">0")`}, '潮位カラムが数値のもの'],
    ['平均潮位 (cm)', {t:'n', v:0, f:`AVERAGEIF(${rawSheetRef}D2:D${lastRow},">0",${rawSheetRef}D2:D${lastRow})`}, ''],
    ['中央値潮位 (cm)', {t:'n', v:0, f:`MEDIAN(${rawSheetRef}D2:D${lastRow})`}, ''],
    ['最大サイズ (cm)', {t:'n', v:0, f:`MAX(${rawSheetRef}I2:I${lastRow})`}, ''],
    ['平均サイズ (cm)', {t:'n', v:0, f:`AVERAGEIF(${rawSheetRef}I2:I${lastRow},">0",${rawSheetRef}I2:I${lastRow})`}, ''],
    ['上げ潮でのヒット数', {t:'n', v:0, f:`COUNTIF(${rawSheetRef}E2:E${lastRow},"上げ")`}, ''],
    ['下げ潮でのヒット数', {t:'n', v:0, f:`COUNTIF(${rawSheetRef}E2:E${lastRow},"下げ")`}, ''],
    ['転流時のヒット数',   {t:'n', v:0, f:`COUNTIF(${rawSheetRef}E2:E${lastRow},"転流")`}, ''],
    [],
    ['—— 相関分析の準備 ——', '', ''],
    ['色 × 潮位帯のクロス表は Crosstab_Color_Tide シート', '', ''],
    ['色 × 潮汐位相 のクロス表は Crosstab_Color_Phase シート', '', ''],
    ['Rの chisq.test() または scipy.stats.chi2_contingency にそのまま渡せます', '', ''],
  ];
  const wsSum = XLSX.utils.aoa_to_sheet(summaryData);
  wsSum['!cols'] = [{wch:40},{wch:14},{wch:36}];
  XLSX.utils.book_append_sheet(wb, wsSum, 'Summary');

  // ============================================================
  // 追加シート: 投入セッション + ヒット率分析
  // ============================================================
  const allSessions = [...state.sessions]
    .filter(s => s.startTime)
    .sort((a,b)=>(a.date+a.startTime).localeCompare(b.date+b.startTime));

  if(allSessions.length > 0){
    // ---------- Sessions_Raw ----------
    // 各セッションに対し、潮汐位相(中央時刻)、潮位範囲、ヒット数、ヒット率を計算
    const sesHeader = [
      'session_id', 'date', 'color',
      'start_time', 'end_time', 'duration_min',
      'mid_time', 'mid_tide_cm', 'mid_phase',
      'tide_min_cm', 'tide_max_cm',
      'hits_in_session', 'hits_per_hour',
      'memo', 'day_of_week', 'month'
    ];
    const sesRows = allSessions.map(s => {
      const mins = sessionMinutes(s);
      const toMin = (t)=>{const [h,m]=t.split(':').map(Number); return h*60+m};
      const startMin = toMin(s.startTime);
      const endMin = s.endTime ? toMin(s.endTime) : startMin;
      const midMin = (startMin + endMin) / 2;
      const midH = Math.floor(midMin/60);
      const midM = Math.round(midMin%60);
      const midTime = `${pad(midH)}:${pad(midM)}`;

      const td = state.tide[s.date];
      let midTide = '', midPhase = '', tideMin = '', tideMax = '';
      if(td){
        midTide = Math.round(interpolateTide(td.hourly, midMin/60));
        // 位相
        const before = interpolateTide(td.hourly, Math.max(0, midMin/60 - 0.5));
        const after = interpolateTide(td.hourly, Math.min(23.99, midMin/60 + 0.5));
        if(after > before + 1) midPhase = '上げ';
        else if(after < before - 1) midPhase = '下げ';
        else midPhase = '転流';
        // セッション中の潮位レンジ
        const samples = [];
        for(let t = startMin; t <= endMin; t += 10){
          samples.push(interpolateTide(td.hourly, t/60));
        }
        if(samples.length){
          tideMin = Math.round(Math.min(...samples));
          tideMax = Math.round(Math.max(...samples));
        }
      }

      // セッション内ヒット数
      const sHits = state.hits.filter(h => {
        if(h.date !== s.date) return false;
        if(h.time < s.startTime) return false;
        const end = s.endTime || '23:59';
        return h.time <= end;
      }).length;
      const rate = mins > 0 ? +(sHits / (mins/60)).toFixed(3) : '';

      const d = new Date(s.date + 'T00:00:00');
      const dow = ['日','月','火','水','木','金','土'][d.getDay()];

      return [
        s.id, s.date, s.color || '',
        s.startTime, s.endTime || '', mins,
        midTime, midTide, midPhase,
        tideMin, tideMax,
        sHits, rate,
        s.memo || '', dow, d.getMonth()+1,
      ];
    });
    const wsSes = XLSX.utils.aoa_to_sheet([sesHeader, ...sesRows]);
    wsSes['!cols'] = [
      {wch:10},{wch:12},{wch:10},{wch:9},{wch:9},{wch:9},
      {wch:9},{wch:9},{wch:8},{wch:8},{wch:8},
      {wch:8},{wch:10},{wch:24},{wch:6},{wch:6}
    ];
    XLSX.utils.book_append_sheet(wb, wsSes, 'Sessions_Raw');

    // ---------- Hit_Rate_by_Color_Phase ----------
    // セッションを基準にした分母つきヒット率: 色 × 位相 → ヒット数/投入分/h^-1
    const sesLast = allSessions.length + 1; // ヘッダー+データ行のExcel行数
    const sesRef = 'Sessions_Raw!';
    // C=color, I=mid_phase, F=duration_min, L=hits_in_session
    const phasesAll = ['上げ','下げ','転流'];
    const colorsSes = [...new Set(allSessions.map(s => s.color || '未記入'))];
    const hrHeader = ['色', '位相', 'セッション数', '総投入分', '総HIT', 'HIT/h'];
    const hrRows = [];
    colorsSes.forEach(c => {
      phasesAll.forEach(p => {
        const colorMatch = c==='未記入' ? '""' : `"${c}"`;
        // セッション数 = COUNTIFS
        const nSes = `COUNTIFS(${sesRef}C2:C${sesLast},${colorMatch},${sesRef}I2:I${sesLast},"${p}")`;
        // 投入分合計 = SUMIFS
        const sumMin = `SUMIFS(${sesRef}F2:F${sesLast},${sesRef}C2:C${sesLast},${colorMatch},${sesRef}I2:I${sesLast},"${p}")`;
        // ヒット数合計 = SUMIFS
        const sumHits = `SUMIFS(${sesRef}L2:L${sesLast},${sesRef}C2:C${sesLast},${colorMatch},${sesRef}I2:I${sesLast},"${p}")`;
        // ヒット率 = ヒット数 / (投入分/60), ゼロ除算回避
        const rowIdx = hrRows.length + 2;
        const rateF = `IFERROR(E${rowIdx}/(D${rowIdx}/60),"")`;
        hrRows.push([
          c, p,
          {t:'n', v:0, f: nSes},
          {t:'n', v:0, f: sumMin},
          {t:'n', v:0, f: sumHits},
          {t:'n', v:0, f: rateF},
        ]);
      });
    });
    const wsHR = XLSX.utils.aoa_to_sheet([hrHeader, ...hrRows]);
    wsHR['!cols'] = [{wch:10},{wch:8},{wch:11},{wch:10},{wch:9},{wch:9}];
    XLSX.utils.book_append_sheet(wb, wsHR, 'Hit_Rate_Color_Phase');

    // ---------- Hit_Rate_by_Color_TideBand ----------
    // 色 × 潮位帯 (mid_tide_cm基準) のヒット率
    const hrtHeader = ['色', '潮位帯', 'セッション数', '総投入分', '総HIT', 'HIT/h'];
    const hrtRows = [];
    colorsSes.forEach(c => {
      bands.forEach(b => {
        const colorMatch = c==='未記入' ? '""' : `"${c}"`;
        // mid_tide_cm = H列
        const nSes = `COUNTIFS(${sesRef}C2:C${sesLast},${colorMatch},${sesRef}H2:H${sesLast},">=${b.min}",${sesRef}H2:H${sesLast},"<=${b.max}")`;
        const sumMin = `SUMIFS(${sesRef}F2:F${sesLast},${sesRef}C2:C${sesLast},${colorMatch},${sesRef}H2:H${sesLast},">=${b.min}",${sesRef}H2:H${sesLast},"<=${b.max}")`;
        const sumHits = `SUMIFS(${sesRef}L2:L${sesLast},${sesRef}C2:C${sesLast},${colorMatch},${sesRef}H2:H${sesLast},">=${b.min}",${sesRef}H2:H${sesLast},"<=${b.max}")`;
        const rowIdx = hrtRows.length + 2;
        const rateF = `IFERROR(E${rowIdx}/(D${rowIdx}/60),"")`;
        hrtRows.push([
          c, b.label,
          {t:'n', v:0, f: nSes},
          {t:'n', v:0, f: sumMin},
          {t:'n', v:0, f: sumHits},
          {t:'n', v:0, f: rateF},
        ]);
      });
    });
    const wsHRT = XLSX.utils.aoa_to_sheet([hrtHeader, ...hrtRows]);
    wsHRT['!cols'] = [{wch:10},{wch:10},{wch:11},{wch:10},{wch:9},{wch:9}];
    XLSX.utils.book_append_sheet(wb, wsHRT, 'Hit_Rate_Color_Tide');

    // ---------- Hit_Rate_Summary ----------
    // 色のみで集約した最重要指標
    const hrsHeader = ['色', 'セッション数', '総投入分', '総HIT', 'HIT/h', 'HIT/セッション'];
    const hrsRows = colorsSes.map((c, i) => {
      const colorMatch = c==='未記入' ? '""' : `"${c}"`;
      const r = i + 2;
      return [
        c,
        {t:'n', v:0, f: `COUNTIF(${sesRef}C2:C${sesLast},${colorMatch})`},
        {t:'n', v:0, f: `SUMIF(${sesRef}C2:C${sesLast},${colorMatch},${sesRef}F2:F${sesLast})`},
        {t:'n', v:0, f: `SUMIF(${sesRef}C2:C${sesLast},${colorMatch},${sesRef}L2:L${sesLast})`},
        {t:'n', v:0, f: `IFERROR(D${r}/(C${r}/60),"")`},
        {t:'n', v:0, f: `IFERROR(D${r}/B${r},"")`},
      ];
    });
    // 合計行
    const totalR = colorsSes.length + 2;
    hrsRows.push([
      '計',
      {t:'n', v:0, f: `SUM(B2:B${totalR-1})`},
      {t:'n', v:0, f: `SUM(C2:C${totalR-1})`},
      {t:'n', v:0, f: `SUM(D2:D${totalR-1})`},
      {t:'n', v:0, f: `IFERROR(D${totalR}/(C${totalR}/60),"")`},
      {t:'n', v:0, f: `IFERROR(D${totalR}/B${totalR},"")`},
    ]);
    const wsHRS = XLSX.utils.aoa_to_sheet([hrsHeader, ...hrsRows]);
    wsHRS['!cols'] = [{wch:10},{wch:11},{wch:10},{wch:8},{wch:9},{wch:13}];
    XLSX.utils.book_append_sheet(wb, wsHRS, 'Hit_Rate_Summary');
  }

  // ---------- Sheet: README ----------
  const readmeData = [
    ['== Hits_Raw 列定義 =='],
    ['列名', '説明', '分析でのヒント'],
    ['date', 'ヒット日 (YYYY-MM-DD)', '時系列分析・季節性検定の主キー'],
    ['time', 'ヒット時刻 (HH:MM, JST)', '時間帯分布のヒストグラム'],
    ['hour_decimal', '小数時 (例 14:30 → 14.5)', '潮位カーブの内挿に使用'],
    ['tide_cm', '推定潮位 (cm, 観測基準面上)', '気象庁天文潮位の毎時値を線形内挿'],
    ['phase', '潮汐位相 (上げ/下げ/転流)', '前後30分の潮位差で判定'],
    ['min_from_high', '直近の満潮からの経過分(±)', '負=満潮前, 正=満潮後'],
    ['min_from_low', '直近の干潮からの経過分(±)', '同上(干潮基準)'],
    ['color', 'ルアー色', '主要な説明変数'],
    ['size_cm', '魚体サイズ (cm)', '量的変数'],
    ['weather', '天候', 'カテゴリ'],
    ['memo', 'メモ欄', '質的データ'],
    ['day_of_week / month / year', '時期', '交絡変数'],
    [],
    ['== Sessions_Raw 列定義 =='],
    ['session_id', 'セッション識別子', ''],
    ['date', 'セッション日付', ''],
    ['color', 'セッション中のルアー色', '主要説明変数'],
    ['start_time / end_time', '開始・終了時刻', ''],
    ['duration_min', 'セッション継続時間(分)', 'ヒット率分母'],
    ['mid_time', 'セッション中央時刻', '位相判定の基準'],
    ['mid_tide_cm', '中央時刻での推定潮位', '量的変数'],
    ['mid_phase', '中央時刻での潮汐位相', 'カテゴリ説明変数'],
    ['tide_min_cm / tide_max_cm', 'セッション内の潮位レンジ', '潮位変動の幅'],
    ['hits_in_session', 'セッション内のHIT数', '応答変数'],
    ['hits_per_hour', '時間あたりHIT (=hits/(duration/60))', '応答変数'],
    [],
    ['== Hit_Rate シート群 =='],
    ['Hit_Rate_Summary',       '色別の総セッション数・投入分・HIT数・HIT/h', 'まず最初に見るシート'],
    ['Hit_Rate_Color_Phase',   '色 × 位相 のHIT/h', '位相による色の効果差'],
    ['Hit_Rate_Color_Tide',    '色 × 潮位帯 のHIT/h', '潮位帯による色の効果差'],
    ['※ いずれもセッションを分母とした「真のヒット率」', '', ''],
    [],
    ['== 推奨される分析の流れ =='],
    ['1. Hit_Rate_Summary で色別のHIT/h を比較 (記述統計)'],
    ['2. Hit_Rate_Color_Phase / Color_Tide で交互作用を目視確認'],
    ['3. ポアソン回帰 (R: glm(hits ~ color * phase + offset(log(duration_min)), family=poisson))'],
    ['   → これがヒット率の検定として最も適切。'],
    ['   offset でセッション時間を分母に含めることで、HIT/分 のlogをモデリング'],
    ['4. 過分散がある場合は負の二項回帰: glm.nb()'],
    ['5. または Sessions_Raw を pandas に読み込み、'],
    ['   from statsmodels.formula.api import glm'],
    ['   from statsmodels.genmod.families import Poisson'],
    ['   model = glm("hits_in_session ~ C(color)*C(mid_phase)",'],
    ['                data=df, family=Poisson(),'],
    ['                offset=np.log(df.duration_min)).fit()'],
    [],
    ['== カイ二乗との違い =='],
    ['・Crosstab_* シートはヒット回数だけのクロス表 → 「赤が多い」が分母無視'],
    ['・Hit_Rate_* シートは投入時間で正規化 → 真のヒット率比較が可能'],
    ['・600+データの過去研究を再分析する場合は、本シートの形式に移行することを推奨'],
    [],
    ['== 注意事項 =='],
    ['・潮位は気象庁の天文潮位 (予測値) であり、実測値ではありません'],
    ['・気象 (気圧・風) による偏差は反映されません'],
    ['・mid_phase はセッション中央時刻基準。長時間セッションでは位相が変わる可能性'],
    ['・短時間セッション(例:5分)はサンプル分散が大きくなりがち'],
  ];
  const wsReadme = XLSX.utils.aoa_to_sheet(readmeData);
  wsReadme['!cols'] = [{wch:18},{wch:38},{wch:42}];
  XLSX.utils.book_append_sheet(wb, wsReadme, 'README');

  // ---------- 書出し ----------
  const filename = `enkogawa_${todayStr()}.xlsx`;
  XLSX.writeFile(wb, filename);
  toast('Excel書出し完了');
}


function exportCSV(){
  if(state.hits.length===0){alert('記録がありません'); return}
  const header = ['date','time','tide_cm','color','size_cm','weather','memo'];
  const rows = state.hits
    .sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time))
    .map(h=>{
      const td = state.tide[h.date];
      const [hh,mm] = h.time.split(':').map(Number);
      const tide = td ? Math.round(interpolateTide(td.hourly, hh+mm/60)) : '';
      return [h.date, h.time, tide, h.color||'', h.size||'', h.weather||'', (h.memo||'').replace(/"/g,'""')]
        .map(v=>`"${v}"`).join(',');
    });
  download(`enkogawa_hits_${todayStr()}.csv`, '\uFEFF' + [header.join(','), ...rows].join('\n'), 'text/csv');
}

function exportJSON(){
  const data = {hits:state.hits, tide:state.tide, sessions:state.sessions, exportedAt:new Date().toISOString()};
  download(`enkogawa_backup_${todayStr()}.json`, JSON.stringify(data, null, 2), 'application/json');
}

function importJSON(e){
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const data = JSON.parse(reader.result);
      const hitsCount = data.hits && Array.isArray(data.hits) ? data.hits.length : 0;
      const sesCount = data.sessions && Array.isArray(data.sessions) ? data.sessions.length : 0;
      if(hitsCount === 0 && sesCount === 0){alert('読込みできるデータが見つかりませんでした'); return}
      if(confirm(`HIT ${hitsCount}件 / セッション ${sesCount}件 を読込みます。既存データに統合します。`)){
        const hitIds = new Set(state.hits.map(h=>h.id));
        (data.hits||[]).forEach(h=>{if(!hitIds.has(h.id)) state.hits.push(h)});
        const sesIds = new Set(state.sessions.map(s=>s.id));
        (data.sessions||[]).forEach(s=>{if(!sesIds.has(s.id)) state.sessions.push(s)});
        if(data.tide) Object.assign(state.tide, data.tide);
        saveHits(); saveTide(); saveSessions();
        renderAll();
        toast('読込み完了');
      }
    }catch(err){alert('読込みに失敗: '+err.message)}
  };
  reader.readAsText(file);
  e.target.value='';
}

function download(name, content, mime){
  const blob = new Blob([content], {type:mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ============================================================
// 起動
// ============================================================
window.addEventListener('DOMContentLoaded', ()=>{
  initEvents();
  renderAll();
});

// Service worker (オフライン対応 - PWA用、任意)
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}
