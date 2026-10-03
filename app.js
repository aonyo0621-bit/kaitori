"use strict";
// 買取価格比較: data/*.json（暗号化時は *.enc）を読み、商品ごとに各店の価格を並べる。
// 表示は「ランキング」（商品ごとに高い店順。店が増えても横に伸びない）と「店別の表」（PC 向け）。
const $ = (id) => document.getElementById(id);
const PAGE = 50;
const RECENT_DAYS = 7;          // この日数以内に変わった価格に前回比を出す
const TOP_PC = 6, TOP_SP = 3;   // ランキングで最初に見せる店の数

// data・hist はカテゴリ ID で引く。共有リンク・端末の保存値から来た ID（"constructor" 等）で Object の既定のプロパティに当たらないよう、プロトタイプ無しの入れ物にする
const st = { shopSort: null, mode: null, key: null, status: null, sites: {}, cat: null, data: Object.create(null), hist: Object.create(null),
  shown: PAGE, rows: [], view: "rank", open: new Set(), mvOn: false, mvData: null, mvFailed: false, mvInfo: new Map(), mvRange: null,
  prof: new Map(), skew: 0 };  // prof = 商品 ID → 実利益の欄を開いているか（押した時だけ。無ければ仕入れ値がある商品のカードは開く）。skew = サーバーの時刻 − 端末の時計
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  // 保存できなかった項目 → その時の保存値（生の文字列）。画面の値の方が新しい印で、次に保存できたら外す。設定の控え（sync.js）は、保存値が
  // その時のままなら読み直しで上書きせず、画面の値を書き出す（2026-09-29 ASTRA 指摘: ★の保存が容量不足で失敗すると、画面には残るのに
  // 「書き出す」の前の読み直しで古い保存値に戻り、控えから消えていた）。設定の項目（label）は失敗を知らせる（続けて失敗する間は 1 回だけ）
  miss: new Map(),
  label: { favs: "★", hiddenShops: "比較から外した店", includeStore: "来店のみの扱い", patterns: "保存したパターン", fees: "送料・手数料の設定",
    cart: "在庫リスト", cartName: "在庫リストの名前", buyPrices: "仕入れ値", profitSet: "計算の設定", skin: "見た目", cartLimit: "店数の上限" },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); store.miss.delete(k); return true; }
    catch {
      let now = null; try { now = localStorage.getItem(k); } catch {}
      const first = !store.miss.has(k), what = store.label[k];
      store.miss.set(k, now);
      if (first && what) store.say(`この端末に${what}を保存できませんでした（保存の容量不足など）。この画面を閉じると消えます。画面の一番下の「設定の控え」から書き出せます`);
      return false;
    }
  },
  // 知らせ（cart.js の toast）を、呼んだ処理の知らせ（「在庫リストに追加」等）の後に出す（先に出すと上書きされて見えない）。
  // 起動の途中（画面の部品を読み終える前。toast はまだ id="toast" の要素）なら、読み終えてから出す
  say(msg) {
    const f = () => { try { toast(msg); } catch {} };
    if (typeof document !== "undefined" && document.readyState === "loading") addEventListener("DOMContentLoaded", f, { once: true });
    else setTimeout(f, 0);
  },
  // 端末に残った値が壊れている・古い版の形の時は既定値にする（配列でない・想定外の値で画面全体が止まらないように。2026-09-27 多角チェック1）
  strs(k) { const v = this.get(k, []); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; },
  pick(k, ok, d) { const v = this.get(k, d); return ok.includes(v) ? v : d; },
};
let favs = new Set(store.strs("favs"));
let hidden = new Set(store.strs("hiddenShops"));  // 比較から外した店
let includeStore = store.get("includeStore", false) === true;  // 来店のみの価格も最高値・順位・計算に含めるか
const wide = matchMedia("(min-width: 1000px)");
const dark = matchMedia("(prefers-color-scheme: dark)");

// ---- 読み込み・復号 ----
// パスワードは PBKDF2 の元の鍵（取り出せない CryptoKey）にして持つ。端末に覚えるのもこの鍵で、パスワードの文字列は残さない
// （以前は localStorage に平文で保存していた。2026-09-27 多角チェック1）。鍵は IndexedDB に置く（CryptoKey は取り出せないまま保存できる）
const pwKey = (pw) => crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
const keyDb = {
  // 失敗（非公開モードで IndexedDB が無い等）は null。3 秒待っても返事が無い時も null（IndexedDB が返事をしないと、
  // 入力画面も出ずに白いままになるため。2026-09-27 多角チェック2）
  // 打ち切りは読み出し（起動時に画面が白いままにならないように）だけ。保存・削除は最後まで待つ（打ち切ると、
  // 保存が遅れて成功したのに平文も残す・ログアウトしても鍵が残る。2026-09-28 多角チェック）
  // bad = 最後の読み書きが失敗した（IndexedDB を使えない端末。打ち切りは入れない）。入力画面に「開くたびに入力」を出す
  bad: false,
  run(mode, f, limit = 0) {
    const job = (async () => {
      const db = await new Promise((ok, ng) => { const r = indexedDB.open("kaitori", 1); r.onupgradeneeded = () => r.result.createObjectStore("k"); r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error); });
      return await new Promise((ok, ng) => { const tx = db.transaction("k", mode), q = f(tx.objectStore("k")); tx.oncomplete = () => { db.close(); ok(mode === "readonly" ? q.result : true); }; tx.onerror = tx.onabort = () => { db.close(); ng(tx.error); }; });
    })().then((r) => { keyDb.bad = false; return r; }, () => { keyDb.bad = true; return null; });
    return limit ? Promise.race([job, new Promise((ok) => setTimeout(() => ok(null), limit))]) : job;
  },
  get() { return this.run("readonly", (s) => s.get("pw"), 3000); },
  set(k) { return this.run("readwrite", (s) => s.put(k, "pw")); },
  del() { return this.run("readwrite", (s) => s.delete("pw")); },
};
async function decrypt(b64, base) {
  const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const salt = buf.slice(0, 16), iv = buf.slice(16, 28), body = buf.slice(28);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: st.mode.iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const packed = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body); // 中身は gzip
  const plain = new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(plain).text());
}
async function load(name) {
  const bust = st.status ? "?v=" + encodeURIComponent(st.status.generated) : "?t=" + Date.now();
  if (!st.mode.encrypted) { const r = await fetch(`data/${name}.json${bust}`); if (name === "status") noteClock(r); return r.json(); }
  const r = await fetch(`data/${name}.enc${bust}`);
  if (!r.ok) throw new Error(r.status);
  if (name === "status") noteClock(r);
  return decrypt(await r.text(), st.key);
}
// 取得状況（status）は毎回取り直す（?t=）ので、その応答の Date（サーバーの時刻）で端末の時計のずれを知る。
// 端末の時計が狂っていても「データが古い」の判定を誤らないように（キャッシュの応答は Age の分だけ足す）
function noteClock(r) {
  const d = Date.parse(r.headers.get("date") || ""), age = +(r.headers.get("age") || 0) || 0;
  if (Number.isFinite(d)) st.skew = d + age * 1000 - Date.now();
}
const nowMs = () => Date.now() + (Math.abs(st.skew) > 3e5 ? st.skew : 0);  // 5 分未満のずれは端末の時計のまま（Date は秒単位のため）

