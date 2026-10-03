"use strict";
// 見た目の着せ替え（2026-09-29 ユーザー指示: 案A「取引所の板」を既定に、いつもの見た目と切り替えられるように）。
//   取引所 = <html data-skin="board">（skin-board.css が効く。端末の明暗設定にかかわらず黒地の 1 つの見た目）
//   いつもの = data-skin なし（2026-09-29 までの見た目そのまま。skin-board.css は何も効かない）
// 選択は端末ごと（localStorage の "skin"。起動直後は skin-init.js が決める）。
// 取引所の時だけ動くもの: 上部の値動きテロップ・最高値を数える演出・PC のカテゴリの縦並びの位置合わせ。
// 計算（最高値・順位・売り先・実利益）は変えない（見た目だけの着せ替え）。
// app.js の $, st, store, esc, num, yen, offersOf, recentChange, shortName, boardSkin, scrollMotion, renderShops, renderShopPick,
// renderList, filterRows, setMv, hidden, includeStore, wide, PAGE, RECENT_DAYS と、cart.js の toast を使う。app.js の renderList が描いた後に skinAfter() を呼ぶ。
const SKINS = { board: "取引所", classic: "いつもの" };
const skinGet = () => (boardSkin() ? "board" : "classic");
const reduceMotion = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

function skinSet(v, save = true) {
  v = v === "classic" ? "classic" : "board";
  if (v === "board") document.documentElement.setAttribute("data-skin", "board");
  else document.documentElement.removeAttribute("data-skin");
  if (save) store.set("skin", v);
  skinLabel();
  tick.key = null; skinAnim.cat = null;  // 取引所に切り替えた時もテロップを作り直し、最高値を数える
  if (!boardSkin()) { const t = $("ticker"); if (t) { t.hidden = true; t.innerHTML = ""; } document.documentElement.style.removeProperty("--sideTop"); }
  // 店の色（明るさ）が見た目で変わるので描き直す（端末の明暗の切り替えと同じ）
  if (st.status) { renderShops(); renderShopPick(); renderList(); }
}
function skinLabel() {
  const b = $("skinBtn"), cur = skinGet(), next = cur === "board" ? "classic" : "board";
  if (b) {
    b.querySelector("b").textContent = SKINS[cur];
    b.setAttribute("aria-label", `見た目: ${SKINS[cur]}（押すと「${SKINS[next]}」に切り替え）`);
    b.title = `画面の見た目を「${SKINS[next]}」に切り替える（この端末に保存）`;
  }
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute("content", cur === "board" ? "#0A0E0D" : "#0b1220");
}

