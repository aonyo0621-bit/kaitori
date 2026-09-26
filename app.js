"use strict";
// 買取価格比較: data/*.json（暗号化時は *.enc）を読み、商品ごとに各店の価格を並べる。
// 表示は「ランキング」（商品ごとに高い店順。店が増えても横に伸びない）と「店別の表」（PC 向け）。
const $ = (id) => document.getElementById(id);
const PAGE = 50;
const RECENT_DAYS = 7;          // この日数以内に変わった価格に前回比を出す
const TOP_PC = 6, TOP_SP = 3;   // ランキングで最初に見せる店の数

const st = { shopSort: null, mode: null, pw: null, status: null, sites: {}, cat: null, data: {}, hist: {},
  shown: PAGE, rows: [], view: "rank", open: new Set() };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let favs = new Set(store.get("favs", []));
let hidden = new Set(store.get("hiddenShops", []));  // 比較から外した店
let includeStore = store.get("includeStore", false);  // 来店のみの価格も最高値・順位・計算に含めるか
const wide = matchMedia("(min-width: 1000px)");
const dark = matchMedia("(prefers-color-scheme: dark)");

// ---- 読み込み・復号 ----
async function decrypt(b64, pw) {
  const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const salt = buf.slice(0, 16), iv = buf.slice(16, 28), body = buf.slice(28);
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: st.mode.iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const packed = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body); // 中身は gzip
  const plain = new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(plain).text());
}
async function load(name) {
  const bust = st.status ? "?v=" + encodeURIComponent(st.status.generated) : "?t=" + Date.now();
  if (!st.mode.encrypted) return (await fetch(`data/${name}.json${bust}`)).json();
  const r = await fetch(`data/${name}.enc${bust}`);
  if (!r.ok) throw new Error(r.status);
  return decrypt(await r.text(), st.pw);
}

