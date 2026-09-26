"use strict";
// 売り先計算（カート）: 手元の在庫（商品×個数）を、どの店に売るのが一番得かを計算する。
// 在庫リストとパターンはこの端末（ブラウザ）に保存。別の端末へは共有リンクで渡す。
// app.js の $, st, store, esc, yen, siteName, safeUrl, loadCat, offersOf, includeStore を使う。
// 計算の核（candidatesOf / cartSolve / resultOf）は tests/cart_solver_check.js が総当たりと突き合わせる。

const cart = {
  items: store.get("cart", []),      // [{id, k, n, c, q}]  id=商品の固定番号 k=カテゴリ n=名前 c=状態 q=個数
  name: store.get("cartName", ""),   // 今のリストが属するパターン名（未保存なら空）
  patterns: store.get("patterns", {}), // {名前: {items, saved}}
  fees: store.get("fees", {}),       // {店ID: {ship, free, fee}}
  limit: store.get("cartLimit", 0),  // 店数の上限（0 = 制限なし）
  view: "best",
};
const cartSave = () => { store.set("cart", cart.items); store.set("cartName", cart.name); cartBadge(); };
const cartBadge = () => { $("cartCount").textContent = cart.items.reduce((n, x) => n + x.q, 0); };

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2200);
}

function cartAdd(p) {
  const it = cart.items.find((x) => x.id === p.id);
  if (it) it.q++; else cart.items.push({ id: p.id, k: p.k, n: p.n, c: p.c, q: 1 });
  cartSave();
  toast(`在庫リストに追加: ${p.n}（${it ? it.q : 1} 個）`);
  if (!$("cartPanel").hidden) cartRender();
}

// ---- 計算 ----
// 店ごとの費用: 送料（無料基準以上なら 0）＋ 固定の手数料。その店に 1 品も送らなければ 0
function feeOf(site, subtotal, fees = cart.fees) {
  if (!(subtotal > 0)) return 0;
  const f = fees[site] || {};
  const ship = f.free && subtotal >= f.free ? 0 : +f.ship || 0;
  return ship + (+f.fee || 0);
}
// 商品の最低買取数（価格配列の 9 番目。無ければ 1）。カートの個数がこれ未満の価格は売れないので候補にしない
const minQty = (o) => Math.max(1, +o[8] || 1);
// 1 行（商品×個数）の候補: allowed の店ごとに最高の 1 価格。来店のみ・非表示の店は offersOf に従う
function candidatesOf(L, allowed) {
  if (!L.p) return [];
  const by = {};
  for (const o of offersOf(L.p)) {
    if (!allowed.has(o[0]) || minQty(o) > L.it.q) continue;
    if (!by[o[0]] || o[1] > by[o[0]][1]) by[o[0]] = o;
  }
  return Object.values(by).map((o) => ({ s: o[0], o, v: o[1] * L.it.q })).sort((a, b) => b.v - a.v);
}
// 割り当て（行ごとの店 or null）から画面用の結果を組み立てる
function resultOf(lines, cands, assign, fees = cart.fees) {
  const by = {}, unsold = [];
  lines.forEach((L, i) => {
    const c = assign[i] == null ? null : cands[i].find((x) => x.s === assign[i]);
    if (c) (by[c.s] ||= []).push({ L, o: c.o }); else unsold.push(L);
  });
  const shops = Object.entries(by).map(([s, rows]) => {
    const sub = rows.reduce((n, r) => n + r.o[1] * r.L.it.q, 0);
    return { s, rows, sub, fee: feeOf(s, sub, fees) };
  }).sort((a, b) => b.sub - a.sub);
  const gross = shops.reduce((n, x) => n + x.sub, 0), total = shops.reduce((n, x) => n + x.fee, 0);
  return { shops, unsold, gross, fees: total, net: gross - total };
}
// 各商品を（候補の中で）一番高い店へ。送料・手数料は差し引くだけで、最適化はしない
function plan(lines, allowed) {
  const cands = lines.map((L) => candidatesOf(L, allowed));
  return resultOf(lines, cands, cands.map((c) => (c[0] ? c[0].s : null)));
}