// ---- 値動きテロップ（取引所だけ）----
// 今のカテゴリの商品（比較する店・来店のみの設定は効く。検索・★・並び順には左右されない＝相場の見出し）のうち、最高値（offersOf の先頭＝
// 外れ値・価格が不安定・来店のみ・外した店を除く）が前回から動いた商品を、動きの大きい順に並べる。押すとその商品へ移る。動きを減らす設定の端末では流さずに並べるだけ（横にスクロールできる）
// 動き = 今の最高値 −「前の最高値」。前の最高値 = 各店の前回の価格（直近 RECENT_DAYS 日に変わった店。商品カードの ▲▼ と同じ期間）と、変わっていない店の今の価格の最高。
// 前の最高値が前の時点の 2 位より大きく離れていて、それが他店の近くまで下がった動き（入力ミスが直っただけ）と、上げで 1 店だけが他店から
// 大きく離れた動き（入力ミスらしい）は流さない（tickFixLike）。
// 2026-09-29 独立 QA: 以前は最高値の店の値動き（o[0][1] − o[0][2]）だったので、他の店が前から同じ額を付けていても「+24,700」、
// 最高値が下がったのに「▲+12,000」と流れていた（本番の複製でテロップ 120 件中 56 件が最高値の動きと食い違った）
const TICK_MAX = 12;
const tick = { key: null, items: [], paused: false };
// 店の入力ミスが直っただけらしい動き（2026-09-29 ユーザー指示: RTX 5070 Ti 250,200→150,200、他店は約 15 万）: 前の最高値が前の時点の 2 位の
// TICK_FIX 倍を超えて離れていて、下げでその開きの半分以上が縮んだ動き。本番の複製（1,071 件の候補）で 1.5 倍が消すのは 4 件（RTX 5070 Ti・
// 1 店だけ他店の 1.5〜1.7 倍だった 3 商品が他店の近くまで下げた）。1.4 倍では加えて 3 件（DQVII など）、「開きの半分以上」の条件が無いと
// 他店よりずっと高い店の小さな値動き（シャイニースターV BOX 17,000→16,500、2 位は 2,000 など）まで消えるので付けた
// 上げにも同じ規則（2026-09-29 ユーザー了承「おすすめどおり」）: 上がった後の最高値が今の 2 位の TICK_FIX 倍を超えて離れていて（1 店だけが
// 大きく離れた）、その開きの半分以上がこの上げでできた動きは、店の入力ミスらしいので流さない。本番の複製（9/29 17 時まで・上げの候補 609 件）で
// 1.5 倍に当たる上げは 0 件。1.4 倍（以上）にすると AQUOS wish6 SH-M36 の 2 商品（ゲストモバイル 28,700→35,200。他の店の同じ機種も 35,000 前後＝
// 正しい上げ）が消え、Dyson CameraJet（買取商店 40,000→70,000、2 位 50,000＝1.40 倍。2 色が同時に同じ額に上がり入力ミスとは言い切れない）と
// 比では見分けられないので 1.5 倍のまま。「開きの半分以上」が無いと、前から他店よりずっと高い店の小さな上げも消える（1.5 倍で 5 件・1.4 倍で 15 件。
// arrows We2 +800・2 位の 1.43 倍など）
// 上げのもう 1 つの規則（2026-09-29 メインの判断）: 最高値の店が自分の価格を 5 割以上（TICK_JUMP 倍以上）上げ、かつ上がった後の最高値が
// 今の 2 位の TICK_JUMP_GAP 倍を超える上げも流さない（Dyson CameraJet: 買取商店 40,000→70,000＝自店 1.75 倍・2 位 50,000 の 1.40 倍）。
// 本番の複製（9/29 23 時の試験取得まで・上げの候補 615 件）で自店が 5 割以上上げたのは 4 件で、Dyson 以外の 3 件は他店に追いついた上げ
// （HD-LX1225 15,000→32,500＝2 位と同額・GARMIN Instinct 2 20,000→42,000＝2 位の 1.05 倍・MQ10201 1,600→2,500＝1.09 倍）なので 1.3 倍で分ける。
// AQUOS wish6 SH-M36（28,700→35,200＝自店 1.23 倍・2 位の 1.41 倍）・BOSE QC Ultra Earbuds ルナブルー（自店 1.30 倍）は自店の上げが 5 割未満なので流す
const TICK_FIX = 1.5, TICK_JUMP = 1.5, TICK_JUMP_GAP = 1.3;
// offs = offersOf(p)（高い順）→ 最高値の動き（動いた店が無ければ 0）。prev2 = 前の時点の 2 位、cur2 = 今の 2 位（店が 1 つなら 0）、
// own = 今の最高値の店の自店の上げ（今の価格 ÷ 前回の価格。直近 RECENT_DAYS 日に上げていなければ 1）
function tickMove(offs) {
  let moved = false;
  const pv = offs.map((x) => { const d = recentChange(x); if (d) moved = true; return d ? x[2] : x[1]; }).sort((a, b) => b - a);
  const prev = pv[0] || 0, prev2 = pv[1] || 0, cur = offs[0] ? offs[0][1] : 0, cur2 = offs[1] ? offs[1][1] : 0;
  const own = offs[0] && offs[0][2] > 0 && recentChange(offs[0]) > 0 ? offs[0][1] / offs[0][2] : 1;
  return moved && prev > 0 ? { d: cur - prev, prev, prev2, cur, cur2, own } : { d: 0, prev, prev2, cur, cur2, own };
}
const tickFixLike = ({ d, prev, prev2, cur, cur2, own = 1 }) =>
  (d < 0 && prev2 > 0 && prev > prev2 * TICK_FIX && -d >= (prev - prev2) / 2) ||   // 下げ: 離れていた最高値が他店の近くまで戻った
  (d > 0 && cur2 > 0 && cur > cur2 * TICK_FIX && d >= (cur - cur2) / 2) ||         // 上げ: 1 店だけが他店から大きく離れた
  (d > 0 && cur2 > 0 && own >= TICK_JUMP && cur > cur2 * TICK_JUMP_GAP);             // 上げ: 1 店が自店の価格を 5 割以上上げて他店から離れた