// ---- 小道具 ----
const yen = (n) => "¥" + n.toLocaleString("ja-JP");
const num = (n) => n.toLocaleString("ja-JP");
// 店から取ったリンクは http(s) だけ通す（javascript: などを防ぐ）
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const siteName = (id) => st.sites[id]?.name || id;
const shortName = (id) => st.sites[id]?.short || siteName(id);
// 時刻は端末の時間帯にかかわらず日本時間で出す（取得の予定 11・14・17 時と合わせる。海外や時間帯の設定が違う端末でもずれない）
const jst = (t) => new Date((typeof t === "number" ? t : Date.parse(t)) + 9 * 36e5);  // getUTC〜 で読むと日本時間
const fmtTime = (iso) => { const d = jst(iso); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
// 動きを減らす設定の端末では、スクロールを一瞬で行う（なめらかなスクロールで酔う人向けの OS の設定）
const scrollMotion = () => (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
const fmtDay = (t) => { const d = jst(t); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
// 店ごとの色（ランキング・表・グラフで共通）。黄金角で色相を散らす
// 見た目「取引所」（<html data-skin="board">。skin.js）は端末の明暗にかかわらず黒地なので、暗い地向けの明るさにする
const boardSkin = () => document.documentElement.getAttribute("data-skin") === "board";
function shopColor(id) {
  const i = Math.max(0, st.status.sites.findIndex((s) => s.id === id));
  return `hsl(${(i * 137.508 + 200) % 360} 62% ${dark.matches || boardSkin() ? 62 : 44}%)`;
}
const dot = (id) => `<i class="dot" style="background:${shopColor(id)}"></i>`;
function recentChange(o) { // o = [site, price, prev, changed_at, url, label, note]
  if (o[2] == null || !o[3]) return 0;
  return (Date.now() - new Date(o[3])) / 864e5 <= RECENT_DAYS ? o[1] - o[2] : 0;
}
const chgHtml = (d) => d ? `<span class="chg ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"}${num(Math.abs(d))}</span>` : "";
// o[7] = 1: 来店・持ち込みのみの価格（郵送では売れない）。既定では最高値・順位・計算に含めず別枠で見せる
const isStore = (o) => o[7] === 1;
// o[9] = 1 は「他店と桁違いの価格（高すぎ・安すぎ）」（build の外れ値判定。店側の誤掲載・読み違いの疑い）。順位・最高値・売り先計算には使わず別枠で見せる
const isOut = (o) => o[9] === 1;
// o[10] = 「価格が不安定」＝同じ店の同じ行の価格が直近 7 日に同じ 2 つの値の間を行き来した回数（3 以上。安定は 0 か無し。build の _unstable。
// 例: 店が JAN を商品間で共有していて別の商品の価格にそろう）。外れ値と同じく順位・最高値・売り先計算・実利益・テロップから外し別枠で見せる
const isUnst = (o) => o[10] > 0;
const isAside = (o) => isOut(o) || isUnst(o);  // 最高値に使わない価格（桁違いの疑い・価格が不安定）
const offersOf = (p) => p.o.filter((o) => !hidden.has(o[0]) && !isAside(o) && (includeStore || !isStore(o)));  // 比較に使う価格（高い順）
const storeOffersOf = (p) => p.o.filter((o) => !hidden.has(o[0]) && (isAside(o) || (!includeStore && isStore(o))));  // 別枠（来店のみ・桁違いの疑い・価格が不安定）
const unstTip = "同じ店の価格が直近 7 日に 2 つの値の間を何度も行き来している（店が JAN を別の商品と共有しているなど、表示の価格で買い取られるか分からない）ので、最高値・順位・差の計算・売り先計算・実利益から外している";
const seriesKey = (o) => o[0] + (isStore(o) ? "#store" : "");
// o[8] = 最低買取数（無ければ 1）。これ未満の個数では売れないので、売り先計算はカートの個数で候補を絞る
const storeTag = (o) => (isStore(o) ? `<span class="storetag" title="郵送では売れない、来店・持ち込みのみの価格">来店のみ</span>` : "") +
  (isOut(o) ? `<span class="storetag" title="他の店と桁違いの価格（高すぎ・安すぎ）。店側の誤掲載か読み取りの誤りの疑いがあるので、最高値・順位・差の計算・売り先計算から外している">桁違いの疑い</span>` : "") +
  (isUnst(o) ? `<span class="storetag unst" title="${unstTip}">価格が不安定（7日で ${num(o[10])} 回行き来）</span>` : "") +
  (o[8] > 1 ? `<span class="storetag" title="この個数からしか買い取らない（売り先計算は個数が足りない時は候補にしない）">最低${num(o[8])}個</span>` : "");
function moveScore(p) { return Math.max(0, ...offersOf(p).map((o) => Math.abs(recentChange(o)) / Math.max(o[2] || 1, 1))); }
function spread(p) { const o = offersOf(p); return o.length > 1 ? o[0][1] - o[o.length - 1][1] : 0; }
// 価格の順位（同じ価格は同じ順位）。色分けは 1〜3 位だけ
const rankOf = (offers) => { const u = [...new Set(offers.map((o) => o[1]))].sort((a, b) => b - a); return (price) => u.indexOf(price) + 1; };
const rcls = (r) => (r >= 1 && r <= 3 ? ` r${r}` : "");
const favKey = (p) => p.id; // 商品の固定番号（照合キーから作る。公開のたびに変わらない）

// ---- 実利益（計算）----
// 01.商材購入 の src/pricing.py（profit_breakdown）と同じ考え（tests/profit_check.js が確かめる）:
//   実利益 = 最高買取額 − 査定減額（最高買取額 × 減額率）− 買取送料 − 実質の仕入れ値（仕入れ値 − ポイント還元）
//   利益率 = 実利益 ÷ 実質の仕入れ値（01 の compare_rakuten.py と同じ。実質の仕入れ値が 0 以下なら出さない）
// 端数は pricing.py と同じ偶数への丸め（Python の round）。% のポイントは pricing.py の effective_ec_price と同じく
// 「仕入れ値 × (1 − 率)」を丸めた額を実質の仕入れ値にする。
// ポイント還元の上限（2026-09-29 ASTRA 指摘で pricing.py にそろえた。kaitori/lookup.py も同じ）: pricing.py の rakuten_point_rate は
//   率を 0〜50% に切る。% は 50% で切り、円も「仕入れ値の 50%」＝率 50% の時と同じ額で切る（pricing.py に円のポイントは無いので、
//   率の上限を円にも当てはめた）。切った時は画面に「上限」と出す。以前は % は 100% まで、円は仕入れ値まで使っていた
// 実質の仕入れ値が 0 円以下（仕入れ値 0 円など）: pricing.py の profit_breakdown は「値が欠ける」として実利益 0 を返す。
//   同じく値なしとして扱い（none。net 0・利益率なし）、画面は ±0 と出さずに「計算しません」と出す
// set = {cut: 査定減額率 %, ship: 買取送料 円（1 回分）, pt: ポイント還元, unit: "pct"（仕入れ値の %）| "yen"（1 個あたりの円）}
const PROFIT_DEFAULT = { cut: 5, ship: 800, pt: 0, unit: "pct" };
const PT_MAX = 50;  // ポイント還元の上限（仕入れ値の %）。pricing.py の rakuten_point_rate の上限 0.5
const roundEven = (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r; };
function cleanProfitSet(v) {  // 端末に残った値が壊れていても使える形にする
  const o = v !== null && typeof v === "object" ? v : {}, unit = o.unit === "yen" ? "yen" : "pct";
  const n = (x, d, hi) => { x = typeof x === "number" ? x : NaN; return Number.isFinite(x) && x >= 0 ? Math.min(x, hi) : d; };
  // 円のポイントは 1 円単位（「150.5」のままだと実質の仕入れ値・実利益が「199,649.5 円」のように端数で出た）。
  // 丸めは lookup.py（Python の round）と同じ偶数への丸め（150.5 → 150。以前は四捨五入で 151 になり、実利益が 1 円ずれた）
  return { cut: n(o.cut, PROFIT_DEFAULT.cut, 100), ship: Math.round(n(o.ship, PROFIT_DEFAULT.ship, 1e7)),
    pt: unit === "pct" ? n(o.pt, 0, 100) : roundEven(n(o.pt, 0, 1e9)), unit };
}
// 入力欄の金額（「199,800」「１９９８００円」「¥199800」）→ 数。読めなければ null
function parseYen(s) { const t = String(s ?? "").normalize("NFKC").replace(/[,\s¥円]/g, ""); return /^\d{1,10}$/.test(t) ? +t : null; }
// 1 個あたりの実質の仕入れ値（ポイント還元を引いた額）と、ポイントを上限（仕入れ値の 50%）で切ったか
function effOf(cost, set) {
  if (set.unit === "yen") {
    const cap = cost - roundEven(cost * (1 - PT_MAX / 100));  // 率 50% の時のポイント（同じ丸め）
    return { eff: cost - Math.min(set.pt, cap), capped: set.pt > cap };
  }
  return { eff: roundEven(cost * (1 - Math.min(set.pt, PT_MAX) / 100)), capped: set.pt > PT_MAX };
}
const effCost = (cost, set) => effOf(cost, set).eff;
// 1 商品 × 個数。ship = その売り先へ送る 1 回分の送料・手数料（個数にかかわらず 1 回）。
// capped = ポイントを上限で切った、none = 実質の仕入れ値が 0 円以下で計算しない（net 0・rate null。pricing.py と同じ）
function profitCalc(buyback, cost, set, ship, qty = 1) {
  const e = effOf(cost, set), none = !(e.eff > 0);
  const gross = buyback * qty, cut = roundEven(buyback * (set.cut / 100)) * qty, eff = e.eff * qty;
  const net = none ? 0 : gross - cut - ship - eff;
  return { gross, cut, ship, cost: cost * qty, pt: cost * qty - eff, eff, net, rate: none ? null : net / eff, capped: e.capped, none };
}
// 損益分岐の買取額（この額以上で売れれば赤字にならない）。減額率 100% なら無い（null）。
// ship = その店へ送る 1 回分の費用。数（いつも同じ額）か、送料の決まり {ship, free, fee}（買取額が無料基準 free 以上なら送料 0。
// 手数料 fee はいつも。cart.js の shipRule）。
// 実利益は買取額に対して減らない（上げると査定減額は増えても手取りは減らず、送料は無料基準を超えると下がるだけ）ので、
// 送料を払う時の分岐が無料基準より安ければそれ、でなければ「送料 0 の時の分岐」と無料基準の高いほう。
// （2026-09-29 ASTRA 指摘: 以前は今の最高値での送料（基準以上なら 0）をいつも同じとして解き、基準未満の額を分岐と出していた。
//   買取 11,000・仕入れ 9,200・送料 800・10,000 円以上無料 → 9,684 円と出たが、その額では送料がかかり 800 円の赤字。正しくは 10,000 円）
function breakEven(cost, set, ship) {
  const f = ship !== null && typeof ship === "object" ? ship : { ship: +ship || 0, free: 0, fee: 0 };
  const fee = +f.fee || 0, full = (+f.ship || 0) + fee, free = +f.free || 0;
  const b1 = beFlat(cost, set, full);
  if (!(free > 0) || full === fee || (b1 != null && b1 < free)) return b1;
  const b2 = beFlat(cost, set, fee);
  return b2 == null ? null : Math.max(b2, Math.ceil(free));
}
// 送料がいつも同じ額の時の損益分岐。見積もりから前後に詰める（実利益は 1 円上げると 0 か 1 円増える）
function beFlat(cost, set, ship) {
  if (!(set.cut < 100)) return null;
  const e = effCost(cost, set), net = (b) => b - roundEven(b * (set.cut / 100)) - ship - e;
  let b = Math.max(0, Math.ceil((e + ship) / (1 - set.cut / 100)));
  // 減額率が 100% に近い（99.9999% 等）と見積もりが 2^53 を超え、1 円ずつ詰められず止まらなくなる（画面が固まる）。
  // 現実の買取額を大きく超える時は線を引かない。詰める回数にも上限を付ける（2026-09-28 独立検証）
  if (!(b <= 1e12)) return null;
  for (let i = 0; b > 0 && net(b - 1) >= 0; i++) { if (i > 1e5) return null; b--; }
  for (let i = 0; net(b) < 0; i++) { if (i > 1e5) return null; b++; }
  return b;
}
// 売り先計算の 1 つの案（cart.js の resultOf の結果）の実利益。売り先の無い商品は含めない。
//   buyOf(商品ID) → 1 個の仕入れ値か null、shipOf(店, 小計) → {v: 1 回分の送料・手数料, own: 店ごとの設定を使ったか}
//   仕入れ値が 1 つでも無い・実質の仕入れ値が 0 円以下（計算しない）なら ok = false（合計を出さない）。capped = ポイントを上限で切った
function planProfit(r, buyOf, set, shipOf) {
  const x = { gross: 0, cut: 0, ship: 0, cost: 0, pt: 0, eff: 0, own: 0, def: 0, missing: [], capped: false };
  for (const s of r.shops) {
    const f = shipOf(s.s, s.sub);
    x.ship += f.v; f.own ? x.own++ : x.def++;
    for (const { L, o } of s.rows) {
      const b = buyOf(L.it.id), e = b == null ? null : profitCalc(o[1], b, set, 0, L.it.q);
      if (!e || e.none) { x.missing.push(L); continue; }
      x.gross += e.gross; x.cut += e.cut; x.cost += e.cost; x.pt += e.pt; x.eff += e.eff; x.capped ||= e.capped;
    }
  }
  x.net = x.gross - x.cut - x.ship - x.eff;
  x.rate = x.eff > 0 ? x.net / x.eff : null;
  x.ok = r.shops.length > 0 && !x.missing.length;
  return x;
}

// ---- データの鮮度（計算）----
// 取得の予定時刻（日本時間の hours 時）から grace 分たっても、それより新しいデータ（generated）が無ければ古い。
// 夜（最後の回の後）は、翌日の最初の回の grace 分後までは前日の最後の回で判定する。定休日で全店休みでも build はされる前提。
// now は ms（端末の時計をサーバーの時刻で直した値）。→ {stale, due: 反映されているはずの回の時刻, next: 次に判定が変わる時刻, gen} か null
function staleInfo(genIso, now, hours = [11, 14, 17], grace = 90) {
  const gen = Date.parse(genIso);
  const H = (Array.isArray(hours) ? hours : []).filter((h) => Number.isInteger(h) && h >= 0 && h < 24).sort((a, b) => a - b);
  if (!Number.isFinite(gen) || !Number.isFinite(now) || !H.length) return null;
  const J = 9 * 36e5, d = new Date(now + J), g = grace * 6e4;
  const day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - J;  // 日本時間の今日 0 時
  let due = null, next = null;
  for (let k = -2; k <= 1; k++) for (const h of H) {
    const t = day0 + k * 864e5 + h * 36e5;
    if (t + g <= now) due = t; else if (next === null) next = t + g;
  }
  return { stale: due !== null && gen < due, due, next, gen };
}

// ---- バーコードの番号（計算）----
// 読み取った番号を JAN（EAN-13 / EAN-8）にそろえる。UPC-A（12 桁）は頭に 0 を付けて 13 桁、UPC-E（8 桁）は UPC-A に広げてから。
// 検査数字が合わない・形が違う時は null（読み違いを検索しない）
function janCheck(d) {
  if (!/^(?:\d{8}|\d{12}|\d{13})$/.test(d)) return false;
  let s = 0;
  for (let i = d.length - 2, w = 3; i >= 0; i--, w = 4 - w) s += +d[i] * w;
  return (10 - (s % 10)) % 10 === +d[d.length - 1];
}
function upcEtoA(e) {  // 8 桁（番号系 0/1 ＋ 6 桁 ＋ 検査数字）→ 12 桁
  if (!/^[01]\d{7}$/.test(e)) return null;
  const [ns, a, b, c, d, f, x, ck] = e;
  const mid = x <= "2" ? a + b + x + "0000" + c + d + f : x === "3" ? a + b + c + "00000" + d + f : x === "4" ? a + b + c + d + "00000" + f : a + b + c + d + f + "0000" + x;
  return ns + mid + ck;
}
function janOf(text, format = "") {
  const t = String(text ?? "").trim(), f = String(format).toLowerCase().replace(/-/g, "_");
  if (!/^\d+$/.test(t)) return null;
  // UPC-E は 8 桁で返る読み取り器が多いが、広げた 12・13 桁で返すもの（端末の読み取り器による）もあるので、その時は下の UPC-A・EAN-13 と同じに扱う
  if (f === "upc_e" && t.length === 8) { const a = upcEtoA(t); return a && janCheck(a) ? "0" + a : null; }
  if (t.length === 12 && janCheck(t)) return "0" + t;
  return (t.length === 13 || t.length === 8) && janCheck(t) ? t : null;
}

// ---- 最高値の値動き（計算）----
// build が作る data/moves.json（画面で「最高値の値動き」を開いた時だけ読む。tests/moves_check.js が node で確かめる）:
//   t: [[ISO, 表示名, 取れた店の数], ...]  取得の回（定時の回）の終わりの時刻。古い順で、番号 = 添字
//   s: [店ID, ...]                         系列番号 sid の店は s[sid >> 1]。sid & 1 = 1 は来店のみの価格
//   p: {商品ID: [[sid, 時点, 値, 時点, 値, ...], ...]}  値が変わった時点だけ。ある時点の値 = その時点以前の最後の値
//      値: 正 = その時点に掲載されていた価格 / 負 = 最高値に使わない価格（桁違いの外れ値か価格が不安定）/ 0 = 掲載なし
//   u: {商品ID: [[sid, 時点, 1 か 0, ...], ...]}  負の値のうち「価格が不安定」（その時点までの 7 日に同じ 2 つの値を 3 回以上行き来）で
//      外したものが 1（p と同じ持ち方。無い商品・系列は 0）。理由の一言（mvWhy）だけが使う
// 最高値 = 比較から外した店・（既定では）来店のみの価格・外れ値・不安定な価格を除いた中で一番高い価格（今の画面の最高値と同じ規則）
function mvValue(s, ti) { let v = 0; for (let k = 1; k < s.length && s[k] <= ti; k += 2) v = s[k + 1]; return v; }
function mvTop(mv, id, ti, hiddenShops, withStore) {  // → [最高額, 店ID] か null（その時点に最高値が無い）
  let best = null;
  for (const s of mv.p[id] || []) {
    if ((s[0] & 1) && !withStore) continue;
    const site = mv.s[s[0] >> 1];
    if (hiddenShops.has(site)) continue;
    const v = mvValue(s, ti);
    if (v > 0 && (!best || v > best[0])) best = [v, site];
  }
  return best;
}
// 期間の選び方 → [始まりの時点, 終わりの時点]（始まり < 終わり）。比べられる時点が 2 つ無ければ null
//   prev = 直前の回 → 最新 / day = 最新のおよそ 24 時間前に一番近い回 → 最新 / custom = 指定（範囲外・逆順は直す）
function mvRange(times, mode, from, to) {
  const n = times.length;
  if (n < 2) return null;
  if (mode === "custom") {
    const b = Math.min(Math.max(Number.isInteger(to) ? to : n - 1, 1), n - 1);
    return [Math.min(Math.max(Number.isInteger(from) ? from : b - 1, 0), b - 1), b];
  }
  if (mode === "day") {
    const want = Date.parse(times[n - 1][0]) - 864e5, gap = (i) => Math.abs(Date.parse(times[i][0]) - want);
    let a = 0;
    for (let i = 1; i < n - 1; i++) if (gap(i) < gap(a)) a = i;
    return [a, n - 1];
  }
  return [n - 2, n - 1];
}
// 1 商品の比較。kind: up 値上がり / down 値下がり / same 同じ / new 始まりに最高値が無い / gone 終わりに無い / none 両方に無い
function mvCompare(mv, id, a, b, hiddenShops, withStore) {
  const x = mvTop(mv, id, a, hiddenShops, withStore), y = mvTop(mv, id, b, hiddenShops, withStore);
  const d = x && y ? y[0] - x[0] : 0;
  const kind = x && y ? (d > 0 ? "up" : d < 0 ? "down" : "same") : y ? "new" : x ? "gone" : "none";
  return { a: x, b: y, d, r: x && y ? d / x[0] : 0, kind };
}
// 最高値の店が替わった時の理由（掲載の増減を、価格の上げ下げと見分けられるように。2026-09-27 独立検証）。同じ店・片方に無い時は null
//   値下がり: 始まりの最高値の店が 終わりに → end 価格が無い（掲載終了・7 日以上取れていない）/ out 桁違い扱い / unst 価格が不安定扱い / cut 値下げ（v = 終わりの価格）
//   値上がり: 終わりの最高値の店が 始まりに → new 価格が無かった（新たに載せた）/ out 桁違い扱い / unst 価格が不安定扱い / raise 値上げ（v = 始まりの価格）
function mvWhy(mv, id, c, a, b, hiddenShops, withStore) {
  if (c.kind !== "up" && c.kind !== "down") return null;
  const site = c.kind === "down" ? c.a[1] : c.b[1];
  if (c.a[1] === c.b[1] || hiddenShops.has(site)) return null;
  const ti = c.kind === "down" ? b : a;
  let v = 0, vs = -1;
  for (const s of mv.p[id] || []) {
    if (mv.s[s[0] >> 1] !== site || ((s[0] & 1) && !withStore)) continue;
    const x = mvValue(s, ti);
    if (x > 0 ? x > v || v < 0 : x < 0 && v === 0) { v = x; vs = s[0]; }
  }
  // 負の値が「価格が不安定」で外したものか（u に 1）。u が無い（古い moves.json）時は桁違い扱い
  const us = v < 0 ? ((mv.u && mv.u[id]) || []).find((s) => s[0] === vs) : null;
  const t = v < 0 ? (us && mvValue(us, ti) === 1 ? "unst" : "out") : v === 0 ? (c.kind === "down" ? "end" : "new") : c.kind === "down" ? "cut" : "raise";
  return { t, site, v: v > 0 ? v : 0 };
}

// ---- 検索（表記ゆれを吸収する）----
// 名前・型番（build が p.a に店ごとの別名を入れていればそれも）を、1 商品 1 回だけ検索用に整えて持つ（1 万 6 千件でも 1 文字ごとの絞り込みを軽く）:
//   p._t = 全角半角・大小・ひらがな/カタカナをそろえた文字列（空白は残す。色の英単語の区切りを見る）
//   p._h = さらに空白・ハイフン・括弧などを除いて詰めた文字列（「WH-1000XM5」「wh1000xm5」「WH 1000 XM5」を同じにする）。
//          数字どうしの間の区切りだけは「|」で残す（「iPhone 16 1TB」の 16 と 1 がくっつかないように）
const kata = (s) => s.replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const normText = (s) => kata(String(s ?? "").normalize("NFKC").toLowerCase()).replace(/[éè]/g, "e");
const SEP = "\\s\\-‐‑‒–—―−_/\\\\・()\\[\\]{}【】「」『』〔〕<>〈〉《》&'\"“”‘’:;,、。!?~〜*#";
const reDigitSep = new RegExp(`(\\d)[${SEP}]+(?=\\d)`, "g"), reSep = new RegExp(`[${SEP}]+`, "g");
// メーカー・商品名の日英、ひらがな/カタカナの言い方を 1 つにそろえる（商品側と検索語の両方に同じ置き換えをする）
const ALIAS = {
  sony: ["ソニー"], apple: ["アップル"], nintendo: ["ニンテンドー", "任天堂"], switch: ["スイッチ"], ps: ["プレイステーション", "プレステ", "playstation"],
  iphone: ["アイフォーン", "アイフォン"], ipad: ["アイパッド"], macbook: ["マックブック"], airpods: ["エアーポッズ", "エアポッズ"],
  watch: ["ウォッチ"], pro: ["プロ"], max: ["マックス"], mini: ["ミニ"], box: ["ボックス"], pokemon: ["ポケットモンスター", "ポケモン"], "pokemonカード": ["ポケカ"],
  galaxy: ["ギャラクシー"], pixel: ["ピクセル"], google: ["グーグル"], samsung: ["サムスン", "サムソン"], xperia: ["エクスペリア"],
  panasonic: ["パナソニック"], sharp: ["シャープ"], canon: ["キヤノン", "キャノン"], nikon: ["ニコン"], fujifilm: ["富士フイルム", "富士フィルム", "フジフイルム", "フジフィルム"],
  olympus: ["オリンパス"], ricoh: ["リコー"], dyson: ["ダイソン"], bose: ["ボーズ"], sennheiser: ["ゼンハイザー"], zojirushi: ["象印"], hitachi: ["日立"],
  toshiba: ["東芝"], mitsubishi: ["三菱"], balmuda: ["バルミューダ"], delonghi: ["デロンギ"], irobot: ["アイロボット"], roomba: ["ルンバ"], xiaomi: ["シャオミ"],
  huawei: ["ファーウェイ"], lenovo: ["レノボ"], microsoft: ["マイクロソフト"], surface: ["サーフェス"], gopro: ["ゴープロ"], garmin: ["ガーミン"],
  logicool: ["ロジクール"], buffalo: ["バッファロー"], anker: ["アンカー"], makita: ["マキタ"], philips: ["フィリップス"], ヘッドホン: ["ヘッドフォン"],
  onepiece: ["ワンピース"],
};
const aliasTo = new Map(Object.entries(ALIAS).flatMap(([to, froms]) => froms.map((f) => [normText(f), to])));
const reAlias = new RegExp([...aliasTo.keys()].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
// 「第3世代」「第 8 世代」→「3世代」「8世代」（検索語は語に分ける前にそろえる）
const reGen = /第\s*(\d+)\s*世代/g;
const canon = (s) => s.replace(reAlias, (m) => aliasTo.get(m)).replace(reGen, "$1世代");
// 「第6世代」→「6世代」は区切りを消す前にも行う（後だけだと「M5 第6世代」が「m56世代」になり、「6世代」「M5」で当たらなかった）
const compact = (s) => canon(canon(s).replace(reDigitSep, "$1|").replace(reSep, ""));
// 名前にメーカー名が無くても、機種名からメーカーが決まるものは足す（「アップル AirPods」「ソニー PS5」で当たるように）
const MAKER = [["apple", /iphone|ipad|airpods|macbook|imac|applewatch|airtag|homepod|macmini|macstudio|appletv|applepencil/],
  ["sony", /xperia|ps[345](?!\d)|psvr|psportal|dualsense|wh1000|wf1000|linkbuds/], ["nintendo", /switch(?!bot|ング)/],
  ["google", /pixel/], ["samsung", /galaxy/], ["microsoft", /surface|xbox/]];
function prep(p) {
  const extra = Array.isArray(p.a) ? p.a : p.a ? [p.a] : [];  // 店ごとの別名・型番（build が入れていれば）
  p._t = normText([p.n, p.m, ...extra].join(" | "));
  p._w = canon(p._t);  // 区切りを残したまま日英をそろえた文字列（短い型番「M4」「S25」を語の頭だけで探すのに使う）
  let h = [p.n, p.m, ...extra].map((s) => compact(normText(s))).join("|");
  for (const [mk, re] of MAKER) if (!h.includes(mk) && re.test(h)) h += "|" + mk;
  p._h = h;
}
// 色: 同じ色の言い方（日英・漢字）と、近い色（例: ホワイト → シルバー・スターライト）。
// 近い色だけで当たった商品は、画面で「近い色」の印を付ける（別の色だと分かるように）
const COLORS = [
  ["ホワイト", ["ホワイト", "white", "白", "シロ"], ["シルバー", "silver", "銀", "スターライト", "starlight", "プラチナ", "platinum", "パール", "pearl", "アイボリー", "ivory", "クリーム", "cream"]],
  ["ブラック", ["ブラック", "black", "黒", "クロ"], ["ミッドナイト(?!ブルー|グリーン)", "midnight(?! ?blue| ?green)", "グラファイト", "graphite", "チャコール", "charcoal", "オニキス", "onyx", "オブシディアン", "obsidian"]],
  ["シルバー", ["シルバー", "silver", "銀"], ["プラチナ", "platinum", "スターライト", "starlight", "ホワイト", "white", "白"]],
  ["グレー", ["グレー", "グレイ", "gray", "grey", "灰"], ["グラファイト", "graphite", "チャコール", "charcoal", "スレート", "slate", "ガンメタ"]],
  ["ブルー", ["ブルー", "blue", "青", "アオ"], ["ネイビー", "navy", "ミッドナイト(?!グリーン)", "midnight(?! ?green)", "ターコイズ", "turquoise", "ティール", "teal", "シアン", "cyan", "インディゴ", "indigo"]],
  ["レッド", ["レッド", "red", "赤", "アカ"], ["バーガンディ", "burgundy", "ボルドー", "クリムゾン", "crimson", "ルビー", "ruby", "マルーン"]],
  ["ピンク", ["ピンク", "pink", "桃"], ["ローズ", "rose", "コーラル", "coral", "ピーチ", "peach", "ブラッシュ", "blush", "サクラ", "桜"]],
  ["グリーン", ["グリーン", "green", "緑"], ["セージ", "sage", "ミント", "mint", "オリーブ", "olive", "カーキ", "khaki", "エメラルド", "emerald"]],
  ["イエロー", ["イエロー", "yellow", "黄"], ["レモン", "lemon", "マスタード", "mustard"]],
  ["オレンジ", ["オレンジ", "orange", "橙"], ["アプリコット", "apricot", "テラコッタ", "カッパー", "copper"]],
  ["パープル", ["パープル", "purple", "紫"], ["ラベンダー", "lavender", "バイオレット", "violet", "ライラック", "lilac"]],
  ["ゴールド", ["ゴールド", "gold", "金"], ["シャンパン", "champagne", "ブロンズ", "bronze", "ベージュ", "beige"]],
  ["ブラウン", ["ブラウン", "brown", "茶"], ["ベージュ", "beige", "キャメル", "camel", "ウォールナット", "walnut", "チョコ", "ココア"]],
  ["ベージュ", ["ベージュ", "beige"], ["アイボリー", "ivory", "クリーム", "cream", "トープ", "taupe", "サンドベージュ"]],
].map(([label, same, near]) => {
  // 英単語は前後が英字でない所だけ（「Redmi」を赤にしない）。1 字の漢字は前後が漢字でない所だけ（「料金」「銀座」「桃太郎」を色にしない。白・黒は「絹白」「墨黒」も色なので除く）
  const pat = (w) => /^[a-z]/.test(w) ? `(?<![a-z])${w}(?![a-z])` : /^[\u4e00-\u9fff]$/.test(w) && !"白黒".includes(w) ? `(?<![\u4e00-\u9fff々])${w}(?![\u4e00-\u9fff々])` : normText(w);
  // 「シロ」「クロ」などは検索語として受け付けるだけ（商品名の「シロカ」「マイクロ」を色にしない）
  const inName = same.filter((w) => !["シロ", "クロ", "アオ", "アカ"].includes(w));
  return { label, words: new Set(same.map(normText)), inName: inName.map(normText), same: new RegExp(inName.map(pat).join("|")), near: new RegExp(near.map(pat).join("|")) };
});
const colorOf = (w) => COLORS.find((c) => c.words.has(w));
// 「プラチナシルバー」「スペースグレイ」のように色名（カタカナ 3 字以上）を含む語。その語のままで当たらない時は、含まれる色（シルバー等）で探して「近い色」の印を付ける
const colorIn = (w) => COLORS.find((c) => c.inName.some((x) => /^[\u30a0-\u30ff]{3,}$/.test(x) && x !== w && w.includes(x)));
const isDig = (c) => c >= 48 && c <= 57;
// 語 k が h の中にあるか。語の端が 1〜2 桁の数字なら、その外側に数字が続く所は当たりにしない（「Switch 2」を「Switch 2022」に当てない。「17」を「117」に当てない）
// 英字と数字が混ざる語（型番「M4」「S25」「X100VI」「WH1000XM5」）は、詰めた文字列 p._h だと別の型番の途中にも当たる
// （「M4」→「MDYM4J/A」「ILCE-7RM4」、「X100VI」→「RX100 VI」、「OM-5」→「Pro (M5)」）ので、区切りを残した p._w で語の頭から探す
// （語の中の区切りはあってよい:「Z 6」「X-T5」「WH-1000XM5」）。ローマ数字（「VII」「IV」「V」「X」）は前後が英字でない所だけ
// （「Xperia 1 VII」を「VIII」に、「EOS R6 Mark II」を「Mark III」に当てない）。2026-09-24 再点検2
const reRoman = /^(?:i{1,3}|iv|vi{0,3}|ix|x)$/;
const reEdgeSep = new RegExp(`^[${SEP}]+|[${SEP}]+$`, "g");
function tokenRe(k, w) {
  if (reRoman.test(k)) {
    // 「I&II」のように語の中に区切りがあるローマ数字は、詰めずに区切りごと探す（詰めると「iii」になり、
    // 「バテン・カイトス I&II」が自分の名前で当たらず、「Mark III」等 193 件に当たっていた。2026-09-24 再点検3）
    const lit = (w || k).replace(reEdgeSep, "");
    const body = lit === k ? k : lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(?<![a-z])" + body + "(?![a-z])");
  }
  if (!/^[a-z0-9]+$/.test(k) || !/[a-z]/.test(k) || !/\d/.test(k)) return null;
  const head = /^\d{1,2}(?!\d)/.test(k) ? "(?<!\\d)" : /^[a-z]/.test(k) ? "(?<![a-z])" : "";
  const tail = /(?<!\d)\d{1,2}$/.test(k) ? "(?!\\d)" : "";
  return new RegExp(head + [...k].join(`[${SEP}]*`) + tail);
}
function hitShort(p, t) { return t.re ? t.re.test(p._w) : hit(p._h, t); }
function hit(h, t) {
  for (let i = h.indexOf(t.k); i >= 0; i = h.indexOf(t.k, i + 1))
    if ((!t.db || !isDig(h.charCodeAt(i - 1))) && (!t.de || !isDig(h.charCodeAt(i + t.k.length)))) return true;
  return false;
}
// 検索語を解釈する。strict = 「Switch 2」「Pro 3」「iPhone 17」のように、語の直後の 1〜2 桁の数字はその語とつなげて探す。
// loose = 語を別々に探す（strict で 1 件も無い時や、利用者が選んだ時に使う）
function parseQuery(raw) {
  const words = normText(raw).replace(reGen, "$1世代").split(/\s+/).filter(Boolean);
  // jz = JAN の頭の 0 を除いた形（店によって UPC の JAN を 13 桁「0840…」・12 桁「840…」・11 桁で持つので、どれでも当てる）
  const mk = (k, w) => ({ k, db: /^\d{1,2}(?!\d)/.test(k), de: /(?<!\d)\d{1,2}$/.test(k), jan: /^\d{8,}$/.test(k), jz: k.replace(/^0+/, ""), re: tokenRe(k, w) });
  const loose = [], strict = [];
  for (const w of words) {
    const color = colorOf(w);
    if (color) { const t = { color, w }; loose.push(t); strict.push(t); continue; }
    const k = compact(w);
    if (!k) continue;
    const cf = colorIn(w);
    if (cf) { const t = { ...mk(k, w), cf, w }; loose.push(t); strict.push(t); continue; }
    loose.push(mk(k, w));
    const prev = strict[strict.length - 1];
    if (/^\d{1,2}$/.test(k) && prev && !prev.color && !/\d$/.test(prev.k)) strict[strict.length - 1] = { ...mk(prev.k + k), merged: true };
    else strict.push(mk(k, w));
  }
  const color = loose.find((t) => t.color || t.cf);
  return { loose, strict, merged: strict.length < loose.length, empty: !loose.length, color: color && color.w };
}
// 色名を含む語（cf）を、含まれる色での代わりの検索をしない語にする
const literal = (toks) => toks.map((t) => (t.cf ? { ...t, cf: null } : t));
// 当たれば { near: 近い色で当たった時はその色名 }、外れなら null
function match(p, toks) {
  if (p._h === undefined || p._w === undefined) prep(p);
  let near = null;
  for (const t of toks) {
    if (t.color) {
      if (t.color.same.test(p._t)) continue;
      const m = p._t.match(t.color.near);
      if (!m) return null;
      near = m[0];
    } else if (!hitShort(p, t) && !(t.jan && (p.j.includes(t.k) || (t.jz.length >= 8 && p.j.includes(t.jz))))) {  // JAN は 8 桁以上の数字の時だけ見る
      const m = t.cf && p._t.match(t.cf.same);
      if (!m) return null;
      near = m[0];
    }
  }
  return { near };
}

// ---- 上部: 要約・取得状況・店の選択 ----
function renderKpis() {
  const all = st.data[st.cat] || [];
  let up = 0, down = 0;
  for (const p of all) for (const o of offersOf(p)) {
    const d = o[2] != null && o[3] && (Date.now() - new Date(o[3])) / 36e5 <= 24 ? o[1] - o[2] : 0;
    if (d > 0) up++; else if (d < 0) down++;
  }
  const shops = st.status.sites.filter((s) => s.enabled);
  const warn = shops.filter((s) => !s.closed_today && ["partial", "error"].includes(s.last_status)).length;
  $("kpis").innerHTML = `
    <div class="kpi"><span>商品</span><b>${num(all.length)}</b></div>
    <div class="kpi"><span>比較中の店</span><b>${shops.filter((s) => !hidden.has(s.id)).length}<small>/${shops.length}</small></b></div>
    <div class="kpi"><span>24時間の値上がり</span><b class="up">▲ ${num(up)}</b></div>
    <div class="kpi"><span>24時間の値下がり</span><b class="down">▼ ${num(down)}</b></div>
    <div class="kpi ${warn ? "warn" : ""}"><span>取得状況</span><b>${warn ? `要確認 ${warn}` : "正常"}</b></div>`;
  $("kpis").hidden = false;
}
function renderShops() {
  const ul = $("shopList"); ul.innerHTML = "";
  let warn = 0;
  for (const s of st.status.sites) {
    let tag;
    // 止めた店（sites.toml の enabled = false）は「停止中」。要確認には数えない（2026-09-29 エノキング停止で要確認 1 が出ていた）
    if (s.enabled === false) tag = `<span class="tag closed" title="取得の対象から外しています">停止中</span>`;
    else if (s.closed_today) tag = `<span class="tag closed">${esc(s.closed_today)}</span>`;
    else if (s.last_status === "ok") tag = `<span class="tag ok">正常</span>`;
    else if (s.last_status === "partial") { tag = `<span class="tag warn" title="${esc(s.last_message)}">一部失敗</span>`; warn++; }
    else if (s.last_status === "error") { tag = `<span class="tag err" title="${esc(s.last_message)}">失敗</span>`; warn++; }
    else tag = `<span class="tag closed">未取得</span>`;
    ul.insertAdjacentHTML("beforeend", `<li>${dot(s.id)}<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">${esc(s.name)}</a>
      <span class="muted">${s.last_ok ? fmtTime(s.last_ok) : ""}</span>${tag}</li>`);
  }
  const on = st.status.sites.filter((s) => s.enabled !== false).length, off = st.status.sites.length - on;
  $("shops").querySelector("summary").innerHTML = `取得状況 <span class="muted">${on} 店${off ? `（停止中 ${off}）` : ""}${warn ? ` ・ <b class="err">要確認 ${warn}</b>` : ""}</span>`;
  $("shops").hidden = false;
}
function renderShopPick() {
  const shops = st.status.sites.filter((s) => s.enabled);
  $("shopPickCount").textContent = `${shops.filter((s) => !hidden.has(s.id)).length}/${shops.length}`;
  $("shopPick").innerHTML = `<div class="pickhead"><b>比較する店</b><span><button data-all="1">すべて</button><button data-all="0">すべて外す</button></span></div>
    <div class="pickgrid">${shops.map((s) => `<label>${dot(s.id)}<input type="checkbox" value="${s.id}" ${hidden.has(s.id) ? "" : "checked"}>${esc(s.name)}</label>`).join("")}</div>
    <label class="storeopt"><input type="checkbox" id="includeStore" ${includeStore ? "checked" : ""}> 来店専用・持ち込み限定の価格も、最高値・順位・売り先計算に含める</label>
    <p class="muted">外した店は、ランキング・表・最高値・売り先計算から除きます。来店専用の価格は、含めない時も「来店のみ」として別に表示します（この端末に保存）。</p>`;
  // PC では売り先計算（右の引き出し）を開いたまま後ろのこの欄を押せるので、売り先計算も描き直す（2026-10-01 独立点検: 外した店が
  // 案に残ったまま・来店のみの価格が入らないままの古い額が、パネルの中を触るまで出ていた）
  $("includeStore").onchange = (e) => { includeStore = e.target.checked; store.set("includeStore", includeStore); filterRows(); if (typeof cartRefresh === "function") cartRefresh(); };
  $("shopPick").querySelectorAll(".pickgrid input").forEach((c) => c.onchange = () => {
    c.checked ? hidden.delete(c.value) : hidden.add(c.value); applyHidden();
  });
  $("shopPick").querySelectorAll("[data-all]").forEach((b) => b.onclick = () => {
    hidden = b.dataset.all === "1" ? new Set() : new Set(shops.map((s) => s.id)); applyHidden(); renderShopPick();
  });
}
function applyHidden() {
  store.set("hiddenShops", [...hidden]);
  const on = st.status.sites.filter((s) => s.enabled);  // 端末に残った、今は無い店の ID は数えない
  $("shopPickCount").textContent = `${on.filter((s) => !hidden.has(s.id)).length}/${on.length}`;
  filterRows();
  if (typeof cartRefresh === "function") cartRefresh();   // 売り先計算を開いていれば、外した店を除いて計算し直す
}
function renderCats() {
  const nav = $("cats"); nav.innerHTML = "";
  const total = st.status.categories.reduce((n, c) => n + c.count, 0);
  for (const c of [{ id: "all", label: "すべて", count: total }, ...st.status.categories]) {
    const b = document.createElement("button");
    b.innerHTML = `${esc(c.label)}<span>${num(c.count)}</span>`;
    b.setAttribute("aria-pressed", c.id === st.cat);
    b.onclick = () => selectCat(c.id);
    nav.append(b);
  }
  nav.hidden = false;
}

// ---- 絞り込み・並び替え ----
// 「すべて」のデータ（全カテゴリ）。カテゴリのタブで検索した時も、他のカテゴリに何件あるかを数えるために裏で読む
let allLoading = null;
function loadAll() {
  if (st.data.all) return Promise.resolve(st.data.all);
  return allLoading ||= Promise.all(st.status.categories.map((c) => loadCat(c.id)))
    .then((a) => (st.data.all = a.flat())).catch((e) => { allLoading = null; throw e; });
}
function filterRows() {
  const all = st.data[st.cat] || [];
  const raw = $("q").value.trim();
  const Q = parseQuery(raw);
  // 検索語が変わったら「離れた語も」「近い色」の選択は元に戻す。近い色は、機種名などと一緒に色を探した時だけ既定で含める
  // （「WH-1000XM5 ホワイト」→ シルバーも出す。「白」だけの時は全シルバー製品が出てしまうので、ボタンで含める）
  if (raw !== st.qRaw) { st.qRaw = raw; st.useLoose = false; st.nearOff = Q.loose.every((t) => t.color); }
  const cond = $("cond").value, favOnly = $("favOnly").checked;
  const visible = (p) => offersOf(p).length || storeOffersOf(p).length;  // 比較から外した店だけが扱う商品は出せない
  // 検索に当たるか（strict で 1 件も無ければ loose に切り替える）
  const test = (p, toks) => (Q.empty ? { near: null } : match(p, toks));
  const hitsOf0 = (toks) => { const m = new Map(); for (const p of all) if (!cond || p.c === cond) { const r = test(p, toks); if (r) m.set(p, r); } return m; };
  // 「プラチナシルバー」「ブルーレイレコーダー」のように色名を含む語は、その語のまま当たる商品があればそれだけにする
  // （含まれる色での代わりの検索は、そのままでは 1 件も無い時だけ。以前は商品ごとに代わりを使い、「ブルーレイレコーダー」で青い商品 801 件が出た）
  const hitsOf = (toks) => { if (toks.some((t) => t.cf)) { const lit = hitsOf0(literal(toks)); if (lit.size) return lit; } return hitsOf0(toks); };
  let hits = hitsOf(Q.strict), looseExtra = 0, autoLoose = false, strictHere = true;
  if (Q.merged) {
    const lh = hitsOf(Q.loose);
    const shown = (m) => [...m.keys()].filter((p) => visible(p) && (!favOnly || favs.has(favKey(p)))).length;
    looseExtra = shown(lh) - shown(hits);
    if (st.useLoose || !shown(hits)) { autoLoose = !st.useLoose && looseExtra > 0; hits = lh; strictHere = false; }
  }
  const hid = { shop: 0, fav: 0, near: 0 };
  st.near = new Map(); st.nearColor = Q.color;
  let rows = [];
  for (const [p, r] of hits) {
    if (!visible(p)) { hid.shop++; continue; }
    if (favOnly && !favs.has(favKey(p))) { hid.fav++; continue; }
    if (r.near) { if (st.nearOff) { hid.near++; continue; } st.near.set(p.id, r.near); }
    rows.push(p);
  }
  const sort = $("sort").value, top = (p) => (offersOf(p)[0] || storeOffersOf(p)[0])[1];
  const byPrice = (a, b) => top(b) - top(a);
  let moved = -1, mvc = null;
  if (st.mvOn) {  // 最高値の値動き: 検索・カテゴリ・★・状態で絞った商品のうち、2 時点の最高値に差のあるものだけ
    if (!st.mvData) return mvWait();
    mvc = mvFilter(rows); rows = mvc.rows;
  }
  else if (sort === "price") rows.sort(byPrice);
  else if (sort === "move") {  // 値動きのあった商品を先に。動きの無い商品も消さずに後ろへ（価格の高い順）
    const sc = new Map(rows.map((p) => [p, moveScore(p)]));
    rows.sort((a, b) => sc.get(b) - sc.get(a) || byPrice(a, b));
    moved = rows.filter((p) => sc.get(p) > 0).length;
  }
  else if (sort === "spread") rows.sort((a, b) => spread(b) - spread(a));
  else if (sort === "shops") rows.sort((a, b) => offersOf(b).length - offersOf(a).length || top(b) - top(a));
  if (st.shopSort && !st.mvOn) { // 表で店の列見出しを押した時: その店の価格の高い順（扱いの無い商品は後ろ）
    const price = (p) => (p.o.find((o) => o[0] === st.shopSort) || [0, -1])[1];
    rows = rows.slice().sort((a, b) => price(b) - price(a));
  }
  st.rows = rows; st.shown = PAGE;
  // 他のカテゴリにも当たる商品があれば件数を出す（カテゴリのタブを開いたまま検索して「無い」と思わないように）
  let other = null;
  if (!Q.empty && st.cat !== "all") {
    if (st.data.all) {
      const cnt = (toks) => { let n = 0;
      for (const p of st.data.all) if (p.k !== st.cat && (!cond || p.c === cond) && visible(p) && (!favOnly || favs.has(favKey(p)))) {
        const r = test(p, toks);
        // 最高値の値動きを開いている時は、今の期間・向きで出る商品だけ数える（「すべて」で開いた時の件数と合うように）
        if (r && !(r.near && st.nearOff) && (!mvc || !mvc.range || mvCompare(st.mvData, p.id, mvc.range[0], mvc.range[1], hidden, includeStore).kind === mvSet.dir)) n++;
      }
      return n; };
      const cntL = (toks) => (toks.some((t) => t.cf) && cnt(literal(toks))) || cnt(toks);
      other = cntL(st.useLoose ? Q.loose : Q.strict);
      // 語を別々に含む商品の件数は、このタブも続けて書かれた商品が無くて別々に探している時だけ（「すべて」の選び方と同じ。
      // 以前は「Switch 2」で、ゲームのタブは続けて書かれた 107 件なのに他のカテゴリの別々の 4 件を案内し、「すべて」を押すと出なかった）
      if (!other && Q.merged && !st.useLoose && !strictHere) other = cntL(Q.loose);
    } else if (!st.allFailed) {  // 失敗したら繰り返さない（「すべて」タブを押せば読み直す）
      const q0 = raw, cat0 = st.cat;
      loadAll().then(() => { if ($("q").value.trim() === q0 && st.cat === cat0) filterRows(); })
        .catch(() => { st.allFailed = true; if (st.cat === cat0) filterRows(); });  // 読めなければ「確認中」を出し続けない
    }
  }
  // 色の語のせいで 0 件の時は、色を除いた件数を出す（その機種にその色が無い・店の表記が違う、が分かるように）
  let noColor = 0;
  if (!rows.length && Q.color) {
    const toks = Q.strict.filter((t) => !t.color);
    if (toks.length) for (const p of all) if ((!cond || p.c === cond) && visible(p) && match(p, toks)) noColor++;
  }
  renderSummary({ Q, hid, looseExtra, autoLoose, moved, other, noColor, mvc });
  if (mvc) updateMvBar(mvc);
  renderKpis();
  renderList();
}
// ---- フリマの検索を開くリンク（2026-09-29 ユーザー指示「新品・売り切れ・新しい順で開く」）----
// フリマのページは読まない・取らない（自動取得は規約違反＝恒久禁止。01.商材購入と同じ方針）。リンクを置くだけで、開くのは人の操作。
// 検索語（fleaQuery）: 代表名から、出品の名前に無い店の注記を落とし、商品を決める語（型番・色・容量・世代・マウント等）は残す。
//   2026-09-29 独立 QA で見直し（本番の複製 26,601 商品）: 以前は（）の中を全部落として「Nothing Phone (4a) Pro」→「Nothing Phone Pro」
//   （別の機種に当たる）・「(128GB)」「(第3世代)」「(M4)」が消え、60 字で後ろを切って末尾の型番・色が消え（857 商品）、
//   型番の中の 8 桁以上の数字を JAN として消していた（「RZ04-05170100-R3M1」→「RZ04- -R3M1」）。
//   - （）: 色の記号（W）（BK）と、英字の名前の後の読み（「SONY(ソニー)」）・振り仮名（「美(ミ)ラクル」）は落とす。
//     他（M4・11inch・第3世代・4a・PRODUCT・Porcelain・ショートパック）は語として残す
//   - 【】・[]: 中身は残す（色・マウント・機種・BOX・弾の番号）。「未開封」「予約必須」等の店の注記は語から落とす
//   - 1 語だけの 8〜14 桁の数字（JAN）・「JAN:…」・※ から後ろ・「-2000円」等の店の値引き・店で切れた「...」・引用符（語句の一致の検索になる）・記号だけの語は落とす
//   - 語の頭の「-」は外す（「-M/L」。フリマの検索で「その語を含まない」の意味になる）。同じ語は 1 回。「黒」等の 1 字の色は、別の色の名前がある時は落とす
//   - 60 字を超える時は、型番らしい語・色・【】[] の中の語を残し、他の語は名前の頭から入るだけ入れる（長いと出品の名前に全部の語がそろわず 0 件になりやすい）
const FLEA_MAX = 60;
const FLEA_COLOR = /ブラック|ホワイト|シルバー|ゴールド|ブルー(?!レイ)|レッド|グリーン|ピンク|パープル|イエロー|オレンジ|グレー|グレイ|ベージュ|ブラウン|ネイビー|ミッドナイト|スターライト|ナチュラル|チタニウム|ラベンダー|ミント|アイボリー|シャンパン|ローズ|コーラル|ボルドー|カーキ|オリーブ|バイオレット|グラファイト|クリーム|チャコール|\b(?:black|white|silver|gold|blue|red|green|pink|purple|yellow|orange|gr[ae]y|beige|brown|navy|midnight|starlight|natural|titanium|lavender|mint|cream|graphite|porcelain|obsidian|hazel)\b/i;
const FLEA_NOISE = /新品|未開封|未使用|買取不可|買取|予約必須|数量限定品|同額/g;
const fleaQuery = (p) => {
  const key = new Set();  // 【】・[] の中の語（色・マウント・機種・BOX 等。長い時も残す）
  let s = String(p.n || "").replace(/[™®©]/g, "").normalize("NFKC")  // ™ は NFKC で「TM」になり語にくっつく
    .replace(/※.*$/, " ").replace(/(?:JAN|EAN)\s*:?\s*\d{8,14}/gi, " ").replace(/[-+]?\d[\d,]*円/g, " ")
    .replace(/\.{3,}|…/g, " ").replace(/["“”『』「」]/g, " ");
  s = s.replace(/\(([^()]*)\)/g, (m, c, i, all) => {
    const t = c.trim(), before = all.slice(0, i), next = all[i + m.length] || " ";
    if (!t || /^[A-Z]{1,2}$/.test(t)) return " ";                    // 色の記号 (W) (BK)
    if (/^[ァ-ヶー・]+$/.test(t) && !FLEA_COLOR.test(t)) {             // 読み（「拡張パック(ショートパック)」「32GB (タングステン)」は読みでないので残す）
      if (t.length <= 2 && /[\u4e00-\u9fff]$/.test(before) && /\S/.test(next)) return "";   // 美(ミ)ラクル → 美ラクル
      if (/(?:^|\s)[A-Za-z][A-Za-z.&'’-]*\s?$/.test(before)) return " ";                   // SONY(ソニー)・GIGABYTE (ギガバイト)
    }
    return ` ${t}${/[^\x00-\x7f]/.test(t.slice(-1)) && /[^\x00-\x7f\s]/.test(next) ? "" : " "}`;  // Pro(第4世代)用 → 第4世代用
  });
  s = s.replace(/【([^】]*)】|\[([^\]]*)\]/g, (m, a, b) => {
    const t = (a ?? b).trim();
    if (t.length <= 12) for (const w of t.split(/\s+/)) if (w) key.add(w);  // 長い中身（「[Matte Black アルミケース/Obsidian アクティブ バンド]」）は説明なので数えない
    return ` ${t} `;
  });
  const seen = new Set();
  let q = [];
  for (let t of s.replace(/[()【】[\]]/g, " ").split(/\s+/)) {
    t = t.replace(FLEA_NOISE, "").replace(/^[-–—/]+|\/+$/g, "");  // 「/Switch」の頭の / も外す（「MP7P2J/A」「M/L」の中の / は残す）
    if (!t || /^[\p{P}\p{S}]+$/u.test(t) || /^\d{8,14}$/.test(t) || seen.has(t.toLowerCase())) continue;
    if (!/^\d+$/.test(t)) seen.add(t.toLowerCase());  // 数字だけの語は重ねてよい（「Gen 5 Ryzen 5」）
    q.push(t);
  }
  if (q.some((t) => FLEA_COLOR.test(t))) q = q.filter((t) => !/^[黒白赤青緑金銀紫桃灰茶紺藍]$/.test(t));
  if (q.join(" ").length > FLEA_MAX) {
    // 長い時: 容量（「32GB」「1TB」だけの語）・【】[] の中の語（「[55インチ]」「[ニコンZ用]」）・型番らしい語（英字と数字で 4〜20 字・「010-02907-50」）・
    // 色（12 字まで。長いのはバンド等の説明）は残し（型番・色でも「32GBメモリ」「14.5インチ」「重量1.28kg」等の仕様の語は除く）、他の語は頭から入るだけ入れる
    // （名前の頭にメーカー・シリーズ、後ろに仕様が並ぶことが多い。「Lenovo … Yoga Slim 7x … 重量1.28kg」）
    // 仕様の語: 数字＋単位（前後が英数字でない。「MF8W4J/A」の 8W は型番の中なので仕様ではない）・メモリ等
    const spec = (t) => /(?:^|[^A-Za-z0-9.])\d+(?:\.\d+)?(?:GB|TB|MB|kg|g|mm|cm|インチ|型|Hz|MHz|GHz|W|Wh|mAh)(?![A-Za-z0-9])/i.test(t) || /メモリ|SSD|HDD|搭載|重量/.test(t);
    const model = (t) => t.length <= 20 && ((/[A-Za-z]/.test(t) && /\d/.test(t) && t.length >= 4) || (/^\d+(?:-\d+)+$/.test(t) && t.length >= 6));
    const must = (t) => /^\d+(?:\.\d+)?(?:GB|TB)$/i.test(t) || key.has(t) || (!spec(t) && (model(t) || (t.length <= 12 && FLEA_COLOR.test(t))));
    let room = FLEA_MAX + 1 - q.filter(must).reduce((n, t) => n + t.length + 1, 0), open = true;
    const out = [];
    for (const t of q) {
      if (must(t)) out.push(t);
      else if (open && t.length + 1 <= room) { out.push(t); room -= t.length + 1; }
      else open = false;
    }
    if (out.length) q = out;  // 何も入らない（空白の無い長い名前）時は、下で 60 字に切る
    while (q.length > 1 && q.join(" ").length > FLEA_MAX) q.pop();
  }
  return q.join(" ").slice(0, FLEA_MAX).trim();
};
// 開く条件（2026-09-29 ユーザー指示: 新品・売り切れ・新しい順）。フリマのサイトは開かずに、第三者の記事・公開コードの一致で引数を確かめた
// （出典は tests/flea_check.js の先頭）。第三者の情報しか無い引数は、裏付けが 1 件だけ・食い違うものは入れない（本人がブラウザで選んだ URL の引数は入れる）（間違った引数で 0 件になるより、絞り込みが 1 つ足りないほうがよい）:
//   ラクマの状態（候補 status=new。1 件だけ）・Yahoo!フリマの並び順（候補 sort=openTime&order=desc。1 件だけで、URL では変わらないという 2026-09 の記述もある）
// Yahoo!フリマは検索語が URL の道筋に入るので「/」は空白にする（%2F を道筋の区切りとして扱うサーバーがある）
// ラクマ（2026-10-01 ユーザーがスマホのブラウザで「ゲーム機本体・新品、未使用・売り切れ・新着順」を選んだ URL から）:
//   statuses=5 = 新品、未使用／category_id=787 = ゲーム機本体。ラクマは語が一部しか合わない出品も出すので、本体のセット
//   （例「Switch 2 … Pokemon LEGENDS Z-A … Edition セット」）でソフト単体が混ざった。本体と確かな商品にだけカテゴリを付ける
//   （ソフトに付けると 0 件になるので、迷うものは付けない）
const FLEA_HW = /本体|有機EL|Switch Lite|Nintendo Switch 2\s*[（(]?\s*(?:日本語|多言語|国内)|Nintendo Switch 2.*セット|(?:プレイステーション|PlayStation) ?5 ?(?:Pro|Slim|デジタル|Digital)|PS5 ?(?:Pro|Slim|本体)|Xbox Series [XS]|\b(?:HAD|HEG|HDH|BEE)-S|\bCFI-[127]\d{3}[AB]|\bCFIJ-10\d{3}|\b(?:EP2|RRT|RRS|XXU)-\d/i;
const FLEA_NOT_HW = /\[(?:Nintendo Switch[^\]]*|PS[45]|Switch)\]|(?<!マイクロ)ソフト|ダウンロード|コントローラ|Joy-?Con|amiibo|ケース|カバー|フィルム|ポーチ|充電|ドック|スタンド|アダプタ|ケーブル|カメラ|ヘッドセット|メモリー?カード|microSD|Edition(?!\s*セット)|for (?:Nintendo|PS5|Switch)|\/(?:PS5|Switch)|専用\]|Alarmo|サウンドクロック|Controller|ストレージ|X\|S|Steam ?Deck|\bROG\b|\bAlly\b|Legion|VR2?\b|Portal|リモートプレーヤー|(?<!専)用|スキン|(?<!多言語)対応|CFI-ZDD|グリップ|ストラップ|ハンドル|Quest|Vision Pro/i;
const fleaConsole = (p) => p.k === "game" && FLEA_HW.test(p.n || "") && !FLEA_NOT_HW.test(p.n || "");
const FLEA = [
  { name: "メルカリ", how: "新品・未使用の売り切れを新しい順で", note: "",
    url: (q) => `https://jp.mercari.com/search?keyword=${encodeURIComponent(q)}&status=sold_out%7Ctrading&item_condition_id=1&sort=created_time&order=desc` },
  { name: "ラクマ", how: "新品・未使用の売り切れを新しい順で", note: "",
    url: (q, p) => `https://fril.jp/s?query=${encodeURIComponent(q)}${p && fleaConsole(p) ? "&category_id=787" : ""}&statuses=5&transaction=soldout&sort=created_at&order=desc` },
  { name: "Yahoo!フリマ", how: "新品・未使用の売り切れを", note: "。並び順はサイトの既定なので、開いた先で「新着順」を選んでください",
    url: (q) => `https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(q.replace(/[/\\]+/g, " ").trim())}?sold=1&conditions=NEW` },
];
const fleaLinks = (p) => {
  const q = fleaQuery(p);
  if (!q) return "";  // 名前が JAN だけ等（空の検索はフリマの全部の商品が出る）
  return `<div class="flea" role="group" aria-label="フリマの売り切れ（新品・新しい順）を新しいタブで開く"><span class="flea-l" aria-hidden="true">売り切れ<small>新品・新しい順</small></span>${FLEA.map((f) =>
    `<a href="${esc(f.url(q, p))}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" title="${esc(`${f.name}で「${q}」の${f.how}開きます（新しいタブ）${f.name === "ラクマ" && fleaConsole(p) ? "。カテゴリはゲーム機本体" : ""}${f.note}`)}">${esc(f.name)}</a>`).join("")}</div>`;
};
// 検索した色（例: ホワイト）の名前が無く、近い色（例: シルバー）で当たった商品に付ける印
const nearTag = (p) => {
  const w = st.near && st.near.get(p.id);
  return w ? ` <span class="neartag" title="商品名に「${esc(st.nearColor)}」は無く、近い色「${esc(w)}」として表示しています">近い色: ${esc(w)}</span>` : "";
};
// 件数と「何が隠れているか」。隠れている理由ごとに、戻す操作を付ける
function renderSummary({ Q, hid, looseExtra, autoLoose, moved, other, noColor, mvc }) {
  const notes = [];
  const btn = (act, label) => `<button class="linkbtn" data-act="${act}">${label}</button>`;
  if (mvc) {
    if (!mvc.range) notes.push(`比べられる取得の回がまだありません（2 回以上の取得が要ります）`);
    else {
      notes.push(`${mvDirLabel[mvSet.dir]}（${esc(mvLabel(mvc.range[0]))} → ${esc(mvLabel(mvc.range[1]))}）`);
      if (mvc.cnt.same) notes.push(`最高値が同じ ${num(mvc.cnt.same)} 件は出していません`);
      const off = st.status.sites.filter((s) => s.enabled && hidden.has(s.id)).length;
      if (off) notes.push(`<b class="warnnote">比較から外した ${off} 店</b>を除いた最高値で比べています ${btn("shops", "比較する店を選ぶ")}`);
      if (includeStore) notes.push(`来店のみの価格も最高値に含めています`);
      if (mvSet.dir === "gone") notes.push(`<span class="muted">対象は今どこかの店に載っている商品だけです（今どの店にも無い商品は出ません）</span>`);
    }
  }
  if (st.shopSort) notes.push(`<span class="muted">${esc(siteName(st.shopSort))} の高い順</span> ${btn("shopsort", "解除")}`);
  if (st.near.size) notes.push(`商品名に「${esc(Q.color)}」が無く<span class="neartag">近い色</span>で当たった ${num(st.near.size)} 件を含む ${btn("nearoff", "近い色を外す")}`);
  if (hid.near) notes.push(`「${esc(Q.color)}」に近い色の ${num(hid.near)} 件を外しています ${btn("nearon", "含める")}`);
  if (autoLoose) notes.push(`続けて書かれた商品が無いため、語を別々に含む商品を表示`);
  else if (st.useLoose) notes.push(`語を別々に含む商品も表示中 ${btn("strict", "続けて書かれた商品だけ")}`);
  else if (looseExtra > 0) notes.push(`「${esc(Q.strict.filter((t) => t.merged).map((t) => t.k).join("」「"))}」と続けて書かれた商品だけ表示（語を別々に含む ${num(looseExtra)} 件は除外） ${btn("loose", "それも表示")}`);
  if (moved >= 0) notes.push(`値動きのあった ${num(moved)} 件が先頭、値動きの無い ${num(st.rows.length - moved)} 件はその後ろ`);
  if (hid.fav) notes.push(`<b class="warnnote">★のみ表示中</b>（★の無い ${num(hid.fav)} 件を隠しています） ${btn("favoff", "すべて表示")}`);
  if (hid.shop) notes.push(`<b class="warnnote">比較から外した店</b>だけが扱う ${num(hid.shop)} 件を隠しています ${btn("shops", "比較する店を選ぶ")}`);
  if (other === null && !Q.empty && st.cat !== "all") notes.push(st.allFailed ? `<span class="muted">他のカテゴリは確認できませんでした</span> ${btn("allcat", "「すべて」で探す")}` : `<span class="muted">他のカテゴリを確認中…</span>`);
  if (noColor) notes.push(`<b class="warnnote">色「${esc(Q.color)}」を除くと ${num(noColor)} 件</b>（この色が無いか、店の表記が違います） ${btn("nocolor", "色を外して探す")}`);
  if (other > 0) notes.push(`<b class="warnnote">他のカテゴリにも ${num(other)} 件</b> ${btn("allcat", "「すべて」で表示")}`);
  $("summary").innerHTML = `<b>${num(st.rows.length)}</b> 件${notes.map((n) => `<span class="note">${n}</span>`).join("")}`;
  const acts = {
    shopsort: () => { st.shopSort = null; filterRows(); },
    nearoff: () => { st.nearOff = true; filterRows(); }, nearon: () => { st.nearOff = false; filterRows(); },
    loose: () => { st.useLoose = true; filterRows(); }, strict: () => { st.useLoose = false; filterRows(); },
    favoff: () => { $("favOnly").checked = false; filterRows(); },
    shops: () => { $("shopPick").hidden = false; $("shopPick").scrollIntoView({ block: "nearest" }); },
    allcat: () => selectCat("all"),
    nocolor: () => { $("q").value = $("q").value.split(/\s+/).filter((w) => !colorOf(normText(w)) && !colorIn(normText(w))).join(" "); filterRows(); },
  };
  $("summary").querySelectorAll("[data-act]").forEach((b) => b.onclick = acts[b.dataset.act]);
}

// ---- 実利益（画面）----
// 計算の設定（減額率・送料・ポイント）と仕入れ値（商品 ID ごと・1 個の額）はこの端末に保存する。共有リンク・パターンには入れない
let profitSet = cleanProfitSet(store.get("profitSet", null));
const buyPrices = (() => {
  const v = store.get("buyPrices", {}), out = Object.create(null);  // "__proto__" 等の ID でも普通の名前として扱う
  if (v && typeof v === "object" && !Array.isArray(v))
    for (const [k, x] of Object.entries(v)) if (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1e10) out[k] = Math.round(x);
  return out;
})();
const buyOf = (id) => (id in buyPrices ? buyPrices[id] : null);
function setBuy(id, v) { if (v == null) delete buyPrices[id]; else buyPrices[id] = v; store.set("buyPrices", buyPrices); }
// 売り先へ送る 1 回分の費用: 売り先計算で店ごとの送料・手数料を設定した店はその設定（無料基準も効く）、設定の無い店は既定の買取送料。
// 売り先計算の手取り見込み・店の選び方と同じ決まり（cart.js の shipRule / feeOf）。同じ店の送料を二重に引かない。
// → {v: 買取額の合計 sub の時の費用, own: 店ごとの設定を使ったか, rule: 送料の決まり {ship, free, fee}（損益分岐に使う）}
function shipOf(site, sub) {
  if (typeof cart === "undefined") return { v: profitSet.ship, own: false, rule: { ship: profitSet.ship, free: 0, fee: 0 } };
  return { v: feeOf(site, sub, cart.fees, profitSet.ship), own: !!cart.fees[site], rule: shipRule(site, cart.fees, profitSet.ship) };
}
const signYen = (n) => (n > 0 ? "+" : n < 0 ? "−" : "±") + num(Math.abs(n)) + " 円";
const pctTxt = (r) => (r == null ? "—" : (r < 0 ? "−" : "") + Math.abs(r * 100).toFixed(1) + "%");
const pfCls = (n) => (n < 0 ? "minus" : "plus");
// 実利益に使う最高値 = 画面の最高値（offersOf の先頭。来店のみ・桁違いの疑い・価格が不安定・比較から外した店は除く）
function profitOf(p) {
  const o = offersOf(p)[0];
  if (!o) return null;
  const f = shipOf(o[0], o[1]), b = buyOf(p.id);
  return { o, f, x: b == null ? null : profitCalc(o[1], b, profitSet, f.v) };
}
function profitOutHtml(p) {
  const r = profitOf(p);
  if (!r) return `<span class="muted">郵送で売れる最高値が無いため計算できません（来店のみ・桁違いの疑い・価格が不安定・比較から外した店の価格は使いません）</span>`;
  const { o, f, x } = r, shop = esc(shortName(o[0]));
  if (!x) return `<span class="muted">仕入れ値を入れると、最高値 ${yen(o[1])}（${shop}）で売った時の実利益を出します</span>`;
  if (x.none) return `<span class="muted">仕入れ値${x.pt ? "からポイントを引いた額" : ""}が 0 円のため、実利益は計算しません（01.商材購入 の基準と同じく値なしとして扱います。1 円以上で入れてください）</span>`;
  return `<b class="pf-net ${pfCls(x.net)}">実利益 ${signYen(x.net)}</b><span class="pf-rate ${pfCls(x.net)}">利益率 ${pctTxt(x.rate)}</span>
    <span class="pf-bd">最高値 ${num(o[1])}（${shop}） − 査定減額 ${profitSet.cut}% ${num(x.cut)} − ${f.own ? `送料・手数料 ${num(f.v)}（${shop}の設定）` : `送料 ${num(f.v)}`} − 仕入れ ${num(x.eff)}${x.pt ? `（ポイント ${num(x.pt)} を引いた額${x.capped ? "。ポイントは上限の仕入れ値の 50% で計算" : ""}）` : ""}${o[8] > 1 ? ` ・ ${shop}は最低 ${num(o[8])} 個から` : ""}</span>`;
}
function profitBoxHtml(p) {
  const b = buyOf(p.id);
  return `<div class="profit" data-pf-box="${esc(p.id)}">
    <label class="pf-in"><span>仕入れ値</span><input type="text" inputmode="numeric" autocomplete="off" enterkeyhint="done" value="${b == null ? "" : num(b)}" placeholder="1 個の額" aria-label="仕入れ値（1 個・円）"><span>円</span></label>
    <div class="pf-out" aria-live="polite">${profitOutHtml(p)}</div>
    <button type="button" class="linkbtn pf-set" data-pfset title="査定減額率・送料・ポイント還元を変える">計算の設定</button>
  </div>`;
}
// 表の最高値の欄に添える一言（仕入れ値がある商品だけ）
function pfMetaHtml(p) { const r = profitOf(p); return r && r.x && !r.x.none ? `<span class="pf-net ${pfCls(r.x.net)}">利益 ${signYen(r.x.net)}</span>` : ""; }
// 欄を開くか: 押して開いた・閉じたならそれ。押していなければ、カードは仕入れ値がある商品だけ開く（表は行が伸びるので開かない）
const profOpen = (p, table) => (st.prof.has(p.id) ? st.prof.get(p.id) : !table && buyOf(p.id) != null);
function bindProfit(box, p) {
  const inp = box.querySelector("input");
  inp.oninput = () => {
    const v = parseYen(inp.value);
    if (v == null && inp.value.trim()) { box.querySelector(".pf-out").innerHTML = `<span class="err">数字で入れてください（例: 199800）</span>`; return; }
    setBuy(p.id, v); profitSync(p, inp);
  };
  inp.onchange = () => {  // 入れ終わったら 3 桁区切りにそろえる。売り先計算を開いていれば、その仕入れ値も合わせる
    // 読めない文字のまま離れた時は欄が前の値に戻るので、「数字で入れてください」も消して前の値の実利益に戻す
    // （以前は欄に前の値が出ているのに案内が残り、実利益が出ないままだった。2026-09-29 再点検）
    profitSync(p, null, false);
    if (typeof cartRender === "function" && !$("cartPanel").hidden) cartRender();
  };
}
// 同じ商品の欄（カード・表の行）と売り先計算の実利益を、今の仕入れ値・設定で書き直す（入力中の欄の文字はそのまま）
function profitSync(p, from, cartToo = true) {
  document.querySelectorAll(`[data-pf-box="${p.id}"]`).forEach((box) => {
    const i = box.querySelector("input");
    if (i !== from) { const v = buyOf(p.id); i.value = v == null ? "" : num(v); }
    box.querySelector(".pf-out").innerHTML = profitOutHtml(p);
  });
  document.querySelectorAll(`[data-pf="${p.id}"]`).forEach((m) => { m.innerHTML = pfMetaHtml(p); });
  // 開いている推移グラフの損益分岐の線も引き直す
  if (st.hist[p.k]) document.querySelectorAll(`.chart[data-chart="${p.id}"]`).forEach((box) => { if (box.querySelector("svg")) drawChart(box, st.hist[p.k][p.id] || {}, p); });
  if (cartToo && typeof cartProfitRefresh === "function") cartProfitRefresh();
}
function refreshProfits() {  // 設定を変えた時: 出ている欄をすべて書き直す。売り先計算は店の選び方・手取り見込みも変わるので描き直す
  for (const p of st.rows.slice(0, st.shown)) if (document.querySelector(`[data-pf-box="${p.id}"], [data-pf="${p.id}"]`)) profitSync(p, document.activeElement, false);
  if (typeof cartRefresh === "function") cartRefresh();
}
// カード: 最高値の枠の下に欄を出し入れする（一覧を描き直さない＝開いた推移グラフを閉じない）
function profToggle(li, p, btn, focus = true) {
  const old = li.querySelector(".profit");
  if (old) old.remove();
  else { li.querySelector(".p-best").insertAdjacentHTML("afterend", profitBoxHtml(p)); bindProfit(li.querySelector(".profit"), p); }
  st.prof.set(p.id, !old); btn.classList.toggle("on", !old); btn.setAttribute("aria-expanded", !old);
  if (!old && focus) li.querySelector(".profit input").focus();
}
// 表: 行の下に欄の行を出し入れする
const rowAfter = (tr, cls) => { for (let n = tr.nextElementSibling; n && /\b(chartrow|profrow)\b/.test(n.className); n = n.nextElementSibling) if (n.classList.contains(cls)) return n; return null; };
const profRowHtml = (p, i, span) => `<tr class="profrow" data-i="${i}"><td colspan="${span}">${profitBoxHtml(p)}</td></tr>`;

// 計算の設定（画面の下の小窓）。変えるとすぐ出ている実利益に反映し、この端末に保存する
function pfSetOpen(opener) {
  const f = $("pfSetForm");
  f.cut.value = profitSet.cut; f.ship.value = profitSet.ship; f.pt.value = profitSet.pt; f.unit.value = profitSet.unit;
  $("pfSetMsg").textContent = "";
  sheetOpen($("pfSet"), opener);
}
function pfSetBind() {
  const f = $("pfSetForm"), dec = (s) => { const t = String(s).normalize("NFKC").replace(/[,\s%円]/g, ""); return /^\d+(\.\d+)?$/.test(t) ? +t : null; };
  const apply = () => {
    const v = { cut: dec(f.cut.value), ship: dec(f.ship.value), pt: dec(f.pt.value), unit: f.unit.value };
    // 範囲外（減額率 100 超・% のポイント 100 超）は使わない（以前は案内に「前の値のまま」と出しながら 100% に切り詰めて計算していた。
    // 円 → % に切り替えた時の「3000」が 100% になり、実質の仕入れ値が 0 になっていた）。ポイントは単位と一緒に前の値のままにする。2026-09-28 独立検証
    if (v.cut != null && v.cut > 100) v.cut = null;
    if (v.pt != null && v.unit === "pct" && v.pt > 100) v.pt = null;
    // 案内は「数字でない」と「範囲外（例: 円 → % に切り替えた時の 3000）」の両方に当てはまる言い方にする
    const bad = [v.cut == null ? "査定減額率（0〜100 の数字）" : "", v.ship == null ? "送料（0 以上の数字）" : "", v.pt == null ? `ポイント還元（${v.unit === "pct" ? "% は 0〜100 の数字" : "0 以上の数字"}）` : ""].filter(Boolean);
    const unitKept = v.pt == null && v.unit !== profitSet.unit;  // 単位を切り替えたが値が使えない → 単位も前のまま
    if (v.pt == null) delete v.unit;
    // 50% を超える率は使えるが 50% で計算する（pricing.py と同じ上限）。誤りではないので赤字にしない
    const over = v.pt != null && v.unit === "pct" && v.pt > PT_MAX;
    $("pfSetMsg").textContent = bad.length ? `${bad.join("・")}を確かめてください。前の値${unitKept ? `（${profitSet.pt}${profitSet.unit === "yen" ? " 円" : "%"}）` : ""}のまま計算しています`
      : over ? `ポイント還元は仕入れ値の ${PT_MAX}% までで計算します（01.商材購入 の基準と同じ上限）` : "";
    $("pfSetMsg").className = bad.length ? "err" : "muted";
    const next = cleanProfitSet({ ...profitSet, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x != null)) });
    if (JSON.stringify(next) === JSON.stringify(profitSet)) return;
    profitSet = next; store.set("profitSet", profitSet); refreshProfits();
  };
  f.oninput = apply; f.onchange = apply;
  f.onsubmit = (e) => { e.preventDefault(); sheetClose($("pfSet")); };
  f.querySelector("[data-reset]").onclick = () => { profitSet = { ...PROFIT_DEFAULT }; store.set("profitSet", profitSet); pfSetOpen(); refreshProfits(); };
  document.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest("[data-pfset]"); if (b) pfSetOpen(b); });
}
// 小窓（バーコード・計算の設定）の開け閉め。背景を押す・Esc・×で閉じる
// 開いたら小窓の中（×）へ、閉じたら開いたボタンへ入力の位置を移す（aria-modal の小窓の決まり。キーボード・読み上げで
// 背後の一覧を操作したままにならないように。×にするのは、スマホで入力欄に移すとキーボードが出てカメラの映像を隠すため）
function sheetOpen(el, opener) {
  if (!el.hidden) return;  // 開いたまま（「既定に戻す」で値を入れ直した時など）は入力の位置を動かさない
  // 戻り先は押したボタン（Safari はボタンを押してもフォーカスが移らず、activeElement が body のままになるため）
  el._ret = opener || document.activeElement;
  el.hidden = false; document.body.classList.add("noscroll");
  const x = el.querySelector("[data-close]"); if (x) x.focus({ preventScroll: true });
}
// 開いている小窓の中で Tab を回す（aria-modal の小窓から背後の一覧へ出ない。以前は Tab 5 回で背後の 📷 に届き、
// 押すとカメラをもう 1 つ起動して、閉じても前のカメラが動いたままになった。2026-09-29 再点検）
function sheetTrap(e) {
  const el = ["scan", "pfSet", "syncSheet"].map($).find((x) => x && !x.hidden);
  if (!el) return;
  const fs = [...el.querySelectorAll("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")].filter((x) => !x.disabled && x.getClientRects().length);
  if (!fs.length) return;
  const a = fs[0], z = fs[fs.length - 1], cur = document.activeElement;
  if (!el.contains(cur)) { e.preventDefault(); (e.shiftKey ? z : a).focus(); }
  else if (e.shiftKey && cur === a) { e.preventDefault(); z.focus(); }
  else if (!e.shiftKey && cur === z) { e.preventDefault(); a.focus(); }
}
function sheetClose(el) {
  const wasOpen = !el.hidden;
  el.hidden = true;
  if ($("cartPanel").hidden && $("scan").hidden && $("pfSet").hidden && (!$("syncSheet") || $("syncSheet").hidden)) document.body.classList.remove("noscroll");
  if (el.id === "scan") scanStop();
  let r = el._ret; el._ret = null;
  // 開いたボタンが描き直しで消えた時（売り先計算の実利益の欄の「計算の設定」は、設定を変えると欄ごと書き直す）は、同じ役のボタンへ戻す
  if (r && !r.isConnected && r.matches && r.matches("[data-pfset]")) r = document.querySelector("#cartPanel:not([hidden]) [data-pfset]");
  if (wasOpen && r && r.isConnected && typeof r.focus === "function" && (!document.activeElement || document.activeElement === document.body || el.contains(document.activeElement))) r.focus({ preventScroll: true });
}

// ---- ランキング表示（PC・スマホ共通。店が増えても横に伸びない）----
// 店名に残す最小の幅（em）: 4.5 文字分か、店名の幅（全角 1・半角 0.6 で見積もる）の短いほう。
// 一律 4.5 文字分だと、短い店名（ルデヤ・4 文字の店）で 1 行に入るのに印が次の行へ回っていた（2026-09-27 多角チェック2）
const snMin = (s) => Math.min(4.5, [...s].reduce((w, c) => w + (c.charCodeAt(0) > 0xff ? 1 : 0.6), 0)).toFixed(2);
function rankChip(o, i, best, rk = () => 0) {
  const diff = o[1] - best, sn = shortName(o[0]);
  const bar = best > 0 ? Math.min(100, Math.max(0, (o[1] / best) * 100)).toFixed(1) : "0";  // 見た目「取引所」の板の棒（最高値に対する割合）
  const title = [siteName(o[0]), o[5], o[6], o[3] ? "価格変更 " + fmtTime(o[3]) : ""].filter(Boolean).join(" / ");
  // 差: 別枠（来店のみ・桁違いの疑い・価格が不安定）の価格は最高値より高いことがある（以前は「−-782,000」と出た）
  return `<li class="${i === 0 ? "first" : ""}${isStore(o) && !includeStore ? "" : rcls(rk(o[1]))}"><a href="${esc(safeUrl(o[4]))}" target="_blank" rel="noopener" title="${esc(title)}" style="--bar:${bar}%">
    <span class="rk">${i + 1}</span>${dot(o[0])}<span class="sn" style="min-width:${snMin(sn)}em">${esc(sn)}</span>
    <span class="pr">${num(o[1])}</span>${i ? `<span class="df">${diff > 0 ? "+" + num(diff) : diff ? "−" + num(-diff) : "同額"}</span>` : ""}${storeTag(o)}${chgHtml(recentChange(o))}</a></li>`;
}
function renderRank() {
  const ul = $("list"); ul.innerHTML = "";
  const topN = wide.matches ? TOP_PC : TOP_SP;
  for (const p of st.rows.slice(0, st.shown)) {
    const stores = storeOffersOf(p), offers = offersOf(p), fk = favKey(p);
    const best = offers[0] || stores[0], onlyStore = !offers.length;
    // 別枠だけの商品: 来店のみの価格か、桁違いの疑い・価格が不安定の価格か（比較する店を外すと、それだけが残ることがある）
    const bestOut = onlyStore && isOut(best), bestUnst = onlyStore && !bestOut && isUnst(best);
    const open = st.open.has(p.id), shown = open ? offers : offers.slice(0, topN);
    const li = document.createElement("li"); li.className = "prod";
    const lead = offers[1] ? offers[0][1] - offers[1][1] : null;
    // 別枠の見出し: 桁違いと不安定の両方に当たる価格は桁違いに数える。どれにも当たらない別枠は来店のみ
    const nOut = stores.filter(isOut).length, nUnst = stores.filter((o) => isUnst(o) && !isOut(o)).length, pfOn = profOpen(p, false);
    const kinds = [stores.length > nOut + nUnst && "来店のみ", nOut && "桁違いの疑い", nUnst && "価格が不安定"].filter(Boolean);
    const storeHead = kinds.length > 1 ? `${kinds.join("・")}の価格（最高値に含めていません）` : nOut ? "桁違いの疑いがある価格（最高値に含めていません）"
      : nUnst ? "価格が不安定（同じ店の価格が行き来している・最高値に含めていません）" : "来店・持ち込みのみの価格（郵送不可・最高値に含めていません）";
    // 「N 店が買取」は最高値に使える店の数。別枠の価格だけの商品では出さない（2026-09-30 再総チェック: 「0 店が買取」の横に大きな価格が出て、
    // 買い取る店が無いように読めた。別枠の件数（来店のみ・価格が不安定など）と最高値の欄の見出しで分かる）
    li.innerHTML = `
      <div class="p-main">
        <div class="p-title"><span class="name" title="クリックで価格の推移">${esc(p.n)}</span>${nearTag(p)}</div>
        <div class="p-meta">${[p.m && esc(p.m), p.j && "JAN " + esc(p.j), offers.length > 0 && `${offers.length} 店が買取`, stores.some(isStore) && `来店のみ ${stores.filter(isStore).length} 店`, nOut && `桁違いの疑い ${nOut} 件`, nUnst && `価格が不安定 ${nUnst} 件`].filter(Boolean).join(" ・ ")}</div>
        <div class="p-acts">
          <button class="add" title="在庫リストに追加（売り先計算）">＋ 在庫に追加</button>
          <button class="fav${favs.has(fk) ? " on" : ""}" aria-pressed="${favs.has(fk)}" aria-label="お気に入り" title="お気に入り">★</button>
          <button class="hist" title="価格の推移">推移</button>
          <button class="pfbtn${pfOn ? " on" : ""}" aria-expanded="${pfOn}" title="仕入れ値を入れて、この商品の実利益を計算">利益</button>
        </div>
        ${fleaLinks(p)}
      </div>
      <div class="p-best${onlyStore ? " storeonly" : ""}">
        <span class="lbl">${bestOut ? "桁違いの疑いの価格" : bestUnst ? "不安定な価格" : onlyStore ? "来店のみの価格" : "最高値"}</span>
        <span class="amt" data-v="${best[1]}">${yen(best[1])}</span>
        <span class="bshop">${dot(best[0])}${esc(siteName(best[0]))}</span>
        ${bestOut ? `<span class="lead">他店と桁違いのため最高値にしていません</span>` : bestUnst ? `<span class="lead" title="${unstTip}">価格が不安定（7日で ${num(best[10])} 回行き来）のため最高値にしていません</span>` : onlyStore ? `<span class="lead">郵送では売れません</span>` : lead !== null ? `<span class="lead">${lead ? `2位より +${num(lead)}` : "2位と同額"}</span>` : `<span class="lead">1 店のみ</span>`}
      </div>
      ${pfOn ? profitBoxHtml(p) : ""}
      <div class="p-rank">
        <ol>${shown.map((o, i) => rankChip(o, i, best[1], rankOf(offers))).join("")}</ol>
        ${offers.length > topN ? `<button class="morebtn">${open ? "上位だけ表示" : `他 ${offers.length - topN} 店を表示`}</button>` : ""}
        ${stores.length ? `<div class="storebox"><span class="storehead">${storeHead}</span><ol>${stores.map((o) => rankChip(o, -1, best[1])).join("")}</ol></div>` : ""}
      </div>`;
    li.querySelector("button.add").onclick = () => cartAdd(p);
    li.querySelector("button.fav").onclick = (e) => toggleFav(e.currentTarget, fk);
    const chart = () => toggleChart(li, p);
    li.querySelector(".name").onclick = chart; li.querySelector("button.hist").onclick = chart;
    li.querySelector("button.pfbtn").onclick = (e) => profToggle(li, p, e.currentTarget);
    if (pfOn) bindProfit(li.querySelector(".profit"), p);
    const mb = li.querySelector(".morebtn");
    if (mb) mb.onclick = () => { open ? st.open.delete(p.id) : st.open.add(p.id); renderList(); };
    ul.append(li);
  }
}
function toggleFav(btn, fk) {
  favs.has(fk) ? favs.delete(fk) : favs.add(fk);
  btn.classList.toggle("on", favs.has(fk)); btn.setAttribute("aria-pressed", favs.has(fk)); store.set("favs", [...favs]);  // オン・オフを色だけでなく読み上げにも伝える
}

// ---- 店別の表（PC 向け。列 = 比較する店）----
function renderTable() {
  const rows = st.rows.slice(0, st.shown);
  // 列は「表示中の商品のどれかに価格がある店」だけ（店が多くても、絞り込むと列が減って見やすい）
  const has = new Set(rows.flatMap((p) => [...offersOf(p), ...storeOffersOf(p)].map((o) => o[0])));
  const cols = st.status.sites.filter((s) => s.enabled && !hidden.has(s.id) && has.has(s.id)).map((s) => s.id), tbl = $("table");
  const head = cols.map((id) => `<th class="shop${st.shopSort === id ? " sorted" : ""}" data-site="${id}" tabindex="0" aria-sort="${st.shopSort === id ? "descending" : "none"}" title="${esc(siteName(id))}：クリックでこの店の高い順">
    <span class="bar" style="background:${shopColor(id)}"></span>${esc(shortName(id))}</th>`).join("");
  let html = `<thead><tr><th class="acts"></th><th class="pname">商品</th><th class="num">最高値</th>${head}</tr></thead><tbody>`;
  rows.forEach((p, i) => {
    const offers = offersOf(p), stores = storeOffersOf(p), fk = favKey(p);
    // 店ごとに 1 つ: 比較に使う価格（高い順の先頭）を優先し、無い店だけ別枠（来店のみ・桁違い）の価格。
    // 以前は後ろの別枠が上書きし、郵送と来店の両方を出す店（買取当番の 3 商品）で郵送の価格が列に出なかった（2026-09-27 多角チェック1）
    const by = {}, also = {};  // also = 同じ店のもう 1 つの価格（郵送と来店のみの両方を出す店）。セルに小さく添える
    for (const o of [...offers, ...stores]) if (!by[o[0]]) by[o[0]] = o; else if (!also[o[0]] && isStore(o) !== isStore(by[o[0]])) also[o[0]] = o;
    const top = offers[0] || stores[0], best = top[1];
    const pfOn = profOpen(p, true);
    // 別枠（来店のみ・桁違いの疑い・価格が不安定）の価格だけの商品は、最高値の欄を最高値の色にしない（カードの「来店のみの価格」等と同じ色。
    // 2026-09-30 再総チェック: 最高値の金・緑の色で出ていて、その価格が最高値に見えた）
    html += `<tr data-i="${i}"><td class="acts"><button class="add" title="在庫リストに追加" aria-label="在庫リストに追加">＋</button><button class="fav${favs.has(fk) ? " on" : ""}" aria-pressed="${favs.has(fk)}" aria-label="お気に入り">★</button><button class="pf${pfOn ? " on" : ""}" aria-expanded="${pfOn}" aria-label="実利益" title="仕入れ値を入れて、この商品の実利益を計算">¥</button></td>
      <td class="pname"><span class="name" role="button" tabindex="0" title="クリックで価格の推移">${esc(p.n)}</span>${nearTag(p)}<div class="meta">${[p.m && esc(p.m), p.j && "JAN " + esc(p.j)].filter(Boolean).join(" ・ ")}${fleaLinks(p)}</div></td>
      <td class="num topv${offers.length ? "" : " aside"}">${num(best)}${offers.length ? "" : storeTag(top)}<div class="meta">${dot(top[0])}${esc(shortName(top[0]))}</div><div class="meta pfmeta" data-pf="${esc(p.id)}">${pfMetaHtml(p)}</div></td>
      ${cols.map((id) => cell(by[id], best, rankOf(offers), also[id])).join("")}</tr>${pfOn ? profRowHtml(p, i, cols.length + 3) : ""}`;
  });
  tbl.innerHTML = html + "</tbody>";
  tbl.querySelectorAll("th.shop").forEach((th) => th.onclick = () => {
    const site = th.dataset.site, kb = document.activeElement === th;
    st.shopSort = st.shopSort === site ? null : site; filterRows();
    // キーボードで並べ替えた時は、描き直した表の同じ列見出しに戻る（描き直しでフォーカスが外れるため）
    if (kb) { const t = $("table").querySelector(`th.shop[data-site="${CSS.escape(site)}"]`); if (t) t.focus({ preventScroll: true }); }
  });
  tbl.querySelectorAll("tbody tr.profrow").forEach((tr) => bindProfit(tr, rows[+tr.dataset.i]));
  tbl.querySelectorAll("tbody tr[data-i]:not(.profrow)").forEach((tr) => {
    const p = rows[+tr.dataset.i], fk = favKey(p);
    tr.querySelector("button.add").onclick = () => cartAdd(p);
    tr.querySelector("button.fav").onclick = (e) => toggleFav(e.currentTarget, fk);
    tr.querySelector("button.pf").onclick = (e) => {  // 行の下に実利益の欄を出し入れする
      const old = rowAfter(tr, "profrow"), b = e.currentTarget;
      if (old) old.remove();
      else { tr.insertAdjacentHTML("afterend", profRowHtml(p, tr.dataset.i, cols.length + 3)); bindProfit(tr.nextElementSibling, p); tr.nextElementSibling.querySelector("input").focus(); }
      st.prof.set(p.id, !old); b.classList.toggle("on", !old); b.setAttribute("aria-expanded", !old);
    };
    tr.querySelector(".name").onclick = () => {
      const next = rowAfter(tr, "chartrow");
      if (next) return next.remove();
      const row = document.createElement("tr"); row.className = "chartrow";
      row.innerHTML = `<td colspan="${cols.length + 3}"></td>`;
      (rowAfter(tr, "profrow") || tr).after(row); toggleChart(row.firstChild, p);  // 実利益の行があればその下（押した順で並びが変わらないように）
    };
  });
}
// 順位で色分け（1 位 = 濃い緑の塗り、2 位 = 中間、3 位 = 薄い、4 位以下 = 無色）
function cell(o, best, rk, also) {
  const sub = also ? `<div class="meta" title="${esc(siteName(also[0]) + (isStore(also) ? " / 来店・持ち込みのみの価格" : " / 郵送の価格"))}">${isStore(also) ? "来店" : "郵送"} ${num(also[1])}</div>` : "";
  if (!o) return `<td class="na">·</td>`;
  if (isAside(o) || (isStore(o) && !includeStore))  // 来店のみ・桁違いの疑い・価格が不安定: 色の濃さ（最高値との差）には含めない
    return `<td class="store"><a href="${esc(safeUrl(o[4]))}" target="_blank" rel="noopener" title="${esc(siteName(o[0]) + (isOut(o) ? " / 他店と桁違いの価格（誤掲載の疑い） / " : isUnst(o) ? ` / 価格が不安定（7日で ${o[10]} 回行き来。最高値に含めていません） / ` : " / 来店・持ち込みのみ（郵送不可） / ") + (o[6] || ""))}">${num(o[1])}</a>${storeTag(o)}${sub}</td>`;
  const r = rk(o[1]);
  const title = [siteName(o[0]), o[5], o[6], best - o[1] ? `最高値との差 −${num(best - o[1])}` : "最高値", o[3] ? "価格変更 " + fmtTime(o[3]) : ""].filter(Boolean).join(" / ");
  return `<td class="${rcls(r).trim()}"><a href="${esc(safeUrl(o[4]))}" target="_blank" rel="noopener" title="${esc(title)}">${num(o[1])}</a>${chgHtml(recentChange(o))}${sub}</td>`;
}

// 検索で 2〜12 件に絞れた時は、ランキング表示の上に「違う部分（色・容量など）」の一覧を出す。
// スマホは 1 商品が縦に長く、色違いが 4 つあっても最初の 1〜2 個しか画面に入らないため（押すとその商品へ移動）
function renderJumps(on) {
  const nav = $("jumps"), rows = st.rows.slice(0, st.shown);
  if (!on || !$("q").value.trim() || rows.length < 2 || rows.length > 12) { nav.hidden = true; nav.innerHTML = ""; return; }
  let pre = rows.reduce((a, p) => { let i = 0; while (i < a.length && a[i] === p.n[i]) i++; return a.slice(0, i); }, rows[0].n);
  pre = pre.slice(0, pre.lastIndexOf(" ") + 1);  // 語の途中で切らない
  const label = (p) => (pre.length >= 4 && p.n.length > pre.length ? p.n.slice(pre.length) : p.n);
  nav.innerHTML = `<span class="muted">${pre.length >= 4 ? esc(pre.trim()) + " の" : ""}${num(rows.length)} 件:</span>` +
    rows.map((p, i) => { const b = offersOf(p)[0] || storeOffersOf(p)[0];
      return `<button data-i="${i}" title="${esc(p.n)}">${esc(label(p))}${nearTag(p)}<b>${yen(b[1])}</b></button>`; }).join("");
  nav.querySelectorAll("button").forEach((b) => b.onclick = () => $("list").children[+b.dataset.i]?.scrollIntoView({ block: "start", behavior: scrollMotion() }));
  nav.hidden = false;
}
function renderList() {
  document.documentElement.style.setProperty("--hdr", document.querySelector(".top").offsetHeight + "px");
  const table = st.mvOn ? wide.matches : st.view === "table" && wide.matches;
  if (st.mvOn) {  // 最高値の値動き: PC は表、スマホはカード
    $("list").hidden = table; $("tableWrap").hidden = !table; $("viewSeg").hidden = true;
    $("table").classList.toggle("mvtable", table); $("tableWrap").classList.toggle("mvwrap", table);
    table ? renderMvTable() : renderMvCards();
    renderJumps(false);
    $("more").hidden = st.rows.length <= st.shown;
    $("more").textContent = `もっと見る（残り ${num(Math.max(0, st.rows.length - st.shown))} 件）`;
    if (typeof skinAfter === "function") skinAfter();
    return;
  }
  $("list").hidden = table; $("tableWrap").hidden = !table;
  $("viewSeg").hidden = !wide.matches; $("table").classList.remove("mvtable"); $("tableWrap").classList.remove("mvwrap");
  table ? renderTable() : renderRank();
  renderJumps(!table);
  $("more").hidden = st.rows.length <= st.shown;
  $("more").textContent = `もっと見る（残り ${num(Math.max(0, st.rows.length - st.shown))} 件）`;
  if (typeof skinAfter === "function") skinAfter();  // 見た目「取引所」のテロップ・数える演出（skin.js）
}

// ---- 最高値の値動き（画面）----
// 期間の選び方・表示する変化・並び順はこの端末に保存する（開いているかどうかは保存しない。普段の一覧を絞り込んだまま忘れないように）
const mvSet = { mode: store.pick("mvMode", ["prev", "day", "custom"], "prev"), dir: store.pick("mvDir", ["up", "down", "new", "gone"], "up"),
  order: store.pick("mvOrder", ["amt", "rate"], "amt"), from: null, to: null };
const mvDirLabel = { up: "最高値が上がった商品", down: "最高値が下がった商品",
  new: "始まりの回に最高値が無く、終わりの回にある商品（新たに載った）", gone: "始まりの回に最高値があり、終わりの回に無い商品（載らなくなった）" };
let mvLoading = null;
function mvLabel(i) {  // 「9/26 17時」。取れた店が一番多い回の 8 割に満たない回は店数も（1 店だけ取り直した回など。定休日の 1〜2 店の休みでは出さない）
  const t = st.mvData.t;
  st.mvFull ??= Math.max(...t.map((x) => x[2]));
  return t[i][1] + (t[i][2] < st.mvFull * 0.8 ? `（${t[i][2]}店だけ取得）` : "");
}
function setMv(on) {
  st.mvOn = on; st.shopSort = null;
  $("mvBtn").setAttribute("aria-pressed", on);
  $("sort").hidden = on; $("mvBar").hidden = !on || !st.mvData;
  filterRows();
}
function mvWait() {  // moves.json をまだ読んでいない: 読み込んでから描き直す
  st.rows = []; st.shown = PAGE;
  $("summary").textContent = st.mvFailed ? "最高値の値動きを読み込めませんでした。再読み込みしてください" : "最高値の値動きを読み込み中…";
  $("list").innerHTML = ""; $("table").innerHTML = ""; $("more").hidden = true; $("jumps").hidden = true; $("mvBar").hidden = true;
  if (!st.mvFailed) (mvLoading ||= load("moves")).then((d) => {
    if (!st.mvData) { st.mvData = d; buildMvBar(); }
    if (st.mvOn) { $("mvBar").hidden = false; filterRows(); }
  }, () => { st.mvFailed = true; mvLoading = null; if (st.mvOn) filterRows(); });
}
function mvFilter(rows) {
  const mv = st.mvData, range = mvRange(mv.t, mvSet.mode, mvSet.from, mvSet.to);
  const cnt = { up: 0, down: 0, same: 0, new: 0, gone: 0, none: 0 }, lists = { up: [], down: [], new: [], gone: [] };
  st.mvInfo = new Map(); st.mvRange = range;
  if (!range) return { rows: [], cnt, range };
  for (const p of rows) {
    const c = mvCompare(mv, p.id, range[0], range[1], hidden, includeStore);
    cnt[c.kind]++;
    if (lists[c.kind]) { c.why = mvWhy(mv, p.id, c, range[0], range[1], hidden, includeStore); lists[c.kind].push(p); st.mvInfo.set(p.id, c); }
  }
  const I = (p) => st.mvInfo.get(p.id), key = mvSet.order === "rate" ? "r" : "d";
  const out = lists[mvSet.dir] || [];
  if (mvSet.dir === "up") out.sort((a, b) => I(b)[key] - I(a)[key] || I(b).b[0] - I(a).b[0]);
  else if (mvSet.dir === "down") out.sort((a, b) => I(a)[key] - I(b)[key] || I(b).b[0] - I(a).b[0]);
  else out.sort((a, b) => (I(b).b || I(b).a)[0] - (I(a).b || I(a).a)[0]);
  return { rows: out, cnt, range };
}
function buildMvBar() {
  const n = st.mvData.t.length, dis = n < 2 ? " disabled" : "";
  const opts = st.mvData.t.map((t, i) => `<option value="${i}">${esc(mvLabel(i))}</option>`).join("");
  $("mvBar").innerHTML = `
    <div class="mvhead"><b>最高値の値動き</b><button class="linkbtn" data-mv="close">通常の一覧に戻る</button></div>
    <p class="mvnote">商品ごとの<b>最高買取額</b>（比較中の店で一番高い価格）を、取得した回どうしで比べます。
      上の「24時間の値上がり・値下がり」（店ごとの価格の件数）や並び順の「各店の値動きが大きい順」（店ごとの直近 7 日）と違い、こちらは最高値そのものの上がり下がりです（最高値の店が替わった時も含む）。</p>
    <div class="mvrow">
      <div class="mvseg" role="group" aria-label="比べる期間">
        <button data-mode="prev"${dis}>前回の取得から</button><button data-mode="day"${dis}>1日前から</button><button data-mode="custom"${dis}>期間を指定</button>
      </div>
      <span class="mvcustom"><select id="mvFrom" aria-label="比べる期間の始まり">${opts}</select><span aria-hidden="true">→</span><select id="mvTo" aria-label="比べる期間の終わり">${opts}</select></span>
    </div>
    <div class="mvrow">
      <div class="mvseg dir" role="group" aria-label="表示する変化">
        <button data-dir="up" title="${mvDirLabel.up}"><span class="up">▲</span>値上がり<b></b></button><button data-dir="down" title="${mvDirLabel.down}"><span class="down">▼</span>値下がり<b></b></button><button data-dir="new" title="${mvDirLabel.new}">新たに載った<b></b></button><button data-dir="gone" title="${mvDirLabel.gone}">載らなくなった<b></b></button>
      </div>
      <select id="mvOrder" aria-label="並び順"><option value="amt">差額の大きい順</option><option value="rate">率の大きい順</option></select>
    </div>`;
  const bar = $("mvBar");
  bar.querySelector("[data-mv=close]").onclick = () => setMv(false);
  bar.querySelectorAll("[data-mode]").forEach((b) => b.onclick = () => {
    if (b.dataset.mode === "custom" && mvSet.mode !== "custom" && st.mvRange) [mvSet.from, mvSet.to] = st.mvRange;  // 今見ている期間から始める
    mvSet.mode = b.dataset.mode; store.set("mvMode", mvSet.mode); filterRows();
  });
  bar.querySelectorAll("[data-dir]").forEach((b) => b.onclick = () => { mvSet.dir = b.dataset.dir; store.set("mvDir", mvSet.dir); filterRows(); });
  // 始まり・終わりの片方を変えた時は、もう片方は今の値のまま（選べない時点は updateMvBar が選べなくしている）
  $("mvFrom").onchange = (e) => { mvSet.from = +e.target.value; mvSet.to = st.mvRange ? st.mvRange[1] : null; filterRows(); };
  $("mvTo").onchange = (e) => { mvSet.to = +e.target.value; mvSet.from = st.mvRange ? st.mvRange[0] : null; filterRows(); };
  $("mvOrder").onchange = (e) => { mvSet.order = e.target.value; store.set("mvOrder", mvSet.order); filterRows(); };
}
function updateMvBar(c) {
  const bar = $("mvBar");
  bar.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mvSet.mode));
  bar.querySelectorAll("[data-dir]").forEach((b) => { b.setAttribute("aria-pressed", b.dataset.dir === mvSet.dir); b.querySelector("b").textContent = num(c.cnt[b.dataset.dir]); });
  bar.querySelector(".mvcustom").hidden = mvSet.mode !== "custom" || !c.range;
  $("mvOrder").value = mvSet.order; $("mvOrder").hidden = !["up", "down"].includes(mvSet.dir);
  if (!c.range) return;
  const [a, b] = c.range;
  $("mvFrom").value = a; $("mvTo").value = b;  // 始まり < 終わり になるよう、選べない時点は選べなくする
  [...$("mvFrom").options].forEach((o, i) => { o.disabled = i >= b; });
  [...$("mvTo").options].forEach((o, i) => { o.disabled = i <= a; });
}
const pct = (r) => (Math.abs(r) * 100).toFixed(Math.abs(r) < 0.001 ? 2 : 1) + "%";
function mvDiffHtml(c) {
  if (c.kind === "new") return `<span class="mvd new">新たに載った</span>`;
  if (c.kind === "gone") return `<span class="mvd gone">載らなくなった</span>`;
  const up = c.d > 0;
  return `<span class="mvd ${up ? "up" : "down"}">${up ? "▲" : "▼"}${num(Math.abs(c.d))}<small>${up ? "+" : "−"}${pct(c.r)}</small></span>`;
}
// 最高値の店が替わった理由（mvWhy）の一言。掲載の増減と価格の上げ下げを見分けられるように
function mvWhyHtml(c) {
  const w = c.why;
  if (!w) return "";
  const n = esc(shortName(w.site));
  const [txt, tip] = {
    end: [`${n} の価格が無くなった`, "始まりの回の最高値の店に、終わりの回は価格が無い（掲載終了か、7 日以上取れていない）"],
    cut: [`${n} が ${yen(w.v)} に値下げ`, "始まりの回の最高値の店が値下げし、別の店が最高値になった"],
    new: [`${n} が新たに載せた`, "終わりの回の最高値の店は、始まりの回にはこの商品の価格が無かった"],
    raise: [`${n} が ${yen(w.v)} から値上げ`, "別の店が値上げして最高値になった"],
    out: [`${n} の価格は桁違いの疑いで除外`, "その回の他店と桁違いの価格だったので最高値に使っていない"],
    unst: [`${n} の価格は不安定で除外`, "その回までの 7 日に、同じ店の価格が 2 つの値の間を 3 回以上行き来していたので最高値に使っていない"],
  }[w.t];
  return `<div class="mvwhy" title="${tip}">最高値の店が替わった: ${txt}</div>`;
}
const mvSide = (x) => (x ? `<b class="mvp">${yen(x[0])}</b><span class="mvs">${dot(x[1])}${esc(shortName(x[1]))}</span>`
  : `<b class="mvp none">―</b><span class="mvs">最高値なし</span>`);