// 手取り最大の割り当てを厳密に求める（分枝限定法）。
//   cands[i] = 行 i の候補 [{s: 店, v: 価格×個数}]（v の高い順）、fees = {店: {ship, free, fee}}、limit = 店数上限（0 = なし）
//   返り値 {assign: 行ごとの店 or null, net, approx}。approx は探索を maxNodes で打ち切った印（その時は「見つけた中で最良」）
// 考え方: 商品ごとに最高値の店へ送るのが上限（送料・手数料を引く前）。上限が今の最良以下になった枝は捨てる。
//   送料・手数料が 0 の店ばかりなら分岐はほぼ起きず、費用のある店があっても「費用の合計より安い差」の店だけを試すので速い。
//   店数上限があると「使っている店だけ」で残りを見積もるので、上限に届いた枝も早く切れる。
function cartSolve(cands, fees, limit, maxNodes = 200000) {
  const n = cands.length;
  const siteIdx = {}, sites = [];
  for (const cs of cands) for (const c of cs) if (!(c.s in siteIdx)) { siteIdx[c.s] = sites.length; sites.push(c.s); }
  const k = sites.length;
  const fixed = sites.map((s) => +(fees[s] || {}).fee || 0), ship = sites.map((s) => +(fees[s] || {}).ship || 0),
    free = sites.map((s) => +(fees[s] || {}).free || 0);
  const cost = (j, sub) => (sub > 0 ? fixed[j] + (free[j] && sub >= free[j] ? 0 : ship[j]) : 0);
  const netOf = (sub) => { let t = 0; for (let j = 0; j < k; j++) if (sub[j] > 0) t += sub[j] - cost(j, sub[j]); return t; };
  // 価値の大きい商品から決める（間違った店に置いた時の損が大きく、早く枝が切れる）
  const order = cands.map((cs, i) => i).sort((a, b) => (cands[b][0]?.v || 0) - (cands[a][0]?.v || 0));
  const C = order.map((i) => cands[i].map((c) => ({ j: siteIdx[c.s], v: c.v })));
  const maxv = C.map((cs) => (cs[0] ? cs[0].v : 0));
  // pot[i][j] = 行 i 以降を全部店 j に送った時の合計（無料基準に届き得るかの見積もりに使う）
  const pot = Array.from({ length: n + 1 }, () => new Float64Array(k));
  for (let i = n - 1; i >= 0; i--) { pot[i].set(pot[i + 1]); for (const c of C[i]) pot[i][c.j] += c.v; }
  const vAt = (i, j) => { for (const c of C[i]) if (c.j === j) return c.v; return -1; };

  // 最初の最良: 商品ごとに最高値の店へ → 店数上限を超えていれば損の小さい店から外す → 外して得になる店は外す
  const cur = new Int16Array(n).fill(-1), sub = new Float64Array(k);
  const evalAssign = (a) => { sub.fill(0); for (let i = 0; i < n; i++) if (a[i] >= 0) sub[a[i]] += vAt(i, a[i]); return netOf(sub); };
  const usedOf = (a) => { const u = new Set(); for (const j of a) if (j >= 0) u.add(j); return u; };
  const reassignWithout = (a, drop) => { // 店 drop を使わずに、各商品を残りの店の中で最高値へ
    const b = Int16Array.from(a), keep = usedOf(a); keep.delete(drop);
    for (let i = 0; i < n; i++) if (a[i] === drop) { const c = C[i].find((x) => keep.has(x.j)); b[i] = c ? c.j : -1; }
    return b;
  };
  for (let i = 0; i < n; i++) cur[i] = C[i][0] ? C[i][0].j : -1;
  let curNet = evalAssign(cur);
  for (;;) { // 店数上限まで減らす／外したほうが得な店を外す
    const used = usedOf(cur);
    let pick = null;
    for (const j of used) {
      const b = reassignWithout(cur, j), v = evalAssign(b);
      if (!pick || v > pick.v) pick = { b, v };
    }
    if (pick && ((limit && used.size > limit) || pick.v > curNet)) { cur.set(pick.b); curNet = pick.v; } else break;
  }
  let best = Int16Array.from(cur), bestNet = curNet;

  // 分枝限定法
  const a = new Int16Array(n).fill(-1);
  sub.fill(0);
  let used = 0, nodes = 0, approx = false;
  const inUse = new Uint8Array(k);
  const dfs = (i, curV, curFixed) => {
    if (approx) return;
    if (++nodes > maxNodes) { approx = true; return; }
    if (i === n) {
      const net = netOf(sub);
      if (net > bestNet) { bestNet = net; best = Int16Array.from(a); }
      return;
    }
    // 上限: 残りの商品は最高値の店（上限に届いていれば使用中の店だけ）へ、送料は無料基準に届き得るなら 0 とみなす
    let remain = 0;
    const capped = limit && used >= limit;
    for (let r = i; r < n; r++) {
      if (!capped) { remain += maxv[r]; continue; }
      for (const c of C[r]) if (inUse[c.j]) { remain += c.v; break; }
    }
    let unavoidable = 0;
    for (let j = 0; j < k; j++) if (inUse[j] && ship[j] && !(free[j] && sub[j] + pot[i][j] >= free[j])) unavoidable += ship[j];
    if (curV + remain - curFixed - unavoidable <= bestNet) return;
    for (const c of C[i]) {
      const fresh = !inUse[c.j];
      if (fresh && capped) continue;
      a[i] = c.j; sub[c.j] += c.v;
      if (fresh) { inUse[c.j] = 1; used++; }
      dfs(i + 1, curV + c.v, curFixed + (fresh ? fixed[c.j] : 0));
      sub[c.j] -= c.v; if (fresh) { inUse[c.j] = 0; used--; }
    }
    a[i] = -1; dfs(i + 1, curV, curFixed); // 売らない（費用のほうが高い時だけ意味がある）
  };
  dfs(0, 0, 0);
  // 同じ手取りなら店の数が少ないほうを選ぶ
  for (;;) {
    let done = true;
    for (const j of usedOf(best)) { const b = reassignWithout(best, j); if (evalAssign(b) >= bestNet) { best = b; done = false; break; } }
    if (done) break;
  }
  const assign = new Array(n).fill(null);
  order.forEach((i, pos) => { assign[i] = best[pos] >= 0 ? sites[best[pos]] : null; });
  return { assign, net: bestNet, approx, nodes };
}
// 店数上限つきで手取り最大の割り当て。sites が空でも結果（全部「売り先なし」）を返す
function bestCombo(lines, sites, limit) {
  const cands = lines.map((L) => candidatesOf(L, new Set(sites)));
  const r = cartSolve(cands, cart.fees, limit);
  return Object.assign(resultOf(lines, cands, r.assign), { approx: r.approx });
}
// 同じ条件（商品・個数・店・送料設定・上限）なら計算し直さない（タブ切替のたびに解かない）
function cartCombo(lines, sites, limit) {
  const key = JSON.stringify([lines.map((L) => [L.it.id, L.it.q, L.p ? L.p.k : null]), sites, cart.fees, limit, includeStore, st.status.generated]);
  if (cartCombo.key !== key) { cartCombo.key = key; cartCombo.val = bestCombo(lines, sites, limit); }
  return cartCombo.val;
}

