const $ = s => document.querySelector(s);
const DEFAULT_SUB = $('#dataSub').textContent;
let ENTRANTS = [];   // сырые items
let APPS = [];       // плоский список заявлений
let state = { view:'summary', group:'program', mode:'apps', comp:'', inst:'', status:'', prio:'', smin:'', smax:'', search:'', sortDesc:true, rSort:'total', meDir:'', meComp:'', meScore:'' };

/* ---------- загрузка ---------- */
function setStatus(msg, cls){
  const s=$('#status'); s.textContent=msg; s.className='status'+(cls?' '+cls:'');
  // если приложение уже открыто (обновление данных на лету) — дублируем статус в шапку
  if(!$('#app').classList.contains('hidden')) $('#dataSub').textContent = msg || DEFAULT_SUB;
}

async function fetchFromServer(){
  setStatus('Тянем данные с urfu.ru…');
  $('#btnFetch').disabled = true;
  try{
    const base = 'https://urfu.ru/api/entrant/';
    let size=null, first=null;
    for(const s of [1000,500,200,100,50,25,20,10]){
      const r = await fetch(`${base}?page=1&size=${s}`);
      if(r.ok){ const j=await r.json(); if(j.items){ size=s; first=j; break; } }
    }
    if(!size) throw new Error('не нашёл рабочий size');
    const total=first.count, pages=Math.ceil(total/size);
    const CONC=6, RETRIES=3;
    const buckets=new Array(pages); buckets[0]=first.items;
    let nextPage=2, done=1, got=first.items.length;
    const getPage=async(p)=>{
      for(let t=1;t<=RETRIES;t++){
        try{ const r=await fetch(`${base}?page=${p}&size=${size}`);
          if(r.ok){ const j=await r.json(); if(j.items) return j.items; } }catch(e){}
        await new Promise(res=>setTimeout(res,400*t));
      }
      return [];
    };
    const worker=async()=>{ while(nextPage<=pages){ const p=nextPage++;
      buckets[p-1]=await getPage(p); got+=buckets[p-1].length; done++;
      setStatus(`Загружено ${got} из ${total} · ${done}/${pages} стр.…`); } };
    await Promise.all(Array.from({length:CONC},worker));
    ingest(buckets.flat(), new Date().toLocaleString('ru',{day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'})+' (загружено с urfu.ru)');
  }catch(e){
    setStatus('Не удалось загрузить с urfu.ru ('+e.message+'). Скорее всего, сервер не отдаёт данные браузеру (CORS) — остаёмся на текущих данных.', 'err');
  }finally{
    $('#btnFetch').disabled = false;
  }
}

function parseLoaded(obj){
  // принимаем и {items:[...]}, и голый массив
  const items = Array.isArray(obj) ? obj : (obj && obj.items);
  if(!Array.isArray(items)) throw new Error('не вижу массив items');
  return items;
}

// сжатый формат со словарём (v:2) -> обычные items
function unpack(obj){
  const D = obj.dict;
  return obj.items.map(e=>({
    regnum: e.r,
    applications: (e.a||[]).map(x=>({
      program: D.program[x[0]],
      speciality: D.speciality[x[1]],
      institute: D.institute[x[2]],
      compensation: D.compensation[x[3]],
      status: D.status[x[4]],
      total_mark: x[5],
      avgm: x[6],
      achievs: x[7],
      priority: x[8]
    }))
  }));
}

function loadObject(obj, label){
  const items = (obj && obj.v===2 && obj.dict) ? unpack(obj) : parseLoaded(obj);
  ingest(items, label);
}

/* ---------- подготовка данных ---------- */
function ingest(items, sourceLabel){
  ENTRANTS = items;
  APPS = [];
  for(const ent of items){
    const reg = ent.regnum;
    for(const a of (ent.applications||[])){
      APPS.push({
        regnum: reg,
        program: a.program || '—',
        speciality: a.speciality || '—',
        institute: a.institute || '—',
        compensation: a.compensation || '—',
        status: a.status || '—',
        total: Number(a.total_mark)||0,
        avgm: Number(a.avgm)||0,
        achievs: Number(a.achievs)||0,
        priority: (a.priority==null?'':a.priority),
        marks: a.marks||{}
      });
    }
  }
  buildFilters();
  $('#dataSub').textContent = sourceLabel ? 'Данные обновлены: '+sourceLabel : DEFAULT_SUB;
  $('#loader').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#sEntrants').textContent = ENTRANTS.length.toLocaleString('ru');
  $('#sApps').textContent = APPS.length.toLocaleString('ru');
  render();
}

function uniqueSorted(field){
  return [...new Set(APPS.map(a=>a[field]))].filter(Boolean).sort((a,b)=>a.localeCompare(b,'ru'));
}
function fillSelect(sel, values){
  const cur = sel.value;
  sel.innerHTML = '<option value="">все</option>' + values.map(v=>`<option>${esc(v)}</option>`).join('');
  sel.value = cur;
}
function buildFilters(){
  fillSelect($('#fComp'), uniqueSorted('compensation'));
  fillSelect($('#fInst'), uniqueSorted('institute'));
  fillSelect($('#fStatus'), uniqueSorted('status'));
  // приоритеты: числовые по возрастанию + «без приоритета»
  const prios = [...new Set(APPS.map(a=>a.priority).filter(p=>p!==''))].sort((a,b)=>a-b);
  const sel = $('#fPrio'), cur = sel.value;
  sel.innerHTML = '<option value="">любой</option>'
          + prios.map(p=>`<option value="${p}">${p}</option>`).join('')
          + '<option value="none">без приоритета</option>';
  sel.value = cur;
  // «Где я»: список направлений (программ) для автодополнения + финансирование
  const dirs = uniqueSorted('program');
  $('#dirList').innerHTML = dirs.map(d=>`<option value="${esc(d)}">`).join('');
  fillSelect($('#meComp'), uniqueSorted('compensation'));
  $('#meComp').querySelector('option[value=""]').textContent = 'любое';
}

/* ---------- агрегация ---------- */
function aggregate(){
  const key = state.group;         // program | speciality
  const map = new Map();           // name -> count | Set
  let shownTotal = 0;
  const seenPeopleAll = new Set();

  for(const a of APPS){
    if(!passFilters(a)) continue;

    const name = a[key];
    if(state.mode === 'people'){
      if(!map.has(name)) map.set(name, new Set());
      map.get(name).add(a.regnum);
      seenPeopleAll.add(a.regnum);
    }else{
      map.set(name, (map.get(name)||0)+1);
      shownTotal++;
    }
  }
  if(state.mode==='people') shownTotal = seenPeopleAll.size;

  let rows = [...map.entries()].map(([name,v])=>({
    name,
    spec: key==='program' ? specForProgram(name) : null,
    count: state.mode==='people' ? v.size : v
  }));
  rows.sort((a,b)=> state.sortDesc ? b.count-a.count : a.count-b.count);
  return { rows, shownTotal };
}
// подтягиваем код специальности к программе для подписи
const _progSpec = {};
function specForProgram(prog){
  if(prog in _progSpec) return _progSpec[prog];
  const hit = APPS.find(a=>a.program===prog);
  return _progSpec[prog] = hit ? hit.speciality : '';
}

/* ---------- единый предикат фильтрации ---------- */
function passFilters(a){
  if(state.comp && a.compensation !== state.comp) return false;
  if(state.inst && a.institute !== state.inst) return false;
  if(state.status && a.status !== state.status) return false;
  if(state.prio!==''){
    if(state.prio==='none'){ if(a.priority!=='') return false; }
    else if(String(a.priority)!==state.prio) return false;
  }
  if(state.smin!=='' && a.total < +state.smin) return false;
  if(state.smax!=='' && a.total > +state.smax) return false;
  const q = state.search.trim().toLowerCase();
  if(q && !(a.program.toLowerCase().includes(q) || a.speciality.toLowerCase().includes(q) || String(a.regnum).includes(q))) return false;
  return true;
}

/* ---------- общий фильтр заявлений ---------- */
function filterApps(){ return APPS.filter(passFilters); }

/* ---------- отрисовка ---------- */
function render(){
  const v = state.view;
  $('#cardSummary').classList.toggle('hidden', v!=='summary');
  $('#cardRating').classList.toggle('hidden', v!=='rating');
  $('#cardFirst').classList.toggle('hidden', v!=='first');
  $('#cardMe').classList.toggle('hidden', v!=='me');
  // видимость фильтров по атрибуту data-views
  document.querySelectorAll('#app .controls .field[data-views]').forEach(f=>{
    f.classList.toggle('hidden', !f.dataset.views.split(' ').includes(v));
  });
  // CSV только для сводки и рейтинга; статистика-плашки прячем в «Где я»
  $('#btnCsv').classList.toggle('hidden', !(v==='summary'||v==='rating'));
  $('.stats') && document.querySelector('.stats').classList.toggle('hidden', v==='me');
  ({summary:renderSummary, rating:renderRating, first:renderFirst, me:renderMe})[v]();
}

function renderSummary(){
  const {rows, shownTotal} = aggregate();
  const maxByVal = Math.max(1, ...rows.map(r=>r.count));

  $('#sShownCount').textContent = shownTotal.toLocaleString('ru');
  $('#sShownLbl').textContent = state.mode==='people' ? 'людей в срезе' : 'заявлений в срезе';
  $('#sDirs').textContent = rows.length.toLocaleString('ru');
  $('#thCount').textContent = 'Кол-во ' + (state.sortDesc?'↓':'↑');

  const box = $('#rows');
  if(!rows.length){ box.innerHTML = '<div class="empty">Ничего не найдено под эти фильтры.</div>'; $('#ftInfo').textContent=''; return; }

  box.innerHTML = rows.map((r,i)=>{
    const w = (r.count/maxByVal*100).toFixed(1);
    const top = i<3 ? ' top' : '';
    const spec = r.spec ? `<span class="spec">${esc(r.spec)}</span>` : '';
    return `<div class="trow${top}">
    <div class="bar" style="width:${w}%"></div>
    <div class="rank">${i+1}</div>
    <div class="name">${esc(r.name)}${spec}</div>
    <div class="count">${r.count.toLocaleString('ru')}</div>
  </div>`;
  }).join('');

  $('#ftInfo').textContent = `${rows.length} направлений · сумма по срезу: ${rows.reduce((s,r)=>s+r.count,0).toLocaleString('ru')} ${state.mode==='people'?'(с учётом пересечений между направлениями)':'заявлений'}`;
}

function renderRating(){
  const k = state.rSort;
  let apps = filterApps().slice();
  apps.sort((a,b)=>{
    if(k==='priority'){ // пустой приоритет — в конец, иначе по возрастанию
      const pa=a.priority===''?1e9:a.priority, pb=b.priority===''?1e9:b.priority;
      return pa-pb;
    }
    return b[k]-a[k]; // total / avgm — по убыванию
  });

  $('#sShownCount').textContent = apps.length.toLocaleString('ru');
  $('#sShownLbl').textContent = 'заявлений в срезе';
  $('#sDirs').textContent = new Set(apps.map(a=>a.regnum)).size.toLocaleString('ru');
  document.querySelectorAll('.thead-r .sortable').forEach(el=>{
    const on = el.dataset.k===k;
    el.classList.toggle('on', on);
    const base = el.dataset.k==='priority' ? 'Приор.' : (el.dataset.k==='achievs'?'ИД':'Балл');
    el.textContent = base + (on && el.dataset.k!=='priority' ? ' ↓' : '');
  });

  const box = $('#rowsR');
  if(!apps.length){ box.innerHTML='<div class="empty">Ничего не найдено под эти фильтры.</div>'; $('#ftInfo').textContent=''; return; }

  const LIMIT = 3000;
  const shown = apps.slice(0, LIMIT);
  box.innerHTML = shown.map((a,i)=>`<div class="trow-r">
  <div class="rank">${i+1}</div>
  <div class="reg">${a.regnum}</div>
  <div class="dir" title="${esc(a.program)}">${esc(a.program)}</div>
  <div class="num pr">${a.priority===''?'<span class="zero">—</span>':a.priority}</div>
  <div class="num av${a.achievs?'':' zero'}">${a.achievs||0}</div>
  <div class="num big${a.total?'':' zero'}">${a.total||0}</div>
</div>`).join('');

  $('#ftInfo').textContent = apps.length>LIMIT
          ? `Показаны первые ${LIMIT.toLocaleString('ru')} из ${apps.length.toLocaleString('ru')} — сузьте фильтром или поиском`
          : `${apps.length.toLocaleString('ru')} заявлений`;
}

function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

/* ---------- вид «1-й выбор» ---------- */
function renderFirst(){
  const key = state.group;
  const q = state.search.trim().toLowerCase();
  const tot = new Map(), p1 = new Map();
  for(const a of APPS){
    if(state.comp && a.compensation!==state.comp) continue;
    if(state.inst && a.institute!==state.inst) continue;
    if(q && !(a.program.toLowerCase().includes(q) || a.speciality.toLowerCase().includes(q))) continue;
    const name = a[key];
    tot.set(name,(tot.get(name)||0)+1);
    if(a.priority===1) p1.set(name,(p1.get(name)||0)+1);
  }
  let rows = [...tot.entries()].map(([name,t])=>({
    name, spec: key==='program'?specForProgram(name):null,
    total:t, p1:p1.get(name)||0
  }));
  rows.sort((a,b)=> b.p1-a.p1 || b.total-a.total);

  const maxTotal = Math.max(1, ...rows.map(r=>r.total));
  $('#sShownCount').textContent = rows.reduce((s,r)=>s+r.p1,0).toLocaleString('ru');
  $('#sShownLbl').textContent = 'заявлений 1-м приоритетом';
  $('#sDirs').textContent = rows.length.toLocaleString('ru');

  const box = $('#rowsF');
  if(!rows.length){ box.innerHTML='<div class="empty">Ничего не найдено под эти фильтры.</div>'; $('#ftInfo').textContent=''; return; }
  box.innerHTML = rows.map((r,i)=>{
    const wt=(r.total/maxTotal*100).toFixed(1), wp=(r.p1/maxTotal*100).toFixed(1);
    const share=r.total?Math.round(r.p1/r.total*100):0;
    const spec=r.spec?` <span style="color:var(--faint);font-family:var(--mono);font-size:11px">${esc(r.spec.split(' ')[0])}</span>`:'';
    return `<div class="trow-f">
    <div class="bar" style="width:${wt}%"></div>
    <div class="bar p1" style="width:${wp}%"></div>
    <div class="rank">${i+1}</div>
    <div class="name" title="${esc(r.name)}">${esc(r.name)}${spec}</div>
    <div class="num p1">${r.p1.toLocaleString('ru')}</div>
    <div class="num">${r.total.toLocaleString('ru')}</div>
    <div class="num share">${share}%</div>
  </div>`;
  }).join('');
  $('#ftInfo').textContent = 'Тёмная полоса — сколько человек поставили направление первым приоритетом; светлая — все заявления. «Доля 1-х» = насколько это направление для людей главное.';
}

/* ---------- вид «Где я» ---------- */
function renderMe(){
  const box = $('#meResult');
  $('#ftInfo').textContent = '';
  const dir = state.meDir.trim();
  const score = state.meScore==='' ? null : +state.meScore;
  if(!dir){ box.innerHTML='<div class="me-empty">Выбери направление из списка, укажи финансирование и введи свой балл — покажу твою позицию в текущем списке подавших.</div>'; return; }

  let list = APPS.filter(a=> a.program===dir && (!state.meComp || a.compensation===state.meComp));
  if(!list.length){ box.innerHTML='<div class="me-empty">На это направление с выбранным финансированием заявлений пока нет. Проверь название (выбирай из подсказок) или сними фильтр финансирования.</div>'; return; }

  list.sort((a,b)=> b.total-a.total);
  const n = list.length;
  const scored = list.filter(a=>a.total>0).length;

  if(score===null){
    box.innerHTML = `<div class="me-empty">В списке «${esc(dir)}»${state.meComp?` (${esc(state.meComp)})`:''} сейчас <b>${n}</b> заявлений${scored<n?`, из них с проставленным баллом — ${scored}`:''}. Введи свой балл, чтобы увидеть позицию.</div>`;
    return;
  }

  const above = list.filter(a=>a.total>score).length;
  const equal = list.filter(a=>a.total===score).length;
  const below = n-above-equal;
  const posFrom = above+1, posTo = above+equal;
  const pctBelow = Math.round(below/n*100);

  // соседи: несколько выше и ниже точки вставки
  const idx = above; // позиция вставки (0-based) перед равными
  const from = Math.max(0, idx-5), to = Math.min(n, idx+6);
  const neigh = list.slice(from, to).map((a,j)=>{
    const rank = from+j+1;
    return `<div class="me-row"><span class="r">${rank}</span><span class="reg">${a.regnum}${a.priority===1?' · 1-й приор.':''}</span><span class="sc">${a.total||0}</span></div>`;
  });
  // строка «ты» — вставляем на границу above|equal
  const youRow = `<div class="me-row you"><span class="r">${posFrom}${equal>1?'–'+posTo:''}</span><span class="reg">твой балл ${score}</span><span class="sc">${score}</span></div>`;
  const insertAt = above - from; // сколько соседей идёт до тебя
  neigh.splice(insertAt, 0, youRow);

  box.innerHTML = `
  <div class="me-head">
    <div><span class="me-pos-n">#${posFrom}${equal>1?'–'+posTo:''}</span> <span class="me-pos-of">из ${n}</span></div>
    <div class="me-pct">ты выше <b>${pctBelow}%</b> подавших</div>
  </div>
  <div class="me-sub">
    Выше по баллу: <b>${above}</b> · с таким же (${score}): <b>${equal>0?equal-0:0}</b> · ниже: <b>${below}</b>.
    ${scored<n?`<br>Ещё <b>${n-scored}</b> заявлений без проставленного балла (стоят внизу).`:''}
    ${state.meComp?'':'<br>Показаны бюджет и контракт вместе — выбери финансирование, чтобы сузить.'}
  </div>
  <div class="me-list">${neigh.join('')}</div>`;
}

/* ---------- CSV ---------- */
function exportCsv(){
  if(state.view==='rating'){ exportRatingCsv(); return; }
  const {rows} = aggregate();
  const head = state.group==='program' ? ['Программа','Специальность','Количество'] : ['Специальность','Количество'];
  const lines = [head.join(';')];
  for(const r of rows){
    const cells = state.group==='program' ? [r.name, r.spec||'', r.count] : [r.name, r.count];
    lines.push(cells.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(';'));
  }
  const blob = new Blob(['\uFEFF'+lines.join('\n')], {type:'text/csv;charset=utf-8'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download = `urfu_${state.group}_${state.mode}.csv`; a.click();
}

function exportRatingCsv(){
  const k=state.rSort;
  const apps=filterApps().slice().sort((a,b)=>{
    if(k==='priority'){const pa=a.priority===''?1e9:a.priority,pb=b.priority===''?1e9:b.priority;return pa-pb;}
    return b[k]-a[k];
  });
  const head=['Рег.номер','Программа','Специальность','Финансирование','Приоритет','Балл','Ср.балл аттестата','Достижения','Статус'];
  const lines=[head.join(';')];
  for(const a of apps){
    const cells=[a.regnum,a.program,a.speciality,a.compensation,a.priority,a.total,a.avgm,a.achievs,a.status];
    lines.push(cells.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(';'));
  }
  const blob=new Blob(['\uFEFF'+lines.join('\n')],{type:'text/csv;charset=utf-8'});
  const el=document.createElement('a'); el.href=URL.createObjectURL(blob);
  el.download='urfu_reyting.csv'; el.click();
}

/* ---------- встроенный срез ---------- */
const SNAPSHOT_LABEL = `${SNAPSHOT_DATE} (срез обновляется автоматически раз в день)`;
async function loadSnapshot(){
  try{
    if(SNAPSHOT_DATA){ loadObject(SNAPSHOT_DATA, SNAPSHOT_LABEL); return; }
    if(SNAPSHOT_URL){
      setStatus('Открываю срез от '+SNAPSHOT_DATE+'…');
      const r = await fetch(SNAPSHOT_URL);
      if(!r.ok) throw new Error('HTTP '+r.status);
      loadObject(await r.json(), SNAPSHOT_LABEL);
      return;
    }
  }catch(e){
    setStatus('Не удалось открыть срез ('+e.message+') — попробуйте ещё раз или загрузите с сервера.', 'err');
  }
}
function initSnapshot(){
  if(!(SNAPSHOT_DATA || SNAPSHOT_URL)) return;
  const btn = $('#btnSnap');
  btn.textContent = `Открыть срез от ${SNAPSHOT_DATE}`;
  btn.classList.remove('hidden');
  btn.onclick = loadSnapshot;
  loadSnapshot(); // основной сценарий: сразу показываем последний задеплоенный срез
}
initSnapshot();

/* ---------- события ---------- */
$('#btnFetch').onclick = fetchFromServer;

$('#segView').onclick = e=>{ const b=e.target.closest('button'); if(!b)return;
  state.view=b.dataset.v; [...e.currentTarget.children].forEach(x=>x.classList.toggle('on',x===b)); render(); };
$('#cardRating').querySelector('.thead-r').addEventListener('click', e=>{
  const c=e.target.closest('.sortable'); if(!c)return; state.rSort=c.dataset.k; render(); });
$('#segGroup').onclick = e=>{ const b=e.target.closest('button'); if(!b)return;
  state.group=b.dataset.v; [...e.currentTarget.children].forEach(x=>x.classList.toggle('on',x===b)); render(); };
$('#segMode').onclick = e=>{ const b=e.target.closest('button'); if(!b)return;
  state.mode=b.dataset.v; [...e.currentTarget.children].forEach(x=>x.classList.toggle('on',x===b)); render(); };
$('#fComp').onchange = e=>{ state.comp=e.target.value; render(); };
$('#fInst').onchange = e=>{ state.inst=e.target.value; render(); };
$('#fStatus').onchange = e=>{ state.status=e.target.value; render(); };
$('#fPrio').onchange = e=>{ state.prio=e.target.value; render(); };
$('#fSmin').oninput = e=>{ state.smin=e.target.value; render(); };
$('#fSmax').oninput = e=>{ state.smax=e.target.value; render(); };
$('#fSearch').oninput = e=>{ state.search=e.target.value; render(); };
$('#thCount').onclick = ()=>{ state.sortDesc=!state.sortDesc; render(); };
$('#meDir').oninput = e=>{ state.meDir=e.target.value; renderMe(); };
$('#meComp').onchange = e=>{ state.meComp=e.target.value; renderMe(); };
$('#meScore').oninput = e=>{ state.meScore=e.target.value; renderMe(); };
$('#btnCsv').onclick = exportCsv;
$('#btnUpdate').onclick = async ()=>{
  const b=$('#btnUpdate'); b.disabled=true;
  try{ await fetchFromServer(); }
  finally{ b.disabled=false; }
};