function renderMvCards() {
  const ul = $("list"); ul.innerHTML = "";
  const [a, b] = st.mvRange || [0, 0];
  for (const p of st.rows.slice(0, st.shown)) {
    const c = st.mvInfo.get(p.id), fk = favKey(p);
    const li = document.createElement("li"); li.className = "prod mvcard";
    li.innerHTML = `
      <div class="p-main">
        <div class="p-title"><span class="name" title="クリックで価格の推移">${esc(p.n)}</span>${nearTag(p)}</div>
        <div class="p-meta">${[p.m && esc(p.m), p.j && "JAN " + esc(p.j)].filter(Boolean).join(" ・ ")}</div>
      </div>
      <div class="mvbox ${c.kind}">
        ${mvDiffHtml(c)}${mvWhyHtml(c)}
        <div class="mvab">
          <div class="mvside"><span class="mvt">${esc(mvLabel(a))}</span>${mvSide(c.a)}</div>
          <span class="mvarrow" aria-hidden="true">→</span>
          <div class="mvside"><span class="mvt">${esc(mvLabel(b))}</span>${mvSide(c.b)}</div>
        </div>
      </div>
      <div class="p-acts">
        <button class="add" title="在庫リストに追加（売り先計算）">＋ 在庫に追加</button>
        <button class="fav${favs.has(fk) ? " on" : ""}" aria-pressed="${favs.has(fk)}" aria-label="お気に入り" title="お気に入り">★</button>
        <button class="hist" title="価格の推移">推移</button>
      </div>
      ${fleaLinks(p)}`;
    li.querySelector("button.add").onclick = () => cartAdd(p);
    li.querySelector("button.fav").onclick = (e) => toggleFav(e.currentTarget, fk);
    const chart = () => toggleChart(li, p);
    li.querySelector(".name").onclick = chart; li.querySelector("button.hist").onclick = chart;
    ul.append(li);
  }
}
function renderMvTable() {
  const rows = st.rows.slice(0, st.shown), tbl = $("table");
  const [a, b] = st.mvRange || [0, 0];
  const side = (x) => (x ? `${num(x[0])}<div class="meta">${dot(x[1])}${esc(shortName(x[1]))}</div>` : `<span class="muted">―</span><div class="meta">最高値なし</div>`);
  let html = `<thead><tr><th class="acts"></th><th class="pname">商品</th><th class="num">差額</th><th class="num">率</th>
    <th class="num mvcol">${esc(mvLabel(a))}<br>の最高値</th><th class="num mvcol">${esc(mvLabel(b))}<br>の最高値</th></tr></thead><tbody>`;
  rows.forEach((p, i) => {
    const c = st.mvInfo.get(p.id), fk = favKey(p), cls = c.kind === "up" || c.kind === "down" ? c.kind : "";
    html += `<tr data-i="${i}"><td class="acts"><button class="add" title="在庫リストに追加" aria-label="在庫リストに追加">＋</button><button class="fav${favs.has(fk) ? " on" : ""}" aria-pressed="${favs.has(fk)}" aria-label="お気に入り">★</button></td>
      <td class="pname"><span class="name" role="button" tabindex="0" title="クリックで価格の推移">${esc(p.n)}</span>${nearTag(p)}<div class="meta">${[p.m && esc(p.m), p.j && "JAN " + esc(p.j)].filter(Boolean).join(" ・ ")}${fleaLinks(p)}</div>${mvWhyHtml(c)}</td>
      <td class="num mvdiff ${cls}">${cls ? `${c.d > 0 ? "▲" : "▼"}${num(Math.abs(c.d))}` : c.kind === "new" ? "新たに載った" : "載らなくなった"}</td>
      <td class="num mvdiff ${cls}">${cls ? `${c.d > 0 ? "+" : "−"}${pct(c.r)}` : ""}</td>
      <td class="num">${side(c.a)}</td><td class="num mvto">${side(c.b)}</td></tr>`;
  });
  tbl.innerHTML = html + "</tbody>";
  tbl.querySelectorAll("tbody tr[data-i]").forEach((tr) => {
    const p = rows[+tr.dataset.i], fk = favKey(p);
    tr.querySelector("button.add").onclick = () => cartAdd(p);
    tr.querySelector("button.fav").onclick = (e) => toggleFav(e.currentTarget, fk);
    tr.querySelector(".name").onclick = () => {
      const next = tr.nextElementSibling;
      if (next && next.classList.contains("chartrow")) return next.remove();
      const row = document.createElement("tr"); row.className = "chartrow";
      row.innerHTML = `<td colspan="6"></td>`;
      tr.after(row); toggleChart(row.firstChild, p);
    };
  });
}

