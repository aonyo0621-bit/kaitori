"use strict";
// 売り先計算（カート）: 手元の在庫（商品×個数）を、どの店に売るのが一番得かを計算する。
// 在庫リストとパターンはこの端末（ブラウザ）に保存。別の端末へは共有リンクで渡す。
// app.js の $, st, store, esc, yen, siteName, safeUrl, loadCat, offersOf, includeStore を使う（候補は offersOf に従うので、
// 来店のみ（既定）・桁違いの疑い・価格が不安定（o[10]。2026-09-29）の価格は候補にならない）。
// 実利益（仕入れ値・計算の設定）は app.js の buyOf, setBuy, parseYen, profitSet, planProfit, shipOf, signYen, pctTxt, pfCls, profitSync, num を、
// 計算する時・描く時・入力した時にだけ使う（読み込みの時には使わない。tests/cart_*_check.js は app.js 無しで cart.js を読む。
// profitSet が無ければ pfRule が 送料 0・減額 0 を返す）。
// 計算の核（candidatesOf / cartSolve / resultOf）は tests/cart_solver_check.js が総当たりと突き合わせる。

// 端末に保存した値・共有リンクの中身は、使える形だけ残す（壊れた値・古い版の形・"__proto__" 等の名前で
// 売り先計算が「計算中…」のまま開けなくならないように。2026-09-27 多角チェック1）
const MAX_Q = 9999;  // 1 商品の個数の上限（共有リンクの 1e400 等で合計が ∞ にならないように）
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clampQ = (q) => { q = Math.floor(+q); return q >= 1 ? Math.min(q, MAX_Q) : 1; };
function cleanItem(x) {
  if (!isObj(x) || typeof x.id !== "string" || !x.id) return null;
  return { id: x.id, k: typeof x.k === "string" ? x.k : "", n: typeof x.n === "string" ? x.n : x.id, c: typeof x.c === "string" ? x.c : "", q: clampQ(x.q) };
}
const cleanItems = (v) => (Array.isArray(v) ? v.map(cleanItem).filter(Boolean) : []);
function cleanPatterns(v) {  // プロトタイプ無し（名前が "__proto__" でも普通の名前として扱う）
  const out = Object.create(null);
  if (isObj(v)) for (const [n, x] of Object.entries(v)) if (isObj(x) && Array.isArray(x.items)) out[n] = { items: cleanItems(x.items), saved: typeof x.saved === "string" ? x.saved : "" };
  return out;
}
function cleanFees(v) {
  const out = Object.create(null), num = (x) => Math.round(Math.max(0, +x || 0));   // 1 円単位（小数は丸める。金額はすべて整数の円）
  if (isObj(v)) for (const [s, f] of Object.entries(v)) if (isObj(f)) out[s] = { ship: num(f.ship), free: num(f.free), fee: num(f.fee) };
  return out;
}
const cart = {
  items: cleanItems(store.get("cart", [])),      // [{id, k, n, c, q}]  id=商品の固定番号 k=カテゴリ n=名前 c=状態 q=個数
  name: (typeof store.get("cartName", "") === "string" && store.get("cartName", "")) || "",   // 今のリストが属するパターン名（未保存なら空）
  patterns: cleanPatterns(store.get("patterns", {})), // {名前: {items, saved}}
  fees: cleanFees(store.get("fees", {})),       // {店ID: {ship, free, fee}}
  limit: [0, 1, 2, 3].includes(store.get("cartLimit", 0)) ? store.get("cartLimit", 0) : 0,  // 店数の上限（0 = 制限なし）
  view: "best",
  last: null,  // 最後に描いた 3 つの案（仕入れ値を入れた時に、計算し直さずに実利益だけ書き直す）
};
const cartSave = () => { store.set("cart", cart.items); store.set("cartName", cart.name); cartBadge(); };
const cartBadge = () => { $("cartCount").textContent = cart.items.reduce((n, x) => n + x.q, 0); };

// 表示は文字数に合わせて長くする（2.2 秒では「JAN … の商品は見つかりませんでした（検査数字が…）」を読み切れなかった）。
// 読み上げには、いつも画面にある見えない欄（#live・role="status"）で伝える（隠していた欄を出すのと同時に書くと読み上げられないことがあるため）
const toastMs = (msg) => Math.min(9000, Math.max(2200, 600 + String(msg).length * 90));
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  const live = $("live"); if (live) { live.textContent = ""; clearTimeout(toast.lt); toast.lt = setTimeout(() => { live.textContent = msg; }, 50); }
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, toastMs(msg));
}

function cartAdd(p) {
  const it = cart.items.find((x) => x.id === p.id);
  if (it) it.q++; else cart.items.push({ id: p.id, k: p.k, n: p.n, c: p.c, q: 1 });
  cartSave();
  toast(`在庫リストに追加: ${p.n}（${it ? it.q : 1} 個）`);
  if (!$("cartPanel").hidden) cartRender();
}