// ---- 画面 ----
// 商品の固定番号で探す。保存した時と今のカテゴリが違っても（多数決で変わる）見つかるよう、まず元のカテゴリ、無ければ全カテゴリを見る
async function cartLines() {
  const find = (it, cats) => { for (const k of cats) { const p = (st.data[k] || []).find((p) => p.id === it.id); if (p) return p; } return null; };
  await Promise.all([...new Set(cart.items.map((x) => x.k))].map((k) => loadCat(k).catch(() => [])));
  const lines = cart.items.map((it) => ({ it, p: find(it, [it.k]) }));
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

function planHtml(r, title) {
  let h = `<div class="res"><div class="reshead"><b>${title}</b><span class="net">手取り ${yen(r.net)}</span></div>
    <div class="muted">買取合計 ${yen(r.gross)}${r.fees ? ` − 送料・手数料 ${yen(r.fees)}` : ""} ・ ${r.shops.length} 店に送る</div>`;
  for (const x of r.shops) {
    h += `<div class="shopblk"><div class="shoph"><a href="${esc(safeUrl(st.sites[x.s]?.url))}" target="_blank" rel="noopener">${esc(siteName(x.s))}</a>
      <span>${yen(x.sub)}${x.fee ? ` <span class="muted">（−${yen(x.fee)}）</span>` : ""}</span></div><ul>`;
    for (const { L, o } of x.rows)
      h += `<li><a href="${esc(safeUrl(o[4]))}" target="_blank" rel="noopener">${esc(L.it.n)}</a><span>${yen(o[1])} × ${L.it.q}</span></li>`;
    h += `</ul></div>`;
  }
  if (r.unsold.length) h += `<div class="warnbox">売り先が無い商品: ${r.unsold.map((L) => esc(L.it.n)).join("、")}</div>`;
  return h + `</div>`;
}

async function cartRender() {
  const panel = $("cartPanel");
  const lines = await cartLines();
  const sites = shopIds();
  const names = Object.keys(cart.patterns).sort();
  let h = `<div class="panelhead"><b>売り先計算</b><button class="x" id="cartClose" aria-label="閉じる">×</button></div>
  <div class="pat">
    <select id="patSel"><option value="">— 保存したパターン（${names.length}） —</option>${names.map((n) => `<option ${n === cart.name ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
    <input id="patName" placeholder="パターン名" value="${esc(cart.name)}">
    <button id="patSave">保存</button><button id="patNew">新規</button><button id="patDel">削除</button><button id="patShare">共有リンク</button>
  </div>`;
  if (!cart.items.length) {
    h += `<p class="muted">在庫リストは空です。商品の「＋」を押すと追加されます。</p>`;
  } else {
    const allowed = new Set(sites);
    if (!sites.length) h += `<div class="warnbox">比較する店がすべて外されています。「比較する店」で店を選ぶと計算できます。</div>`;
    h += `<table class="inv items"><thead><tr><th>商品</th><th>個数</th><th>最高値</th><th></th></tr></thead><tbody>`;
    lines.forEach((L, i) => {
      // 最高値は計算と同じ候補（来店のみ・外した店・最低買取数の設定に従う）から出す
      const top = candidatesOf(L, allowed)[0];
      const need = L.p && !top ? Math.min(...offersOf(L.p).filter((o) => allowed.has(o[0])).map(minQty)) : Infinity; // 個数が足りないだけの時の案内
      let note = "";
      if (!L.p) note = ` <span class="err">（今はどの店も買取していない）</span>`;
      else if (!top && Number.isFinite(need)) note = ` <span class="err">（最低買取数 ${need} 個から）</span>`;
      else if (!top && sites.length) note = ` <span class="err">（比較中の店には買取価格がない）</span>`;
      h += `<tr><td>${esc(L.it.n)}${note}</td>
        <td class="qty"><button data-d="-1" data-i="${i}">−</button><input data-i="${i}" type="number" min="1" value="${L.it.q}"><button data-d="1" data-i="${i}">＋</button></td>
        <td class="num">${top ? `${yen(top.o[1])}<div class="muted">${esc(siteName(top.s))}</div>` : "—"}</td>
        <td><button class="rm" data-i="${i}" aria-label="削除">🗑</button></td></tr>`;
    });
    h += `</tbody></table>`;
    const each = plan(lines, allowed);
    const combo = cartCombo(lines, sites, cart.limit);
    const singles = sites.map((s) => ({ s, r: plan(lines, new Set([s])) })).filter((x) => x.r.shops.length)
      .sort((a, b) => b.r.net - a.r.net);
    h += `<div class="tabs">
      <button data-v="best" aria-pressed="${cart.view === "best"}">商品ごとに最高値<br><b>${yen(each.net)}</b></button>
      <button data-v="combo" aria-pressed="${cart.view === "combo"}">店数を絞る<br><b>${yen(combo.net)}</b></button>
      <button data-v="single" aria-pressed="${cart.view === "single"}">1店にまとめる<br><b>${singles[0] ? yen(singles[0].r.net) : "—"}</b></button></div>`;
    if (cart.view === "best") h += planHtml(each, "商品ごとに最高値の店へ");
    if (cart.view === "combo") {
      h += `<div class="row">送る店の数: ${[1, 2, 3, 0].map((k) => `<label class="chk"><input type="radio" name="lim" value="${k}" ${cart.limit === k ? "checked" : ""}>${k ? k + " 店まで" : "制限なし"}</label>`).join(" ")}</div>`;
      h += planHtml(combo, `手取りが最大の組み合わせ（${cart.limit ? cart.limit + " 店まで" : "店数の制限なし"}）${combo.approx ? "・探索を打ち切ったため近似" : ""}`);
    }
    if (cart.view === "single") {
      const total = cart.items.length;
      h += `<table class="inv single"><thead><tr><th>店</th><th>手取り</th><th>扱う商品</th></tr></thead><tbody>` +
        singles.map(({ s, r }) => `<tr><td>${esc(siteName(s))}</td><td class="num">${yen(r.net)}${r.fees ? `<div class="muted">送料等 −${yen(r.fees)}</div>` : ""}</td>
          <td>${total - r.unsold.length}/${total}${r.unsold.length ? `<div class="muted">無し: ${r.unsold.map((L) => esc(L.it.n)).join("、")}</div>` : ""}</td></tr>`).join("") + `</tbody></table>`;
    }
  }
  h += `<details class="fees"><summary>送料・手数料の設定（店ごと・この端末に保存）</summary>
    <p class="muted">送料: 自分が払う 1 回分の送料。無料基準: この金額以上なら送料 0。手数料: 振込手数料など。店負担なら 0 のまま。</p>
    <table class="inv"><thead><tr><th>店</th><th>送料</th><th>無料基準</th><th>手数料</th></tr></thead><tbody>` +
    sites.map((s) => { const f = cart.fees[s] || {};
      return `<tr><td>${esc(siteName(s))}</td>${["ship", "free", "fee"].map((k) => `<td><input type="number" min="0" step="100" data-s="${s}" data-k="${k}" value="${f[k] || ""}" placeholder="0"></td>`).join("")}</tr>`; }).join("") +
    `</tbody></table></details>`;
  panel.innerHTML = h;
  bindCart();
}

function bindCart() {
  const P = $("cartPanel");
  $("cartClose").onclick = () => { P.hidden = true; document.body.classList.remove("noscroll"); };
  P.querySelectorAll(".qty button").forEach((b) => b.onclick = () => {
    const it = cart.items[+b.dataset.i]; it.q = Math.max(1, it.q + +b.dataset.d); cartSave(); cartRender();
  });
  P.querySelectorAll(".qty input").forEach((inp) => inp.onchange = () => {
    cart.items[+inp.dataset.i].q = Math.max(1, Math.floor(+inp.value) || 1); cartSave(); cartRender();
  });
  P.querySelectorAll("button.rm").forEach((b) => b.onclick = () => { cart.items.splice(+b.dataset.i, 1); cartSave(); cartRender(); });
  P.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => { cart.view = b.dataset.v; cartRender(); });
  P.querySelectorAll('input[name="lim"]').forEach((r) => r.onchange = () => { cart.limit = +r.value; store.set("cartLimit", cart.limit); cartRender(); });
  P.querySelectorAll(".fees input").forEach((inp) => inp.onchange = () => {
    const f = (cart.fees[inp.dataset.s] ||= {}); f[inp.dataset.k] = Math.max(0, +inp.value || 0);
    store.set("fees", cart.fees); const open = true; cartRender().then(() => { if (open) P.querySelector(".fees").open = true; });
  });
  $("patSel").onchange = () => {
    const n = $("patSel").value; if (!n) return;
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
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(data))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const url = location.origin + location.pathname + "#cart=" + b64;
    try { await navigator.clipboard.writeText(url); toast("共有リンクをコピーしました。別の端末で開くと取り込めます"); }
    catch { prompt("このリンクをコピーして、別の端末で開いてください", url); }
  };
}

function cartOpen() {
  $("cartPanel").hidden = false; document.body.classList.add("noscroll");
  $("cartPanel").innerHTML = `<p class="muted">計算中…</p>`; cartRender();
}

// 共有リンク（#cart=...）で開かれたら、パターンとして取り込む
function cartImport() {
  const m = location.hash.match(/#cart=([\w-]+)/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const s = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0))));
    let n = data.n || "受け取ったリスト";
    if (cart.patterns[n]) n += `（${new Date().toLocaleDateString("ja-JP")}受取）`;
    if (!confirm(`共有されたリスト「${data.n}」（${data.i.length} 商品）をパターン「${n}」として保存し、開きますか？`)) return;
    cart.items = data.i.map(([id, k, q, nm, c]) => ({ id, k, q: Math.max(1, +q || 1), n: nm, c }));
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