function tickerItems() {
  const out = [];
  for (const p of st.data[st.cat] || []) {
    const offs = offersOf(p), o = offs[0];
    // 1 店だけの商品と、店の入力ミスらしい極端な動き（前の最高値の半分を超える上げ下げ）・入力ミスが直っただけらしい下げと 1 店だけが離れた上げ（tickFixLike）は流さない
    // （2026-09-29: 「−855,000」「PRIME-RTX5070TI −100,000」が流れていた）
    if (!o || offs.length < 2) continue;
    const m = tickMove(offs), d = m.d;
    if (d && Math.abs(d) <= m.prev * 0.5 && !tickFixLike(m)) out.push({ p, o, d });
  }
  out.sort((a, b) => Math.abs(b.d) - Math.abs(a.d) || b.o[1] - a.o[1]);
  return out.slice(0, TICK_MAX);
}
const tkName = (n) => { const s = String(n); return s.length > 28 ? s.slice(0, 27) + "…" : s; };
// 同じテロップの中で、頭で切ると同じ名前に見える商品（色・サイズ違い。違いは名前の末尾にあることが多い）だけ、頭と末尾を残して
// 真ん中を詰める。それでも同じに見えれば、違う所から見せる。ほかの商品は tkName のまま
// （2026-09-29 組み合わせの QA: 本番の複製で 11 カテゴリ中 6 つのテロップに「Apple Watch Ultra 4 GPS+Cel…」が 3 つ並ぶ等、
//   別の商品（バンドの S・M・L）が同じ名前・同じ額に見えて、同じ商品が何度も流れているように見えた）
function tkNames(items) {
  const full = items.map((x) => String(x.p.n)), head = full.map(tkName);
  const clash = (arr, i) => arr.some((h, j) => j !== i && h === arr[i]);
  const mid = head.map((h, i) => (clash(head, i) && full[i].length > 28 ? full[i].slice(0, 22).trimEnd() + "…" + full[i].slice(-12).trimStart() : h));
  return mid.map((h, i) => {
    if (!clash(mid, i)) return h;
    const grp = full.filter((_, j) => mid[j] === h);
    let k = 0;
    while (k < full[i].length && grp.every((n) => n[k] === full[i][k])) k++;
    if (k >= full[i].length) return h;  // 名前がまったく同じ（詰め方では見分けられない）
    return full[i].slice(0, 20).trimEnd() + "…" + full[i].slice(k, k + 15).trim() + (full[i].length > k + 15 ? "…" : "");
  });
}
function renderTicker() {
  const el = $("ticker");
  if (!el) return;
  if (!boardSkin() || !st.status) { el.hidden = true; return; }
  // 同じカテゴリ・同じ比較の設定なら作り直さない（検索の 1 文字ごと・「もっと見る」で流れ直さないように）
  const key = [st.cat, (st.data[st.cat] || []).length, [...hidden].sort().join(","), includeStore].join("|");
  if (tick.key === key && !el.hidden) return;
  tick.key = key; tick.items = tickerItems();
  el.hidden = false;
  const items = tick.items;
  if (!items.length) {
    el.innerHTML = `<div class="tk-empty">直近 ${RECENT_DAYS} 日に最高値が動いた商品はありません${(st.data[st.cat] || []).length ? "" : "（読み込み中）"}</div>`;
    return;
  }
  const names = tkNames(items);
  const one = (x, i, dup) => `<button type="button" class="tk ${x.d > 0 ? "up" : "down"}" data-tk="${i}"${dup ? ' tabindex="-1" aria-hidden="true"' : ""} title="${esc(x.p.n)}（最高値の店 ${esc(shortName(x.o[0]))}）">` +
    `<span class="tk-a" aria-hidden="true">${x.d > 0 ? "▲" : "▼"}</span><span class="sr-only">${x.d > 0 ? "値上がり" : "値下がり"}</span>` +
    `<span class="tk-n">${esc(names[i])}</span><span class="tk-p">${num(x.o[1])}</span>` +
    `<span class="tk-d">${x.d > 0 ? "+" : "−"}${num(Math.abs(x.d))}</span><span class="tk-s">${esc(shortName(x.o[0]))}</span></button>`;
  const list = items.map((x, i) => one(x, i, false)).join("");
  el.innerHTML = `<div class="tk-view"><div class="tk-track">${list}</div></div>` +
    `<button type="button" class="tk-pause" aria-pressed="${tick.paused}" title="テロップを止める・流す" aria-label="テロップを止める">${tick.paused ? "▶" : "Ⅱ"}</button>`;
  const view = el.querySelector(".tk-view"), track = el.querySelector(".tk-track");
  // 画面に収まらない時だけ流す（同じ並びを 2 つつなげて、半分進んだら頭に戻す＝切れ目なく流れる）
  const moving = !reduceMotion() && track.scrollWidth > view.clientWidth + 4;
  el.classList.toggle("moving", moving);
  el.querySelector(".tk-pause").hidden = !moving;
  if (moving) {
    const w = track.scrollWidth;
    track.insertAdjacentHTML("beforeend", items.map((x, i) => one(x, i, true)).join(""));
    track.style.setProperty("--tkdur", Math.max(18, Math.round(w / 55)) + "s");  // 1 秒に約 55px
  }
  el.classList.toggle("paused", tick.paused);
}
function tickBind() {
  const el = $("ticker");
  if (!el) return;
  el.addEventListener("click", (e) => {
    const pb = e.target.closest(".tk-pause");
    if (pb) {
      tick.paused = !tick.paused; el.classList.toggle("paused", tick.paused);
      pb.setAttribute("aria-pressed", tick.paused); pb.textContent = tick.paused ? "▶" : "Ⅱ";
      pb.setAttribute("aria-label", tick.paused ? "テロップを流す" : "テロップを止める");
      return;
    }
    const b = e.target.closest("[data-tk]");
    if (b) { const x = tick.items[+b.dataset.tk]; if (x) tickJump(x.p); }
  });
}
// その商品へ移る。今の一覧の近く（「もっと見る」2 回分まで）ならそこまで出して移り、遠い・今の一覧に無い時は、その商品を検索する
// （JAN があれば JAN、無ければ名前。「すべて」で 4 千件先まで描き足すと重いので）。移った先を少しの間 金色の枠で示す
// 「最高値の値動き」を開いている時は、その商品が値動きの一覧にあればそこへ、無ければ値動きを閉じていつもの一覧で探す
// （2026-09-29 組み合わせの QA: 値動きを開いたまま押すと、値動きの一覧を JAN で絞って 0 件になり、
//   「今の絞り込み（★のみ・状態など）で隠れています」と実際と違う理由を出して止まっていた）
function tickJump(p) {
  if (st.mvOn && st.rows.indexOf(p) < 0 && typeof setMv === "function") setMv(false);
  let i = st.rows.indexOf(p);
  if (i < 0 || i >= st.shown + 2 * PAGE) {
    $("q").value = /^\d{8,14}$/.test(p.j || "") ? p.j : p.n;
    filterRows();
    i = st.rows.indexOf(p);
    if (i < 0) { if (typeof toast === "function") toast("その商品は、今の絞り込み（★のみ・状態など）で隠れています"); return; }
  }
  if (i >= st.shown) { st.shown = Math.ceil((i + 1) / PAGE) * PAGE; renderList(); }
  const table = !$("tableWrap").hidden;
  const el = table ? $("table").querySelector(`tbody tr[data-i="${i}"]:not(.profrow)`) : $("list").children[i];
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: scrollMotion() });
  // 前に示した商品の枠は消す（2026-09-29 組み合わせの QA: 同じ一覧の 2 件を 2 秒以内に続けて押すと、前の商品の枠を消す予定が
  // 取り消され、描き直すまで金色の枠が残っていた）
  if (tickJump.el && tickJump.el !== el) tickJump.el.classList.remove("tk-hit");
  tickJump.el = el;
  el.classList.remove("tk-hit"); void el.offsetWidth; el.classList.add("tk-hit");
  clearTimeout(tickJump.t); tickJump.t = setTimeout(() => el.classList.remove("tk-hit"), 2000);
  // 移る先は商品名（無ければ最初のボタン）。「.name, button」だと PC の表では行の頭の「＋」（在庫に追加）に移り、
  // 続けて Enter を押すと在庫に入っていた（2026-09-30 再総チェック）
  const f = el.querySelector(".name") || el.querySelector("button");
  if (f && typeof f.focus === "function") { if (!f.hasAttribute("tabindex") && f.tagName !== "BUTTON") f.setAttribute("tabindex", "-1"); f.focus({ preventScroll: true }); }
}