// ---- 小道具 ----
const yen = (n) => "¥" + n.toLocaleString("ja-JP");
const num = (n) => n.toLocaleString("ja-JP");
// 店から取ったリンクは http(s) だけ通す（javascript: などを防ぐ）
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const siteName = (id) => st.sites[id]?.name || id;
const shortName = (id) => st.sites[id]?.short || siteName(id);
const fmtTime = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
// 店ごとの色（ランキング・表・グラフで共通）。黄金角で色相を散らす
function shopColor(id) {
  const i = Math.max(0, st.status.sites.findIndex((s) => s.id === id));
  return `hsl(${(i * 137.508 + 200) % 360} 62% ${dark.matches ? 62 : 44}%)`;
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
const offersOf = (p) => p.o.filter((o) => !hidden.has(o[0]) && !isOut(o) && (includeStore || !isStore(o)));  // 比較に使う価格（高い順）
const storeOffersOf = (p) => p.o.filter((o) => !hidden.has(o[0]) && (isOut(o) || (!includeStore && isStore(o))));  // 別枠（来店のみ・桁違いの疑い）
const seriesKey = (o) => o[0] + (isStore(o) ? "#store" : "");
// o[8] = 最低買取数（無ければ 1）。これ未満の個数では売れないので、売り先計算はカートの個数で候補を絞る
const storeTag = (o) => (isStore(o) ? `<span class="storetag" title="郵送では売れない、来店・持ち込みのみの価格">来店のみ</span>` : "") +
  (isOut(o) ? `<span class="storetag" title="他の店と桁違いの価格（高すぎ・安すぎ）。店側の誤掲載か読み取りの誤りの疑いがあるので、最高値・順位・差の計算・売り先計算から外している">桁違いの疑い</span>` : "") +
  (o[8] > 1 ? `<span class="storetag" title="この個数からしか買い取らない（売り先計算は個数が足りない時は候補にしない）">最低${num(o[8])}個</span>` : "");
function moveScore(p) { return Math.max(0, ...offersOf(p).map((o) => Math.abs(recentChange(o)) / Math.max(o[2] || 1, 1))); }
function spread(p) { const o = offersOf(p); return o.length > 1 ? o[0][1] - o[o.length - 1][1] : 0; }
// 価格の順位（同じ価格は同じ順位）。色分けは 1〜3 位だけ
const rankOf = (offers) => { const u = [...new Set(offers.map((o) => o[1]))].sort((a, b) => b - a); return (price) => u.indexOf(price) + 1; };
const rcls = (r) => (r >= 1 && r <= 3 ? ` r${r}` : "");
const favKey = (p) => p.id; // 商品の固定番号（照合キーから作る。公開のたびに変わらない）

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
  const mk = (k, w) => ({ k, db: /^\d{1,2}(?!\d)/.test(k), de: /(?<!\d)\d{1,2}$/.test(k), jan: /^\d{8,}$/.test(k), re: tokenRe(k, w) });
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
    } else if (!hitShort(p, t) && !(t.jan && p.j.includes(t.k))) {  // JAN は 8 桁以上の数字の時だけ見る
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
    if (s.closed_today) tag = `<span class="tag closed">${esc(s.closed_today)}</span>`;
    else if (s.last_status === "ok") tag = `<span class="tag ok">正常</span>`;
    else if (s.last_status === "partial") { tag = `<span class="tag warn" title="${esc(s.last_message)}">一部失敗</span>`; warn++; }
    else if (s.last_status === "error") { tag = `<span class="tag err" title="${esc(s.last_message)}">失敗</span>`; warn++; }
    else tag = `<span class="tag closed">未取得</span>`;
    ul.insertAdjacentHTML("beforeend", `<li>${dot(s.id)}<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">${esc(s.name)}</a>
      <span class="muted">${s.last_ok ? fmtTime(s.last_ok) : ""}</span>${tag}</li>`);
  }
  $("shops").querySelector("summary").innerHTML = `取得状況 <span class="muted">${st.status.sites.length} 店${warn ? ` ・ <b class="err">要確認 ${warn}</b>` : ""}</span>`;
  $("shops").hidden = false;
}
function renderShopPick() {
  const shops = st.status.sites.filter((s) => s.enabled);
  $("shopPickCount").textContent = `${shops.filter((s) => !hidden.has(s.id)).length}/${shops.length}`;
  $("shopPick").innerHTML = `<div class="pickhead"><b>比較する店</b><span><button data-all="1">すべて</button><button data-all="0">すべて外す</button></span></div>
    <div class="pickgrid">${shops.map((s) => `<label>${dot(s.id)}<input type="checkbox" value="${s.id}" ${hidden.has(s.id) ? "" : "checked"}>${esc(s.name)}</label>`).join("")}</div>
    <label class="storeopt"><input type="checkbox" id="includeStore" ${includeStore ? "checked" : ""}> 来店専用・持ち込み限定の価格も、最高値・順位・売り先計算に含める</label>
    <p class="muted">外した店は、ランキング・表・最高値・売り先計算から除きます。来店専用の価格は、含めない時も「来店のみ」として別に表示します（この端末に保存）。</p>`;
  $("includeStore").onchange = (e) => { includeStore = e.target.checked; store.set("includeStore", includeStore); filterRows(); };
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
  let hits = hitsOf(Q.strict), looseExtra = 0, autoLoose = false;
  if (Q.merged) {
    const lh = hitsOf(Q.loose);
    const shown = (m) => [...m.keys()].filter((p) => visible(p) && (!favOnly || favs.has(favKey(p)))).length;
    looseExtra = shown(lh) - shown(hits);
    if (st.useLoose || !shown(hits)) { autoLoose = !st.useLoose && looseExtra > 0; hits = lh; }
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
  let moved = -1;
  if (sort === "price") rows.sort(byPrice);
  else if (sort === "move") {  // 値動きのあった商品を先に。動きの無い商品も消さずに後ろへ（価格の高い順）
    const sc = new Map(rows.map((p) => [p, moveScore(p)]));
    rows.sort((a, b) => sc.get(b) - sc.get(a) || byPrice(a, b));
    moved = rows.filter((p) => sc.get(p) > 0).length;
  }
  else if (sort === "spread") rows.sort((a, b) => spread(b) - spread(a));
  else if (sort === "shops") rows.sort((a, b) => offersOf(b).length - offersOf(a).length || top(b) - top(a));
  if (st.shopSort) { // 表で店の列見出しを押した時: その店の価格の高い順（扱いの無い商品は後ろ）
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
        if (r && !(r.near && st.nearOff)) n++;
      }
      return n; };
      const cntL = (toks) => (toks.some((t) => t.cf) && cnt(literal(toks))) || cnt(toks);
      other = cntL(st.useLoose ? Q.loose : Q.strict);
      if (!other && Q.merged && !st.useLoose) other = cntL(Q.loose);
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
  renderSummary({ Q, hid, looseExtra, autoLoose, moved, other, noColor });
  renderKpis();
  renderList();
}
// 検索した色（例: ホワイト）の名前が無く、近い色（例: シルバー）で当たった商品に付ける印
const nearTag = (p) => {
  const w = st.near && st.near.get(p.id);
  return w ? ` <span class="neartag" title="商品名に「${esc(st.nearColor)}」は無く、近い色「${esc(w)}」として表示しています">近い色: ${esc(w)}</span>` : "";
};
// 件数と「何が隠れているか」。隠れている理由ごとに、戻す操作を付ける
function renderSummary({ Q, hid, looseExtra, autoLoose, moved, other, noColor }) {
  const notes = [];
  const btn = (act, label) => `<button class="linkbtn" data-act="${act}">${label}</button>`;
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

// ---- ランキング表示（PC・スマホ共通。店が増えても横に伸びない）----
function rankChip(o, i, best, rk = () => 0) {
  const diff = o[1] - best;
  const title = [siteName(o[0]), o[5], o[6], o[3] ? "価格変更 " + fmtTime(o[3]) : ""].filter(Boolean).join(" / ");
  return `<li class="${i === 0 ? "first" : ""}${isStore(o) && !includeStore ? "" : rcls(rk(o[1]))}"><a href="${esc(safeUrl(o[4]))}" target="_blank" rel="noopener" title="${esc(title)}">
    <span class="rk">${i + 1}</span>${dot(o[0])}<span class="sn">${esc(shortName(o[0]))}</span>
    <span class="pr">${num(o[1])}</span>${i ? `<span class="df">${diff ? "−" + num(-diff) : "同額"}</span>` : ""}${storeTag(o)}${chgHtml(recentChange(o))}</a></li>`;
}
function renderRank() {
  const ul = $("list"); ul.innerHTML = "";
  const topN = wide.matches ? TOP_PC : TOP_SP;
  for (const p of st.rows.slice(0, st.shown)) {
    const stores = storeOffersOf(p), offers = offersOf(p), fk = favKey(p);
    const best = offers[0] || stores[0], onlyStore = !offers.length;
    const open = st.open.has(p.id), shown = open ? offers : offers.slice(0, topN);
    const li = document.createElement("li"); li.className = "prod";
    const lead = offers[1] ? offers[0][1] - offers[1][1] : null;
    li.innerHTML = `
      <div class="p-main">
        <div class="p-title"><span class="name" title="クリックで価格の推移">${esc(p.n)}</span>${nearTag(p)}</div>
        <div class="p-meta">${[p.m && esc(p.m), p.j && "JAN " + esc(p.j), `${offers.length} 店が買取`, stores.some(isStore) && `来店のみ ${stores.filter(isStore).length} 店`, stores.some(isOut) && "桁違いの疑い 1 件"].filter(Boolean).join(" ・ ")}</div>
        <div class="p-acts">
          <button class="add" title="在庫リストに追加（売り先計算）">＋ 在庫に追加</button>
          <button class="fav${favs.has(fk) ? " on" : ""}" aria-label="お気に入り" title="お気に入り">★</button>
          <button class="hist" title="価格の推移">推移</button>
        </div>
      </div>
      <div class="p-best${onlyStore ? " storeonly" : ""}">
        <span class="lbl">${onlyStore ? "来店のみの価格" : "最高値"}</span>
        <span class="amt">${yen(best[1])}</span>
        <span class="bshop">${dot(best[0])}${esc(siteName(best[0]))}</span>
        ${onlyStore ? `<span class="lead">郵送では売れません</span>` : lead !== null ? `<span class="lead">${lead ? `2位より +${num(lead)}` : "2位と同額"}</span>` : `<span class="lead">1 店のみ</span>`}
      </div>
      <div class="p-rank">
        <ol>${shown.map((o, i) => rankChip(o, i, best[1], rankOf(offers))).join("")}</ol>
        ${offers.length > topN ? `<button class="morebtn">${open ? "上位だけ表示" : `他 ${offers.length - topN} 店を表示`}</button>` : ""}
        ${stores.length ? `<div class="storebox"><span class="storehead">${stores.some(isOut) && !stores.some(isStore) ? "桁違いの疑いがある価格（最高値に含めていません）" : "来店・持ち込みのみの価格（郵送不可・最高値に含めていません）"}</span><ol>${stores.map((o) => rankChip(o, -1, best[1])).join("")}</ol></div>` : ""}
      </div>`;
    li.querySelector("button.add").onclick = () => cartAdd(p);
    li.querySelector("button.fav").onclick = (e) => toggleFav(e.currentTarget, fk);
    const chart = () => toggleChart(li, p);
    li.querySelector(".name").onclick = chart; li.querySelector("button.hist").onclick = chart;
    const mb = li.querySelector(".morebtn");
    if (mb) mb.onclick = () => { open ? st.open.delete(p.id) : st.open.add(p.id); renderList(); };
    ul.append(li);
  }
}
function toggleFav(btn, fk) {
  favs.has(fk) ? favs.delete(fk) : favs.add(fk);
  btn.classList.toggle("on"); store.set("favs", [...favs]);
}

// ---- 店別の表（PC 向け。列 = 比較する店）----
function renderTable() {
  const rows = st.rows.slice(0, st.shown);
  // 列は「表示中の商品のどれかに価格がある店」だけ（店が多くても、絞り込むと列が減って見やすい）
  const has = new Set(rows.flatMap((p) => [...offersOf(p), ...storeOffersOf(p)].map((o) => o[0])));
  const cols = st.status.sites.filter((s) => s.enabled && !hidden.has(s.id) && has.has(s.id)).map((s) => s.id), tbl = $("table");
  const head = cols.map((id) => `<th class="shop${st.shopSort === id ? " sorted" : ""}" data-site="${id}" title="${esc(siteName(id))}：クリックでこの店の高い順">
    <span class="bar" style="background:${shopColor(id)}"></span>${esc(shortName(id))}</th>`).join("");
  let html = `<thead><tr><th class="acts"></th><th class="pname">商品</th><th class="num">最高値</th>${head}</tr></thead><tbody>`;
  rows.forEach((p, i) => {
    const offers = offersOf(p), stores = storeOffersOf(p), fk = favKey(p);
    const by = Object.fromEntries([...stores, ...offers].reverse().map((o) => [o[0], o]));  // 郵送の価格を優先
    const top = offers[0] || stores[0], best = top[1];
    html += `<tr data-i="${i}"><td class="acts"><button class="add" title="在庫リストに追加">＋</button><button class="fav${favs.has(fk) ? " on" : ""}" aria-label="お気に入り">★</button></td>
      <td class="pname"><span class="name" title="クリックで価格の推移">${esc(p.n)}</span>${nearTag(p)}<div class="meta">${[p.m && esc(p.m), p.j && "JAN " + esc(p.j)].filter(Boolean).join(" ・ ")}</div></td>
      <td class="num topv">${num(best)}${offers.length ? "" : storeTag(top)}<div class="meta">${dot(top[0])}${esc(shortName(top[0]))}</div></td>
      ${cols.map((id) => cell(by[id], best, rankOf(offers))).join("")}</tr>`;
  });
  tbl.innerHTML = html + "</tbody>";
  tbl.querySelectorAll("th.shop").forEach((th) => th.onclick = () => {
    st.shopSort = st.shopSort === th.dataset.site ? null : th.dataset.site; filterRows();
  });
  tbl.querySelectorAll("tbody tr[data-i]").forEach((tr) => {
    const p = rows[+tr.dataset.i], fk = favKey(p);
    tr.querySelector("button.add").onclick = () => cartAdd(p);
    tr.querySelector("button.fav").onclick = (e) => toggleFav(e.currentTarget, fk);
    tr.querySelector(".name").onclick = () => {
      const next = tr.nextElementSibling;
      if (next && next.classList.contains("chartrow")) return next.remove();
      const row = document.createElement("tr"); row.className = "chartrow";
      row.innerHTML = `<td colspan="${cols.length + 3}"></td>`;
      tr.after(row); toggleChart(row.firstChild, p);
    };
  });
}
// 順位で色分け（1 位 = 濃い緑の塗り、2 位 = 中間、3 位 = 薄い、4 位以下 = 無色）
function cell(o, best, rk) {
  if (!o) return `<td class="na">·</td>`;
  if (isOut(o) || (isStore(o) && !includeStore))  // 来店のみ・桁違いの疑い: 色の濃さ（最高値との差）には含めない
    return `<td class="store"><a href="${esc(safeUrl(o[4]))}" target="_blank" rel="noopener" title="${esc(siteName(o[0]) + (isOut(o) ? " / 他店と桁違いの価格（誤掲載の疑い） / " : " / 来店・持ち込みのみ（郵送不可） / ") + (o[6] || ""))}">${num(o[1])}</a>${storeTag(o)}</td>`;
  const r = rk(o[1]);
  const title = [siteName(o[0]), o[5], o[6], best - o[1] ? `最高値との差 −${num(best - o[1])}` : "最高値", o[3] ? "価格変更 " + fmtTime(o[3]) : ""].filter(Boolean).join(" / ");
  return `<td class="${rcls(r).trim()}"><a href="${esc(safeUrl(o[4]))}" target="_blank" rel="noopener" title="${esc(title)}">${num(o[1])}</a>${chgHtml(recentChange(o))}</td>`;
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
  nav.querySelectorAll("button").forEach((b) => b.onclick = () => $("list").children[+b.dataset.i]?.scrollIntoView({ block: "start", behavior: "smooth" }));
  nav.hidden = false;
}
function renderList() {
  document.documentElement.style.setProperty("--hdr", document.querySelector(".top").offsetHeight + "px");
  const table = st.view === "table" && wide.matches;
  $("list").hidden = table; $("tableWrap").hidden = !table;
  $("viewSeg").hidden = !wide.matches;
  table ? renderTable() : renderRank();
  renderJumps(!table);
  $("more").hidden = st.rows.length <= st.shown;
  $("more").textContent = `もっと見る（残り ${num(Math.max(0, st.rows.length - st.shown))} 件）`;
}

// ---- 価格の推移 ----
async function toggleChart(host, p) {
  const old = host.querySelector(".chart");
  if (old) return old.remove();
  const box = document.createElement("div"); box.className = "chart"; box.textContent = "推移を読み込み中…";
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
  const xs = lines.flatMap(([, s]) => s.map((v) => v[0])), ys = lines.flatMap(([, s]) => s.map((v) => v[1]));
  const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1), pad = (Math.max(...ys) - Math.min(...ys)) * 0.1 || Math.max(...ys) * 0.05 || 1;
  const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad, W = Math.max(280, Math.round(box.clientWidth || 600)), H = 200, L = 60, B = 22;
  const X = (x) => L + (x - x0) / (x1 - x0) * (W - L - 8), Y = (y) => 8 + (y1 - y) / (y1 - y0) * (H - B - 8);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="価格推移">`;
  for (let i = 0; i <= 3; i++) {
    const v = y0 + (y1 - y0) * i / 3;
    svg += `<line x1="${L}" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" stroke="currentColor" stroke-opacity=".1"/>
      <text x="${L - 6}" y="${Y(v) + 4}" font-size="11" text-anchor="end" fill="currentColor" fill-opacity=".55">${num(Math.round(v))}</text>`;
  }
  const d0 = new Date(x0 * 6e4), d1 = new Date(x1 * 6e4);
  svg += `<text x="${L}" y="${H - 4}" font-size="11" fill="currentColor" fill-opacity=".55">${d0.getMonth() + 1}/${d0.getDate()}</text>
    <text x="${W - 4}" y="${H - 4}" font-size="11" text-anchor="end" fill="currentColor" fill-opacity=".55">${d1.getMonth() + 1}/${d1.getDate()}</text>`;
  let legend = "";
  for (const [o, s] of lines) {
    let path = `M${X(s[0][0])},${Y(s[0][1])}`;
    for (let i = 1; i < s.length; i++) path += `H${X(s[i][0])}V${Y(s[i][1])}`; // 階段状（価格は次の変更まで続く）
    svg += `<path d="${path}" fill="none" stroke="${shopColor(o[0])}" stroke-width="2" ${isStore(o) ? 'stroke-dasharray="5 4"' : ""} vector-effect="non-scaling-stroke"/>`;
    legend += `<span>${dot(o[0])}${esc(shortName(o[0]))}${isStore(o) ? "（来店のみ・点線）" : ""}</span>`;
  }
  box.innerHTML = svg + `</svg><div class="legend">${legend}</div>`;
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
async function start() {
  st.status = await load("status");
  for (const s of st.status.sites) st.sites[s.id] = s;
  $("updated").textContent = "更新 " + fmtTime(st.status.generated);
  const cond = $("cond");
  cond.innerHTML = `<option value="">すべての状態</option>` +
    Object.entries(st.status.conditions).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  cond.value = "";
  $("gate").hidden = true; $("controls").hidden = false;
  st.view = store.get("viewPc", "table");  // PC は表が既定（スマホは常にランキング）
  $("viewSeg").querySelectorAll("button").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.view === st.view);
    b.onclick = () => {
      st.view = b.dataset.view; store.set("viewPc", st.view);
      $("viewSeg").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
      renderList();
    };
  });
  $("shopPickBtn").onclick = () => { $("shopPick").hidden = !$("shopPick").hidden; };
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
  st.pw = store.get("pw", null);
  if (st.pw) { try { return await start(); } catch { st.pw = null; } }
  $("gate").hidden = false;
  $("gateForm").onsubmit = async (e) => {
    e.preventDefault(); st.pw = $("pw").value; $("gateErr").hidden = true;
    try { await start(); store.set("pw", st.pw); } catch { $("gateErr").hidden = false; }
  };
})();