// ---- 計算 ----
// 手取り見込み ＝ 買取合計 − 査定減額 − 送料・手数料。3 つの案の額・「店数を絞る」の店の選び方・実利益（app.js の planProfit）で
// 同じ決まりを使う（2026-09-29 ASTRA 指摘: 以前は店の選び方が「店ごとの設定の無い店は送料 0・査定減額なし」で解き、
// 実利益は設定の無い店に既定の送料 800 円を 1 店ごとに引いたので、2 店に分ける案を選んで 1 店にまとめるより実利益が小さくなった）。
//   送料: 店ごとの設定（cart.fees）がある店はその設定（無料基準・手数料も）、無い店は実利益の計算の設定の買取送料（既定 800 円）
//   査定減額: 実利益の計算の設定の率（既定 5%）。1 個ごとに偶数へ丸める（app.js の profitCalc と同じ）
// 実利益の計算の設定は app.js の profitSet。app.js 無しで読む試験（tests/cart_*_check.js）では 送料 0・減額 0（店ごとの設定だけ）
const pfRule = () => (typeof profitSet === "object" && profitSet ? profitSet : { ship: 0, cut: 0 });
// 1 個の査定減額（円）。app.js の profitCalc の roundEven(買取額 × (率 / 100)) と同じ式（tests/cart_solver_check.js が突き合わせる）
function cutYen(price, cut) { const x = price * (cut / 100), r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r; }
// 店へ送る 1 回分の費用の決まり {ship: 送料, free: 無料基準（0 = なし）, fee: 手数料}。設定の無い店は既定の送料だけ
function shipRule(site, fees = cart.fees, defShip = pfRule().ship) {
  const f = fees[site];
  return f ? { ship: +f.ship || 0, free: +f.free || 0, fee: +f.fee || 0 } : { ship: +defShip || 0, free: 0, fee: 0 };
}
// 店ごとの費用: 送料（無料基準以上なら 0）＋ 固定の手数料。その店に 1 品も送らなければ 0。subtotal は買取額（減額前）の合計
function feeOf(site, subtotal, fees = cart.fees, defShip = pfRule().ship) {
  if (!(subtotal > 0)) return 0;
  const f = shipRule(site, fees, defShip);
  return (f.free && subtotal >= f.free ? 0 : f.ship) + f.fee;
}
// 商品の最低買取数（価格配列の 9 番目。無ければ 1）。カートの個数がこれ未満の価格は売れないので候補にしない
const minQty = (o) => Math.max(1, +o[8] || 1);
// 1 行（商品×個数）の候補: allowed の店ごとに最高の 1 価格。来店のみ・非表示の店は offersOf に従う。
//   g = 買取額×個数（無料基準の判定に使う）、v = 査定減額を引いた額×個数（手取り見込みに入る額）
function candidatesOf(L, allowed, cut = pfRule().cut) {
  if (!L.p) return [];
  const by = {};
  for (const o of offersOf(L.p)) {
    if (!allowed.has(o[0]) || minQty(o) > L.it.q || !(o[1] > 0)) continue;   // 0 円以下の価格は候補にしない（今のデータには無い。50 円未満は取得の時に捨てている）
    if (!by[o[0]] || o[1] > by[o[0]][1]) by[o[0]] = o;
  }
  return Object.values(by).map((o) => ({ s: o[0], o, g: o[1] * L.it.q, v: (o[1] - cutYen(o[1], cut)) * L.it.q }))
    .sort((a, b) => b.v - a.v || b.g - a.g);
}
// 割り当て（行ごとの店 or null）から画面用の結果を組み立てる。
//   unsold = 売らない商品すべて。うち skipped = 候補の店はあるが、送料・手数料のほうが高いので売らないと決めた商品
function resultOf(lines, cands, assign, fees = cart.fees, defShip = pfRule().ship) {
  const by = {}, unsold = [], skipped = [];
  lines.forEach((L, i) => {
    const c = assign[i] == null ? null : cands[i].find((x) => x.s === assign[i]);
    if (c) (by[c.s] ||= []).push({ L, o: c.o, v: c.v ?? c.o[1] * L.it.q });
    else { unsold.push(L); if (cands[i] && cands[i].length) skipped.push(L); }
  });
  const shops = Object.entries(by).map(([s, rows]) => {
    const sub = rows.reduce((n, r) => n + r.o[1] * r.L.it.q, 0), val = rows.reduce((n, r) => n + r.v, 0);
    return { s, rows, sub, cut: sub - val, fee: feeOf(s, sub, fees, defShip) };
  }).sort((a, b) => b.sub - a.sub);
  const gross = shops.reduce((n, x) => n + x.sub, 0), cut = shops.reduce((n, x) => n + x.cut, 0), total = shops.reduce((n, x) => n + x.fee, 0);
  return { shops, unsold, skipped, gross, cut, fees: total, net: gross - cut - total };
}
// 各商品を（候補の中で）一番高い店へ。最高値の店が複数ある（同額の）商品は、送料・手数料の合計が一番少なくなる店の組み合わせへ送る。
// 価格の低い店へは回さない（それをするのは「店数を絞る」＝ cartSolve）。候補のある商品は必ず売る。
// （2026-10-01 ユーザーの指摘「商品ごとの最高値より店数を絞るほうが高いのはなぜ」: 以前は同額の店の中で先に出た店へ送ったので、
//   同じ買取額なのに送る店だけが増えた。実データのチェキ中心の 23 商品では 12 商品が同額で 11 店に分かれ、送料 8,800 円。
//   買取額が 100 円少ないだけの「店数を絞る」は 4 店・3,200 円で、手取りが 5,505 円多かった）
const PLAN_NODES = 50000;   // 同額の店の選び方の探索の上限（既定の送料だけなら実データの 150 商品でも届かない。無料基準を多くの店に設定した大きな在庫で届く）
function plan(lines, allowed, maxNodes = PLAN_NODES) {   // maxNodes は試験用（探索を打ち切った時の印を確かめる）
  const cands = lines.map((L) => candidatesOf(L, allowed));
  const tops = cands.map((cs) => cs.filter((c) => c.o[1] === cs[0].o[1]));
  if (tops.every((t) => t.length < 2)) return resultOf(lines, cands, tops.map((t) => (t[0] ? t[0].s : null)));
  const r = cartSolve(tops, cart.fees, 0, maxNodes, pfRule().ship, true);
  return Object.assign(resultOf(lines, cands, r.assign), { approx: r.approx });   // approx = 探索を打ち切った（送料が最小とは限らない。画面に「近似」と出す）
}
// 「商品ごとに最高値」の案。同じ条件なら計算し直さない（cartCombo と同じ考え）
function cartEach(lines, sites) {
  const key = JSON.stringify([lines.map((L) => [L.it.id, L.it.q, L.it.n, L.p ? L.p.k : null]), sites, cart.fees, pfRule().ship, pfRule().cut, includeStore, st.status.generated]);
  if (cartEach.key !== key) { cartEach.key = key; cartEach.val = plan(lines, new Set(sites)); }
  return cartEach.val;
}