// ---- 最高値を数える演出（取引所だけ。カテゴリを開いた時・取引所に切り替えた時の 1 回。動きを減らす設定の端末ではしない）----
const skinAnim = { cat: null, raf: 0 };
function countUp() {
  if (!boardSkin() || reduceMotion() || skinAnim.cat === st.cat) return;
  const els = [...document.querySelectorAll("#list .p-best .amt[data-v]")].slice(0, 24);
  if (!els.length) return;
  skinAnim.cat = st.cat;
  cancelAnimationFrame(skinAnim.raf);
  const tg = els.map((el) => { el.style.minWidth = el.textContent.length + "ch"; return [el, +el.dataset.v]; });
  const t0 = performance.now(), D = 700;
  const done = () => { for (const [el, v] of tg) if (el.isConnected) { el.textContent = yen(v); el.style.minWidth = ""; } };
  const step = (t) => {
    const k = Math.min(1, Math.max(0, (t - t0) / D)), e = 1 - Math.pow(1 - k, 3);
    if (k >= 1) return done();
    for (const [el, v] of tg) if (el.isConnected) el.textContent = yen(Math.round(v * e));
    skinAnim.raf = requestAnimationFrame(step);
  };
  skinAnim.raf = requestAnimationFrame(step);
  setTimeout(done, D + 400);  // 裏に回って描画が止まった時も、最後は必ず本当の額に戻す
}

