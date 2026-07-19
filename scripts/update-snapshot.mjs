/* Скачивает все заявления с urfu.ru, пакует в формат v2 (см. js/app.js → unpack)
   и обновляет assets/urfu_packed.json + SNAPSHOT_DATE в js/config.js.
   Запускается в CI перед сборкой артефакта Pages; при любой ошибке выходит
   с ненулевым кодом — деплой тогда уедет со старым срезом. */
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.URFU_API || 'https://urfu.ru/api/entrant/';
const CONC = 6, RETRIES = 3;
const MIN_ITEMS = 1000; // защита от пустой или обрезанной выгрузки

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// подбираем рабочий размер страницы
let size = null, first = null;
for (const s of [1000, 500, 200, 100, 50, 25, 20, 10]) {
  try {
    const j = await getJson(`${BASE}?page=1&size=${s}`);
    if (j.items) { size = s; first = j; break; }
  } catch {}
}
if (!size) { console.error('не нашёл рабочий size — API недоступен?'); process.exit(1); }

const total = first.count, pages = Math.ceil(total / size);
console.log(`size=${size}, записей=${total}, страниц=${pages}`);

const getPage = async (p) => {
  for (let t = 1; t <= RETRIES; t++) {
    try {
      const j = await getJson(`${BASE}?page=${p}&size=${size}`);
      if (j.items) return j.items;
    } catch {}
    await new Promise(r => setTimeout(r, 400 * t));
  }
  // частичные данные хуже вчерашних полных — падаем целиком
  throw new Error(`страница ${p} не скачалась после ${RETRIES} попыток`);
};

const buckets = new Array(pages);
buckets[0] = first.items;
let next = 2, done = 1;
const worker = async () => {
  while (next <= pages) {
    const p = next++;
    buckets[p - 1] = await getPage(p);
    if (++done % 10 === 0 || done === pages) console.log(`  ${done}/${pages} стр.`);
  }
};
await Promise.all(Array.from({ length: CONC }, worker));
const raw = buckets.flat();
if (raw.length < MIN_ITEMS) {
  console.error(`подозрительно мало записей: ${raw.length} < ${MIN_ITEMS}`);
  process.exit(1);
}

// пакуем со словарём (тот же формат, что снипет в index.html)
const dict = { program: [], speciality: [], institute: [], compensation: [], status: [] };
const idx = Object.fromEntries(Object.keys(dict).map(k => [k, new Map()]));
const id = (f, v) => {
  v = v || '';
  const m = idx[f];
  if (m.has(v)) return m.get(v);
  const i = dict[f].length;
  dict[f].push(v);
  m.set(v, i);
  return i;
};
const items = raw.map(e => ({
  r: e.regnum,
  a: (e.applications || []).map(a => [
    id('program', a.program), id('speciality', a.speciality), id('institute', a.institute),
    id('compensation', a.compensation), id('status', a.status),
    a.total_mark || 0, a.avgm || 0, a.achievs || 0, (a.priority == null ? null : a.priority),
  ]),
}));

writeFileSync('assets/urfu_packed.json', JSON.stringify({ v: 2, dict, items }));

const date = new Date()
  .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Yekaterinburg' })
  .replace(' г.', '');
const cfg = readFileSync('js/config.js', 'utf8')
  .replace(/const SNAPSHOT_DATE = '[^']*'/, `const SNAPSHOT_DATE = '${date}'`);
writeFileSync('js/config.js', cfg);

console.log(`готово: ${items.length} записей, срез от ${date}`);