// 手取り見込みが最大の割り当てを厳密に求める（分枝限定法）。
//   cands[i] = 行 i の候補 [{s: 店, g: 価格×個数, v: 査定減額を引いた額×個数}]（v の高い順。g が無ければ v と同じ）、
//   fees = {店: {ship, free, fee}}、limit = 店数上限（0 = なし）、defShip = 設定の無い店の送料（1 回分）
//   返り値 {assign: 行ごとの店 or null, net, approx}。approx は探索を maxNodes で打ち切った印（その時は「見つけた中で最良」）
// 考え方: 商品ごとに最高値の店へ送るのが上限（送料・手数料を引く前）。上限が今の最良以下になった枝は捨てる。
//   送料・手数料が 0 の店ばかりなら分岐はほぼ起きず、費用のある店があっても「費用の合計より安い差」の店だけを試すので速い。
//   店数上限があると「使っている店だけ」で残りを見積もるので、上限に届いた枝も早く切れる。
//   無料基準は買取額（g）の合計で判定し、手取りには v を足す
//   mustSell = true: 候補のある商品は必ずどこかへ送る（「売らない」を選ばない）。「商品ごとに最高値」（plan）が、同額の店だけを候補にして
//   送料・手数料の一番少ない組み合わせを求めるのに使う（limit = 0 で使う）
function cartSolve(cands, fees, limit, maxNodes = 200000, defShip = pfRule().ship, mustSell = false, eps = 1 / 1024) {
  const n = cands.length;
  const siteIdx = {}, sites = [];
  for (const cs of cands) for (const c of cs) if (!(c.s in siteIdx)) { siteIdx[c.s] = sites.length; sites.push(c.s); }
  const k = sites.length;
  const R = sites.map((s) => shipRule(s, fees, defShip));
  // 手取りが同じなら店の数が少ないほうを確実に選ぶ: 1 店ごとに 1 円に満たない費用（EPS）を足して解く。
  //   金額はすべて整数の円（価格・個数・1 個ごとに丸めた査定減額・1 円単位の送料と手数料）で、EPS × 店数 は 1 円に届かないので、手取りの大小は変えない。
  //   送料 0 円の店どうしでも、少ない店にまとまる（2026-10-01: 最後の「店を 1 つ外してみる」処理だけでは、同額の多い入力で 1 店多い答えが出た。
  //   手取りは同じ）。店は 1,000 店未満の前提（今は 19 店）。
  //   eps = 0 にすると店数の決め手なしで解く（手取りは最大・店数は最少とは限らない。「同じ手取りで店が少ない割り当てが無い」ことを
  //   確かめなくてよいので、枝を切りやすい。solveLimit が、EPS ありの探索が打ち切られた時に使う）
  const EPS = eps;
  const fixed = R.map((f) => f.fee + EPS), ship = R.map((f) => f.ship), free = R.map((f) => f.free);
  const cost = (j, g) => (g > 0 ? fixed[j] + (free[j] && g >= free[j] ? 0 : ship[j]) : 0);
  const netOf = (subG, subV) => { let t = 0; for (let j = 0; j < k; j++) if (subG[j] > 0) t += subV[j] - cost(j, subG[j]); return t; };
  // 価値の大きい商品から決める（間違った店に置いた時の損が大きく、早く枝が切れる）
  // mustSell の時は候補の少ない商品から（店が 1 つに決まる商品で使う店が先に決まり、同額の商品はその店へ寄せるだけになる）
  const order = cands.map((cs, i) => i).sort((a, b) => (mustSell ? cands[a].length - cands[b].length : 0) || (cands[b][0]?.v || 0) - (cands[a][0]?.v || 0));
  const C = order.map((i) => cands[i].map((c) => ({ j: siteIdx[c.s], v: c.v, g: c.g ?? c.v })));
  const maxv = C.map((cs) => (cs[0] ? cs[0].v : 0)), sufMax = new Float64Array(n + 1);
  for (let i = n - 1; i >= 0; i--) sufMax[i] = sufMax[i + 1] + maxv[i];
  // pot[i][j] = 行 i 以降を全部店 j に送った時の買取額の合計（無料基準に届き得るかの見積もりに使う）
  const pot = Array.from({ length: n + 1 }, () => new Float64Array(k));
  for (let i = n - 1; i >= 0; i--) { pot[i].set(pot[i + 1]); for (const c of C[i]) pot[i][c.j] += c.g; }
  const cAt = (i, j) => { for (const c of C[i]) if (c.j === j) return c; return null; };

  // 最初の最良: 商品ごとに最高値の店へ → 店数上限を超えていれば損の小さい店から外す → 外して得になる店は外す
  const cur = new Int16Array(n).fill(-1), subG = new Float64Array(k), subV = new Float64Array(k);
  const evalAssign = (a) => {
    subG.fill(0); subV.fill(0);
    for (let i = 0; i < n; i++) if (a[i] >= 0) { const c = cAt(i, a[i]); subG[a[i]] += c.g; subV[a[i]] += c.v; }
    return netOf(subG, subV);
  };
  const usedOf = (a) => { const u = new Set(); for (const j of a) if (j >= 0) u.add(j); return u; };
  const reassignWithout = (a, drop) => { // 店 drop を使わずに、各商品を残りの店の中で最高値へ
    const b = Int16Array.from(a), keep = usedOf(a); keep.delete(drop);
    for (let i = 0; i < n; i++) if (a[i] === drop) { const c = C[i].find((x) => keep.has(x.j)); b[i] = c ? c.j : -1; }
    return b;
  };
  // mustSell: 候補のある商品が「売らない」になる割り当ては採らない
  const sellable = (b) => { if (mustSell) for (let i = 0; i < n; i++) if (b[i] < 0 && C[i].length) return false; return true; };
  for (let i = 0; i < n; i++) cur[i] = C[i][0] ? C[i][0].j : -1;
  let curNet = evalAssign(cur);
  for (;;) { // 店数上限まで減らす／外したほうが得な店を外す
    const used = usedOf(cur);
    let pick = null;
    for (const j of used) {
      const b = reassignWithout(cur, j);
      if (!sellable(b)) continue;
      const v = evalAssign(b);
      if (!pick || v > pick.v) pick = { b, v };
    }
    if (pick && ((limit && used.size > limit) || pick.v > curNet)) { cur.set(pick.b); curNet = pick.v; } else break;
  }
  let best = Int16Array.from(cur), bestNet = curNet;

  // 分枝限定法
  const a = new Int16Array(n).fill(-1);
  subG.fill(0); subV.fill(0);
  let used = 0, nodes = 0, approx = false;
  const inUse = new Uint8Array(k), G = new Float64Array(k);
  const dfs = (i, curV, curFixed) => {
    if (approx) return;
    if (++nodes > maxNodes) { approx = true; return; }
    if (i === n) {
      const net = netOf(subG, subV);
      if (net > bestNet) { bestNet = net; best = Int16Array.from(a); }
      return;
    }
    // 上限（見積もり）: 残りの商品 r は、使用中の店の中の最高 a_r（無ければ 0＝売らない）に、まだ使っていない店へ送って増える分を足す。
    //   増える分は「商品ごとの (最高値 − a_r) の合計」と「店ごとの (その店へ送って増える分の合計 − その店の最低の費用) の正の分の合計
    //   （店数上限があれば残りの枠の数だけ大きい順）」の小さいほう。送料は無料基準に届き得るなら 0 とみなす。
    //   （2026-09-29: 設定の無い店にも既定の送料がかかるようにしたら、店ごとの見積もりが無いと 30 商品で探索の上限に届きやすかった）
    const capped = limit && used >= limit;
    let unavoidable = 0;
    for (let j = 0; j < k; j++) if (inUse[j] && ship[j] && !(free[j] && subG[j] + pot[i][j] >= free[j])) unavoidable += ship[j];
    // 粗い見積もり（残りは全部最高値の店へ・新しい店の費用は数えない）で切れれば、細かい見積もりは要らない
    if (!capped && curV + sufMax[i] - curFixed - unavoidable <= bestNet) return;
    let base = 0, perItem = 0;
    G.fill(0);
    for (let r = i; r < n; r++) {
      let ar = 0;
      for (const c of C[r]) if (inUse[c.j]) { ar = c.v; break; }
      base += ar;
      if (capped) continue;
      perItem += Math.max(0, maxv[r] - ar);
      for (const c of C[r]) { if (c.v <= ar) break; if (!inUse[c.j]) G[c.j] += c.v - ar; }
    }
    let gain = 0;
    if (!capped && perItem > 0) {
      const gs = [];
      for (let j = 0; j < k; j++) if (!inUse[j] && G[j] > 0) {
        const g = G[j] - fixed[j] - (free[j] && pot[i][j] >= free[j] ? 0 : ship[j]);
        if (g > 0) gs.push(g);
      }
      if (limit && gs.length > limit - used) gs.sort((x, y) => y - x).length = limit - used;
      gain = Math.min(perItem, gs.reduce((t, g) => t + g, 0));
    }
    if (curV + base + gain - curFixed - unavoidable <= bestNet) return;
    {
      // 使用中の店に一番高い候補があり、ほかの候補の店の送料がこの商品の有無で変わらなければ、その店へ送るのが最善なので枝分かれさせない。
      //   理由: どの続きの割り当てでも、この商品を使用中のその店へ移せば、買取額は減らず（一番高い）、その店の費用は増えず（もう使っている・
      //   買取額が増えて無料基準に近づくだけ）、移す元の店の費用も増えず（無料基準が無い／もう届いている／残りを全部送っても届かない）、
      //   店の数も増えない。「売らない」より良いのも同じ。
      // 同額の店どうしの入れ替えを全部試すと、商品の数だけ掛け算で枝が増える（実データの同額の多い在庫 880 通りで、打ち切り＝近似が 113 件 → 9 件。
      // 2026-10-01。最初は mustSell の時だけ使っていたが、店数を絞る計算でも総当たりと 5 万 5 千件で一致することを確かめて広げた）
      let dom = null;
      for (const c of C[i]) if (inUse[c.j]) { dom = c; break; }
      if (dom && dom.v === C[i][0].v && C[i].every((c) => c === dom || !free[c.j] || subG[c.j] >= free[c.j] || subG[c.j] + pot[i][c.j] < free[c.j])) {
        a[i] = dom.j; subG[dom.j] += dom.g; subV[dom.j] += dom.v;
        dfs(i + 1, curV + dom.v, curFixed);
        subG[dom.j] -= dom.g; subV[dom.j] -= dom.v; a[i] = -1;
        return;
      }
    }
    for (const c of C[i]) {
      const fresh = !inUse[c.j];
      if (fresh && capped) continue;
      a[i] = c.j; subG[c.j] += c.g; subV[c.j] += c.v;
      if (fresh) { inUse[c.j] = 1; used++; }
      dfs(i + 1, curV + c.v, curFixed + (fresh ? fixed[c.j] : 0));
      subG[c.j] -= c.g; subV[c.j] -= c.v; if (fresh) { inUse[c.j] = 0; used--; }
    }
    a[i] = -1;
    if (!(mustSell && C[i].length)) dfs(i + 1, curV, curFixed); // 売らない（費用のほうが高い時だけ意味がある。mustSell では候補の無い商品だけ）
  };
  dfs(0, 0, 0);
  // 同じ手取りなら店の数が少ないほうを選ぶ
  for (;;) {
    let done = true;
    for (const j of usedOf(best)) {
      const b = reassignWithout(best, j);
      if (!sellable(b)) continue;
      const v = evalAssign(b);
      if (v >= bestNet) { best = b; bestNet = v; done = false; break; }   // bestNet も更新する（打ち切りの時は、店を外すと手取りが増えることがある）
    }
    if (done) break;
  }
  const assign = new Array(n).fill(null);
  order.forEach((i, pos) => { assign[i] = best[pos] >= 0 ? sites[best[pos]] : null; });
  return { assign, net: Math.round(bestNet + EPS * usedOf(best).size), approx, nodes };   // EPS の分を戻した、整数の手取り
}
// 店数の上限 L での割り当てを求める。まず「手取り最大＋店数最少」を一度に解く（EPS あり）。それが打ち切られた時は、店数の決め手なし
// （EPS = 0。枝を切りやすい）でも解く: そちらが打ち切られなければ、手取りは最大と分かる（店数は最少とは限らない）＝近似ではない。
// 両方打ち切りなら近似（approx）。
// （2026-10-01 二巡目の点検: EPS ありだけだと、無料基準を多くの店に設定した同額の多い在庫で、以前は解けた在庫が打ち切りになり、
//   手取りが 285〜1,160 円少なくなった。既定の設定の実データでは 0 件）
function solveLimit(cands, fees, limit, maxNodes, ship) {
  const a = cartSolve(cands, fees, limit, maxNodes, ship);
  if (!a.approx) return a;
  const b = cartSolve(cands, fees, limit, maxNodes, ship, false, 0);
  const used = (r) => new Set(r.assign.filter((x) => x != null)).size;
  const pick = b.net > a.net || (b.net === a.net && used(b) < used(a)) ? b : a;
  return { assign: pick.assign, net: pick.net, approx: b.approx, nodes: a.nodes + b.nodes };
}
// 店数上限つきで手取り見込みが最大の割り当て。sites が空でも結果（全部「売り先なし」）を返す
function bestCombo(lines, sites, limit, maxNodes = 200000) {   // maxNodes は試験用（探索をすぐ打ち切った時の歯止めを確かめる）
  const { ship, cut } = pfRule();
  const cands = lines.map((L) => candidatesOf(L, new Set(sites), cut));
  // ほかの案（plan の結果）を、この計算の候補（全部の店）で組み立て直す。「1 店にまとめる」案の結果は候補がその店だけなので、そのまま返すと
  // ほかの店なら売れる商品が「売り先が無い商品」に入る（二巡目の点検 低-1）
  const full = (r) => { const to = new Map(); for (const x of r.shops) for (const w of x.rows) to.set(w.L, x.s); return resultOf(lines, cands, lines.map((L) => to.get(L) ?? null), cart.fees, ship); };
  const memo = new Map();
  let others = null;   // 打ち切った時に比べる相手（最高値の案・1 店にまとめる案）。要る時に 1 回だけ作る
  const solve = (lim) => {
    if (memo.has(lim)) return memo.get(lim);
    const r = solveLimit(cands, cart.fees, lim, maxNodes, ship);
    let best = Object.assign(resultOf(lines, cands, r.assign, cart.fees, ship), { approx: r.approx });
    // 探索を打ち切った時（近似）でも、ほかの案より悪い結果は出さない（打ち切りのせいで、必ず成り立つはずの大小が逆に見えないように）。
    //   「商品ごとに最高値」の案（店数の上限に収まる時）・1 店にまとめる案・もっと少ない店数までの答えは、どれもこの上限で選べる割り当てなので、
    //   その中の最良を返す（2026-10-01 独立点検: 実データの 18 商品で「制限なし ¥751,860（近似）＜ 3 店まで ¥751,995」になった）
    if (r.approx) {
      others ||= [plan(lines, new Set(sites)), ...sites.map((x) => plan(lines, new Set([x])))].filter((e) => e.shops.length).map(full);
      const alts = [...others];
      for (const k of [3, 2, 1]) if (!lim || k < lim) alts.push(solve(k));
      for (const e of alts)
        if ((!lim || e.shops.length <= lim) && (e.net > best.net || (e.net === best.net && e.shops.length < best.shops.length))) best = e;
      best = Object.assign({}, best, { approx: true });
    }
    memo.set(lim, best);
    return best;
  };
  return solve(limit);
}
// 2 つの案の手取りの差（b − a）の内訳。手取りの差 = 買取額（査定減額後）の差 − 送料・手数料の差
function planDiff(a, b) {
  const val = (r) => r.gross - r.cut;
  return { net: b.net - a.net, val: val(b) - val(a), fees: b.fees - a.fees };
}
// 「商品ごとに最高値」と「店数を絞る」の手取りの差が、どこから来るかを文にする。差が無ければ空
// （2026-10-01 ユーザーの指摘: 最高値の案より店数を絞る案のほうが高い理由が、画面から分からなかった）
//   view = "best": 最高値の案の中に出す（絞る案のほうが多い時だけ）／"combo": 絞る案の中に出す（多い時も少ない時も）
//   「絞る」案は、安い店へ回すほかに「売らない」も選ぶ（送料のほうが高い商品・店数の上限に入らない商品）。理由の文は、どの場合にも
//   事実と合う言い方にする（2026-10-01 独立点検: 「最高値より少し安い店にまとめても…」は、売らないだけの時・店が増える時に事実と違った）
function planWhyHtml(each, combo, limit, view) {
  if (!each || !combo || !each.shops.length) return "";   // 絞る案が何も売らない（0 店）時も、理由を出す
  const d = planDiff(each, combo);
  if (!d.net || (view === "best" && d.net < 0)) return "";
  const shops = each.shops.length === combo.shops.length ? `送る店は ${each.shops.length} 店のままで` : `送る店が ${each.shops.length} 店 → ${combo.shops.length} 店になって`;
  const fee = d.fees < 0 ? `送料・手数料が ${yen(-d.fees)} 減り` : d.fees > 0 ? `送料・手数料が ${yen(d.fees)} 増え` : "送料・手数料は変わらず";
  const val = d.val < 0 ? `買取額（査定減額後）が ${yen(-d.val)} 減ります` : d.val > 0 ? `買取額（査定減額後）が ${yen(d.val)} 増えます` : "買取額は変わりません";
  const n = (combo.skipped || []).length;
  // 売らない商品: 「送料・手数料のほうが高い」とは書かない（ちょうど同額の時は事実と違う。売っても手取りが増えない、が正しい）
  const skip = n ? `${n} 商品は、${limit ? "店数の上限のため、または" : ""}送料・手数料を引くと手取りが増えないので売りません。` : "";
  if (view === "best")
    return `<div class="plannote">送料まで入れると、「店数を絞る」（${limit ? limit + " 店まで" : "店数の制限なし"}）のほうが手取りが <b>${yen(d.net)}</b> 多くなります。${shops}${fee}、${val}。${
      d.val < 0 ? "買取額が減っても、送料・手数料が減る分のほうが大きいためです。" : ""}${skip}</div>`;
  return `<div class="plannote">「商品ごとに最高値」と比べて、手取りが <b>${yen(Math.abs(d.net))} ${d.net > 0 ? "多い" : "少ない"}</b>: ${shops}${fee}、${val}。${skip}</div>`;
}
// 3 つの案のタブ。額（手取り見込み）の下に「何店に送る・送料等がいくら」を出し、手取りが一番多い案に印を付ける（3 つとも同じ額なら付けない）。
//   何も売らない案（0 店・¥0）も比べる相手に入れる（ほかの案が赤字なら、売らない案が「手取り最大」。2026-10-01 独立点検）
function tabsHtml(each, combo, single, view) {
  const nets = [each, combo, single].filter(Boolean).map((r) => r.net);
  const top = nets.length > 1 && Math.max(...nets) > Math.min(...nets) ? Math.max(...nets) : null;
  const sub = (r) => (!r ? "" : r.shops.length ? `<small>${r.shops.length} 店・送料等 ${yen(r.fees)}</small>` : (r.skipped || []).length ? `<small>どの店にも送らない</small>` : "");
  const tab = (v, label, r, amount) => `<button data-v="${v}" aria-pressed="${view === v}">${label}${r && r.net === top ? ` <span class="besttag">手取り最大</span>` : ""}<br><b>${amount}</b>${sub(r)}</button>`;
  return `<div class="tabs">${tab("best", "商品ごとに最高値", each, yen(each.net))}${tab("combo", "店数を絞る", combo, yen(combo.net))}${
    tab("single", "1店にまとめる", single, single ? yen(single.net) : "—")}</div>`;
}
// 同じ条件（商品・個数・店・送料設定・既定の送料・査定減額率・上限）なら計算し直さない（タブ切替のたびに解かない）
function cartCombo(lines, sites, limit) {
  const key = JSON.stringify([lines.map((L) => [L.it.id, L.it.q, L.it.n, L.p ? L.p.k : null]), sites, cart.fees, pfRule().ship, pfRule().cut, limit, includeStore, st.status.generated]);
  if (cartCombo.key !== key) { cartCombo.key = key; cartCombo.val = bestCombo(lines, sites, limit); }
  return cartCombo.val;
}