// ---- PC のカテゴリの縦並び（取引所だけ）: ヘッダーの下端から始める（上の赤い帯の有無・スクロールで変わる）----
function sideTop() {
  if (!boardSkin() || !wide.matches) return;
  const top = document.querySelector(".top");
  if (top) document.documentElement.style.setProperty("--sideTop", Math.max(0, Math.round(top.getBoundingClientRect().bottom)) + "px");
}
let sideRaf = 0;
const sideLater = () => { if (!sideRaf) sideRaf = requestAnimationFrame(() => { sideRaf = 0; sideTop(); }); };

// app.js の renderList が描いた後に呼ぶ
function skinAfter() { renderTicker(); countUp(); sideTop(); }

(function skinInit() {
  const b = $("skinBtn");
  if (b) b.addEventListener("click", () => skinSet(skinGet() === "board" ? "classic" : "board"));
  skinLabel(); tickBind();
  addEventListener("scroll", sideLater, { passive: true });
  // 幅が変わった時だけテロップを作り直す（流すかどうかが変わる）。スマホはスクロールでアドレスバーが出入りして高さだけ変わる resize が続くので、それでは作り直さない
  let lastW = innerWidth;
  addEventListener("resize", () => { sideLater(); if (innerWidth !== lastW) { lastW = innerWidth; if (boardSkin() && st.status) { tick.key = null; renderTicker(); } } });
  const top = document.querySelector(".top");
  // ヘッダーの上の赤い帯（#stale）が出入りした時も合わせる（2026-09-29 組み合わせの QA: 開いたまま赤い帯が出ると、ヘッダーが下がるのに
  // 縦並びは元の位置のままで、スクロールするまで検索欄の左側に重なっていた）
  if (top && window.ResizeObserver) { const ro = new ResizeObserver(sideLater); ro.observe(top); if ($("stale")) ro.observe($("stale")); }
  const mq = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)");
  if (mq && mq.addEventListener) mq.addEventListener("change", () => { tick.key = null; renderTicker(); });
})();
