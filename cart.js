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
// 在庫の表の並べ替え（2026-10-31 ユーザー「カートに入ったものを売り時などのFlag、商品名、売値価格などでソートできるようにしてほしい。」）。
// 表に出す順だけを変える（在庫の並び cart.items・共有リンク・パターンは変えない）。選んだ順はこの端末に保存
const CART_SORTS = { add: "入れた順", sell: "売り時の印（青→黄→赤）", name: "商品名の順", hi: "最高値の高い順", lo: "最高値の安い順" };
const cartSortOk = (v) => typeof v === "string" && Object.prototype.hasOwnProperty.call(CART_SORTS, v);
// 1 店で売る額の下限（2026-11-03 本人「1店舗だけ20000円とかの少額商品を売りに行くのが、嫌なの。100000円ぐらいで、バランスよく売りに行くならよいけど、
// 20000円とかでも、1000円とか差がついているなら、その店でも同じ最高値なら100000円ぐらいになるように調整したい」）。売り方ごと（郵送・持ち込み）に端末へ保存。
// 2 店以上に分ける時、どの店も買取額の合計（査定減額の前）がこの額以上。1 店だけなら見ない（行く店が 1 つなら、少額でもそこへ行くしかない）。
// 既定は 郵送 なし・持ち込み 10 万円（本人の言葉の額）。0 = なし
const MIN_OPTS = [0, 30000, 50000, 100000, 150000, 200000, 300000], MIN_DEF = { mail: 0, walk: 100000 };
function cleanMin(v) {
  const ok = (x, d) => (MIN_OPTS.includes(x) ? x : d);
  return isObj(v) ? { mail: ok(v.mail, MIN_DEF.mail), walk: ok(v.walk, MIN_DEF.walk) } : { mail: MIN_DEF.mail, walk: MIN_DEF.walk };
}
// 店を選んで比べる画面（cmpHtml）の比べる店。売り方ごと（郵送・持ち込み）に端末へ保存。CMP_MAX 店まで（スマホの幅で 1 個の価格を横に並べられる数）
const CMP_MAX = 4;
function cleanCmp(v) {
  const one = (a) => (Array.isArray(a) ? [...new Set(a.filter((s) => typeof s === "string" && s))].slice(0, CMP_MAX) : []);
  return isObj(v) ? { mail: one(v.mail), walk: one(v.walk) } : { mail: [], walk: [] };
}
const cart = {
  items: cleanItems(store.get("cart", [])),      // [{id, k, n, c, q}]  id=商品の固定番号 k=カテゴリ n=名前 c=状態 q=個数
  name: (typeof store.get("cartName", "") === "string" && store.get("cartName", "")) || "",   // 今のリストが属するパターン名（未保存なら空）
  patterns: cleanPatterns(store.get("patterns", {})), // {名前: {items, saved}}
  fees: cleanFees(store.get("fees", {})),       // {店ID: {ship, free, fee}}
  limit: [0, 1, 2, 3].includes(store.get("cartLimit", 0)) ? store.get("cartLimit", 0) : 0,  // 店数の上限（0 = 制限なし）
  min: cleanMin(store.get("cartMin", null)),   // 1 店で売る額の下限 {mail, walk}（0 = なし。MIN_OPTS）
  view: "best",
  sort: cartSortOk(store.get("cartSort", "add")) ? store.get("cartSort", "add") : "add",   // 在庫の表の並べ替え（CART_SORTS のキー）
  pick: { mail: "", walk: "" },   // 「1店にまとめる」で選んだ店（売り方ごと。この画面を開いている間だけ）
  cmp: false,   // 「店を選んで比べる」の画面を開いているか（売り先計算を閉じると戻る）
  cmpShops: cleanCmp(store.get("cartCmp", null)),   // 比べる店 {mail: [店], walk: [店]}（売り方ごと・端末に保存）
  cmpMode: { mail: "", walk: "" },   // 比べる画面の分け方（売り方ごと。"high" = 商品ごとに高い方へ・"min" = 1 店の下限を守る。空なら下限を守る方。開く・戻る・閉じると cmpReset で空に戻す）
  cmpPickOpen: false,   // 比べる店の欄を開いているか（描く時に今の画面から読む。この画面を開いている間だけ。cmpReset で畳む）
  last: null,  // 最後に描いた案（仕入れ値を入れた時に、計算し直さずに実利益だけ書き直す）
};
// 店ごとの塊の「申込メモをコピー」の中身（描くたびに作り直す。押した時に文にする＝ app.js の fmtTime は描く時に使わない）
let shopMemos = [];
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
// 手取り見込み ＝ 買取合計 − 査定減額 − 送料・手数料。どの案の額も・「店数を絞る」の店の選び方・実利益（app.js の planProfit）で
// 同じ決まりを使う（2026-09-29 ASTRA 指摘: 以前は店の選び方が「店ごとの設定の無い店は送料 0・査定減額なし」で解き、
// 実利益は設定の無い店に既定の送料 800 円を 1 店ごとに引いたので、2 店に分ける案を選んで 1 店にまとめるより実利益が小さくなった）。
//   送料: 店ごとの設定（cart.fees）がある店はその設定（無料基準・手数料も）、無い店は実利益の計算の設定の買取送料（既定 800 円）
//   査定減額: 実利益の計算の設定の率（既定 5%）。1 個ごとに偶数へ丸める（app.js の profitCalc と同じ）
// 実利益の計算の設定は app.js の profitSet。app.js 無しで読む試験（tests/cart_*_check.js）では 送料 0・減額 0（店ごとの設定だけ）
const pfRule = () => (typeof profitSet === "object" && profitSet ? profitSet : { ship: 0, cut: 0 });
// 1 個の査定減額（円）。app.js の profitCalc の roundEven(買取額 × (率 / 100)) と同じ式（tests/cart_solver_check.js が突き合わせる）
function cutYen(price, cut) { const x = price * (cut / 100), r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r; }
// 店へ送る 1 回分の費用の決まり {ship: 送料, free: 無料基準（0 = なし）, fee: 手数料}。設定の無い店は既定の送料だけ
// 持ち込み（売り方。app.js の includeStore = true）の時は送料・手数料 0（店ごとの設定も既定の買取送料も使わない。2026-10-17）。
// 店の順番（app.js の tieRank）: 手取りも店の数も同じ割り当ての中では、順番が先の店を使うほうを選ぶ（cartSolve）。app.js 無しで読む試験では 0
const NO_FEES = Object.freeze(Object.create(null));
const feesNow = () => (includeStore ? NO_FEES : cart.fees);
const shipNow = () => (includeStore ? 0 : pfRule().ship);
const cartMin = () => cart.min[includeStore ? "walk" : "mail"] || 0;   // 今の売り方の 1 店の下限（0 = なし）
// 案（resultOf の結果）で、1 店の下限に届かない店（2 店以上に分ける時だけ。1 店だけなら見ない）。[{s, sub}]（sub = 買取額の合計・減額前）
const minShortOf = (r, m = cartMin()) => (m > 0 && r.shops.length > 1 ? r.shops.filter((x) => x.sub < m).map((x) => ({ s: x.s, sub: x.sub })) : []);
const shopRank = (s) => (typeof tieRank === "function" ? tieRank(s) : 0);
const prioKey = () => (typeof prioRev === "number" ? prioRev : 0);   // 店の順番を作り直した回数（計算の使い回しの鍵に入れる）
function shipRule(site, fees = feesNow(), defShip = shipNow()) {
  const f = fees[site];
  return f ? { ship: +f.ship || 0, free: +f.free || 0, fee: +f.fee || 0 } : { ship: +defShip || 0, free: 0, fee: 0 };
}
// 店ごとの費用: 送料（無料基準以上なら 0）＋ 固定の手数料。その店に 1 品も送らなければ 0。subtotal は買取額（減額前）の合計
function feeOf(site, subtotal, fees = feesNow(), defShip = shipNow()) {
  if (!(subtotal > 0)) return 0;
  const f = shipRule(site, fees, defShip);
  return (f.free && subtotal >= f.free ? 0 : f.ship) + f.fee;
}
// 商品の最低買取数（価格配列の 9 番目。無ければ 1）。カートの個数がこれ未満の価格は売れないので候補にしない
const minQty = (o) => Math.max(1, +o[8] || 1);
// 1 行（商品×個数）の候補: allowed の店ごとに最高の 1 価格。来店のみ・非表示の店は offersOf に従う。
//   g = 買取額×個数（無料基準の判定に使う）、v = 査定減額を引いた額×個数（手取り見込みに入る額）
// 郵送の時は、店のサイトがメンテナンス中の店を候補にしない（申し込めないため。app.js の shopMaint。2026-10-25 ユーザー「おすすめで」）。
// 持ち込みでは候補にする（店頭は開いていることがあるため。案の店の名前の横に「メンテ中」の印）
const maintOff = (s) => !includeStore && typeof shopMaint === "function" && shopMaint(s);
function candidatesOf(L, allowed, cut = pfRule().cut) {
  if (!L.p) return [];
  const by = {};
  for (const o of offersOf(L.p)) {
    if (!allowed.has(o[0]) || maintOff(o[0]) || minQty(o) > L.it.q || !(o[1] > 0)) continue;   // 0 円以下の価格は候補にしない（今のデータには無い。50 円未満は取得の時に捨てている）
    if (!by[o[0]] || o[1] > by[o[0]][1]) by[o[0]] = o;
  }
  return Object.values(by).map((o) => ({ s: o[0], o, g: o[1] * L.it.q, v: (o[1] - cutYen(o[1], cut)) * L.it.q }))
    .sort((a, b) => b.v - a.v || b.g - a.g);
}
// 割り当て（行ごとの店 or null）から画面用の結果を組み立てる。
//   unsold = 売らない商品すべて。うち skipped = 候補の店はあるが、送料・手数料のほうが高いので売らないと決めた商品
function resultOf(lines, cands, assign, fees = feesNow(), defShip = shipNow()) {
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
const topsOf = (cs) => cs.filter((c) => c.o[1] === cs[0].o[1]);   // 行の送り先の候補: 最高値の店（同額なら全部）。cs は candidatesOf（先頭が最高値）
// pick = 行の候補 → 送り先の候補（既定は最高値の店。「好きな店」の案は favTops）
// minG = 1 店の下限（2026-11-03）: 同じ額の店（pick の候補）の中での回し方で、どの店も下限以上にできれば、その中で送料・手数料が一番少ない組み合わせ。
//   できなければ下限を見ずに解き、届かない店を minShort に返す（下限を守る形は「店数を絞る」＝ bestCombo が、安い店へ回す・売らないも含めて探す）
function plan(lines, allowed, maxNodes = PLAN_NODES, pick = topsOf, minG = cartMin()) {   // maxNodes は試験用（探索を打ち切った時の印を確かめる）
  const cands = lines.map((L) => candidatesOf(L, allowed));
  const tops = cands.map((cs) => (cs.length ? pick(cs) : cs));
  const done = (r, approx) => Object.assign(r, { approx, min: minG, minShort: minShortOf(r, minG) });
  if (tops.every((t) => t.length < 2)) return done(resultOf(lines, cands, tops.map((t) => (t[0] ? t[0].s : null))), false);
  let r = minG > 0 ? cartSolve(tops, feesNow(), 0, maxNodes, shipNow(), true, undefined, minG) : null, approx = !!(r && r.approx);
  if (!r || r.infeasible || r.approx) {
    // 下限なしで解く。守れない時はこの答え（届かない店を minShort に返す）。下限ありの探索を打ち切った時は比べる相手にもする: 下限なしの答えが
    // 下限を守っていれば、下限ありでもそれが最良（打ち切りで見落とさない。下限なしの探索が打ち切られていなければ近似でもない。2026-11-03 査読）
    const f = cartSolve(tops, feesNow(), 0, maxNodes, shipNow(), true);
    //   同じ手取りなら、下限なしの答えが打ち切られていない時だけ採る（打ち切った答えは店が多いことがある。2026-11-03 再査読）
    if (!minShortOf(resultOf(lines, cands, f.assign), minG).length && (!r || r.infeasible || f.net > r.net || (f.net === r.net && !f.approx))) { r = f; approx = f.approx; }
    else if (!r || r.infeasible) { r = f; approx = approx || f.approx; }
  }
  // approx = 探索を打ち切った（送料が最小とは限らない・下限を守れる回し方を見落としたかもしれない。画面に「近似」と出す）
  return done(resultOf(lines, cands, r.assign), approx);
}
// 「商品ごとに最高値」の案。同じ条件なら計算し直さない（cartCombo と同じ考え）
function cartEach(lines, sites) {
  const key = JSON.stringify([lines.map((L) => [L.it.id, L.it.q, L.it.n, L.p ? L.p.k : null]), sites, cart.fees, pfRule().ship, pfRule().cut, includeStore, cartMin(), prioKey(), st.status.generated]);
  if (cartEach.key !== key) { cartEach.key = key; cartEach.val = plan(lines, new Set(sites)); }
  return cartEach.val;
}
// 「好きな店」の案（2026-10-31 本人「郵送買取や持ち込み買取で、優先的に好きな店舗を伝えるので、それで買取額があまりかわらなかったら、
// おすすめするようにしてほしい。」）。行ごとの送り先: 最高値との差が目安（app.js の favNearOk。1 個あたり near% 以内かつ yen 円以内）の
// 店のうち、今の売り方の順位（app.js の favRank）が一番先の店。同着なら高いほう、同額なら plan と同じく送料・手数料の合計が一番少ない組み合わせ。
// 一覧の「おすすめ」（app.js の favPick）と同じ決め方。違うのは、候補の決まり（最低買取数・郵送でメンテナンス中の店を外す）と、同着・同額の店を
// 在庫全体の送料で選ぶ所だけ
const favNear = () => (typeof shopPrio === "object" && shopPrio && typeof shopPrio.near === "number" ? shopPrio.near : 0);
const favYen = () => (typeof shopPrio === "object" && shopPrio && typeof shopPrio.yen === "number" ? shopPrio.yen : 0);
function favTops(cs, near = favNear(), yen = favYen()) {
  const m = cs[0].o[1], rk = (c) => (typeof favRank === "function" ? favRank(c.s) : 0);
  const inNear = cs.filter((c) => c.o[1] === m || (near > 0 && typeof favNearOk === "function" && favNearOk(m, c.o[1], near, yen)));
  const r = Math.min(...inNear.map(rk)), pool = inNear.filter((c) => rk(c) === r), hi = Math.max(...pool.map((c) => c.o[1]));
  return pool.filter((c) => c.o[1] === hi);
}
function cartFav(lines, sites) {   // 同じ条件なら計算し直さない（cartEach と同じ。順番・差を変えると prioKey が変わる）
  const key = JSON.stringify([lines.map((L) => [L.it.id, L.it.q, L.it.n, L.p ? L.p.k : null]), sites, cart.fees, pfRule().ship, pfRule().cut, includeStore, cartMin(), prioKey(), favNear(), favYen(), st.status.generated]);
  if (cartFav.key !== key) { cartFav.key = key; cartFav.val = plan(lines, new Set(sites), PLAN_NODES, favTops); }
  return cartFav.val;
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
//   minG = 1 店の下限（2026-11-03。0 = なし）: 2 店以上を使う時は、どの店も買取額の合計（g）が minG 以上の割り当てだけを選ぶ（1 店だけなら見ない）。
//   mustSell で下限を守れる割り当てが無ければ（探索を打ち切って見つからなかった時も）{assign: null, infeasible: true}
function cartSolve(cands, fees, limit, maxNodes = 200000, defShip = shipNow(), mustSell = false, eps = 1 / 1024, minG = 0) {
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
  // 店の順番（2026-10-17 ユーザー「同じ価格の店があった時の動きがいまいち。適当に判断されているので・・・」）: さらに店ごとに、順番が先の店ほど
  //   多く（EPS / 4）× 2^−順位 を引く（順位 = 候補の店の中で 0, 1, 2…）。使う店の分を全部足しても EPS / 2 に届かないので、手取りの大小も
  //   店の数の少なさも変えず、両方が同じ割り当ての中で順番が上の店を使うほうを選ぶ（以前は先に見つかった割り当て）。2 の累乗なので
  //   「1 位＋4 位」と「2 位＋3 位」なら 1 位を含むほう（2026-10-17 独立点検: 順位に比例させた前の形では同点になり、先に見つかったほうだった）。
  //   eps = 0 の解き方では 0 になる
  const rks = sites.map(shopRank), rkUniq = [...new Set(rks)].sort((x, y) => x - y);
  const fixed = R.map((f, j) => f.fee + EPS - (EPS / 4) * 2 ** -rkUniq.indexOf(rks[j])), ship = R.map((f) => f.ship), free = R.map((f) => f.free);
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
  // 1 店の下限: 2 店以上を使う時、使う店はどれも買取額の合計（g）が MIN 以上（使う店 = g の合計が 0 より大きい店。netOf と同じ）
  const MIN = minG > 0 ? minG : 0;
  const minOk = (sg) => { if (!MIN) return true; let u = 0, low = false; for (let j = 0; j < k; j++) if (sg[j] > 0) { u++; if (sg[j] < MIN) low = true; } return u < 2 || !low; };

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
  // 下限がある時: 上の割り当てが下限を守らなければ使わない。1 店だけの割り当て（下限を見ない）はいつも選べるので、最初の最良の候補にする
  // （mustSell では、候補のある全商品をその店で売れる時だけ）。探索を打ち切った時もこの中の最良を返す。店が 1 つも無ければ上の割り当て
  // （全部売らない）が下限を守るので null にならない。mustSell で 1 店では売り切れず、下限を守る割り当ても見つからなければ null（infeasible）
  if (MIN) {
    evalAssign(best);
    if (!minOk(subG)) {
      // 守らなければ、下限に届かない店のうち買取額の一番少ない店を外し（その商品は残りの使う店の最高値へ。無ければ売らない）、守れるまで繰り返した形を
      // 候補にする（探索を打ち切った時に、1 店だけの割り当てまで下がらないように。2026-11-03 査読）
      const fix = Int16Array.from(best);
      let v = evalAssign(fix);
      while (!minOk(subG)) {
        let drop = -1;
        for (let j = 0; j < k; j++) if (subG[j] > 0 && subG[j] < MIN && (drop < 0 || subG[j] < subG[drop])) drop = j;
        if (drop < 0) break;   // minOk と同じ判定なので起きない（判定がずれても止まらなくならないように）
        fix.set(reassignWithout(fix, drop));
        v = evalAssign(fix);
      }
      best = null; bestNet = -Infinity;
      if (minOk(subG) && sellable(fix)) { best = fix; bestNet = v; }
    }
    for (let j = 0; j < k; j++) {
      const b = new Int16Array(n).fill(-1);
      let all = true;
      for (let i = 0; i < n; i++) if (cAt(i, j)) b[i] = j; else if (C[i].length) all = false;
      if (mustSell && !all) continue;
      const v = evalAssign(b);
      if (v > bestNet) { best = b; bestNet = v; }
    }
  }

  // 分枝限定法
  const a = new Int16Array(n).fill(-1);
  subG.fill(0); subV.fill(0);
  let used = 0, nodes = 0, approx = false;
  const inUse = new Uint8Array(k), G = new Float64Array(k);
  const dfs = (i, curV, curFixed) => {
    if (approx) return;
    if (++nodes > maxNodes) { approx = true; return; }
    if (i === n) {
      if (!minOk(subG)) return;   // 下限を守らない割り当ては選ばない
      const net = netOf(subG, subV);
      if (net > bestNet) { bestNet = net; best = Int16Array.from(a); }
      return;
    }
    // 下限: 2 店以上を使っていて、残りの商品を全部送っても下限に届かない店があれば、この先は下限を守れない
    if (MIN && used > 1) for (let j = 0; j < k; j++) if (inUse[j] && subG[j] + pot[i][j] < MIN) return;
    // 下限: 使用中の店があれば、まだ使っていない店のうち残りを全部送っても下限に届かない店は、この先使えない（使うと 2 店以上で下限未満）。
    //   使用中の店（1 店）が下限に届かない時は、ほかの店はどれも使えない（足すと 2 店以上になり、その店が下限未満）。
    //   使えない店は、枝分かれにも上限の見積もりにも入れない（2026-11-03: 実データの 20 商品以上で、下限ありだけ探索の打ち切りが多かった）
    const deadOn = MIN > 0 && used > 0;
    let stuck = false;
    if (deadOn) for (let j = 0; j < k; j++) if (inUse[j] && subG[j] + pot[i][j] < MIN) stuck = true;
    const dead = (j) => deadOn && !inUse[j] && (stuck || pot[i][j] < MIN);
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
      let mr = 0;   // 使える店の中の最高（候補は高い順）
      for (const c of C[r]) if (!dead(c.j)) { mr = c.v; break; }
      perItem += Math.max(0, mr - ar);
      for (const c of C[r]) { if (c.v <= ar) break; if (!inUse[c.j] && !dead(c.j)) G[c.j] += c.v - ar; }
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
      // 下限がある時は、ほかの候補の店がどれも「もう下限以上」か「残りを全部送っても下限に届かない」時だけ使う（2026-11-03）。前者はこの商品を
      //   外しても下限を割らず、後者はその店へこの商品を送る続きがどのみち下限を守れない（使用中の店がほかにあるので 2 店以上になる）。
      //   それ以外（この商品が無いと下限に届かないかもしれない店がある）は寄せると良い答えを落とすので、枝分かれさせる
      if (dom && dom.v === C[i][0].v && C[i].every((c) => c === dom || ((!free[c.j] || subG[c.j] >= free[c.j] || subG[c.j] + pot[i][c.j] < free[c.j])
        && (!MIN || subG[c.j] >= MIN || subG[c.j] + pot[i][c.j] < MIN)))) {
        a[i] = dom.j; subG[dom.j] += dom.g; subV[dom.j] += dom.v;
        dfs(i + 1, curV + dom.v, curFixed);
        subG[dom.j] -= dom.g; subV[dom.j] -= dom.v; a[i] = -1;
        return;
      }
    }
    for (const c of C[i]) {
      const fresh = !inUse[c.j];
      if (fresh && (capped || dead(c.j))) continue;
      a[i] = c.j; subG[c.j] += c.g; subV[c.j] += c.v;
      if (fresh) { inUse[c.j] = 1; used++; }
      dfs(i + 1, curV + c.v, curFixed + (fresh ? fixed[c.j] : 0));
      subG[c.j] -= c.g; subV[c.j] -= c.v; if (fresh) { inUse[c.j] = 0; used--; }
    }
    a[i] = -1;
    if (!(mustSell && C[i].length)) dfs(i + 1, curV, curFixed); // 売らない（費用のほうが高い時だけ意味がある。mustSell では候補の無い商品だけ）
  };
  dfs(0, 0, 0);
  if (!best) return { assign: null, net: -Infinity, approx, nodes, infeasible: true };   // 下限を守る割り当てが無い（mustSell の時だけ）
  // 同じ手取りなら店の数が少ないほうを選ぶ（下限を守ったまま）
  for (;;) {
    let done = true;
    for (const j of usedOf(best)) {
      const b = reassignWithout(best, j);
      if (!sellable(b)) continue;
      const v = evalAssign(b);
      if (v >= bestNet && minOk(subG)) { best = b; bestNet = v; done = false; break; }   // bestNet も更新する（打ち切りの時は、店を外すと手取りが増えることがある）
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
function solveLimit(cands, fees, limit, maxNodes, ship, minG = 0) {
  const a = cartSolve(cands, fees, limit, maxNodes, ship, false, undefined, minG);
  if (!a.approx) return a;
  const b = cartSolve(cands, fees, limit, maxNodes, ship, false, 0, minG);
  const used = (r) => new Set(r.assign.filter((x) => x != null)).size;
  const pick = b.net > a.net || (b.net === a.net && used(b) < used(a)) ? b : a;
  return { assign: pick.assign, net: pick.net, approx: b.approx, nodes: a.nodes + b.nodes };
}
// 店数上限つきで手取り見込みが最大の割り当て。sites が空でも結果（全部「売り先なし」）を返す。
// minG = 1 店の下限（2026-11-03）: 2 店以上を使うなら、どの店も買取額の合計が minG 以上（安い店へ回す・売らないも含めて、守る中で手取り最大）
function bestCombo(lines, sites, limit, maxNodes = 200000, minG = cartMin()) {   // maxNodes は試験用（探索をすぐ打ち切った時の歯止めを確かめる）
  return comboSolver(lines, sites, maxNodes, minG)(limit);
}
// 店数の上限 → 答え を覚えて返す関数（bestCombo の中身）。下限ありで打ち切った時に比べる下限なしの答えは、同じ形の関数を 1 つだけ作り、
// 上限をまたいで使い回す（以前は上限ごとに作り直し、下限ありと下限なしの両方を打ち切ると cartSolve を最大 28 回呼んだ。2026-11-03 再査読）
function comboSolver(lines, sites, maxNodes, minG) {
  const ship = shipNow(), fees = feesNow(), { cut } = pfRule();
  const cands = lines.map((L) => candidatesOf(L, new Set(sites), cut));
  // ほかの案（plan の結果）を、この計算の候補（全部の店）で組み立て直す。「1 店にまとめる」案の結果は候補がその店だけなので、そのまま返すと
  // ほかの店なら売れる商品が「売り先が無い商品」に入る（二巡目の点検 低-1）
  const full = (r) => { const to = new Map(); for (const x of r.shops) for (const w of x.rows) to.set(w.L, x.s); return resultOf(lines, cands, lines.map((L) => to.get(L) ?? null), fees, ship); };
  const memo = new Map();
  let others = null;   // 打ち切った時に比べる相手（最高値の案・1 店にまとめる案）。要る時に 1 回だけ作る
  let free = null;     // 下限なしの答えを返す関数（下限ありで打ち切った時だけ作る）
  const solve = (lim) => {
    if (memo.has(lim)) return memo.get(lim);
    const r = solveLimit(cands, fees, lim, maxNodes, ship, minG);
    let best = Object.assign(resultOf(lines, cands, r.assign, fees, ship), { approx: r.approx, min: minG, minShort: [] });
    // 探索を打ち切った時（近似）でも、ほかの案より悪い結果は出さない（打ち切りのせいで、必ず成り立つはずの大小が逆に見えないように）。
    //   「商品ごとに最高値」の案（店数の上限に収まる時）・1 店にまとめる案・もっと少ない店数までの答えは、どれもこの上限で選べる割り当てなので、
    //   その中の最良を返す（2026-10-01 独立点検: 実データの 18 商品で「制限なし ¥751,860（近似）＜ 3 店まで ¥751,995」になった）
    if (r.approx) {
      // 下限なしの答えが下限を守っていれば、比べる相手に入れる（打ち切りで見落とさない。2026-11-03 査読）
      const f = minG > 0 ? (free ||= comboSolver(lines, sites, maxNodes, 0))(lim) : null, fOk = !!f && !minShortOf(f, minG).length;
      // 下限に届かない店のある案は、比べる相手にしない（この計算は下限を守る答えだけを返す）
      others ||= [plan(lines, new Set(sites), PLAN_NODES, topsOf, minG), ...sites.map((x) => plan(lines, new Set([x]), PLAN_NODES, topsOf, minG))]
        .filter((e) => e.shops.length).map(full).filter((e) => !minShortOf(e, minG).length).map((e) => Object.assign(e, { min: minG, minShort: [] }));
      const alts = [...others];
      if (fOk) alts.push(Object.assign({}, f, { min: minG, minShort: [] }));
      for (const k of [3, 2, 1]) if (!lim || k < lim) alts.push(solve(k));
      for (const e of alts)
        if ((!lim || e.shops.length <= lim) && (e.net > best.net || (e.net === best.net && e.shops.length < best.shops.length))) best = e;
      // 下限なしの答え（打ち切っていない）と同じ手取りに届いていれば、下限ありでもそれが最大（下限なしの最大を超える割り当ては無い）なので近似ではない
      best = Object.assign({}, best, { approx: !(f && !f.approx && best.net >= f.net) });
    }
    memo.set(lim, best);
    return best;
  };
  return solve;
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
  const verb = includeStore ? "持ち込む" : "送る";   // 持ち込みは送料・手数料が 0 円なので、その話はしない
  const shops = each.shops.length === combo.shops.length ? `${verb}店は ${each.shops.length} 店のままで` : `${verb}店が ${each.shops.length} 店 → ${combo.shops.length} 店になって`;
  const fee = includeStore ? "" : d.fees < 0 ? `送料・手数料が ${yen(-d.fees)} 減り` : d.fees > 0 ? `送料・手数料が ${yen(d.fees)} 増え` : "送料・手数料は変わらず";
  const val = d.val < 0 ? `買取額（査定減額後）が ${yen(-d.val)} 減ります` : d.val > 0 ? `買取額（査定減額後）が ${yen(d.val)} 増えます` : "買取額は変わりません";
  const n = (combo.skipped || []).length;
  // 売らない商品: 「送料・手数料のほうが高い」とは書かない（ちょうど同額の時は事実と違う。売っても手取りが増えない、が正しい）。
  // 1 店の下限（2026-11-03）も売らない理由になる（持ち込みで店数の上限なしでも、下限に届かない店でしか売れない商品は売らない）
  const why = [limit && "店数の上限のため", combo.min && `1 店の下限 ${yen(combo.min)} を守るため`, !includeStore && "送料・手数料を引くと手取りが増えないので"]
    .filter(Boolean).reduce((t, x) => (t ? `${t}、または${/^\d/.test(x) ? " " : ""}${x}` : x), "");   // 数字の前は空ける
  const skip = !n ? "" : `${n} 商品は、${why || "手取りが増えないので"}売りません。`;
  const low = (each.minShort || []).length ? `「商品ごとに最高値」の案は、${each.minShort.map((y) => esc(siteName(y.s))).join("・")}が 1 店の下限に届きません。` : "";
  if (view === "best")
    return `<div class="plannote">送料まで入れると、「店数を絞る」（${limit ? limit + " 店まで" : "店数の制限なし"}）のほうが手取りが <b>${yen(d.net)}</b> 多くなります。${shops}${fee}、${val}。${
      d.val < 0 ? "買取額が減っても、送料・手数料が減る分のほうが大きいためです。" : ""}${skip}</div>`;
  return `<div class="plannote">「商品ごとに最高値」と比べて、手取りが <b>${yen(Math.abs(d.net))} ${d.net > 0 ? "多い" : "少ない"}</b>: ${shops}${fee}、${val}。${skip}${low}</div>`;
}
// 「好きな店」の案を「商品ごとに最高値」の案と比べた文: 何商品を好きな店へ回したか・手取りの差と、その内訳（買取額・送料と手数料）。
// 回した商品は「最高値より安い店へ」と「同じ最高値の別の店へ」を分けて数える。同じ最高値の店への入れ替えは、順番が先の店のほか、
// 同じ順番の店どうしで送料・店の数・店の並び（同着は店の名前順）の都合でも起きるので、理由は書かない（2026-10-31 2 回目の総チェック: 「同じ順番で送料が
// 少なくなる店」と書いていたが、送料も同じで店の名前順だけで入れ替わる場合があった）
// （2026-10-31 総チェック: 同じ最高値の店へ分けただけの商品も「最高値より少し安くても」と数えていた。買取額は 1 円も下がっていない）
function favCmpHtml(each, fav) {
  const to = new Map(), hi = new Map();   // 商品の番号で突き合わせる（どちらの案も計算を使い回すので、商品の行は別の描画のものになりうる）。hi = その商品の最高値
  for (const x of each.shops) for (const r of x.rows) { to.set(r.L.it.id, x.s); hi.set(r.L.it.id, r.o[1]); }
  let cheaper = 0, same = 0;
  for (const x of fav.shops) for (const r of x.rows) if (to.get(r.L.it.id) !== x.s) { if (r.o[1] < hi.get(r.L.it.id)) cheaper++; else same++; }
  const d = planDiff(each, fav), amt = (v) => yen(Math.abs(v));
  if (!cheaper && !same) return `<div class="muted single-cmp">どの商品も、最高値の店がそのまま好きな店です（差の範囲に、順番が先の店はありません）。「商品ごとに最高値」の案と同じです</div>`;
  const parts = [d.val && `買取額（査定減額後）が ${amt(d.val)} ${d.val < 0 ? "少ない" : "多い"}`, !includeStore && d.fees && `送料・手数料が ${amt(d.fees)} ${d.fees > 0 ? "多い" : "少ない"}`].filter(Boolean);
  const what = cheaper ? `${cheaper} 商品を、最高値より少し安くても順番が先の店へ回しました${same ? `（ほか ${same} 商品は、同じ最高値の別の店へ）` : ""}。`
    : `${same} 商品を、同じ最高値の別の店へ回しました。`;
  return `<div class="muted single-cmp">${what}${d.net
    ? `「商品ごとに最高値」の案（${yen(each.net)}）より手取りが ${d.net < 0 ? `<b class="minus">−${amt(d.net)}</b>` : `<b class="plus">+${amt(d.net)}</b>`}${parts.length ? `（${parts.join("・")}）` : ""}`
    : `「商品ごとに最高値」の案と手取りが同じ（${yen(each.net)}）`}</div>`;
}
// 「1店にまとめる」で選ぶ店: この画面で選んだ店（売り方ごと。開いている間だけ覚える）→ 今の売り方の順番の 1 位から → 手取りが一番多い店。
// 扱う商品が 1 つも無い店は選べない（singles に無い）。→ {s, r} か null
function singlePick(singles) {
  const by = new Map(singles.map((x) => [x.s, x])), mine = cart.pick[includeStore ? "walk" : "mail"];
  if (mine && by.has(mine)) return by.get(mine);
  for (const s of typeof prioList === "function" ? prioList() : []) if (by.has(s)) return by.get(s);
  return singles[0] || null;
}
// 案のタブ（すすめる差が「すすめない」でなければ「好きな店」を足して 4 つ）。額（手取り見込み）の下に「何店に送る・送料等がいくら」を出し、手取りが一番多い案に印を付ける（3 つとも同じ額なら付けない）。
//   何も売らない案（0 店・¥0）も比べる相手に入れる（ほかの案が赤字なら、売らない案が「手取り最大」。2026-10-01 独立点検）
//   single = 「1店にまとめる」で選んでいる店の案（singlePick）。持ち込みの時は「1店に持ち込む」・送料等の代わりに店の名前
//   fav = 「好きな店」の案（すすめる差が「すすめない」なら null で、タブは 3 つ）。4 つの時は 2 列×2 段（.tabs.four）
function tabsHtml(each, combo, single, view, singleShop = "", fav = null) {
  const nets = [each, combo, single, fav].filter(Boolean).map((r) => r.net);
  const top = nets.length > 1 && Math.max(...nets) > Math.min(...nets) ? Math.max(...nets) : null;
  const sub = (r) => (!r ? "" : r.shops.length ? `<small>${r.shops.length} 店${includeStore ? "" : `・送料等 ${yen(r.fees)}`}</small>` : (r.skipped || []).length ? `<small>どの店にも${includeStore ? "持ち込まない" : "送らない"}</small>` : "");
  const low = (r) => (r && r.minShort && r.minShort.length ? `<small class="minshort">下限未満 ${r.minShort.length} 店</small>` : "");   // 1 店の下限に届かない店がある案（2026-11-03）
  const tab = (v, label, r, amount, small) => `<button data-v="${v}" aria-pressed="${view === v}">${label}${r && r.net === top ? ` <span class="besttag">手取り最大</span>` : ""}<br><b>${amount}</b>${small ?? sub(r)}${low(r)}</button>`;
  return `<div class="tabs${fav ? " four" : ""}">${tab("best", "商品ごとに最高値", each, yen(each.net))}${fav ? tab("fav", "好きな店", fav, yen(fav.net)) : ""}${tab("combo", "店数を絞る", combo, yen(combo.net))}${
    tab("single", includeStore ? "1店に持ち込む" : "1店にまとめる", single, single ? yen(single.net) : "—", singleShop ? `<small>${esc(siteName(singleShop))}</small>` : undefined)}</div>`;
}
// 下限を見ない同じ案（1 店の下限の説明で比べる相手。2026-11-03）。kind = "each"（商品ごとに最高値）・"fav"（好きな店）・"combo"（店数を絞る）。
// 同じ条件なら計算し直さない（下限を変えても使い回す）。絞るは、下限ありの絞るの中で比べる下限なしの答えと同じ探索の上限（下限がある時だけ使う。2026-11-03 再査読）
function cartFree(kind, lines, sites, limit = 0) {
  const key = JSON.stringify([kind, lines.map((L) => [L.it.id, L.it.q, L.it.n, L.p ? L.p.k : null]), sites, cart.fees, pfRule().ship, pfRule().cut, limit, includeStore, prioKey(), favNear(), favYen(), st.status.generated]);
  const m = (cartFree.m ||= new Map());
  if (!m.has(key)) {
    if (m.size >= 6) m.clear();
    m.set(key, kind === "combo" ? bestCombo(lines, sites, limit, COMBO_NODES_MIN, 0) : plan(lines, new Set(sites), PLAN_NODES, kind === "fav" ? favTops : topsOf, 0));
  }
  return m.get(key);
}
// 1 店の下限の欄（今の売り方の値。郵送・持ち込みで別に覚える）と説明
function minRowHtml() {
  const M = cartMin(), walk = includeStore;
  return `<div class="row cartmin"><label for="cartMin">1 店で売る額の下限（${walk ? "持ち込み" : "郵送"}）</label><select id="cartMin">${
    MIN_OPTS.map((v) => `<option value="${v}"${v === M ? " selected" : ""}>${v ? `${v / 10000} 万円` : "なし"}</option>`).join("")}</select>${
    M ? `<div class="muted minhelp">2 店以上に分ける時、どの店も買取額の合計（査定減額の前）を ${yen(M)} 以上にします（1 店だけなら見ません）。「商品ごとに最高値」「好きな店」は、同じ額の店の中での回し方だけで合わせます。` +
      `「店数を絞る」は、少し安い店へ回す・${walk ? "持ち込まない" : "送らない"}も含めて、下限を守る中で手取りが一番多い形を選びます</div>` : ""}</div>`;
}
// 「商品ごとに最高値」「好きな店」の説明（1 店の下限）: 届かない店がある・下限のために回し方を変えた時。free = 下限を見ない同じ案を返す関数（要る時だけ解く）
function minNoteHtml(r, free) {
  const M = r.min || 0;
  if (!M) return "";
  if (r.minShort.length) return `<div class="plannote">この案（同じ額の店の中での回し方だけ）では、${r.minShort.map((y) => `${esc(siteName(y.s))}（${yen(y.sub)}）`).join("・")}が 1 店の下限 ${yen(M)} に届きません。下限を守る形は「店数を絞る」にあります</div>`;
  const f = free(), low = minShortOf(f, M);
  if (!low.length) return "";   // 下限を見なくても届いている（回し方が変わっていても、下限のためではない）
  const to = new Map();
  for (const x of f.shops) for (const w of x.rows) to.set(w.L.it.id, x.s);
  let moved = 0;
  for (const x of r.shops) for (const w of x.rows) if (to.get(w.L.it.id) !== x.s) moved++;
  const d = r.fees - f.fees, nShop = f.shops.length !== r.shops.length ? `${f.shops.length} 店 → ${r.shops.length} 店・` : "";   // 下限のために 1 店へまとめた時も出す（2026-11-03 査読）
  return `<div class="plannote">下限を見ない回し方では ${low.map((y) => `${esc(siteName(y.s))}（${yen(y.sub)}）`).join("・")}が 1 店の下限 ${yen(M)} に届かないので、同じ額の店の中で回し方を変えました（${moved} 商品の店が変わります。${nShop}買取額は同じ${
    !includeStore && d ? `・送料・手数料が ${d > 0 ? `${yen(d)} 多い` : `${yen(-d)} 少ない`}` : ""}）</div>`;
}
// 「店数を絞る」の説明（1 店の下限）: 下限を見ない組み合わせのほうが手取りが多い時、その差
function minComboNoteHtml(combo, free) {
  const M = combo.min || 0;
  if (!M) return "";
  const f = free();
  if (f.net <= combo.net) return "";
  const low = minShortOf(f, M);
  if (!low.length) return "";   // 下限なしの答えが下限を守っているのに少ないのは探索の打ち切り（近似）のためで、下限のためではない（2026-11-03 査読）
  return `<div class="plannote">1 店の下限 ${yen(M)} を守るため、下限を見ない組み合わせ（手取り ${yen(f.net)}・${f.shops.length} 店。${
    low.map((y) => `${esc(siteName(y.s))}は ${yen(y.sub)}`).join("・")}）より手取りが <b>${yen(f.net - combo.net)}</b> 少ない</div>`;
}
// 同じ条件（商品・個数・店・送料設定・既定の送料・査定減額率・上限）なら計算し直さない（タブ切替のたびに解かない）
// 下限ありの探索の上限（2026-11-03: 実データの在庫で、下限ありだけ 20 万で打ち切られ、少し上で解けることが多かった。30 商品で最遅 0.5 秒ほど）
const COMBO_NODES_MIN = 300000;
function cartCombo(lines, sites, limit) {
  const key = JSON.stringify([lines.map((L) => [L.it.id, L.it.q, L.it.n, L.p ? L.p.k : null]), sites, cart.fees, pfRule().ship, pfRule().cut, limit, includeStore, cartMin(), prioKey(), st.status.generated]);
  if (cartCombo.key !== key) { cartCombo.key = key; cartCombo.val = bestCombo(lines, sites, limit, cartMin() > 0 ? COMBO_NODES_MIN : 200000); }
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
const shopIds = () => st.status.sites.filter((s) => s.enabled && !shopOff(s.id)).map((s) => s.id); // 比べない店（外した店・持ち込みで順番の無い店）は除く

// ---- 店で申し込む手伝い（2026-10-24 ユーザー「買取サイトのカゴに入れたものを、実際の買取ショップのカゴに入れるようにすることは
// 出来ないでしょうか？」→「おすすめで」）。店のカートは店の側にあるので、比較サイトから直接は入れられない。代わりに、全店で同じ 2 つ:
// - 「商品ページを順に開く」: 1 回押すごとに次の商品のページを開く（ブラウザは 1 回の操作で 1 つのタブしか開かせないので、まとめては開けない）
// - 「申込メモをコピー」: 商品名・JAN・状態・個数・価格の一覧（店の申込欄・LINE・申込書・店頭で見せる用）
// 買取当番の行だけに出していた「カートに入れる」は、2026-10-25 ユーザー「一つだけ変えるのもおかしいので、買取当番の機能は不要です。」で外した
// （店によって違う手伝いは足さない。古いデータに o[11] が残っていても使わない）
const openLabel = (i, n) => (n === 1 ? "商品ページを開く" : `商品ページを順に開く（${i + 1}/${n}）`);
function shopActHtml(x) {
  const urls = [...new Set(x.rows.map(({ o }) => safeUrl(o[4])))].filter((u) => u !== "#");   // 同じページ（一覧のページ等）は 1 回だけ
  const mi = shopMemos.push({ s: x.s, rows: x.rows }) - 1;
  return `<div class="shopact">${urls.length ? `<a class="linkbtn opennext" href="${esc(urls[0])}" target="_blank" rel="noopener" data-urls="${esc(JSON.stringify(urls))}" data-i="0">${openLabel(0, urls.length)}</a>` : ""}<button type="button" class="linkbtn" data-memo="${mi}">申込メモをコピー</button></div>`;
}
function memoText(m) {
  const lines = m.rows.map(({ L, o }, i) => `${i + 1}. ${L.it.n}${L.p && L.p.j ? `／JAN ${L.p.j}` : ""}${o[5] ? `／${o[5]}` : ""}／${L.it.q} 点／1 点 ${o[1].toLocaleString("ja-JP")} 円`);
  const n = m.rows.reduce((a, { L }) => a + L.it.q, 0), sum = m.rows.reduce((a, { L, o }) => a + o[1] * L.it.q, 0);
  const when = typeof fmtTime === "function" && st.status.generated ? `${fmtTime(st.status.generated)} 作成の` : "";
  return `【${siteName(m.s)}】${includeStore ? "持ち込み" : "申込"}メモ（買取価格比較サイトより）\n${lines.join("\n")}\n` +
    `計 ${n} 点・買取額の合計 ${sum.toLocaleString("ja-JP")} 円（査定減額・送料を引く前。価格は比較サイトの${when}データのもので、今の価格と違うことがあります。申し込む前に店のページで確かめてください）`;
}

// skipWhy = 「候補の店はあるのに売らない商品」の理由の言い方（店数の上限がある案では、上限のせいで売れない商品も入る）
// opt.top = 商品の番号 → 最高値（「1店にまとめる」「好きな店」で、その店の価格が最高値より安い商品に差を出す）、opt.none = 売り先が無い商品の言い方
// （番号で引く: 「好きな店」の案は計算を使い回すので、案の中の商品の行は前の描画のもの。2026-10-31 試験で見つけた）
function planHtml(r, title, extra = "", skipWhy = includeStore ? "この案では売らない商品" : "送料・手数料を引くと手取りが増えないので、この案では売らない商品", opt = {}) {
  let h = `<div class="res"><div class="reshead"><b>${title}</b><span class="net">手取り見込み ${yen(r.net)}</span></div>
    <div class="muted">買取合計 ${yen(r.gross)}${r.cut ? ` − 査定減額 ${pfRule().cut}% ${yen(r.cut)}` : ""}${r.fees ? ` − 送料・手数料 ${yen(r.fees)}` : ""} ・ ${r.shops.length} 店に${includeStore ? "持ち込む" : "送る"}</div>${extra}`;
  for (const x of r.shops) {
    h += `<div class="shopblk"><div class="shoph"><a href="${esc(safeUrl(st.sites[x.s]?.url))}" target="_blank" rel="noopener">${esc(siteName(x.s))}</a>${typeof shopMaint === "function" && shopMaint(x.s) ? `<span class="storetag maint" title="店のサイトがメンテナンス中（最後に取れた時の価格のまま）。店頭で今の価格を確かめてください">メンテ中</span>` : ""}${(r.minShort || []).some((y) => y.s === x.s) ? `<span class="storetag minlow" title="1 店の下限 ${yen(r.min)} に届かない店（2 店以上に分ける時の下限）">下限未満</span>` : ""}
      <span>${yen(x.sub)}${x.fee ? ` <span class="muted">（送料等 −${yen(x.fee)}）</span>` : ""}</span></div><ul>`;
    for (const { L, o } of x.rows)
      h += `<li><a href="${esc(safeUrl(o[4]))}" target="_blank" rel="noopener">${esc(L.it.n)}</a><span>${yen(o[1])} × ${L.it.q}${
        opt.top && opt.top.get(L.it.id) > o[1] ? `<small class="gap" title="この商品の最高値 ${yen(opt.top.get(L.it.id))}">最高値より −${num(opt.top.get(L.it.id) - o[1])}</small>` : ""}</span></li>`;
    h += `</ul>${shopActHtml(x)}</div>`;
  }
  const skip = new Set(r.skipped || []), none = r.unsold.filter((L) => !skip.has(L));
  if (none.length) h += `<div class="warnbox">${opt.none || "売り先が無い商品"}: ${none.map((L) => esc(L.it.n)).join("、")}</div>`;
  if (skip.size) h += `<div class="warnbox">${skipWhy}: ${[...skip].map((L) => esc(L.it.n)).join("、")}</div>`;
  return h + `</div>`;
}

// ---- 売り時の目安（2026-10-27 ユーザー「売り先計算の直近売却在庫に保存されている商品ですが、売り時なのかを見極めたい。…直近数か月で
// 最高値付近だと売り時だとお知らせしてほしい。」）。判定は app.js の sellInfo（最高値の推移と今の最高値を比べる。比較する店・売り方に従う）。
// 値動きのデータ（moves.json）は売り先計算を開いた時に読む（mvGet）。読み込み中・読めない時は目安を出さず、そう書く
const SELL_LABEL = { high: "売り時", mid: "高値の手前", low: "下げ中", rebound: "戻り始め", flat: "横ばい" };
const SELL_TIP = {
  high: "直近の高値に近い（97% 以上）ので、売り時の目安です。この先さらに上がるかは分かりません",
  mid: "高値の 90〜97% で、高値の後の安値から 3% 以上戻っています（高値に向かって戻る途中かもしれません）。高値まで戻るのを待つか、今売るかの間です",
  low: "高値から下がったまま（高値の後の安値から 3% 以上は戻っていない）。セールなどで一時的に下がっているなら、戻るのを待つ手もあります（戻る保証は無く、新しい型の発売などで下がり続けることもあります）",
  rebound: "高値より 10% を超えて安いが、高値の後の安値から 3% 以上戻っています（戻る途中かもしれません。戻る保証はありません）",
  flat: "直近の上下が 5% 未満で、いつ売っても差は小さい",
};
let cartFeesOpen = false;   // 送料・手数料の設定の欄（.fees）を開いていれば、描き直しても開いたまま（cartRender の頭で読む）
let sellHelpOpen = false;   // 決まりの説明（details.sellhelp）を開いていれば、個数の ＋ などの描き直しでも開いたまま（10/28 recheck）
function sellOf(lines) {   // 商品の行 → sellInfo の結果。値動きのデータがまだ無ければ null
  if (typeof sellInfo !== "function" || !st.mvData) return null;
  const m = new Map();
  for (const L of lines) if (L.p) m.set(L, sellInfo(st.mvData, L.p.id, OFF, includeStore));
  return m;
}
const sellDay = (i) => { const x = new Date(Date.parse(st.mvData.t[i][0]) + 324e5); return `${x.getUTCMonth() + 1}/${x.getUTCDate()}`; };   // 日本時間の「10/14」
function sellHtml(si) {
  if (!si || si.kind === "none") return "";
  const pct = Math.round(si.r * 100), hi = `高値 ${yen(si.hi)}（${sellDay(si.hiT)}）`;
  const detail = si.kind === "flat" ? `直近 ${Math.round(si.days)} 日の上下 5% 未満`
    : si.kind === "high" ? (si.r > 1 ? `${hi}を上回る` : `${hi}の ${pct}%`)
    : (si.kind === "mid" ? `${hi}の ${pct}%` : `${hi}から −${100 - pct}%`) + (si.low && si.low < si.hi ? `・その後の安値 ${yen(si.low)}（${sellDay(si.lowT)}）` : "");   // 高値の手前も戻った元の安値を書く（2026-10-31）。高値の直後に 1 回だけ下がった時は安値が高値と同じ額になるので書かない（2026-10-31 2 回目の総チェック。sell.py の describe と同じ）
  const tip = `直近 ${Math.round(si.days)} 日（最大 90 日）の最高値の動き: 高値 ${yen(si.hi)}（${sellDay(si.hiT)}）・安値 ${yen(si.lo)}（${sellDay(si.loT)}）・今 ${yen(si.cur)}。` +
    `${SELL_TIP[si.kind]}。高値・安値は続けて 2 回以上ついた最高値（1 回だけの値・1 店だけ飛び出した値は除く）。「比較する店」と売り方に従います`;
  return `<div class="sellrow"><span class="selltag ${si.kind}" title="${esc(tip)}">${SELL_LABEL[si.kind]}</span><span class="sellnote">${esc(detail)}${
    si.short ? `（履歴 ${Math.round(si.days)} 日分）` : ""}</span></div>`;
}
// 在庫の表に出す順（lines の番号の並び）。cands[i] は lines[i] の売り先の候補（candidatesOf。先頭が最高値）、sm は sellOf の結果（無ければ null）。
// 売り時の印は信号の順（青＝売り時 → 黄＝高値の手前・横ばい → 赤＝戻り始め・下げ中 → 判定なし）で、同じ印の中は高値に近い順。
// 最高値の順は、売り先の無い商品（「—」）をどちらの向きでも最後に置く。決め手が無ければ入れた順
const SELL_RANK = { high: 0, mid: 1, flat: 2, rebound: 3, low: 4 };
function cartOrder(lines, cands, sm, key = cart.sort) {
  const top = (i) => (cands[i] && cands[i][0] ? cands[i][0].o[1] : null), none = (i) => (top(i) == null ? 1 : 0);
  const sig = (i) => { const si = sm && sm.get(lines[i]); return si && Object.prototype.hasOwnProperty.call(SELL_RANK, si.kind) ? si : null; };
  const by = {
    sell: (a, b) => { const x = sig(a), y = sig(b);
      return (x ? SELL_RANK[x.kind] : 9) - (y ? SELL_RANK[y.kind] : 9) || (x && y ? (+y.r || 0) - (+x.r || 0) : 0); },
    name: (a, b) => String(lines[a].it.n).localeCompare(String(lines[b].it.n), "ja", { numeric: true }),
    hi: (a, b) => none(a) - none(b) || (top(b) || 0) - (top(a) || 0),
    lo: (a, b) => none(a) - none(b) || (top(a) || 0) - (top(b) || 0),
  }[key];
  const idx = lines.map((_, i) => i);
  return by ? idx.sort((a, b) => by(a, b) || a - b) : idx;
}
function sellSumHtml(sm) {
  if (!sm) return typeof sellInfo !== "function" ? "" : st.mvFailed ? `<p class="muted sellhelp">売り時の目安: 値動きのデータを読み込めませんでした（再読み込みで直ることがあります）</p>`
    : `<p class="muted sellhelp">売り時の目安を読み込み中…</p>`;
  const c = { high: 0, mid: 0, low: 0, rebound: 0, flat: 0, none: 0 };
  for (const si of sm.values()) c[si.kind]++;
  const t = st.mvData.t, days = t.length ? Math.round((Date.parse(t[t.length - 1][0]) - Date.parse(t[0][0])) / 864e5) : 0;
  // 件数も印と同じ信号の色（青＝売り時・黄＝高値の手前／横ばい・赤＝下げ中。style.css の .sellhi・.sellmid・.sellstop）
  const parts = [c.high && `<b class="sellhi">売り時 ${c.high} 件</b>`,
    (c.low + c.rebound) && `<span class="sellstop">下げ中 ${c.low + c.rebound} 件${c.rebound ? `（うち戻り始め ${c.rebound}）` : ""}</span>`,
    c.mid && `<span class="sellmid">高値の手前 ${c.mid} 件</span>`, c.flat && `<span class="sellmid">横ばい ${c.flat} 件</span>`,
    c.none && `判定なし ${c.none} 件`].filter(Boolean);
  return `<details class="sellhelp"${sellHelpOpen ? " open" : ""}><summary>売り時の目安: ${parts.join("・") || "判定できる商品なし"}</summary>
    <p class="muted">各商品の今の最高値を、直近 ${days} 日（${t.length ? sellDay(0) : ""}から・最大 90 日）の最高値の動きと比べます。
    まず期間の上下が 5% 未満なら<b>横ばい</b>（いつ売っても差は小さい）。それ以外は、<b>売り時</b>＝高値の 97% 以上。それより下は向きで分けます: 高値の後の安値から 3% 以上戻っていれば、高値の 90〜97% は<b>高値の手前</b>・90% 未満は<b>戻り始め</b>、戻っていなければ<b>下げ中</b>（高値の 9 割以上でも、下がったままなら下げ中）。
    印の色は信号です: <b class="sellhi">青</b>＝売り時・<b class="sellmid">黄</b>＝高値の手前・横ばい・<b class="sellstop">赤</b>＝下げ中・戻り始め。
    高値・安値は続けて 2 回以上ついた最高値で、1 回だけの値と、2 位の店の 1.5 倍を超えて 1 店だけ飛び出した値（入力ミスの疑い）は使いません。
    <b>判定なし</b>（印の無い商品）＝今の最高値が無い・載って 1 回目・高値を決められない・今の最高値が 1 店だけ 2 位の店の 1.5 倍を超えている（入力ミスの疑い。正しい価格でも、売る時期の目安になりません）。
    過去の動きから見た目安で、この先の値上がり・値下がりは分かりません。セールで下がった価格が戻るとも限りません。PC では印にマウスを当てると、高値・安値・今の額が出ます。</p></details>`;
}

async function cartRender() {
  const panel = $("cartPanel");
  const lines = await cartLines();
  shopMemos = [];   // 申込メモは描くたびに作り直す（await の後で空にする＝描き直しが重なっても前の回の分が混ざらない）
  // 売り時の目安: 値動きのデータを初めて使う時は読み込んでから描き直す（パネルを閉じていれば描かない）
  if (cart.items.length && typeof mvGet === "function" && !st.mvData && !st.mvFailed)
    mvGet().catch(() => {}).then(() => { if (!panel.hidden) cartRender(); });
  const sm = sellOf(lines);
  // 売り時の目安・送料の設定の欄の開閉は、売り先計算の画面から読む（比べる画面の間は覚えた値のまま＝戻った時に閉じない。2026-11-03 査読）
  if (!panel.querySelector("#cmpBack")) { sellHelpOpen = !!(panel.querySelector("details.sellhelp") || {}).open; cartFeesOpen = !!(panel.querySelector(".fees") || {}).open; }
  const sites = shopIds();
  // 「店を選んで比べる」の画面（2026-11-03）。在庫が空になったら売り先計算に戻る
  if (cart.cmp && cart.items.length) {
    const keep = cartFocusKeys(document.activeElement, panel);
    // 店を選ぶ欄の開閉は今の画面から読む（toggle の知らせは後から届くので、それだけで覚えると、開いた直後に店を足した時に閉じた。2026-11-03）
    const dt = panel.querySelector("details.cmppick");
    if (dt) cart.cmpPickOpen = dt.open;
    panel.innerHTML = cmpHtml(lines, sites, sm);
    const ph = panel.querySelector(".panelhead");   // 店の名前の見出しを、パネルの頭のすぐ下に留める
    if (ph && panel.style) panel.style.setProperty("--ph", ph.offsetHeight + "px");
    bindCmp();
    for (const q of keep) { const el = panel.querySelector(q); if (el && el.getClientRects().length) { el.focus({ preventScroll: true }); break; } }
    return;
  }
  cart.cmp = false;
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
    const topPrice = new Map();   // 商品の番号 → 最高値（「1店にまとめる」「好きな店」の内訳で、送る店の価格との差を出す）
    h += sellSumHtml(sm);
    // 最高値は計算と同じ候補（来店のみ・外した店・最低買取数の設定に従う）から出す
    const cands = lines.map((L) => candidatesOf(L, allowed));
    if (lines.length > 1) h += `<div class="row cartsort"><label for="cartSort">並べ替え</label><select id="cartSort">${
      Object.entries(CART_SORTS).map(([k, v]) => `<option value="${k}"${k === cart.sort ? " selected" : ""}>${v}</option>`).join("")}</select></div>`;
    h += `<table class="inv items"><thead><tr><th>商品</th><th>個数</th><th>最高値</th><th></th></tr></thead><tbody>`;
    // 行の data-i・data-buy は在庫の並び（cart.items）の番号のまま（＋・−・🗑・仕入れ値は並べ替えても同じ商品に効く）
    cartOrder(lines, cands, sm).forEach((i) => {
      const L = lines[i], cs = cands[i], top = cs[0];
      if (top) topPrice.set(L.it.id, top.o[1]);
      const ties = top ? cs.filter((c) => c.o[1] === top.o[1]).length : 0;  // 最高値が同額の店の数
      const need = L.p && !top ? Math.min(...offersOf(L.p).filter((o) => allowed.has(o[0]) && !maintOff(o[0]) && o[1] > 0).map(minQty)) : Infinity; // 個数が足りないだけの時の案内（0 円の価格は数えない）
      let note = "";
      if (!L.p) note = ` <span class="err">（今はどの店も買取していない）</span>`;
      else if (!top && Number.isFinite(need)) note = ` <span class="err">（最低買取数 ${need} 個から）</span>`;
      else if (!top && offersOf(L.p).some((o) => allowed.has(o[0]) && maintOff(o[0]) && o[1] > 0)) note = ` <span class="err">（買い取る店のサイトがメンテナンス中。郵送の売り先にしていません）</span>`;
      // 比較中の店の価格が桁違いの疑い・価格が不安定のものだけ（最高値にも候補にもしない）
      else if (!top && sites.length && L.p.o.some((o) => allowed.has(o[0]) && !shopOff(o[0]) && (o[9] === 1 || o[10] > 0)))
        note = ` <span class="err">（比較中の店は桁違いの疑い・価格が不安定の価格だけ。売り先の候補にしていません）</span>`;
      else if (!top && sites.length) note = ` <span class="err">（比較中の店には買取価格がない）</span>`;
      const b = buyOf(L.it.id);
      h += `<tr><td>${esc(L.it.n)}${note}${sm ? sellHtml(sm.get(L)) : ""}<label class="buyin"><span>仕入れ値</span><input data-buy="${i}" type="text" inputmode="numeric" autocomplete="off" enterkeyhint="done" value="${b == null ? "" : num(b)}" placeholder="未入力" aria-label="仕入れ値（1 個・円）"><span>円/個</span></label></td>
        <td class="qty"><button data-d="-1" data-i="${i}" aria-label="1 個減らす">−</button><input data-i="${i}" type="number" min="1" value="${L.it.q}" aria-label="個数"><button data-d="1" data-i="${i}" aria-label="1 個増やす">＋</button></td>
        <td class="num">${top ? `${yen(top.o[1])}<div class="muted">${esc(siteName(sentTo.get(L.it.id) || top.s))}</div>${
          ties > 1 ? `<div class="muted tie" title="同じ最高値の店が ${ties} 店あります。「商品ごとに最高値」の案では、${includeStore ? "持ち込む店" : "送料"}が少なくなるように、ほかの商品と同じ店にまとめます（それでも同じなら「比較する店」の順番が先の店）">ほか同額 ${ties - 1} 店</div>` : ""}` : "—"}</td>
        <td><button class="rm" data-i="${i}" aria-label="削除">🗑</button></td></tr>`;
    });
    h += `</tbody></table>`;
    const maintHit = [...new Set(lines.flatMap((L) => (L.p ? offersOf(L.p).filter((o) => allowed.has(o[0]) && maintOff(o[0]) && o[1] > 0).map((o) => o[0]) : [])))];
    if (maintHit.length) h += `<div class="warnbox">店のサイトがメンテナンス中の ${maintHit.map((x) => esc(siteName(x))).join("、")} は、郵送の売り先に選んでいません（申し込めないため。価格は最後に取れた時のまま）。店のサイトが戻れば、次の取得の後に候補へ戻ります</div>`;
    const combo = cartCombo(lines, sites, cart.limit);
    const singles = sites.map((s) => ({ s, r: plan(lines, new Set([s])) })).filter((x) => x.r.shops.length)
      .sort((a, b) => b.r.net - a.r.net || shopRank(a.s) - shopRank(b.s));   // 手取りが同じなら店の順番
    const pick = singlePick(singles);
    const fav = favNear() ? cartFav(lines, sites) : null;   // 「好きな店」の案（すすめる差が「すすめない」なら出さない）
    if (cart.view === "fav" && !fav) cart.view = "best";
    const M = cartMin();
    h += minRowHtml();
    h += tabsHtml(each, combo, pick ? pick.r : null, cart.view, pick ? pick.s : "", fav);
    if (sites.length > 1) h += `<div class="row cmpopen"><button type="button" id="cmpOpen">店を選んで比べる<small>選んだ店の 1 個の価格を、商品ごとに横に並べます（店ごとの合計・1 店に全部なら・全店の最高値との差）</small></button></div>`;
    const P = pfRule();
    h += includeStore ? `<p class="muted cartnote">売り方は持ち込み（「比較する店」で切り替え）: どの案の額も手取り見込み ＝ 買取合計 − 査定減額 ${P.cut}%（送料・手数料は 0 円）。来店のみの価格も使い、持ち込みの順番を付けた店だけで比べます。同じ手取りなら、持ち込む店の少ない案・順番が先の店を選びます <button type="button" class="linkbtn" data-pfset title="査定減額率・送料・ポイント還元を変える">計算の設定</button></p>`
      : `<p class="muted cartnote">どの案の額も手取り見込み ＝ 買取合計 − 査定減額 ${P.cut}% − 送料・手数料（下の「送料・手数料の設定」が無い店は 1 店 ${yen(P.ship)}）。どの案も店の選び方もこの額で比べます。送る店が多いほど送料がかさむので、買取合計が一番多い「商品ごとに最高値」より、店を絞った案のほうが手取りが多くなることがあります。同じ手取りなら、送る店の少ない案・「比較する店」の郵送の順番が先の店を選びます <button type="button" class="linkbtn" data-pfset title="査定減額率・送料・ポイント還元を変える">計算の設定</button></p>`;
    cart.last = { each, combo, singles, pick, fav };
    const pf = (r) => `<div id="cartProfit" class="pfsum">${cartProfitHtml(r)}</div>`;
    if (cart.view === "best") h += planHtml(each, `商品ごとに最高値の店へ（同額の店は、${M ? "1 店の下限に合わせ、" : ""}${includeStore ? "持ち込む店" : "送料"}が少なくなるようにまとめる）${each.approx ? "・探索を打ち切ったため近似" : ""}`,
      minNoteHtml(each, () => cartFree("each", lines, sites)) + planWhyHtml(each, combo, cart.limit, "best") + pf(each));
    if (cart.view === "fav") h += planHtml(fav, `好きな店へ（1 個あたりの最高値との差が ${favNear()}%・${num(favYen())} 円以内なら、「比較する店」の${includeStore ? "持ち込み" : "郵送"}の順番が先の店）${fav.approx ? "・探索を打ち切ったため近似" : ""}`,
      minNoteHtml(fav, () => cartFree("fav", lines, sites)) + favCmpHtml(each, fav) + pf(fav), undefined, { top: topPrice });
    if (cart.view === "combo") {
      h += `<div class="row">${includeStore ? "持ち込む" : "送る"}店の数: ${[1, 2, 3, 0].map((k) => `<label class="chk"><input type="radio" name="lim" value="${k}" ${cart.limit === k ? "checked" : ""}>${k ? k + " 店まで" : "制限なし"}</label>`).join(" ")}</div>`;
      // 売らない理由: 店数の上限・1 店の下限（2026-11-03）。郵送ではほかに送料・手数料
      const rs = [cart.limit && `${includeStore ? "持ち込む" : "送る"}店を ${cart.limit} 店までに絞ったため`, M && `1 店の下限 ${yen(M)} を守るため`].filter(Boolean);
      h += planHtml(combo, `手取り見込みが最大の組み合わせ（${cart.limit ? cart.limit + " 店まで" : "店数の制限なし"}${M ? `・2 店以上ならどの店も ${yen(M)} 以上` : ""}）${combo.approx ? "・探索を打ち切ったため近似" : ""}`,
        minComboNoteHtml(combo, () => cartFree("combo", lines, sites, cart.limit)) + planWhyHtml(each, combo, cart.limit, "combo") + pf(combo),
        rs.length ? `${rs.join("、または ")}${includeStore ? "" : "、または送料・手数料を引くと手取りが増えないため"}、この案では売らない商品` : undefined);
    }
    if (cart.view === "single") {
      // 店を選ぶと、その店での商品ごとの価格・最高値との差・その店で売れない商品を下に出す（2026-10-17 ユーザー「少々安くなっても、
      // 1店舗で持ち込みした場合の価格が、店を選べるようにできないかな？」）。最初は今の売り方の順番の 1 位の店（singlePick）
      const total = cart.items.length, walk = includeStore, kind = walk ? "持ち込み" : "郵送";
      const rkTag = (s) => { const r = typeof favRank === "function" ? favRank(s, walk) : 0; return r >= 1 && r <= 99 ? ` <span class="prtag" title="${kind}の順番（「比較する店」で変えられます。同じ数字は同着）">${kind} ${r}</span>` : ""; };
      h += `<p class="muted cartnote">${walk ? "持ち込む" : "まとめる"}店を選ぶと、その店での商品ごとの価格を下に出します。最初に選ぶのは「比較する店」の${kind}の順番の 1 位の店です（順番が無ければ手取りが一番多い店）。</p>`;
      h += `<table class="inv single"><thead><tr><th>店</th><th>手取り見込み</th><th>実利益 <button type="button" class="linkbtn" data-pfset title="査定減額率・送料・ポイント還元を変える">設定</button></th><th>扱う商品</th></tr></thead><tbody>` +
        // 減額と送料は別の行に（数値の欄は折り返さないので、1 行に並べるとスマホ幅で表がはみ出した）
        singles.map(({ s, r }) => `<tr${pick && pick.s === s ? ' class="on"' : ""}><td><label class="pickshop"><input type="radio" name="single" value="${esc(s)}"${pick && pick.s === s ? " checked" : ""}>${esc(siteName(s))}${rkTag(s)}</label></td>
          <td class="num">${yen(r.net)}${r.cut ? `<div class="muted">減額 −${yen(r.cut)}</div>` : ""}${r.fees ? `<div class="muted">送料等 −${yen(r.fees)}</div>` : ""}</td>
          <td class="num" data-pfs="${esc(s)}">${singleProfitHtml(r)}</td>
          <td>${total - r.unsold.length}/${total}${r.unsold.length ? `<div class="muted">無し: ${r.unsold.map((L) => esc(L.it.n)).join("、")}</div>` : ""}</td></tr>`).join("") + `</tbody></table>`;
      if (pick) {
        const d = pick.r.net - each.net;
        const cmp = `<div class="muted single-cmp">${d ? `「商品ごとに最高値」の案（${yen(each.net)}）より手取りが ${d < 0 ? `<b class="minus">−${yen(-d)}</b>` : `<b class="plus">+${yen(d)}</b>（送料・手数料が少ないため）`}`
          : `「商品ごとに最高値」の案と手取りが同じ（${yen(each.net)}）`}</div>`;
        h += planHtml(pick.r, `${esc(siteName(pick.s))}に${walk ? "全部持ち込む" : "まとめて送る"}`, cmp + pf(pick.r), undefined, { top: topPrice, none: "この店では買い取っていない商品" });
      }
    }
  }
  h += `<details class="fees"><summary>送料・手数料の設定（店ごと・この端末に保存）${includeStore ? "・持ち込みでは使いません" : ""}</summary>
    <p class="muted">${includeStore ? "<b>売り方が持ち込みの間は、この設定を使わず送料・手数料 0 円で計算します。</b><br>" : ""}送料: 自分が払う 1 回分の送料。無料基準: この金額（買取額の合計）以上なら送料 0。手数料: 振込手数料など。<br>
      手取り見込み・店の選び方・実利益のどれも、ここに何か入れた店はこの設定を使い、空の店は既定の買取送料（計算の設定・今は ${yen(pfRule().ship)}）を 1 回分引きます。店負担の店は送料に 0 と入れてください（欄を空にして、残りの欄も 0 なら設定を消します）。</p>
    <table class="inv"><thead><tr><th>店</th><th>送料</th><th>無料基準</th><th>手数料</th></tr></thead><tbody>` +
    sites.map((s) => { const f = cart.fees[s];  // 設定した店は 0 も出す（空欄＝設定なし と見分けられるように）
      return `<tr><td>${esc(siteName(s))}</td>${["ship", "free", "fee"].map((k) => `<td><input type="number" min="0" step="100" data-s="${esc(s)}" data-k="${k}" value="${f ? +f[k] || 0 : ""}" placeholder="0"></td>`).join("")}</tr>`; }).join("") +
    `</tbody></table></details>`;
  // 描き直す前に、パネルの中で入力の位置にあった部品（と送料の設定の欄の開閉）を覚え、描き直した後に同じ役の部品へ戻す
  // （2026-09-30 再総チェック: キーボードで ＋・−・案のタブ等を押すと、描き直しで入力の位置が消えて画面の頭から Tab し直しになっていた）
  const keep = cartFocusKeys(document.activeElement, panel);   // 送料の設定の欄の開閉は頭で覚えた（cartFeesOpen）
  panel.innerHTML = h;
  bindCart();
  if (cartFeesOpen && panel.querySelector(".fees")) panel.querySelector(".fees").open = true;
  for (const q of keep) { const el = panel.querySelector(q); if (el && el.getClientRects().length) { el.focus({ preventScroll: true }); break; } }
}
// ---- 店を選んで比べる（2026-11-03 本人「私が場所とかの兼ね合いで、この店とこの店なら、商品ごとに買取額がどうなるかが見づらい。
//   この画面では限界なので、新たに比較専用のページを作るとかで対応するのが良いと思う」）。売り先計算の中の全画面:
//   - 選んだ 1〜CMP_MAX 店の 1 個の価格を、商品ごとに横に並べる。全店の最高値との差と、その商品を売る店（色と「売る」）
//   - 分け方は、選んだ店の中で商品ごとに高い方の店（同じ額なら 1 店の下限・送料で回す＝ plan）。1 店の下限に届かない店があれば、
//     下限を守る分け方（少し安い店へ回す・売らないも含めて手取り最大＝ bestCombo）も出し、既定はそちら（下限は本人が決めた額なので）
//   - 店ごとの売る額・点数・送料等・「1 店に全部なら」の手取り、全店の「商品ごとに最高値」の案との手取りの差
// 比べる店の既定は「商品ごとに最高値」の案で売る額の多い 2 店（足りなければ在庫の商品を多く買い取る店）
// 分け方と店の欄の開閉を既定へ（開く・戻る・閉じる時。既定は本人が決めた 1 店の下限を守る方。2026-11-03 査読: 閉じても「高い方へ」が残っていた）
function cmpReset() { cart.cmpMode = { mail: "", walk: "" }; cart.cmpPickOpen = false; }
function cmpShops(sites, each, cands) {
  const ok = new Set(sites), mine = cart.cmpShops[includeStore ? "walk" : "mail"].filter((s) => ok.has(s));
  if (mine.length) return mine;
  const pick = each.shops.map((x) => x.s).filter((s) => ok.has(s)).slice(0, 2);
  const buys = (s) => cands.filter((cs) => cs.some((c) => c.s === s)).length;
  for (const s of sites.filter((s) => buys(s) && !pick.includes(s)).sort((a, b) => buys(b) - buys(a) || shopRank(a) - shopRank(b))) {
    if (pick.length >= 2) break;
    pick.push(s);
  }
  return pick;
}
// 選んだ店で売れない理由（1 個の価格の欄）。来店のみ（郵送の時）・メンテナンス中（郵送の時）・最低買取数
function cmpNone(L, s) {
  const os = L.p ? offersOf(L.p).filter((o) => o[0] === s && o[1] > 0) : [];
  const why = !os.length ? (L.p && !includeStore && L.p.o.some((o) => o[0] === s && o[1] > 0 && o[7] === 1) ? "来店のみ" : "")
    : maintOff(s) ? "メンテ中" : `${Math.min(...os.map(minQty))} 個から`;
  return `<span class="muted">—</span>${why ? `<small>${why}</small>` : ""}`;
}
function cmpHtml(lines, sites, sm) {
  const walk = includeStore, M = cartMin(), T = lines.length, allowed = new Set(sites);
  let h = `<div class="panelhead"><button type="button" class="linkbtn back" id="cmpBack" aria-label="売り先計算へ戻る">← 戻る</button><b>店を選んで比べる</b><button class="x" id="cartClose" aria-label="閉じる">×</button></div>`;
  if (!sites.length) return h + `<div class="warnbox">比較する店がすべて外されています。「比較する店」で店を選ぶと比べられます。</div>`;
  const each = cartEach(lines, sites), cands = lines.map((L) => candidatesOf(L, allowed));
  const order = sites.slice().sort((a, b) => shopRank(a) - shopRank(b));   // 「比較する店」の今の売り方の順番（同じなら元の並び）
  const chosen = new Set(cmpShops(sites, each, cands)), cols = order.filter((s) => chosen.has(s));
  const buys = (s) => cands.filter((cs) => cs.some((c) => c.s === s)).length;
  h += `<p class="muted cartnote">選んだ店だけで売る時に、商品ごとにどの店がいくらで買うかを並べます（1 個の価格。売り方は${walk ? "持ち込み" : "郵送"}・「比較する店」と計算の設定のまま）。色の付いた欄（「売る」）が、その商品を${walk ? "持ち込む" : "送る"}店です。</p>`;
  // 店を選ぶ欄は畳んでおく（スマホで表が下へ押し出されないように。開いたかは、この画面を開いている間だけ覚える）。今の売り方で在庫の商品を 1 つも売れない店は出さない
  const pickable = order.filter((s) => chosen.has(s) || buys(s) > 0), hid = order.length - pickable.length;
  if (!cols.length) return h + `<div class="warnbox">比較中の店では、今の売り方（${walk ? "持ち込み" : "郵送"}）で売れる在庫の商品がありません${walk ? "" : "（郵送では、来店のみの価格とメンテナンス中の店は使えません）"}。</div>`;   // 保存した店が無く、どの店も売れない時（2026-11-03 査読）
  h += `<details class="cmppick"${cart.cmpPickOpen ? " open" : ""}><summary>比べる店（${cols.length} 店）: ${cols.map((s) => esc(siteName(s))).join("・") || "なし"}<span class="muted">（押して変える）</span></summary>
    <p class="muted">${CMP_MAX} 店まで選べます。数字は、在庫の商品のうち、今の売り方でその店に売れる数${hid ? `（1 つも売れない ${hid} 店は出していません）` : ""}</p><div class="chips">${
    pickable.map((s) => `<label class="chk${chosen.has(s) ? " on" : ""}"><input type="checkbox" name="cmpShop" value="${esc(s)}"${chosen.has(s) ? " checked" : ""}>${esc(siteName(s))}<small>${buys(s)}/${T}</small></label>`).join("")}</div></details>`;
  const hi = plan(lines, new Set(cols));
  const lo = M > 0 && hi.minShort.length ? bestCombo(lines, cols, 0, COMBO_NODES_MIN, M) : null;   // 1 店の下限を守る分け方
  const mode = lo && cart.cmpMode[walk ? "walk" : "mail"] !== "high" ? "min" : "high", r = mode === "min" ? lo : hi, d = r.net - each.net;
  if (lo) h += `<div class="tabs cmpmode"><button data-m="min" aria-pressed="${mode === "min"}">1 店の下限 ${yen(M)} を守る<br><b>${yen(lo.net)}</b><small>${lo.shops.length} 店${walk ? "" : `・送料等 ${yen(lo.fees)}`}</small></button>` +
    `<button data-m="high" aria-pressed="${mode === "high"}">商品ごとに高い方へ<br><b>${yen(hi.net)}</b><small class="minshort">下限未満 ${hi.minShort.length} 店</small></button></div>`;
  const title = cols.length === 1 ? `${esc(siteName(cols[0]))}に${walk ? "全部持ち込む" : "まとめて送る"}`
    : mode === "min" ? `選んだ ${cols.length} 店で、1 店の下限 ${yen(M)} を守る分け方（少し安い店へ回す・${walk ? "持ち込まない" : "送らない"}も含めて、手取りが一番多い形）`
    : `選んだ ${cols.length} 店で、商品ごとに高い方の店へ（同じ額なら${M ? "1 店の下限に合わせ、" : ""}${walk ? "持ち込む店" : "送料"}が少なくなるように）`;
  h += `<div class="res cmpsum"><div class="reshead"><b>${title}${r.approx ? "・探索を打ち切ったため近似" : ""}</b><span class="net">手取り見込み ${yen(r.net)}</span></div>
    <div class="muted">買取合計 ${yen(r.gross)}${r.cut ? ` − 査定減額 ${pfRule().cut}% ${yen(r.cut)}` : ""}${r.fees ? ` − 送料・手数料 ${yen(r.fees)}` : ""} ・ ${r.shops.length} 店に${walk ? "持ち込む" : "送る"}</div>
    <div class="muted single-cmp">全店で比べた「商品ごとに最高値」の案（${yen(each.net)}・${each.shops.length} 店）より手取りが ${d < 0 ? `<b class="minus">−${yen(-d)}</b>` : d > 0 ? `<b class="plus">+${yen(d)}</b>（送料・手数料が少ないため）` : "同じ"}</div>${
    mode === "high" && hi.minShort.length ? `<div class="plannote">${hi.minShort.map((y) => `${esc(siteName(y.s))}（${yen(y.sub)}）`).join("・")}が 1 店の下限 ${yen(M)} に届きません。上の「1 店の下限 ${yen(M)} を守る」で、下限を守る分け方を出します</div>` : ""}</div>`;
  // この分け方で売る店は在庫の行で引く（hi・lo はその場の計算で、行は lines のもの。同じ商品 ID が 2 行ある在庫＝共有リンク・同期で作れる、でも取り違えない。2026-11-03 査読）。
  // 全店の「商品ごとに最高値」の案で売る店は商品 ID で引く（cartEach は使い回すので、行は前の lines のことがある）
  const on = new Map(), sent = new Map();
  for (const x of r.shops) for (const w of x.rows) on.set(w.L, x.s);
  for (const x of each.shops) for (const w of x.rows) sent.set(w.L.it.id, x.s);
  h += `<div class="cmpwrap"><table class="inv cmp n${cols.length}"><thead><tr><th class="nm">商品（1 個の価格）</th>${cols.map((s) => `<th class="cp">${esc(siteName(s))}${typeof shopMaint === "function" && shopMaint(s) ? `<span class="storetag maint" title="店のサイトがメンテナンス中（最後に取れた時の価格のまま）。店頭で今の価格を確かめてください">メンテ中</span>` : ""}</th>`).join("")}</tr></thead><tbody>`;
  for (const i of cartOrder(lines, cands, sm)) {
    const L = lines[i], cs = cands[i], top = cs[0];
    const topTxt = top ? `全店の最高値 ${yen(top.o[1])}（${esc(siteName(sent.get(L.it.id) || top.s))}）` : L.p ? "比較中の店では売り先にできない" : "今はどの店も買い取っていない";
    h += `<tr><th class="nm" scope="row">${esc(L.it.n)}${L.it.q > 1 ? `<span class="q"> ×${L.it.q}</span>` : ""}<small>${topTxt}</small></th>`;
    for (const s of cols) {
      const c = cs.find((x) => x.s === s), sel = on.get(L) === s;
      if (!c) { h += `<td class="cp none">${cmpNone(L, s)}</td>`; continue; }
      const gap = top.o[1] - c.o[1];
      h += `<td class="cp${sel ? " on" : ""}"><b>${yen(c.o[1])}</b>${gap > 0 ? `<small class="gap" title="全店の最高値より ${yen(gap)} 安い">−${num(gap)}</small>` : `<small class="hi">最高値</small>`}${sel ? `<small class="sell">売る</small>` : ""}</td>`;
    }
    h += `</tr>`;
  }
  const by = new Map(r.shops.map((x) => [x.s, x])), low = new Set((r.minShort || []).map((y) => y.s));
  h += `</tbody><tfoot><tr><th class="nm" scope="row">この分け方で${walk ? "持ち込む" : "送る"}額<small>買取額の合計（査定減額の前）・点数</small></th>${cols.map((s) => { const x = by.get(s);
    return `<td class="cp">${x ? `<b>${yen(x.sub)}</b><small>${x.rows.reduce((n, w) => n + w.L.it.q, 0)} 点</small>${low.has(s) ? `<span class="storetag minlow" title="1 店の下限 ${yen(M)} に届かない店">下限未満</span>` : ""}` : `<span class="muted">売らない</span>`}</td>`; }).join("")}</tr>`;
  if (!walk) h += `<tr><th class="nm" scope="row">送料・手数料</th>${cols.map((s) => { const x = by.get(s); return `<td class="cp">${x ? (x.fee ? `−${yen(x.fee)}` : "¥0") : "—"}</td>`; }).join("")}</tr>`;
  h += `<tr><th class="nm" scope="row">1 店に全部${walk ? "持ち込む" : "送る"}なら<small>手取り見込み・売れる商品の数</small></th>${cols.map((s) => { const y = plan(lines, new Set([s]));
    return `<td class="cp">${y.shops.length ? `<b>${yen(y.net)}</b><small>${T - y.unsold.length}/${T} 商品</small>` : "—"}</td>`; }).join("")}</tr></tfoot></table></div>`;
  const skip = new Set(r.skipped || []), none = r.unsold.filter((L) => !skip.has(L));
  if (none.length) h += `<div class="warnbox">選んだ店では売れない商品: ${none.map((L) => esc(L.it.n)).join("、")}</div>`;
  if (skip.size) h += `<div class="warnbox">1 店の下限 ${yen(M)} を守るため${walk ? "" : "、または送料・手数料を引くと手取りが増えないため"}、この分け方では売らない商品: ${[...skip].map((L) => esc(L.it.n)).join("、")}</div>`;
  return h;
}
function bindCmp() {
  const P = $("cartPanel");
  $("cartClose").onclick = cartClose;
  const back = $("cmpBack");
  if (back) back.onclick = () => { cart.cmp = false; cmpReset(); P.scrollTop = 0; cartRender().then(() => { const b = $("cmpOpen"); if (b && b.focus) b.focus({ preventScroll: true }); }); };
  // 比べる店: 今の売り方の分だけ変える（保存値を読み直してから。別のタブで変えた、もう一方の売り方の店を消さない）。0 店・CMP_MAX 店を超える選び方は戻す
  P.querySelectorAll('input[name="cmpShop"]').forEach((c) => c.onchange = () => {
    const now = [...P.querySelectorAll('input[name="cmpShop"]')].filter((x) => x.checked).map((x) => x.value);
    if (now.length > CMP_MAX) { c.checked = false; return toast(`比べる店は ${CMP_MAX} 店までです（ほかの店のチェックを外してから選んでください）`); }
    if (!now.length) { c.checked = true; return toast("比べる店を 1 店以上選んでください"); }
    cart.cmpShops = cleanCmp(store.get("cartCmp", cart.cmpShops)); cart.cmpShops[includeStore ? "walk" : "mail"] = now;
    store.set("cartCmp", cart.cmpShops); cartRender();
  });
  P.querySelectorAll(".cmpmode button").forEach((b) => b.onclick = () => { cart.cmpMode[includeStore ? "walk" : "mail"] = b.dataset.m; cartRender(); });
}

// 入力の位置にあった部品 → 描き直した後に同じ役の部品を探すセレクタ（前から順に試す）。パネルの外・覚えなくてよい部品は []
function cartFocusKeys(a, panel) {
  if (!a || a === panel || !panel.contains(a) || typeof a.matches !== "function") return [];
  const d = a.dataset || {}, q = (k, v) => `[data-${k}="${CSS.escape(String(v))}"]`;
  if (a.id) return ["#" + CSS.escape(a.id)];
  if (a.matches(".qty button")) return [`.qty button${q("d", d.d)}${q("i", d.i)}`];
  if (a.matches(".qty input")) return [`.qty input${q("i", d.i)}`];
  // 削除（🗑）の後は、次の行（無ければ前の行）の個数の欄へ。削除ボタンには移さない（Enter を続けて押すと次の行も消えるため）。
  //   並べ替えた表でも見た目の隣の行へ（2026-10-31 総チェック: 在庫の番号の隣＝見た目では別の場所の行へ移っていた）。消した商品より後ろの番号は 1 つ詰まる
  if (a.matches("button.rm")) {
    const tr = typeof a.closest === "function" ? a.closest("tr") : null, at = (r) => { const x = r && r.querySelector(".qty input"); return x ? +x.dataset.i : NaN; };
    const nb = [tr && tr.nextElementSibling, tr && tr.previousElementSibling].map(at).filter(Number.isInteger).map((j) => `.qty input${q("i", j > +d.i ? j - 1 : j)}`);
    return [...nb, `.qty input${q("i", d.i)}`, `.qty input${q("i", +d.i - 1)}`, "#cartClose"];
  }
  if (a.matches("input[data-buy]")) return [`input${q("buy", d.buy)}`];
  if (a.matches(".cmpmode button")) return [`.cmpmode button${q("m", d.m)}`];   // 比べる画面の分け方（.tabs より先に見る）
  if (a.matches(".tabs button")) return [`.tabs button${q("v", d.v)}`];
  if (a.matches('input[name="lim"]')) return [`input[name="lim"][value="${CSS.escape(a.value)}"]`];
  if (a.matches('input[name="single"]')) return [`input[name="single"][value="${CSS.escape(a.value)}"]`];
  if (a.matches(".fees input")) return [`.fees input${q("s", d.s)}${q("k", d.k)}`];
  if (a.matches(".fees summary")) return [".fees summary"];
  if (a.matches("[data-pfset]")) return ["[data-pfset]"];
  if (a.matches("#cartMin")) return ["#cartMin"];
  if (a.matches('input[name="cmpShop"]')) return [`input[name="cmpShop"][value="${CSS.escape(a.value)}"]`];
  if (a.matches(".cmppick summary")) return [".cmppick summary"];
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
  const co = $("cmpOpen");
  if (co) co.onclick = () => { cart.cmp = true; cmpReset(); P.scrollTop = 0; cartRender().then(() => { const b = $("cmpBack"); if (b && b.focus) b.focus({ preventScroll: true }); }); };
  const so = $("cartSort");
  if (so) so.onchange = () => { cart.sort = cartSortOk(so.value) ? so.value : "add"; store.set("cartSort", cart.sort); cartRender(); };
  // 1 店の下限: 今の売り方の分だけ変える（保存値を読み直してから。前から開いていた別のタブで変えた、もう一方の売り方の値を消さない）
  const mn = $("cartMin");
  if (mn) mn.onchange = () => {
    const v = +mn.value; cart.min = cleanMin(store.get("cartMin", cart.min)); cart.min[includeStore ? "walk" : "mail"] = MIN_OPTS.includes(v) ? v : 0;
    store.set("cartMin", cart.min); cartRender();
  };
  P.querySelectorAll('input[name="lim"]').forEach((r) => r.onchange = () => { cart.limit = +r.value; store.set("cartLimit", cart.limit); cartRender(); });
  P.querySelectorAll('input[name="single"]').forEach((r) => r.onchange = () => { cart.pick[includeStore ? "walk" : "mail"] = r.value; cartRender(); });
  P.querySelectorAll(".fees input").forEach((inp) => inp.onchange = () => {
    // 欄を空にして、その店の残りの欄も 0（か空）なら設定を消す（手取り見込み・実利益とも既定の買取送料に戻る）。
    // 0 と打った時は「店負担」として設定を残す（描き直すと設定した店は 0 と出るので、空＝設定なし と見分けられる）
    const row = [...P.querySelectorAll(".fees input")].filter((x) => x.dataset.s === inp.dataset.s);
    if (inp.value.trim() === "" && row.every((x) => x.value.trim() === "" || +x.value === 0)) delete cart.fees[inp.dataset.s];
    else { const f = (cart.fees[inp.dataset.s] ||= {}); for (const x of row) f[x.dataset.k] = Math.round(Math.max(0, +x.value || 0)); }
    store.set("fees", cart.fees); cartLater(() => cartRender().then(() => { const f = P.querySelector(".fees"); if (f) f.open = true; }));
  });
  // 店ごとの「商品ページを順に開く」: 押すと今の href が新しいタブで開き、その後で次の商品のページへ書き換える（書き換えは次の番＝開く前に変えない）
  // PC の中ボタン（auxclick）で新しいタブに開いた時も次へ進める。iPhone の長押しの「新規タブで開く」は知らせが来ないので進まない（2026-10-25 総チェック）
  P.querySelectorAll("a.opennext").forEach((a) => {
    const step = () => {
      const urls = JSON.parse(a.dataset.urls), i = +a.dataset.i, n = urls.length;
      if (n < 2) return;
      setTimeout(() => {
        const j = (i + 1) % n;
        a.dataset.i = j; a.href = urls[j]; a.textContent = openLabel(j, n);
        if (!j) toast(`${n} 件のページをすべて開きました（もう一度押すと最初から）`);
      }, 0);
    };
    a.onclick = step;
    a.onauxclick = (e) => { if (e.button === 1) step(); };
  });
  // 店ごとの「申込メモをコピー」。コピーできない時（古いブラウザ・許可なし）は、文を欄に出して自分でコピーしてもらう
  P.querySelectorAll("button[data-memo]").forEach((b) => b.onclick = async () => {
    const m = shopMemos[+b.dataset.memo]; if (!m) return;
    const t = memoText(m);
    try { await navigator.clipboard.writeText(t); toast(`${siteName(m.s)}の申込メモをコピーしました`); }
    catch {
      let box = b.parentNode.querySelector("textarea.memobox");
      if (!box) { box = document.createElement("textarea"); box.className = "memobox"; box.readOnly = true; box.setAttribute("aria-label", "申込メモ"); b.parentNode.appendChild(box); }
      box.value = t; box.rows = Math.min(12, t.split("\n").length + 1); box.focus(); box.select(); box.setSelectionRange(0, t.length);   // iPhone は select() だけでは選ばれないことがある
      toast("コピーできなかったので、下の欄の文を選んでコピーしてください");
    }
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
  const ship = includeStore ? "持ち込みなので 0 円" : [x.def ? `設定の無い ${x.def} 店は 1 店 ${yen(profitSet.ship)}（既定）` : "", x.own ? `送料・手数料を設定した ${x.own} 店はその設定` : ""].filter(Boolean).join("、");
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
  const r = cart.view === "combo" ? cart.last.combo : cart.view === "single" && cart.last.pick ? cart.last.pick.r : cart.view === "fav" && cart.last.fav ? cart.last.fav : cart.last.each;
  if (box) box.innerHTML = cartProfitHtml(r);
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
  cart.cmp = false; cmpReset();   // 次に開く時は売り先計算から（分け方は下限を守る方・店の欄は畳む）
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