// ---- 画面 ----
// 商品の固定番号で探す。保存した時と今のカテゴリが違っても（多数決で変わる）見つかるよう、まず元のカテゴリ、無ければ全カテゴリを見る
async function cartLines() {
  const find = (it, cats) => { for (const k of cats) { const p = (st.data[k] || []).find((p) => p.id === it.id); if (p) return p; } return null; };
  const known = new Set(st.status.categories.map((c) => c.id));  // 今あるカテゴリだけ読む（共有リンク・古い保存値の想定外のカテゴリ名は探し直しに回す）
  await Promise.all([...new Set(cart.items.map((x) => x.k))].filter((k) => known.has(k)).map((k) => loadCat(k).catch(() => [])));
  const lines = cart.items.map((it) => ({ it, p: known.has(it.k) ? find(it, [it.k]) : null }));
  const missing = lines.filter((L) => !L.p);
  if (missing.length) {
    const all = st.status.categories.map((c) => c.id);
    await Promise.all(all.map((k) => loadCat(k).catch(() => [])));
    let moved = false;
    for (const L of missing) {
      L.p = find(L.it, all);
      if (L.p && L.p.k !== L.it.k) { L.it.k = L.p.k; moved = true; }
    }
    if (moved) cartSave();
  }
  return lines;
}
const shopIds = () => st.status.sites.filter((s) => s.enabled && !hidden.has(s.id)).map((s) => s.id); // 比較から外した店は除く