// ---- 価格の推移 ----
async function toggleChart(host, p) {
  const old = host.querySelector(".chart");
  if (old) return old.remove();
  const box = document.createElement("div"); box.className = "chart"; box.textContent = "推移を読み込み中…"; box.dataset.chart = p.id;
  host.append(box);
  try {
    if (!st.hist[p.k]) st.hist[p.k] = await load(`hist_${p.k}`);
    drawChart(box, st.hist[p.k][p.id] || {}, p);
  } catch (e) { box.textContent = "推移を読み込めませんでした"; }
}
function drawChart(box, series, p) {
  const now = Date.now() / 6e4;
  // 今の価格を持つ店すべてを描く。期間内に価格の変化が無い店も、左端から今の価格で水平線にする
  const all = Object.values(series).flat();
  const start = all.length ? Math.min(...all.map((v) => v[0])) : now - 1440;
  const lines = [...offersOf(p), ...storeOffersOf(p)].map((o) => {
    const pts = (series[seriesKey(o)] || []).slice();
    if (!pts.length || pts[0][0] > start) pts.unshift([start, pts.length ? pts[0][1] : o[1]]);
    pts.push([now, o[1]]);
    return [o, pts];
  });
  if (!lines.length) { box.textContent = "推移データはまだありません"; return; }
  // 仕入れ値を入れた商品は、損益分岐の買取額（これを下回ると赤字）を点線で引く
  // 送料は無料基準も効く決まりで渡す（その額で売った時の送料で分岐を出す。今の最高値での送料を使うと基準の前後でずれる）
  const pr = profitOf(p), be = pr && pr.x && !pr.x.none ? breakEven(buyOf(p.id), profitSet, pr.f.rule) : null;
  const xs = lines.flatMap(([, s]) => s.map((v) => v[0])), ys = lines.flatMap(([, s]) => s.map((v) => v[1])).concat(be != null ? [be] : []);
  const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1), pad = (Math.max(...ys) - Math.min(...ys)) * 0.1 || Math.max(...ys) * 0.05 || 1;
  const y0 = Math.max(0, Math.min(...ys) - pad),  // 価格の軸は 0 未満にしない
    y1 = Math.max(...ys) + pad, W = Math.max(280, Math.round(box.clientWidth || 600)), H = 200, L = 60, B = 22;
  const X = (x) => L + (x - x0) / (x1 - x0) * (W - L - 8), Y = (y) => 8 + (y1 - y) / (y1 - y0) * (H - B - 8);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="価格推移">`;
  for (let i = 0; i <= 3; i++) {
    const v = y0 + (y1 - y0) * i / 3;
    svg += `<line x1="${L}" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" stroke="currentColor" stroke-opacity=".1"/>
      <text x="${L - 6}" y="${Y(v) + 4}" font-size="11" text-anchor="end" fill="currentColor" fill-opacity=".55">${num(Math.round(v))}</text>`;
  }
  const d0 = jst(x0 * 6e4), d1 = jst(x1 * 6e4);
  svg += `<text x="${L}" y="${H - 4}" font-size="11" fill="currentColor" fill-opacity=".55">${d0.getUTCMonth() + 1}/${d0.getUTCDate()}</text>
    <text x="${W - 4}" y="${H - 4}" font-size="11" text-anchor="end" fill="currentColor" fill-opacity=".55">${d1.getUTCMonth() + 1}/${d1.getUTCDate()}</text>`;
  let legend = "";
  if (be != null) {
    svg += `<line class="beline" x1="${L}" x2="${W}" y1="${Y(be)}" y2="${Y(be)}" stroke-width="1.5" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/>`;
    legend += `<span class="belegend" title="この額より安く売ると赤字（今の計算の設定で）">┅ 損益分岐 ${yen(be)}（仕入れ ${yen(buyOf(p.id))}）</span>`;
  }
  for (const [o, s] of lines) {
    let path = `M${X(s[0][0])},${Y(s[0][1])}`;
    for (let i = 1; i < s.length; i++) path += `H${X(s[i][0])}V${Y(s[i][1])}`; // 階段状（価格は次の変更まで続く）
    svg += `<path d="${path}" fill="none" stroke="${shopColor(o[0])}" stroke-width="2" ${isStore(o) ? 'stroke-dasharray="5 4"' : ""} vector-effect="non-scaling-stroke"/>`;
    legend += `<span>${dot(o[0])}${esc(shortName(o[0]))}${isStore(o) ? "（来店のみ・点線）" : ""}</span>`;
  }
  box.innerHTML = svg + `</svg><div class="legend">${legend}</div>`;
}

// ---- バーコード読み取り（画面）----
// 📷 を押すとカメラで JAN（EAN-13/8・UPC-A/E）を読み、検索欄に入れて探す。1 件に決まればその商品の実利益の欄を開く。
// 読み取りはブラウザの BarcodeDetector（Android の Chrome 等）を使い、無ければ（iPhone の Safari・Windows の Chrome 等）
// ZXing を押した時だけ読み込む（普段の表示は重くしない。版を固定し、中身が変わっていないかを integrity で確かめる）。
// カメラは閉じた・読めた・画面を離れた時に必ず止める
const ZX_URL = "https://cdn.jsdelivr.net/npm/@zxing/library@0.23.0/umd/index.min.js";  // 版を変える時は index.html の CSP（script-src）も同じに直す
const ZX_SRI = "sha384-0ASr5PEWAMtTnWsn0PzKmioHVDA4+QqFiJr94io/0DCrGP6E1gRAmbO6O8y5WZW9";
const JAN_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
const scan = { gen: 0, stream: null, timer: 0, dec: null, hinted: false };
let zxLoading = null;
function loadZxing(limit = 20000) {
  if (window.ZXing && window.ZXing.MultiFormatReader) return Promise.resolve(window.ZXing);
  return (zxLoading ||= new Promise((ok, ng) => {
    const s = document.createElement("script");
    const fail = () => { zxLoading = null; clearTimeout(t); s.remove(); ng(new Error("zxing")); };
    const t = setTimeout(fail, limit);  // 通信が止まっている時に「準備中」のままにしない
    s.src = ZX_URL; s.integrity = ZX_SRI; s.crossOrigin = "anonymous"; s.referrerPolicy = "no-referrer";
    s.onload = () => { clearTimeout(t); if (window.ZXing && window.ZXing.MultiFormatReader) ok(window.ZXing); else fail(); };
    s.onerror = fail;
    document.head.append(s);
  }));
}
// 読み取り器: (video か画像) → [{text, format}]（読めなければ空）
async function nativeDecoder() {
  if (!("BarcodeDetector" in window)) return null;
  try {
    const have = await BarcodeDetector.getSupportedFormats(), fm = JAN_FORMATS.filter((f) => have.includes(f));
    if (!fm.length) return null;
    const det = new BarcodeDetector({ formats: fm });
    return async (src) => (await det.detect(src)).map((r) => ({ text: r.rawValue, format: r.format }));
  } catch { return null; }
}
function zxDecoder(Z) {
  const F = Z.BarcodeFormat, reader = new Z.MultiFormatReader();
  reader.setHints(new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E]], [Z.DecodeHintType.TRY_HARDER, true]]));
  const cv = document.createElement("canvas"), cx = cv.getContext("2d", { willReadFrequently: true });
  let n = 0;
  return async (src) => {
    const w0 = src.videoWidth || src.naturalWidth || src.width, h0 = src.videoHeight || src.naturalHeight || src.height;
    if (!w0 || !h0) return [];
    // 1 回おきに、枠のある真ん中の帯（縦 40%）と全体を読む（帯だけの方が速い。枠からずれていても全体で拾う）
    const band = n++ % 2 === 0, sh = band ? Math.round(h0 * 0.4) : h0, sy = Math.round((h0 - sh) / 2);
    const k = Math.min(1, 1000 / w0), w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(sh * k));
    cv.width = w; cv.height = h; cx.drawImage(src, 0, sy, w0, sh, 0, 0, w, h);
    const px = cx.getImageData(0, 0, w, h).data, lum = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < lum.length; i++, j += 4) lum[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
    try {
      const r = reader.decodeWithState(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(lum, w, h))));
      return [{ text: r.getText(), format: F[r.getBarcodeFormat()] }];
    } catch { return []; }
  };
}
async function getDecoder() {
  if (!scan.dec) scan.dec = (await nativeDecoder()) || zxDecoder(await loadZxing());
  return scan.dec;
}
function scanMsg(t, err = false) { const m = $("scanMsg"); m.textContent = t; m.classList.toggle("err", err); }
function camErr(e) {
  const n = (e && e.name) || "";
  if (["NotAllowedError", "SecurityError", "PermissionDeniedError"].includes(n))
    return "カメラの使用が許可されていません。ブラウザのサイトの設定でカメラを許可してから、もう一度 📷 を押してください（iPhone は「設定 → Safari → カメラ」）。下の欄に番号を入れても探せます。";
  if (["NotFoundError", "OverconstrainedError", "DevicesNotFoundError"].includes(n)) return "カメラが見つかりません。下の欄に JAN の番号を入れて探せます。";
  if (["NotReadableError", "TrackStartError", "AbortError"].includes(n)) return "カメラを開けませんでした（他のアプリが使っている可能性があります）。下の欄に番号を入れて探せます。";
  if (n === "NotSupportedError") return "このブラウザではカメラを使えません（LINE などのアプリの中で開いた時など）。Chrome や Safari で開き直すか、下の欄に番号を入れて探せます。";
  return `カメラを開けませんでした（${n || "不明なエラー"}）。下の欄に番号を入れて探せます。`;
}
// 手入力の番号の誤りの案内は、カメラの案内（scanMsg）とは別の欄に出す（同じ欄だと、打つ間に届いたカメラの
// 「枠の中に合わせて」「読めない時は…」で上書きされて消えていた。2026-09-29 再点検）
function scanManMsg(t) { const m = $("scanManMsg"); m.textContent = t || ""; m.hidden = !t; }
function scanOpen() {
  scanStop();  // 前の起動が残っていれば止める（開いたまま 📷 がもう一度押されると、前のカメラを止めずに上書きしていた）
  const gen = ++scan.gen;
  scan.hinted = false; $("scanMan").value = ""; $("scanView").hidden = true; scanManMsg("");
  scanMsg("カメラを起動しています…");
  sheetOpen($("scan"), $("scanBtn"));
  scanStart(gen);
}
async function scanStart(gen) {
  const md = navigator.mediaDevices;
  if (!window.isSecureContext) return scanMsg("この画面ではカメラを使えません（https で開いた時だけ使えます）。下の欄に JAN の番号を入れて探せます。", true);
  // https でもカメラの仕組みが無いブラウザ（アプリの中で開いた時など）は、https の案内ではなくブラウザの案内を出す
  if (!md || !md.getUserMedia) return scanMsg(camErr({ name: "NotSupportedError" }), true);
  let stream;
  try { stream = await md.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } }); }
  catch (e) { if (gen === scan.gen) scanMsg(camErr(e), true); return; }
  if (gen !== scan.gen) { stream.getTracks().forEach((t) => t.stop()); return; }  // 起動を待つ間に閉じられた
  scan.stream = stream;
  const v = $("scanVideo");
  v.srcObject = stream; $("scanView").hidden = false;
  try { await v.play(); } catch {}
  scanMsg("読み取りの準備をしています…");
  let dec;
  try { dec = await getDecoder(); }
  catch { if (gen === scan.gen) { scanStop(); scanMsg("読み取りの部品を読み込めませんでした（通信を確かめてください）。下の欄に JAN の番号を入れて探せます。", true); } return; }
  if (gen !== scan.gen) return;
  scanMsg("バーコード（JAN）を、枠の中に横向きで合わせてください");
  const t0 = Date.now();
  const tick = async () => {
    if (gen !== scan.gen) return;
    let code = null;
    if (v.readyState >= 2 && v.videoWidth) try { for (const r of await dec(v)) if ((code = janOf(r.text, r.format))) break; } catch {}
    if (gen !== scan.gen) return;
    if (code) return scanDone(code);
    if (!scan.hinted && Date.now() - t0 > 12000) { scan.hinted = true; scanMsg("読めない時は: 明るい所で、バーコードを枠いっぱいに、ピントが合うまで少し離してください。下の欄に番号を入れても探せます。"); }
    scan.timer = setTimeout(tick, 150);
  };
  tick();
}
function scanStop() {  // カメラを止める（読み取りの繰り返しも止める）
  scan.gen++; clearTimeout(scan.timer);
  if (scan.stream) scan.stream.getTracks().forEach((t) => t.stop());
  scan.stream = null;
  const v = $("scanVideo");
  if (v) { v.pause(); v.srcObject = null; }
  if ($("scanView")) $("scanView").hidden = true;
}
function scanDone(code) {
  try { if (navigator.vibrate) navigator.vibrate(60); } catch {}
  sheetClose($("scan"));
  scanSearch(code);
}
// 読んだ（入れた）番号で探す。今のカテゴリに無ければ「すべて」で探す。1 件に決まればその商品の実利益の欄を開く
async function scanSearch(code, badCheck = false) {  // badCheck = 手入力の番号の検査数字が合わない
  if (st.mvOn) setMv(false);
  $("q").value = code;
  // JAN の欄が合う商品を先に見る（名前に JAN を並べた別の商品＝店のまとめ売りの名前等だけが今のタブに当たり、
  // 本物が別のカテゴリにある時に、今のタブの別の商品を開いていた。本番の複製で 4 件。2026-09-28 独立検証）
  const jn = (s) => String(s ?? "").replace(/\D/g, "").replace(/^0+/, "");  // 頭の 0 の違い（UPC を 12 桁・13 桁で持つ店）はそろえて、全体が同じ時だけ
  const toks = parseQuery(code).strict, z = jn(code);
  const byJan = (p) => !!p.j && z.length >= 8 && jn(p.j) === z;
  const byAny = (p) => match(p, toks);
  let found = false;
  const cur = st.data[st.cat] || [];
  if (st.cat === "all") found = cur.some(byAny);
  else if (cur.some(byJan)) found = true;
  else {
    try {
      const all = await loadAll();
      if (all.some(byJan) || (!cur.some(byAny) && all.some(byAny))) { found = true; await selectCat("all"); }
      else found = cur.some(byAny);
    } catch { found = cur.some(byAny); }
  }
  if ($("q").value !== code) return;  // 待つ間に検索欄を書き換えられた
  filterRows();
  // 1 件に決まる（か、JAN の欄が合う商品が 1 つだけ）ならその商品を開く
  const exact = st.rows.filter(byJan);
  const one = st.rows.length === 1 ? st.rows[0] : exact.length === 1 ? exact[0] : null;
  if (one) openProduct(one);
  else if (!st.rows.length && typeof toast === "function")
    toast(found ? `JAN ${code} の商品は、今の絞り込み（★のみ・状態・比較する店）で隠れています`
      : `JAN ${code} の商品は見つかりませんでした${badCheck ? "（最後の桁＝検査数字が合いません。打ち間違いがないか確かめてください）" : ""}`);
}
function openProduct(p) {
  st.prof.set(p.id, true); st.open.add(p.id);
  renderList();
  const box = document.querySelector(`[data-pf-box="${p.id}"]`);
  if (!box) return;
  const row = box.closest(".prod") || box.closest("tr").previousElementSibling || box;
  row.scrollIntoView({ block: "start", behavior: scrollMotion() });
  box.querySelector("input").focus({ preventScroll: true });
  box.classList.add("flash"); setTimeout(() => box.classList.remove("flash"), 1800);
}
function scanBind() {
  $("scanBtn").onclick = scanOpen;
  $("scanForm").onsubmit = (e) => {
    e.preventDefault();
    let d = $("scanMan").value.normalize("NFKC").replace(/[\s-]/g, "");
    if (!/^\d{8,14}$/.test(d)) return scanManMsg("JAN はバーコードの下にある 8〜13 桁の数字です");
    // 8 桁で EAN-8 の検査数字が合わず、UPC-E（頭が 0/1。検査数字は広げた 12 桁で計算する）としてなら合う番号は、
    // 読み取りと同じく UPC-A に広げて探す（そのままだと「検査数字が合いません」と出て、12・13 桁で持つ店の商品に当たらない）
    if (d.length === 8 && !janCheck(d)) d = janOf(d, "upc_e") || d;
    sheetClose($("scan"));
    // 検査数字の案内は、見つからなかった時の案内に含める（先に出すと、すぐ後の「見つかりませんでした」で消えていた）
    const bad = [8, 12, 13].includes(d.length) && !janCheck(d);
    if (bad && typeof toast === "function") toast("番号の最後の桁（検査数字）が合いません。打ち間違いがないか確かめてください");
    scanSearch(d, bad);
  };
  $("scanMan").addEventListener("input", () => scanManMsg(""));
  for (const id of ["scan", "pfSet"]) $(id).addEventListener("click", (e) => { if (e.target === $(id) || e.target.closest("[data-close]")) sheetClose($(id)); });
  document.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;  // 日本語入力の変換中の Esc・Tab は変換の操作（小窓を閉じない）
    if (e.key === "Escape") {
      const open = ["scan", "pfSet", "syncSheet"].filter((id) => $(id) && !$(id).hidden);
      for (const id of open) sheetClose($(id));
      // 売り先計算（cart.js）は、上に小窓が無く、入力の位置がパネルの中（か何も無い）の時だけ閉じる（PC で後ろの検索欄の Esc では閉じない）
      const a = document.activeElement, P = $("cartPanel");
      if (!open.length && typeof cartClose === "function" && !P.hidden && (!a || a === document.body || P.contains(a))) cartClose();
    }
    else if (e.key === "Tab") sheetTrap(e);
    // 表の商品名（推移グラフ）・列見出し（店の高い順）は Enter・スペースでも押せる（以前はマウスでしか使えなかった）
    else if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches('.ptable [role="button"][tabindex], .ptable th.shop[tabindex]')) { e.preventDefault(); e.target.click(); }
  });
  addEventListener("pagehide", scanStop);
}

// ---- データの鮮度（画面）----
// 取得の予定時刻から 90 分（status.json の grace_minutes があればその分）たっても新しいデータが無ければ、画面の上に赤い帯を出す（staleInfo）。
// 開いたままの画面（スマホで前日から開いていた等）では、サーバーに新しいデータがあるかを確かめ、あれば再読み込みを勧める
const freshHours = () => { const h = st.status && st.status.schedule_hours; return Array.isArray(h) && h.length ? h : [11, 14, 17]; };
// 猶予（分）: status.json に grace_minutes があればそれ（build が kaitori/health.py の GRACE_MIN を載せれば、朝刊の生存通知と画面の判定・文言が食い違わない）、無ければ 90
const freshGrace = () => { const g = st.status && st.status.grace_minutes; return Number.isInteger(g) && g >= 10 && g <= 720 ? g : 90; };
async function freshStatus() {
  const r = await fetch(`data/status.${st.mode.encrypted ? "enc" : "json"}?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(r.status);
  noteClock(r);
  return st.mode.encrypted ? decrypt(await r.text(), st.key) : r.json();
}
async function freshCheck() {
  // 裏に回っている間は確かめない（開きっぱなしのタブで 5 分ごとに取り直し・復号し続けない。画面に戻った時に visibilitychange で確かめる）
  if (!st.status || freshCheck.busy || document.hidden) return;
  freshCheck.busy = true;
  try {
    let info = staleInfo(st.status.generated, nowMs(), freshHours(), freshGrace());
    // 前に見つけた新しいデータ（st.newer）も古くなっていれば、もう一度サーバーを見る（以前は 1 度見つけると二度と見ず、
    // 数日開きっぱなしの画面で、サーバーには新しいデータがあるのに「PC の電源を確かめて」と赤い帯を出していた。2026-09-28 独立検証）
    const newerOld = !st.newer || !!(staleInfo(st.newer, nowMs(), freshHours(), freshGrace()) || {}).stale;
    if (info && info.stale && newerOld && Date.now() - (st.freshAt || 0) > 3e5) {  // 5 分に 1 回まで
      st.freshAt = Date.now();
      try { const s = await freshStatus(); if (Date.parse(s.generated) > Date.parse(st.newer || st.status.generated)) st.newer = s.generated; } catch {}
      info = staleInfo(st.status.generated, nowMs(), freshHours(), freshGrace());  // 時計のずれを直した後でもう一度
    }
    freshRender(info);
  } finally { freshCheck.busy = false; }
}
function freshRender(info) {
  const bar = $("stale"), stale = !!(info && info.stale);
  $("updated").classList.toggle("old", stale);
  if (!stale) { bar.hidden = true; bar.innerHTML = ""; bar._html = ""; return; }
  const newer = st.newer ? staleInfo(st.newer, nowMs(), freshHours(), freshGrace()) : null;
  let cls, html;
  if (newer && !newer.stale) {
    cls = "stale newer";
    html = `<span>新しいデータがあります（最終更新 ${esc(fmtDay(st.newer))}）。この画面は前に読み込んだままです</span><button type="button" data-reload>再読み込み</button>`;
  } else {
    cls = "stale";
    html = `<b>⚠ データが古くなっています（最終更新 ${esc(fmtDay(st.newer || st.status.generated))}）</b>
      <span class="stale-sub">予定の ${esc(fmtDay(info.due).replace(/:00$/, "時"))} の取得から ${freshGrace()} 分たっても新しいデータがありません。PC の電源や定時の取得を確かめてください。</span>${st.newer ? `<button type="button" data-reload>再読み込み</button>` : ""}`;
  }
  // 1 分ごとの確認で中身が同じなら書き直さない（role="alert" なので、書き直すたびに読み上げ機能が毎分読み上げるため）
  if (!bar.hidden && bar._html === html && bar.className === cls) return;
  bar.className = cls; bar.innerHTML = html; bar._html = html;
  bar.hidden = false;
  const rb = bar.querySelector("[data-reload]");
  if (rb) rb.onclick = () => location.reload();
}