// skipWhy = 「候補の店はあるのに売らない商品」の理由の言い方（店数の上限がある案では、上限のせいで売れない商品も入る）
function planHtml(r, title, extra = "", skipWhy = "送料・手数料を引くと手取りが増えないので、この案では売らない商品") {
  let h = `<div class="res"><div class="reshead"><b>${title}</b><span class="net">手取り見込み ${yen(r.net)}</span></div>
    <div class="muted">買取合計 ${yen(r.gross)}${r.cut ? ` − 査定減額 ${pfRule().cut}% ${yen(r.cut)}` : ""}${r.fees ? ` − 送料・手数料 ${yen(r.fees)}` : ""} ・ ${r.shops.length} 店に送る</div>${extra}`;
  for (const x of r.shops) {
    h += `<div class="shopblk"><div class="shoph"><a href="${esc(safeUrl(st.sites[x.s]?.url))}" target="_blank" rel="noopener">${esc(siteName(x.s))}</a>
      <span>${yen(x.sub)}${x.fee ? ` <span class="muted">（送料等 −${yen(x.fee)}）</span>` : ""}</span></div><ul>`;
    for (const { L, o } of x.rows)
      h += `<li><a href="${esc(safeUrl(o[4]))}" target="_blank" rel="noopener">${esc(L.it.n)}</a><span>${yen(o[1])} × ${L.it.q}</span></li>`;
    h += `</ul></div>`;
  }
  const skip = new Set(r.skipped || []), none = r.unsold.filter((L) => !skip.has(L));
  if (none.length) h += `<div class="warnbox">売り先が無い商品: ${none.map((L) => esc(L.it.n)).join("、")}</div>`;
  if (skip.size) h += `<div class="warnbox">${skipWhy}: ${[...skip].map((L) => esc(L.it.n)).join("、")}</div>`;
  return h + `</div>`;
}