// ---- カテゴリ ----
// 検索用の文字列は、読み込んだ後の手の空いた時に 1,000 件ずつ作っておく（最初の 1 文字目の検索が重くならないように。間に合わなければ検索時に作る）
function prepIdle(d, i = 0) {
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 50));
  idle(() => { const end = Math.min(d.length, i + 1000); for (; i < end; i++) if (d[i]._h === undefined) prep(d[i]); if (i < d.length) prepIdle(d, i); });
}
async function loadCat(id) { // 商品に元のカテゴリ（k）を持たせる。お気に入り・推移グラフが使う
  if (!st.data[id]) { const d = await load(`cat_${id}`); d.forEach((p) => { p.k = id; }); st.data[id] = d; prepIdle(d); }
  return st.data[id];
}
async function selectCat(id) {
  st.cat = id; store.set("cat", id); renderCats();
  if (!st.data[id]) try {
    $("summary").textContent = "読み込み中…"; $("list").innerHTML = ""; $("table").innerHTML = "";
    if (id === "all") await loadAll();
    else await loadCat(id);
  } catch (e) { $("summary").textContent = "読み込みに失敗しました。再読み込みしてください"; return; }
  if (st.cat === id) filterRows();
}

// ---- 起動 ----
async function start(onOpen) {
  st.status = await load("status");
  // 開けた鍵はすぐ覚える（最初のカテゴリの読み込みを待たない。ログイン直後に再読み込みしても、もう一度の入力を求めないように）
  if (onOpen) onOpen();
  if (st.mode.encrypted) { $("foot").hidden = false; $("forgetPw").onclick = forget; }
  for (const s of st.status.sites) st.sites[s.id] = s;
  $("updated").textContent = "更新 " + fmtTime(st.status.generated);
  const cond = $("cond");
  cond.innerHTML = `<option value="">すべての状態</option>` +
    Object.entries(st.status.conditions).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  cond.value = "";
  $("gate").hidden = true; $("controls").hidden = false;
  st.view = store.pick("viewPc", ["rank", "table"], "table");  // PC は表が既定（スマホは常にランキング）
  $("viewSeg").querySelectorAll("button").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.view === st.view);
    b.onclick = () => {
      st.view = b.dataset.view; store.set("viewPc", st.view);
      $("viewSeg").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
      renderList();
    };
  });
  $("shopPickBtn").onclick = () => { $("shopPick").hidden = !$("shopPick").hidden; };
  $("mvBtn").onclick = () => setMv(!st.mvOn);
  scanBind(); pfSetBind();
  // データの鮮度: 開いた時・1 分ごと・画面に戻った時に確かめる。画面を離れたらカメラは止める
  st.freshAt = Date.now(); freshCheck(); setInterval(freshCheck, 6e4);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) freshCheck(); else if (!$("scan").hidden) sheetClose($("scan")); });
  renderShops(); renderShopPick();
  const cats = st.status.categories.map((c) => c.id);
  const want = store.get("cat", null);
  if (cats.length) await selectCat(cats.includes(want) ? want : "all");
  let t;
  $("q").oninput = () => { clearTimeout(t); t = setTimeout(filterRows, 200); };
  $("cond").onchange = filterRows;
  $("sort").onchange = () => { st.shopSort = null; filterRows(); };
  $("favOnly").onchange = filterRows;
  $("more").onclick = () => { st.shown += PAGE; renderList(); };
  wide.addEventListener("change", renderList);
  dark.addEventListener("change", () => { renderShops(); renderShopPick(); renderList(); });
}
(async () => {
  st.mode = await (await fetch("data/mode.json?t=" + Date.now())).json();
  if (!st.mode.encrypted) return start();
  // 覚えた鍵（IndexedDB）で開く。無ければ以前の版が localStorage に残した平文のパスワードを鍵に移す。平文は、鍵に移せても移せなくても
  // 開く前に消す（古いパスワードで開けなかった時・IndexedDB に置けない端末でも残さない。2026-09-27 多角チェック2・2026-09-29 ASTRA 指摘）
  st.key = await keyDb.get();
  let old = null;
  if (!(st.key instanceof CryptoKey)) { st.key = null; old = store.get("pw", null); }
  try { localStorage.removeItem("pw"); } catch {}
  if (typeof old === "string" && old) try { st.key = await pwKey(old); await remember(); } catch { st.key = null; }
  // 覚えた鍵で開けない（パスワードが変わった・読み込みの失敗）時は入力画面を出す。正しいパスワードを入れると鍵を置き換える
  if (st.key) { try { return await start(); } catch { st.key = null; } }
  $("gate").hidden = false;
  // 復号に要る部品（DecompressionStream・crypto.subtle）の無い古いブラウザ（Chrome 79 以前・Firefox 112 以前など）では、正しいパスワードでも開けない。
  // 「パスワードが違います」と出さず、ブラウザの案内を最初から出す（2026-09-30 再総チェック）。
  // なお iOS 16.3 以前の Safari は、この app.js（正規表現の後読み）をそもそも読めず画面が白いまま（ここには来ない）
  const oldBrowser = typeof DecompressionStream !== "function" || !(window.crypto && crypto.subtle);
  const gateErr = (e) => { e.textContent = oldBrowser ? "このブラウザでは開けません（古い版のため）。ブラウザを最新に更新するか、最新の Chrome・Edge・Firefox・Safari で開いてください" : "パスワードが違います"; e.hidden = false; };
  if (oldBrowser) gateErr($("gateErr"));
  // IndexedDB を使えない端末（非公開モード・サイトのデータを保存しない設定など）は鍵を覚えられない: 開くたびに入力する旨を小さく出す
  if (keyDb.bad) { const n = $("gateNote"); if (n) n.hidden = false; }
  let busy = false;  // 遅い端末で「表示」を 2 度押しても、開く処理は 1 回だけ
  $("gateForm").onsubmit = async (e) => {
    e.preventDefault(); if (busy) return;
    busy = true; const pw = $("pw").value; $("gateErr").hidden = true;
    try { st.key = await pwKey(pw); await start(() => remember()); $("pw").value = ""; }
    catch { st.key = null; gateErr($("gateErr")); }
    busy = false;
  };
})();
// 鍵を覚える（IndexedDB に取り出せない鍵のまま置く）。以前の版が localStorage に残した平文のパスワードは、置けても置けなくても消す。
// IndexedDB に置けない端末（非公開モード等）では覚えない＝次に開く時もパスワードを入れる（入力画面に小さく出す）。
// 以前は置けない端末だけ localStorage にパスワードそのものを平文で残していた（2026-09-29 ASTRA 指摘で廃止）
async function remember() {
  const kept = await keyDb.set(st.key);
  try { localStorage.removeItem("pw"); } catch {}
  const n = $("gateNote");  // 入力画面で案内を見ていない時（覚えられないと、開けた後で分かった時）だけ知らせる
  if (!kept && !(n && !n.hidden)) store.say("このブラウザではパスワードを覚えられないため、次に開く時もパスワードの入力が必要です");
}
// この端末に覚えたパスワード（鍵・以前の版の平文）を消して入力画面に戻る（共用の端末で見た後など。★・在庫リスト等の設定は残す）
async function forget() {
  if (!confirm("この端末に覚えたパスワードを消して、入力画面に戻りますか？\n（★・比較する店・在庫リストなどの設定はそのまま残ります）")) return;
  await keyDb.del(); try { localStorage.removeItem("pw"); } catch {}
  location.reload();
}