async function cartRender() {
  const panel = $("cartPanel");
  const lines = await cartLines();
  const sites = shopIds();
  const names = Object.keys(cart.patterns).sort();
  // option には value を付ける（無いと value は空白を詰めた文字になり、空白が 2 つ続く名前のパターンを選べず例外になった。2026-09-27 多角チェック2）
  let h =`<div class="panelhead"><b>売り先計算</b><button class="x" id="cartClose" aria-label="閉じる">×</button></div>
  <div class="pat">
    <select id="patSel" aria-label="保存したパターン"><option value="">— 保存したパターン（${names.length}） —</option>${names.map((n) => `<option value="${esc(n)}" ${n === cart.name ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
    <input id="patName" placeholder="パターン名" aria-label="パターン名" value="${esc(cart.name)}">
    <button id="patSave">保存</button><button id="patNew">新規</button><button id="patDel">削除</button><button id="patShare">共有リンク</button>
  </div>`;
  if (!cart.items.length) {
    h += `<p class="muted">在庫リストは空です。商品の「＋」を押すと追加されます。</p>`;
  } else {
    const allowed = new Set(sites);
    if (!sites.length) h += `<div class="warnbox">比較する店がすべて外されています。「比較する店」で店を選ぶと計算できます。</div>`;
    // 「商品ごとに最高値」の案を先に求める（下の表の店の名前は、この案で実際に送る店。同額の店が複数ある時は送料の少ない組み合わせ）
    const each = cartEach(lines, sites);
    const sentTo = new Map();
    for (const x of each.shops) for (const r of x.rows) sentTo.set(r.L.it.id, x.s);
    h += `<table class="inv items"><thead><tr><th>商品</th><th>個数</th><th>最高値</th><th></th></tr></thead><tbody>`;
    lines.forEach((L, i) => {
      // 最高値は計算と同じ候補（来店のみ・外した店・最低買取数の設定に従う）から出す
      const cs = candidatesOf(L, allowed), top = cs[0];
      const ties = top ? cs.filter((c) => c.o[1] === top.o[1]).length : 0;  // 最高値が同額の店の数
      const need = L.p && !top ? Math.min(...offersOf(L.p).filter((o) => allowed.has(o[0]) && o[1] > 0).map(minQty)) : Infinity; // 個数が足りないだけの時の案内（0 円の価格は数えない）
      let note = "";
      if (!L.p) note = ` <span class="err">（今はどの店も買取していない）</span>`;
      else if (!top && Number.isFinite(need)) note = ` <span class="err">（最低買取数 ${need} 個から）</span>`;
      // 比較中の店の価格が桁違いの疑い・価格が不安定のものだけ（最高値にも候補にもしない）
      else if (!top && sites.length && L.p.o.some((o) => allowed.has(o[0]) && !hidden.has(o[0]) && (o[9] === 1 || o[10] > 0)))
        note = ` <span class="err">（比較中の店は桁違いの疑い・価格が不安定の価格だけ。売り先の候補にしていません）</span>`;
      else if (!top && sites.length) note = ` <span class="err">（比較中の店には買取価格がない）</span>`;
      const b = buyOf(L.it.id);
      h += `<tr><td>${esc(L.it.n)}${note}<label class="buyin"><span>仕入れ値</span><input data-buy="${i}" type="text" inputmode="numeric" autocomplete="off" enterkeyhint="done" value="${b == null ? "" : num(b)}" placeholder="未入力" aria-label="仕入れ値（1 個・円）"><span>円/個</span></label></td>
        <td class="qty"><button data-d="-1" data-i="${i}" aria-label="1 個減らす">−</button><input data-i="${i}" type="number" min="1" value="${L.it.q}" aria-label="個数"><button data-d="1" data-i="${i}" aria-label="1 個増やす">＋</button></td>
        <td class="num">${top ? `${yen(top.o[1])}<div class="muted">${esc(siteName(sentTo.get(L.it.id) || top.s))}</div>${
          ties > 1 ? `<div class="muted tie" title="同じ最高値の店が ${ties} 店あります。「商品ごとに最高値」の案では、送料が少なくなるように、ほかの商品と同じ店にまとめます">ほか同額 ${ties - 1} 店</div>` : ""}` : "—"}</td>
        <td><button class="rm" data-i="${i}" aria-label="削除">🗑</button></td></tr>`;
    });
    h += `</tbody></table>`;
    const combo = cartCombo(lines, sites, cart.limit);
    const singles = sites.map((s) => ({ s, r: plan(lines, new Set([s])) })).filter((x) => x.r.shops.length)
      .sort((a, b) => b.r.net - a.r.net);
    h += tabsHtml(each, combo, singles[0] ? singles[0].r : null, cart.view);
    const P = pfRule();
    h += `<p class="muted cartnote">3 つの額はどれも手取り見込み ＝ 買取合計 − 査定減額 ${P.cut}% − 送料・手数料（下の「送料・手数料の設定」が無い店は 1 店 ${yen(P.ship)}）。3 つの案も店の選び方もこの額で比べます。送る店が多いほど送料がかさむので、買取合計が一番多い「商品ごとに最高値」より、店を絞った案のほうが手取りが多くなることがあります <button type="button" class="linkbtn" data-pfset title="査定減額率・送料・ポイント還元を変える">計算の設定</button></p>`;
    cart.last = { each, combo, singles };
    const pf = (r) => `<div id="cartProfit" class="pfsum">${cartProfitHtml(r)}</div>`;
    if (cart.view === "best") h += planHtml(each, `商品ごとに最高値の店へ（同額の店は、送料が少なくなるようにまとめる）${each.approx ? "・探索を打ち切ったため近似" : ""}`, planWhyHtml(each, combo, cart.limit, "best") + pf(each));
    if (cart.view === "combo") {
      h += `<div class="row">送る店の数: ${[1, 2, 3, 0].map((k) => `<label class="chk"><input type="radio" name="lim" value="${k}" ${cart.limit === k ? "checked" : ""}>${k ? k + " 店まで" : "制限なし"}</label>`).join(" ")}</div>`;
      h += planHtml(combo, `手取り見込みが最大の組み合わせ（${cart.limit ? cart.limit + " 店まで" : "店数の制限なし"}）${combo.approx ? "・探索を打ち切ったため近似" : ""}`, planWhyHtml(each, combo, cart.limit, "combo") + pf(combo),
        cart.limit ? `送る店を ${cart.limit} 店までに絞ったため、または送料・手数料を引くと手取りが増えないため、この案では売らない商品` : undefined);
    }
    if (cart.view === "single") {
      const total = cart.items.length;
      h += `<table class="inv single"><thead><tr><th>店</th><th>手取り見込み</th><th>実利益 <button type="button" class="linkbtn" data-pfset title="査定減額率・送料・ポイント還元を変える">設定</button></th><th>扱う商品</th></tr></thead><tbody>` +
        // 減額と送料は別の行に（数値の欄は折り返さないので、1 行に並べるとスマホ幅で表がはみ出した）
        singles.map(({ s, r }) => `<tr><td>${esc(siteName(s))}</td><td class="num">${yen(r.net)}${r.cut ? `<div class="muted">減額 −${yen(r.cut)}</div>` : ""}${r.fees ? `<div class="muted">送料等 −${yen(r.fees)}</div>` : ""}</td>
          <td class="num" data-pfs="${esc(s)}">${singleProfitHtml(r)}</td>
          <td>${total - r.unsold.length}/${total}${r.unsold.length ? `<div class="muted">無し: ${r.unsold.map((L) => esc(L.it.n)).join("、")}</div>` : ""}</td></tr>`).join("") + `</tbody></table>`;
    }
  }
  h += `<details class="fees"><summary>送料・手数料の設定（店ごと・この端末に保存）</summary>
    <p class="muted">送料: 自分が払う 1 回分の送料。無料基準: この金額（買取額の合計）以上なら送料 0。手数料: 振込手数料など。<br>
      手取り見込み・店の選び方・実利益のどれも、ここに何か入れた店はこの設定を使い、空の店は既定の買取送料（計算の設定・今は ${yen(pfRule().ship)}）を 1 回分引きます。店負担の店は送料に 0 と入れてください（欄を空にして、残りの欄も 0 なら設定を消します）。</p>
    <table class="inv"><thead><tr><th>店</th><th>送料</th><th>無料基準</th><th>手数料</th></tr></thead><tbody>` +
    sites.map((s) => { const f = cart.fees[s];  // 設定した店は 0 も出す（空欄＝設定なし と見分けられるように）
      return `<tr><td>${esc(siteName(s))}</td>${["ship", "free", "fee"].map((k) => `<td><input type="number" min="0" step="100" data-s="${s}" data-k="${k}" value="${f ? +f[k] || 0 : ""}" placeholder="0"></td>`).join("")}</tr>`; }).join("") +
    `</tbody></table></details>`;
  // 描き直す前に、パネルの中で入力の位置にあった部品（と送料の設定の欄の開閉）を覚え、描き直した後に同じ役の部品へ戻す
  // （2026-09-30 再総チェック: キーボードで ＋・−・案のタブ等を押すと、描き直しで入力の位置が消えて画面の頭から Tab し直しになっていた）
  const keep = cartFocusKeys(document.activeElement, panel), feesOpen = !!(panel.querySelector(".fees") || {}).open;
  panel.innerHTML = h;
  bindCart();
  if (feesOpen && panel.querySelector(".fees")) panel.querySelector(".fees").open = true;
  for (const q of keep) { const el = panel.querySelector(q); if (el && el.getClientRects().length) { el.focus({ preventScroll: true }); break; } }
}
// 入力の位置にあった部品 → 描き直した後に同じ役の部品を探すセレクタ（前から順に試す）。パネルの外・覚えなくてよい部品は []
function cartFocusKeys(a, panel) {
  if (!a || a === panel || !panel.contains(a) || typeof a.matches !== "function") return [];
  const d = a.dataset || {}, q = (k, v) => `[data-${k}="${CSS.escape(String(v))}"]`;
  if (a.id) return ["#" + CSS.escape(a.id)];
  if (a.matches(".qty button")) return [`.qty button${q("d", d.d)}${q("i", d.i)}`];
  if (a.matches(".qty input")) return [`.qty input${q("i", d.i)}`];
  // 削除（🗑）の後は、次の行（無ければ前の行）の個数の欄へ。削除ボタンには移さない（Enter を続けて押すと次の行も消えるため）
  if (a.matches("button.rm")) return [`.qty input${q("i", d.i)}`, `.qty input${q("i", +d.i - 1)}`, "#cartClose"];
  if (a.matches("input[data-buy]")) return [`input${q("buy", d.buy)}`];
  if (a.matches(".tabs button")) return [`.tabs button${q("v", d.v)}`];
  if (a.matches('input[name="lim"]')) return [`input[name="lim"][value="${CSS.escape(a.value)}"]`];
  if (a.matches(".fees input")) return [`.fees input${q("s", d.s)}${q("k", d.k)}`];
  if (a.matches(".fees summary")) return [".fees summary"];
  if (a.matches("[data-pfset]")) return ["[data-pfset]"];
  return [];
}

function bindCart() {
  const P = $("cartPanel");
  $("cartClose").onclick = cartClose;
  P.querySelectorAll(".qty button").forEach((b) => b.onclick = () => {
    const it = cart.items[+b.dataset.i]; it.q = clampQ(it.q + +b.dataset.d); cartSave(); cartRender();
  });
  // 個数・送料の欄は、打って Tab などで離れた時（change）に描き直す。描き直しは次の番に回す（change は入力の位置が次の部品へ移る前に
  // 起きるので、すぐ描き直すと移った先の部品ごと消えて入力の位置が無くなる。次の番なら移った先を cartRender が覚えて戻す。2026-09-30 再総チェック）
  P.querySelectorAll(".qty input").forEach((inp) => inp.onchange = () => {
    cart.items[+inp.dataset.i].q = clampQ(inp.value); cartSave(); cartLater(cartRender);
  });
  P.querySelectorAll("button.rm").forEach((b) => b.onclick = () => { cart.items.splice(+b.dataset.i, 1); cartSave(); cartRender(); });
  // 仕入れ値（商品 ID ごとに端末へ保存。一覧のカードの仕入れ値と共通。共有リンク・パターンには入れない）。
  // 打つたびに実利益だけ書き直す（在庫リストを描き直すと入力中の欄から外れるため）
  P.querySelectorAll("input[data-buy]").forEach((inp) => {
    const it = cart.items[+inp.dataset.buy];
    inp.oninput = () => {
      const v = parseYen(inp.value), bad = v == null && !!inp.value.trim();
      inp.classList.toggle("bad", bad);
      if (bad) return;
      setBuy(it.id, v); cartProfitRefresh();
    };
    inp.onchange = () => {
      const v = buyOf(it.id); inp.value = v == null ? "" : num(v); inp.classList.remove("bad");
      const p = st.rows.find((x) => x.id === it.id);  // 一覧に出ている同じ商品の欄も合わせる
      if (p) profitSync(p, null, false);
    };
  });
  P.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => { cart.view = b.dataset.v; cartRender(); });
  P.querySelectorAll('input[name="lim"]').forEach((r) => r.onchange = () => { cart.limit = +r.value; store.set("cartLimit", cart.limit); cartRender(); });
  P.querySelectorAll(".fees input").forEach((inp) => inp.onchange = () => {
    // 欄を空にして、その店の残りの欄も 0（か空）なら設定を消す（手取り見込み・実利益とも既定の買取送料に戻る）。
    // 0 と打った時は「店負担」として設定を残す（描き直すと設定した店は 0 と出るので、空＝設定なし と見分けられる）
    const row = [...P.querySelectorAll(".fees input")].filter((x) => x.dataset.s === inp.dataset.s);
    if (inp.value.trim() === "" && row.every((x) => x.value.trim() === "" || +x.value === 0)) delete cart.fees[inp.dataset.s];
    else { const f = (cart.fees[inp.dataset.s] ||= {}); for (const x of row) f[x.dataset.k] = Math.round(Math.max(0, +x.value || 0)); }
    store.set("fees", cart.fees); cartLater(() => cartRender().then(() => { const f = P.querySelector(".fees"); if (f) f.open = true; }));
  });
  $("patSel").onchange = () => {
    const n = $("patSel").value; if (!n) return;
    if (unsavedCart() && !confirm("今の在庫リストには保存していない変更があります。置き換えて「" + n + "」を開きますか？")) { $("patSel").value = cart.name || ""; return; }
    cart.items = JSON.parse(JSON.stringify(cart.patterns[n].items)); cart.name = n; cartSave(); cartRender();
    toast(`パターン「${n}」を呼び出しました`);
  };
  $("patSave").onclick = () => {
    const n = $("patName").value.trim(); if (!n) return toast("パターン名を入れてください");
    if (!cart.items.length) return toast("在庫リストが空です");
    if (cart.patterns[n] && n !== cart.name && !confirm(`「${n}」を上書きしますか？`)) return;
    cart.patterns[n] = { items: JSON.parse(JSON.stringify(cart.items)), saved: new Date().toISOString() };
    cart.name = n; store.set("patterns", cart.patterns); cartSave(); cartRender(); toast(`「${n}」を保存しました`);
  };
  $("patNew").onclick = () => {
    if (cart.items.length && !confirm("在庫リストを空にして新しく作りますか？（保存済みのパターンは残ります）")) return;
    cart.items = []; cart.name = ""; cartSave(); cartRender();
  };
  $("patDel").onclick = () => {
    const n = $("patSel").value || cart.name; if (!n || !cart.patterns[n]) return toast("削除するパターンを選んでください");
    if (!confirm(`パターン「${n}」を削除しますか？`)) return;
    delete cart.patterns[n]; if (cart.name === n) cart.name = ""; store.set("patterns", cart.patterns); cartSave(); cartRender();
  };
  $("patShare").onclick = async () => {
    if (!cart.items.length) return toast("在庫リストが空です");
    const data = { n: $("patName").value.trim() || "受け取ったリスト", i: cart.items.map((x) => [x.id, x.k, x.q, x.n, x.c]) };
    // 1 文字ずつの引数展開は長いリスト（数千商品）で「Maximum call stack size exceeded」になるので、区切って変換する
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x2000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
    const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const url = location.origin + location.pathname + "#cart=" + b64;
    try { await navigator.clipboard.writeText(url); toast("共有リンクをコピーしました。別の端末で開くと取り込めます"); }
    catch { prompt("このリンクをコピーして、別の端末で開いてください", url); }
  };
}

// 案（resultOf の結果）の合計の実利益 ＝ 手取り見込み − 仕入れ（ポイントを引いた額）。送料・査定減額は手取り見込みと同じ決まり
// （店ごとの設定がある店はその設定、無い店は既定の買取送料。app.js の shipOf → feeOf）なので、二重には引かない
function cartProfitHtml(r) {
  if (!r.shops.length) return "";
  const x = planProfit(r, buyOf, profitSet, shipOf), setBtn = `<button type="button" class="linkbtn" data-pfset title="査定減額率・送料・ポイント還元を変える">計算の設定</button>`;
  if (!x.ok) {
    const miss = x.missing.map((L) => esc(L.it.n));
    return `<div class="muted">実利益: 仕入れ値が未入力か 0 円の商品があります（${miss.slice(0, 3).join("、")}${miss.length > 3 ? ` ほか ${miss.length - 3} 件` : ""}）。在庫リストの「仕入れ値」に 1 円以上で入れると合計を出します ${setBtn}</div>`;
  }
  const ship = [x.def ? `設定の無い ${x.def} 店は 1 店 ${yen(profitSet.ship)}（既定）` : "", x.own ? `送料・手数料を設定した ${x.own} 店はその設定` : ""].filter(Boolean).join("、");
  return `<div class="pfhead"><span>実利益</span><b class="pf-net ${pfCls(x.net)}">${signYen(x.net)}</b><span class="pf-rate ${pfCls(x.net)}">利益率 ${pctTxt(x.rate)}</span>${setBtn}</div>
    <div class="pf-bd">買取合計 ${yen(x.gross)} − 査定減額 ${profitSet.cut}% ${yen(x.cut)} − 送料・手数料 ${yen(x.ship)} − 仕入れ ${yen(x.eff)}${x.pt ? `（ポイント ${yen(x.pt)} を引いた額）` : ""}</div>
    <div class="muted">実利益 ＝ 手取り見込み ${yen(x.gross - x.cut - x.ship)} − 仕入れ ${yen(x.eff)}。送料: ${ship}。${x.capped ? "ポイントは仕入れ値の 50% までで計算（01.商材購入 の基準と同じ上限）。" : ""}${r.unsold.length ? "売らない商品は含めていません。" : ""}</div>`;
}
function singleProfitHtml(r) {
  if (!r.shops.length) return `<span class="muted">—</span>`;
  const x = planProfit(r, buyOf, profitSet, shipOf);
  return x.ok ? `<span class="pf-net ${pfCls(x.net)}">${signYen(x.net)}</span><div class="muted">${pctTxt(x.rate)}</div>` : `<span class="muted" title="仕入れ値が未入力か 0 円の商品があります">—</span>`;
}
// 計算の設定（査定減額率・既定の送料・ポイント）を変えた時: 店の選び方と手取り見込みも変わるので、開いていれば描き直す
// （送料・手数料の設定の欄を開いていれば開いたまま）
function cartRefresh() {
  const P = $("cartPanel");
  if (P.hidden) return;   // 在庫が空（cart.last が無い）でも描き直す（送料の設定の表の店を、比較する店に合わせる。二巡目の点検 低-6）
  const open = !!(P.querySelector(".fees") || {}).open;
  cartRender().then(() => { if (open && P.querySelector(".fees")) P.querySelector(".fees").open = true; });
}
function cartProfitRefresh() {  // 仕入れ値を変えた時: 描き直さずに実利益の所だけ書き直す
  const P = $("cartPanel");
  if (P.hidden || !cart.last) return;
  const box = P.querySelector("#cartProfit");
  if (box) box.innerHTML = cartProfitHtml(cart.view === "combo" ? cart.last.combo : cart.last.each);
  P.querySelectorAll("[data-pfs]").forEach((td) => { const x = cart.last.singles.find((y) => y.s === td.dataset.pfs); if (x) td.innerHTML = singleProfitHtml(x.r); });
}

// 欄の change（Tab・マウスで離れた時）の描き直しは次の番へ。マウスのボタンを押している最中なら離した後（click の後）へ回す
// （2026-09-30 二巡目の検証: 押して離すまでの間に描き直すと押した部品が消え、打った直後の PC の 1 回目のクリック（＋・案のタブ・🗑・×）が効かなかった）
const cartLater = (f) => { if (!cartLater.down) return setTimeout(f, 0); addEventListener("pointerup", () => setTimeout(f, 0), { once: true, capture: true }); };
addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse" || e.pointerType === "pen") cartLater.down = true; }, true);
for (const t of ["pointerup", "pointercancel"]) addEventListener(t, () => { cartLater.down = false; }, true);

// 開いたら入力の位置をパネルの「×」へ、閉じたら開いたボタンへ戻す。Esc でも閉じる（app.js の keydown。上に小窓が無い時）
// （2026-09-30 再総チェック: 以前は開いても入力の位置が後ろの一覧に残り、キーボード・読み上げでは売り先計算に入れず、
//   閉じると入力の位置が消えていた。Esc でも閉じなかった）
function cartOpen() {
  const P = $("cartPanel"), was = !P.hidden;
  if (!was) { const a = document.activeElement; cartOpen.ret = a && a !== document.body && !P.contains(a) ? a : $("cartBtn"); }
  P.hidden = false; document.body.classList.add("noscroll");
  P.innerHTML = `<p class="muted">計算中…</p>`;
  cartRender().then(() => { const x = $("cartClose"); if (!was && !P.hidden && x) x.focus({ preventScroll: true }); });
}
function cartClose() {
  const P = $("cartPanel");
  if (P.hidden) return;
  const a = document.activeElement, inside = !a || a === document.body || P.contains(a);
  P.hidden = true;
  if ($("scan").hidden && $("pfSet").hidden && (!$("syncSheet") || $("syncSheet").hidden)) document.body.classList.remove("noscroll");
  const r = cartOpen.ret; cartOpen.ret = null;
  const to = r && r.isConnected && r.getClientRects().length ? r : $("cartBtn");
  if (inside && to && typeof to.focus === "function") to.focus({ preventScroll: true });
}

// 今の在庫リストに保存していない変更があるか（名前の無いリストに商品がある・呼び出したパターンと中身が違う）。
// パターンの切り替え・共有リンクの取り込みで黙って消えないように尋ねる（2026-09-28 多角チェック）
function unsavedCart() {
  if (!cart.items || !cart.items.length) return false;
  const saved = cart.name && cart.patterns[cart.name];
  if (!saved) return true;
  const sig = (xs) => JSON.stringify((xs || []).map((x) => [x.id, x.q]));
  return sig(saved.items) !== sig(cart.items);
}
// 共有リンク（#cart=...）で開かれたら、パターンとして取り込む
function cartImport() {
  const m = location.hash.match(/#cart=([\w-]+)/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const s = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0))));
    // 中身を確かめてから尋ねる（商品の形でない行は捨てる。1 件も無ければ取り込まない）
    const items = isObj(data) && Array.isArray(data.i)
      ? data.i.map((a) => (Array.isArray(a) ? cleanItem({ id: a[0], k: a[1], q: a[2], n: a[3], c: a[4] }) : null)).filter(Boolean) : [];
    if (!items.length) return toast("共有リンクに商品がありませんでした");
    const got = typeof data.n === "string" && data.n.trim() ? data.n.trim().slice(0, 100) : "受け取ったリスト";
    let n = got;
    if (cart.patterns[n]) n += `（${new Date().toLocaleDateString("ja-JP")}受取）`;
    if (!confirm(`共有されたリスト「${got}」（${items.length} 商品）をパターン「${n}」として保存し、開きますか？` +
                 (unsavedCart() ? "\n（今の在庫リストの保存していない変更は置き換わります）" : ""))) return;
    cart.items = items;
    cart.patterns[n] = { items: JSON.parse(JSON.stringify(cart.items)), saved: new Date().toISOString() };
    cart.name = n; store.set("patterns", cart.patterns); cartSave(); cartOpen();
  } catch { toast("共有リンクを読み取れませんでした"); }
}

// app.js の起動が終わったら（status が読めたら）ボタンを出す
(function waitReady() {
  if (!st.status) return setTimeout(waitReady, 300);
  $("cartBtn").hidden = false; $("cartBtn").onclick = cartOpen; cartBadge(); cartImport();
  addEventListener("hashchange", cartImport); // 開いているページに共有リンクを貼った時
})();
