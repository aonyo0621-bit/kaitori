"use strict";
// 設定の控え（① JSON ファイル）と、別の端末への引き継ぎ（② #sync=… のリンクと QR コード）。2026-09-29 ユーザー指示
// 中身: ★・比較から外した店・来店のみを含めるか・在庫リスト（今のリストとその名前）・保存したパターン・送料の設定・仕入れ値・
//       計算の設定（減額・送料・ポイント）・見た目。形式の版番号（v）と作成日時（created）を付ける。
// パスワードは入れない（覚えた鍵は IndexedDB の取り出せない鍵、以前の版の平文 "pw" も集めない）。
// 版 2（2026-09-29 ユーザー了承）: 中身をサイトの価格データと同じ方式で暗号化する（サイトのパスワードの鍵 st.key から PBKDF2（mode.json の
//   iter 回・SHA-256・塩 16 バイト）→ AES-GCM 256（iv 12 バイト）。暗号化する前に gzip）。パスワードを知らない人は中身を読めない
//   （パスワードを知っている家族には読める）。受け取る端末はパスワードで開いた後（鍵がある時）に復号する。復号できない＝別のパスワードで
//   作られた（か書き換わった）時は理由を出して何も変えない。版 1（暗号化なし）のリンク・ファイルも読む（確認画面に「暗号化されていない古い形式」）。
//   パスワードなしのサイト（mode.encrypted = false。試験用）では暗号化できないので、版 2 の暗号化なしで作る。
// 取り込む時は中身を確かめ（cart.js の cleanItem 等・app.js の cleanProfitSet と同じ検査＋件数・長さの上限）、壊れた・巨大・古い／新しい形は
// 取り込まずに理由を出す。何が入っているかを見せて、取り込み方（足し合わせる＝既定／置き換える）を選んでから取り込む。取り込む前の設定は
// 1 つ前の控え（localStorage の "settingsUndo"）に残し「元に戻す」で戻せる（どちらの取り込み方でも）。
// 2026-09-29 独立 QA で足したこと: 取り込み・元に戻すは全部か無しか（保存できない項目が 1 つでもあれば、保存値も画面の値も前に戻す）。
//   取り込んだ後に設定を変えてから「元に戻す」を押すと確かめる（控えに取り込んだ直後の形の目印 after を持つ）。
//   別のタブで取り込んだ・元に戻した時は印の変化（storage の知らせ・画面に戻った時）で、取り込み・元に戻す・書き出し等の前はいつも、
//   画面の値が端末の保存値と違えば読み直す（syncReload）。
// 2026-09-29 ASTRA 指摘（3 回目）で直したこと:
//   「元に戻す」の控えは、取り込みで書く項目の取り込む前の保存値を生の文字列のまま持ち、検査を通さずに書き戻す（1,001 字の名前なども失わない。
//   戻すのは取り込んだ項目だけ）。取り込み・元に戻すのたびに "settingsRev"（時刻＋乱数）を書き、別のタブはその変化でも読み直す（控えを残せない
//   取り込みでも知る）。保存に失敗した項目（app.js の store.miss）は読み直しで古い保存値に戻さず、画面の値を書き出す。戻す書き込みの失敗も
//   確かめて、混ざった可能性を正直に出す。書き出し・リンクは受け取る側と同じ上限で確かめてから作る（syncCheckOut）。#sync= はパスワードの入力の
//   前に URL から消してメモリに持つ。
// 引き継ぎリンクの #sync= の後ろ（先頭 1 字で形を区別）:
//   e = 暗号化（版 2）: base64url(反復回数 4 バイト（大きい桁から）＋塩 16＋iv 12＋暗号文)。暗号文を開くと gzip（無ければ JSON そのまま）
//   z = gzip → base64url（暗号化なし。版 1 か、パスワードなしのサイト）/ j = 圧縮なし（CompressionStream の無いブラウザ）
// 控えのファイル（版 2 の暗号化）: {format, v: 2, enc: SYNC_ENC, iter, body: base64(塩＋iv＋暗号文)}。暗号化なしは {format, v, created, data}
// 受け取った端末では、#sync= は読み込んだらすぐ（パスワードの入力の前でも）URL から消してメモリに持ち、パスワードで開いた後（st.status が
// 読めた後）に内容を見せて確認する。
// 在庫リストの共有リンク #cart=（cart.js）とは別に動く。
// app.js の $, st, store（store.miss・store.label も）, esc, num, yen, fmtDay, jst, favs, hidden, includeStore, profitSet, buyPrices, cleanProfitSet, PROFIT_DEFAULT,
// siteName, renderShopPick, applyHidden, sheetOpen, sheetClose と、cart.js の cart, isObj, cleanItems, cleanPatterns, cleanFees, cartSave,
// cartRender, toast と、skin.js の skinGet, skinSet, SKINS を使う。
// 検査・変換・暗号化・足し合わせの区間（「---- 控えの形（計算）」〜「---- 控え（画面）」）は tests/sync_check.js が node で確かめる。

// ---- 控えの形（計算）----
const SYNC_FORMAT = "kaitori-settings", SYNC_VER = 2;
const SYNC_ENC = "pbkdf2-sha256-aes256gcm";  // 版 2 の暗号化の方式（サイトの価格データと同じ）
const SYNC_ITER = [1e4, 5e6];  // 受け取る反復回数の範囲（書き換えた巨大な回数で固まらないように。今のサイトは 20 万回）
const SYNC_MAX_BYTES = 5e6;    // ファイル・リンクを開いた中身（JSON）の上限（仕入れ値 2.6 万商品でも 1 MB 足らず）
const SYNC_LINK_MAX = 1e6;     // リンクの長さの上限（これより長いリンクは作らず、ファイルを案内する）
const QR_MAX = 2900;           // QR コード（最大の 40 型・誤り訂正 L）に入る長さの目安（バイト）。超えたらリンクだけ
// 件数・長さの上限（超えるものは壊れた・別の目的のファイルとみなして取り込まない。足し合わせた結果もこの上限まで）
// pat = パターン名・在庫リストの名前の長さ。売り先計算の名前の欄に字数の上限は無く、共有リンク（#cart=）の受け取りも 100 字＋「（日付受取）」に
// なるので、100 字だと取り込みで黙って捨て、元に戻すでも消えていた（2026-09-29 独立 QA）。1,000 字にし、超える名前は「読めなかった項目」に出す
const SYNC_LIM = { favs: 50000, hiddenShops: 500, cart: 5000, patterns: 500, patItems: 50000, fees: 500, buyPrices: 100000, id: 200, name: 300, pat: 1000 };
const SKIN_KEYS = ["board", "classic"];
class SyncErr extends Error {}
const syncBig = () => new SyncErr("項目の数・長さが多すぎます（壊れたファイルか、別の目的のファイルの可能性）。取り込みませんでした");
const nullObj = () => Object.create(null);  // "__proto__" 等の名前も普通の名前として扱う入れ物
const WHAT = { link: "リンク", file: "ファイル" };

// 集める（今の端末の設定 → 控えの形）。値は画面が使っている（検査済みの）ものから取る
function syncCollect(now = new Date()) {
  const items = (xs) => xs.map((x) => ({ id: x.id, k: x.k, n: x.n, c: x.c, q: x.q }));
  const pats = nullObj();  // 普通の {} だと「__proto__」という名前のパターンが代入で消える（テストで見つけた）
  for (const [n, p] of Object.entries(cart.patterns)) pats[n] = { items: items(p.items), saved: p.saved };
  return { format: SYNC_FORMAT, v: SYNC_VER, created: now.toISOString(), data: {
    favs: [...favs], hiddenShops: [...hidden], includeStore,
    cart: items(cart.items), cartName: cart.name, patterns: pats, fees: Object.assign(nullObj(), cart.fees),
    buyPrices: Object.assign(nullObj(), buyPrices), profitSet: { ...profitSet }, skin: skinGet(),
  } };
}
// 設定の形の目印（syncCollect().data の形。取り込んだ直後の形と今の形が同じか＝取り込んだ後に設定を変えたかを元に戻す前に見る・
// 画面の値が端末の保存値と同じかを見る）。app.js・cart.js の読み込みと同じ直し方をしてから比べるので、入れ物の項目の並び
// （送料の {ship, free, fee} 等）や、読み込みで直る壊れた値には左右されない。FNV-1a
function syncSig(d) {
  const its = (xs) => cleanItems(xs).map((x) => [x.id, x.k, x.n, x.c, x.q]);
  const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  const ps = cleanProfitSet(d.profitSet);
  const s = JSON.stringify([strs(d.favs), strs(d.hiddenShops), d.includeStore === true, its(d.cart), typeof d.cartName === "string" ? d.cartName : "",
    Object.entries(cleanPatterns(d.patterns)).map(([k, x]) => [k, its(x.items), x.saved]),
    Object.entries(cleanFees(d.fees)).map(([k, f]) => [k, f.ship, f.free, f.fee]), Object.entries(isObj(d.buyPrices) ? d.buyPrices : {}),
    [ps.cut, ps.ship, ps.pt, ps.unit], d.skin === "classic" ? "classic" : "board"]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${s.length}:${(h >>> 0).toString(16)}`;
}
// 設定の形（syncCollect().data）のうち ks の項目だけ（元に戻す項目だけの目印を作る。無い項目は syncSig で既定値になり、両側で同じ）
const syncPick = (d, ks) => Object.fromEntries(ks.filter((k) => k in d).map((k) => [k, d[k]]));
// 確かめる（控えの形 → 取り込める値）。→ {data: 取り込む項目だけ, created, bad: 読めなかった項目の名前, v}。取り込めない時は SyncErr
// 暗号化の包み（enc のあるもの）はここでは受けない（syncOpenRaw が開いてから中身をここに渡す）
// 手で作った値（{"toString": "x"} の個数など）で検査の途中に TypeError 等が出ても、理由の分かる SyncErr にする（2026-09-29 独立 QA）
function syncClean(raw) {
  try { return syncClean0(raw); }
  catch (e) { if (e instanceof SyncErr) throw e; throw new SyncErr("控えの中身の形が正しくありません（壊れているか、別の目的のファイルの可能性）。取り込みませんでした"); }
}
function syncClean0(raw) {
  if (!isObj(raw) || raw.format !== SYNC_FORMAT) throw new SyncErr("買取価格比較の設定の控えではありません（別のファイルか、壊れている可能性）");
  if (!Number.isInteger(raw.v) || raw.v < 1) throw new SyncErr("形式の版がわからない控えです。取り込みませんでした");
  if (raw.v > SYNC_VER) throw new SyncErr("新しい版の画面で作られた控えです。この画面を再読み込み（新しい版に）してから読み込んでください");
  if ("enc" in raw) throw new SyncErr("控えの形が正しくありません（暗号化の包みが二重になっている等）。取り込みませんでした");
  const d = raw.data;
  if (!isObj(d)) throw new SyncErr("控えに中身がありません");
  const out = {}, bad = [];
  const keysOf = (v, max) => { if (!isObj(v)) return null; const k = Object.keys(v); if (k.length > max) throw syncBig(); return k; };
  const strs = (v, max, len) => {
    if (!Array.isArray(v)) return null;
    if (v.length > max) throw syncBig();
    return [...new Set(v.filter((x) => typeof x === "string" && x && x.length <= len))];
  };
  const fixItems = (xs) => {  // cart.js の cleanItems の後で、長すぎる ID は捨て、名前などは長さを切る
    if (xs.length > SYNC_LIM.cart) throw syncBig();
    return cleanItems(xs).filter((x) => x.id.length <= SYNC_LIM.id)
      .map((x) => ({ id: x.id, k: x.k.slice(0, 64), n: x.n.slice(0, SYNC_LIM.name), c: x.c.slice(0, 32), q: x.q }));
  };
  if ("favs" in d) { const x = strs(d.favs, SYNC_LIM.favs, SYNC_LIM.id); x ? (out.favs = x) : bad.push("★"); }
  if ("hiddenShops" in d) { const x = strs(d.hiddenShops, SYNC_LIM.hiddenShops, 64); x ? (out.hiddenShops = x) : bad.push("比較から外した店"); }
  if ("includeStore" in d) typeof d.includeStore === "boolean" ? (out.includeStore = d.includeStore) : bad.push("来店のみの扱い");
  if ("cart" in d) Array.isArray(d.cart) ? (out.cart = fixItems(d.cart)) : bad.push("在庫リスト");
  // リストの名前はリストと一緒の時だけ（名前だけ取り込むと、今のリストが別のパターンの名前になり、「保存」でそのパターンを確かめずに上書きしかねない）
  if ("cartName" in d) typeof d.cartName === "string" && "cart" in out ? (out.cartName = d.cartName.slice(0, SYNC_LIM.pat)) : bad.push("在庫リストの名前");
  if ("patterns" in d) {
    const ks = keysOf(d.patterns, SYNC_LIM.patterns);
    if (!ks) bad.push("保存したパターン");
    else {
      let total = 0;
      for (const k of ks) { const p = d.patterns[k]; if (isObj(p) && Array.isArray(p.items)) total += p.items.length; }
      if (total > SYNC_LIM.patItems) throw syncBig();
      const c = cleanPatterns(d.patterns), o = nullObj();
      let skip = 0;
      for (const [n, p] of Object.entries(c)) {
        if (!n.trim() || n.length > SYNC_LIM.pat) { skip++; continue; }
        o[n] = { items: fixItems(p.items), saved: p.saved.slice(0, 40) };
      }
      if (skip) bad.push(`保存したパターンのうち名前が空・長すぎる ${skip} 件`);
      out.patterns = o;
    }
  }
  if ("fees" in d) {
    if (!keysOf(d.fees, SYNC_LIM.fees)) bad.push("送料・手数料の設定");
    else {
      const o = nullObj();  // cleanFees の後で、無限大（JSON の 1e400）や桁外れの額は 0 にする
      for (const [s, f] of Object.entries(cleanFees(d.fees))) if (s.length <= 64) {
        const fin = (x) => (Number.isFinite(x) && x <= 1e9 ? x : 0);
        o[s] = { ship: fin(f.ship), free: fin(f.free), fee: fin(f.fee) };
      }
      out.fees = o;
    }
  }
  if ("buyPrices" in d) {
    const ks = keysOf(d.buyPrices, SYNC_LIM.buyPrices);
    if (!ks) bad.push("仕入れ値");
    else {
      const o = nullObj();  // app.js の buyPrices の読み込みと同じ検査（0〜100 億円の数・円に丸める）
      for (const k of ks) { const x = d.buyPrices[k]; if (k && k.length <= SYNC_LIM.id && typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1e10) o[k] = Math.round(x); }
      out.buyPrices = o;
    }
  }
  if ("profitSet" in d) isObj(d.profitSet) ? (out.profitSet = cleanProfitSet(d.profitSet)) : bad.push("計算の設定");
  if ("skin" in d) SKIN_KEYS.includes(d.skin) ? (out.skin = d.skin) : bad.push("見た目");
  if (!Object.keys(out).length) throw new SyncErr("取り込める設定がありませんでした");
  const created = typeof raw.created === "string" && raw.created.length <= 40 && Number.isFinite(Date.parse(raw.created)) ? raw.created : null;
  return { data: out, created, bad, v: raw.v };
}
// バイト列（ファイル・リンクを開いた中身）→ JSON の値
function syncJson(bytes) {
  if (bytes.length > SYNC_MAX_BYTES) throw new SyncErr("大きすぎます（5 MB まで）。取り込みませんでした");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new SyncErr("文字が壊れていて読めません（別の形式のファイルの可能性）"); }
  try { return JSON.parse(text); } catch { throw new SyncErr("中身を読めません（壊れているか、途中で切れている可能性）"); }
}
// 暗号化していないバイト列 → syncClean の結果（版 1 と、パスワードなしのサイトの版 2）
const syncParse = (bytes) => syncClean(syncJson(bytes));
const b64url = (bytes) => {  // 長い中身でも引数の上限に当たらないよう区切って変換する（cart.js の共有リンクと同じ）
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x2000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const b64std = (bytes) => b64url(bytes).replace(/-/g, "+").replace(/_/g, "/");
// gzip で詰める（CompressionStream が無い・失敗した時は null）
async function syncGzip(bytes) {
  if (typeof CompressionStream !== "function") return null;
  try { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer()); } catch { return null; }
}
// gzip を開く。開いた中身が cap を超えたら途中でやめる（小さなリンクが巨大な中身に膨らむもの＝圧縮爆弾で固まらないように）
async function gunzipCapped(bytes, cap) {
  const rd = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    n += value.length;
    if (n > cap) { try { await rd.cancel(); } catch {} throw new SyncErr("開いた中身が大きすぎます（5 MB まで）。取り込みませんでした"); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
// ---- 暗号化（サイトの価格データと同じ: パスワードの鍵 base → PBKDF2（iter 回）→ AES-GCM）----
const syncAes = (base, salt, iter, use) => crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
  base, { name: "AES-GCM", length: 256 }, false, [use]);
// 控えの形 → 塩 16＋iv 12＋暗号文（中身は gzip。できない時は JSON そのまま。開く側は頭の 2 バイトで見分ける）
async function syncSeal(obj, base, iter) {
  // 受け取る側が断る反復回数では作らない（mode.json の iter を範囲の外に変えた時に、誰も開けないリンク・ファイルを作らないように）
  if (!iterOk(iter)) throw new SyncErr("このサイトの暗号化の設定（反復回数）が引き継ぎで使える範囲の外のため、控えを作れません");
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const plain = (await syncGzip(json)) || json;
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await syncAes(base, salt, iter, "encrypt"), plain));
  const out = new Uint8Array(28 + ct.length);
  out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
  return out;
}
const iterOk = (x) => Number.isInteger(x) && x >= SYNC_ITER[0] && x <= SYNC_ITER[1];
// 塩＋iv＋暗号文 → syncClean の結果（enc: true）。復号できない（別のパスワード・書き換わった）時は SyncErr で何も変えない
async function syncUnseal(bytes, base, iter, what) {
  const w = WHAT[what] || what;
  if (!base) throw new SyncErr(`この${w}は暗号化されていますが、この画面はパスワードなしで開いているため読めません`);
  if (!iterOk(iter) || bytes.length < 28 + 16 + 2) throw new SyncErr(`この${w}の形が正しくありません（途中で切れた・書き換わった可能性）`);
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(16, 28) },
      await syncAes(base, bytes.slice(0, 16), iter, "decrypt"), bytes.slice(28)));
  } catch {
    // AES-GCM では「別のパスワード」と「途中で切れた・書き換わった」を見分けられない（どちらも認証に失敗する）。切れたリンクの 3/4 はここに来るので、
    // 別のパスワードと言い切らずに両方を案内する（2026-09-29 独立 QA: 途中で切れたリンクも「別のパスワードで作られています」と出ていた）
    throw new SyncErr(`この${w}を開けませんでした。別のパスワードで作られたか（パスワードを変える前に作った${w}など）、途中で切れた・書き換わった可能性があります。何も変えていません。作った端末で、もう一度作ってください`);
  }
  if (plain[0] === 0x1f && plain[1] === 0x8b) {
    try { plain = await gunzipCapped(plain, SYNC_MAX_BYTES); }
    catch (e) { if (e instanceof SyncErr) throw e; throw new SyncErr(`この${w}の中身が壊れています。もう一度作ってください`); }
  }
  return { ...syncClean(syncJson(plain)), enc: true };
}
// ファイル・リンクの JSON の値（暗号化の包みか、暗号化なしの控え）→ syncClean の結果（enc: 暗号化されていたか）
async function syncOpenRaw(raw, base, what = "file") {
  if (isObj(raw) && raw.format === SYNC_FORMAT && "enc" in raw) {
    if (!Number.isInteger(raw.v) || raw.v < 2) throw new SyncErr("形式の版がわからない控えです。取り込みませんでした");
    if (raw.v > SYNC_VER) throw new SyncErr("新しい版の画面で作られた控えです。この画面を再読み込み（新しい版に）してから読み込んでください");
    if (raw.enc !== SYNC_ENC) throw new SyncErr("暗号化の方式がわからない控えです（新しい版の画面で作られた可能性）。取り込みませんでした");
    if (typeof raw.body !== "string" || raw.body.length > SYNC_MAX_BYTES * 2 || !/^[A-Za-z0-9+/]+=*$/.test(raw.body))
      throw new SyncErr(`この${WHAT[what]}の形が正しくありません（途中で切れた・書き換わった可能性）`);
    let bytes;
    try { bytes = unb64url(raw.body.replace(/=+$/, "")); } catch { throw new SyncErr(`この${WHAT[what]}の形が正しくありません（途中で切れた・書き換わった可能性）`); }
    return syncUnseal(bytes, base, raw.iter, what);
  }
  return { ...syncClean(raw), enc: false };
}
// 控えのファイル（バイト列）→ syncClean の結果
const syncOpenFile = async (bytes, base) => syncOpenRaw(syncJson(bytes), base, "file");
// 控えのファイルの中身（文字列）。鍵があれば暗号化の包み、無ければ暗号化なし（パスワードなしのサイト）
async function syncFileText(obj, base, iter) {
  if (!base) return JSON.stringify(obj, null, 1);
  return JSON.stringify({ format: SYNC_FORMAT, v: SYNC_VER, enc: SYNC_ENC, iter, body: b64std(await syncSeal(obj, base, iter)) }, null, 1);
}
// 書き出す・リンクを作る前に、受け取る側と同じ上限で確かめる（2026-09-29 ASTRA 指摘: パターン 501 件・開いた中身が 5 MB 超などの控えは、
// 作れても自分でも読み戻せなかった）。件数・大きさが上限を超える時は理由を出して作らない（SyncErr）。最後に受け取る側と同じ検査（syncClean）も通す。
// → 読み込む側で読めない項目（名前が 1,000 字を超えるパターン等。控えは作り、知らせる）
function syncCheckOut(obj) {
  const d = obj.data, L = SYNC_LIM, over = [], n = (x) => x.toLocaleString("ja-JP");
  const cnt = (label, x, max, unit) => { if (x > max) over.push(`${label} ${n(x)} ${unit}（上限 ${n(max)} ${unit}）`); };
  const ps = Object.values(d.patterns || {});
  cnt("★", (d.favs || []).length, L.favs, "件");
  cnt("比較から外した店", (d.hiddenShops || []).length, L.hiddenShops, "店");
  cnt("在庫リスト", (d.cart || []).length, L.cart, "商品");
  cnt("保存したパターン", ps.length, L.patterns, "件");
  cnt("パターンの商品", ps.reduce((t, p) => t + ((p && p.items) || []).length, 0), L.patItems, "行");
  cnt("送料・手数料の設定", Object.keys(d.fees || {}).length, L.fees, "店");
  cnt("仕入れ値", Object.keys(d.buyPrices || {}).length, L.buyPrices, "商品");
  const json = JSON.stringify(obj), size = new TextEncoder().encode(json).length;
  if (size > SYNC_MAX_BYTES) over.push(`中身の大きさ ${(size / 1e6).toFixed(1)} MB（上限 5 MB）`);
  if (over.length) throw new SyncErr(`読み込む側で読めない大きさのため、作りませんでした（${over.join("・")}）。不要な★・パターン・仕入れ値などを減らしてから、もう一度お試しください`);
  try { return syncClean(JSON.parse(json)).bad; }
  catch (e) { throw new SyncErr(`読み込む側で読めない形のため、作りませんでした（${e instanceof SyncErr ? e.message : "形を確かめられませんでした"}）`); }
}
// 控えのファイルの大きさ（受け取る側はファイルが 5 MB を超えると読まない。暗号化なしのファイルは字下げの分だけ中身より大きい）
function syncCheckFile(text) {
  const size = new Blob([text]).size;
  if (size > SYNC_MAX_BYTES) throw new SyncErr(`ファイルが ${(size / 1e6).toFixed(1)} MB になり、読み込む側の上限（5 MB）を超えるため、作りませんでした。不要な★・パターン・仕入れ値などを減らしてから、もう一度お試しください`);
}
// 控えの形 → リンクの #sync= の後ろ。鍵があれば e（暗号化）、無ければ z（gzip）か j（そのまま）
async function syncPack(obj, base = null, iter = 0) {
  if (base) {
    const sealed = await syncSeal(obj, base, iter), out = new Uint8Array(4 + sealed.length);
    new DataView(out.buffer).setUint32(0, iter);
    out.set(sealed, 4);
    return "e" + b64url(out);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const gz = await syncGzip(bytes);
  return gz ? "z" + b64url(gz) : "j" + b64url(bytes);
}
// リンクの #sync= の後ろ → syncClean の結果（enc: 暗号化されていたか）
async function syncUnpack(s, base = null) {
  if (typeof s !== "string" || s.length > SYNC_LINK_MAX * 2 || !/^[zje][A-Za-z0-9_-]+$/.test(s))
    throw new SyncErr("引き継ぎリンクの形が正しくありません（途中で切れた・書き換わった可能性）");
  let bytes;
  try { bytes = unb64url(s.slice(1)); } catch { throw new SyncErr("引き継ぎリンクの形が正しくありません（途中で切れた・書き換わった可能性）"); }
  if (s[0] === "e") {
    if (bytes.length < 4) throw new SyncErr("引き継ぎリンクの形が正しくありません（途中で切れた・書き換わった可能性）");
    return syncUnseal(bytes.slice(4), base, new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0), "link");
  }
  if (s[0] === "z") {
    if (typeof DecompressionStream !== "function") throw new SyncErr("このブラウザは圧縮された引き継ぎリンクを読めません。控えのファイルを使ってください");
    try { bytes = await gunzipCapped(bytes, SYNC_MAX_BYTES); }
    catch (e) { if (e instanceof SyncErr) throw e; throw new SyncErr("引き継ぎリンクが壊れています（途中で切れた・書き換わった可能性）。もう一度リンクを作ってください"); }
  }
  return { ...syncParse(bytes), enc: false };
}
// ---- 足し合わせ（取り込み方「足し合わせる」）----
// cur = 今の端末の設定（syncCollect().data）、inc = 受け取った中身（syncClean の data。含まれていない項目は今のまま）。
//   ★・比較から外した店: 両方を合わせる（和集合）
//   仕入れ値: 両方を残し、同じ商品は受け取った値
//   パターン: 両方を残す。同じ名前で中身が違うものは、受け取った側に「（受取）」を付けて両方残す（中身が同じなら 1 つ。前に足した「（受取）」と同じ中身も 1 つ）
//   在庫リスト（今のリスト）: 受け取ったリストにする。今のリストが空でなく、受け取ったリスト・保存したパターンのどれとも中身が違う時は、
//     今のリストをパターン「取り込む前の在庫リスト」に残す（足し合わせで何も失わないように。2026-09-29 の推測で決めた規則）
//   送料の設定: 店ごとに合わせ、同じ店は受け取った設定。来店のみの扱い・計算の設定・見た目: 受け取った側
// → {data: 取り込む値（syncApply に渡す）, info: {renamed: [[元の名前, 付けた名前]], kept: 今のリストを残したパターン名, same: 中身が同じで 1 つにしたパターン数, over: 受け取った値にした仕入れ値の数}}
// 足し合わせると上限（SYNC_LIM）を超える時は SyncErr（「置き換える」を案内）
function syncMerge(cur, inc, now = new Date()) {
  const out = {}, info = { renamed: [], kept: null, same: 0, over: 0 };
  const sig = (xs) => JSON.stringify(xs.map((x) => [x.id, x.c, x.q]).sort());
  const uniq = (o, base, tag) => {  // o に無い名前（「名前（受取）」「名前（受取2）」…。長さの上限に収める）
    for (let i = 1; i < 1000; i++) {
      const t = `（${tag}${i > 1 ? i : ""}）`, n = base.slice(0, SYNC_LIM.pat - t.length) + t;
      if (!(n in o)) return n;
    }
    throw syncBig();
  };
  if ("favs" in inc) out.favs = [...new Set([...(cur.favs || []), ...inc.favs])];
  if ("hiddenShops" in inc) out.hiddenShops = [...new Set([...(cur.hiddenShops || []), ...inc.hiddenShops])];
  if ("includeStore" in inc) out.includeStore = inc.includeStore;
  if ("buyPrices" in inc) {
    const o = nullObj();
    for (const [k, v] of Object.entries(cur.buyPrices || {})) o[k] = v;
    for (const [k, v] of Object.entries(inc.buyPrices)) { if (k in o && o[k] !== v) info.over++; o[k] = v; }
    out.buyPrices = o;
  }
  const pats = nullObj();
  for (const [n, p] of Object.entries(cur.patterns || {})) pats[n] = p;
  const rename = nullObj();  // 受け取ったパターン名 → 付けた名前（受け取った在庫リストの名前も同じに直す）
  if ("patterns" in inc) {
    for (const [n, p] of Object.entries(inc.patterns)) {
      if (!(n in pats)) { pats[n] = p; continue; }
      // 中身が同じものが同じ名前か、前に足し合わせた「名前（受取…）」にあれば足さない（同じリンクを 2 回取り込んでも増えない）
      const s = sig(p.items), head = n.slice(0, SYNC_LIM.pat - 8) + "（受取";
      const twin = Object.keys(pats).find((k) => (k === n || k.startsWith(head)) && sig(pats[k].items) === s);
      if (twin !== undefined) { info.same++; if (twin !== n) rename[n] = twin; continue; }
      const nn = uniq(pats, n, "受取");
      pats[nn] = p; rename[n] = nn; info.renamed.push([n, nn]);
    }
  }
  if ("cart" in inc) {
    const mine = cur.cart || [];
    if (mine.length && sig(mine) !== sig(inc.cart) && !Object.values(pats).some((p) => sig(p.items) === sig(mine))) {
      const kn = "取り込む前の在庫リスト" in pats ? uniq(pats, "取り込む前の在庫リスト", "前") : "取り込む前の在庫リスト";
      pats[kn] = { items: mine.map((x) => ({ ...x })), saved: now.toISOString() };
      info.kept = kn;
    }
    out.cart = inc.cart;
    out.cartName = "cartName" in inc ? (rename[inc.cartName] || inc.cartName) : "";
  } else if ("cartName" in inc) out.cartName = rename[inc.cartName] || inc.cartName;
  if ("patterns" in inc || info.kept) out.patterns = pats;
  if ("fees" in inc) {
    const o = nullObj();
    for (const [s, f] of Object.entries(cur.fees || {})) o[s] = f;
    for (const [s, f] of Object.entries(inc.fees)) o[s] = f;
    out.fees = o;
  }
  if ("profitSet" in inc) out.profitSet = inc.profitSet;
  if ("skin" in inc) out.skin = inc.skin;
  // 足し合わせた結果も、控えとして書き出し・読み込み（元に戻す）できる大きさに収める
  const L = SYNC_LIM, n = (o) => (o ? Object.keys(o).length : 0);
  const patItems = out.patterns ? Object.values(out.patterns).reduce((t, p) => t + p.items.length, 0) : 0;
  if ((out.favs && out.favs.length > L.favs) || (out.hiddenShops && out.hiddenShops.length > L.hiddenShops) || n(out.buyPrices) > L.buyPrices ||
      n(out.patterns) > L.patterns || patItems > L.patItems || n(out.fees) > L.fees)
    throw new SyncErr("足し合わせると件数が上限を超えます。「置き換える」を選んでください");
  return { data: out, info };
}
// 取り込み方ごとの「取り込むと」の一覧: [[項目名, 今 → 取り込んだ後の説明]]（受け取った中身に含まれる項目だけ）。mode = "merge" | "replace"
function syncPlan(cur, inc, mode, siteNameOf = (id) => id, now = new Date()) {
  const m = mode === "merge" ? syncMerge(cur, inc, now) : { data: inc, info: null };
  const d = m.data, info = m.info, rows = [];
  const n = (x) => x.toLocaleString("ja-JP"), cnt = (o) => Object.keys(o || {}).length;
  const arrow = (a, b, unit) => `${n(a)} → ${n(b)} ${unit}`;  // 件数が同じでも中身は変わりうるので「変わらず」とは書かない
  const how = mode === "merge" ? "（足し合わせ）" : "（置き換え）";
  if ("favs" in d) rows.push(["★（お気に入り）", arrow(cur.favs.length, d.favs.length, "件") + how]);
  if ("hiddenShops" in d) rows.push(["比較から外した店", arrow(cur.hiddenShops.length, d.hiddenShops.length, "店") + how]);
  if ("includeStore" in d) rows.push(["来店のみの価格", (d.includeStore ? "最高値・計算に含める" : "含めない（別枠で表示）") + "（受け取った設定）"]);
  if ("cart" in d) {
    const q = (xs) => xs.reduce((t, x) => t + x.q, 0);
    const now1 = cur.cart.length ? `${n(cur.cart.length)} 商品・計 ${n(q(cur.cart))} 個` : "空";
    const aft = d.cart.length ? `${n(d.cart.length)} 商品・計 ${n(q(d.cart))} 個` : "空";
    rows.push(["在庫リスト（今のリスト）", `${now1} → 受け取ったリスト（${aft}）に置き換え${info && info.kept ? `。今のリストはパターン「${info.kept}」に残します` : ""}`]);
  }
  if ("patterns" in d) {
    let s = arrow(cnt(cur.patterns), cnt(d.patterns), "件") + how;
    if (info && info.renamed.length) s += `。同じ名前で中身の違う ${n(info.renamed.length)} 件は、受け取った側に「（受取）」を付けて両方残します（${info.renamed.slice(0, 3).map(([, b]) => `「${b}」`).join("")}${info.renamed.length > 3 ? " ほか" : ""}）`;
    rows.push(["保存したパターン", s]);
  }
  if ("fees" in d) rows.push(["送料・手数料の設定", arrow(cnt(cur.fees), cnt(d.fees), "店") + (mode === "merge" ? "（同じ店は受け取った設定）" : how)]);
  if ("buyPrices" in d) rows.push(["仕入れ値", arrow(cnt(cur.buyPrices), cnt(d.buyPrices), "商品") + (info ? `（足し合わせ${info.over ? `。同じ商品で値の違う ${n(info.over)} 件は受け取った値` : ""}）` : how)]);
  if ("profitSet" in d) { const p = d.profitSet; rows.push(["計算の設定", `査定減額 ${p.cut}%・買取送料 ${n(p.ship)} 円・ポイント ${p.pt}${p.unit === "yen" ? " 円" : "%"}（受け取った設定）`]); }
  if ("skin" in d) rows.push(["見た目", `${d.skin === "board" ? "取引所" : "いつもの"}（受け取った設定）`]);
  return rows;
}
// 取り込む前の確認に出す一覧: [[項目名, 中身の説明]]（含まれていない項目は「今のまま」）
function syncSummary(d, siteNameOf = (id) => id) {
  const keep = "含まれていません（今のまま）", rows = [];
  const n = (x) => x.toLocaleString("ja-JP");
  rows.push(["★（お気に入り）", "favs" in d ? `${n(d.favs.length)} 件` : keep]);
  rows.push(["比較から外した店", "hiddenShops" in d ? (d.hiddenShops.length ? `${n(d.hiddenShops.length)} 店（${d.hiddenShops.slice(0, 6).map(siteNameOf).join("、")}${d.hiddenShops.length > 6 ? " ほか" : ""}）` : "なし（すべての店と比較）") : keep]);
  rows.push(["来店のみの価格", "includeStore" in d ? (d.includeStore ? "最高値・計算に含める" : "含めない（別枠で表示）") : keep]);
  if ("cart" in d) {
    const q = d.cart.reduce((t, x) => t + x.q, 0);
    rows.push(["在庫リスト（今のリスト）", d.cart.length ? `${n(d.cart.length)} 商品・計 ${n(q)} 個${d.cartName ? `（「${d.cartName}」）` : ""}` : "空"]);
  } else rows.push(["在庫リスト（今のリスト）", keep]);
  if ("patterns" in d) { const ks = Object.keys(d.patterns); rows.push(["保存したパターン", ks.length ? `${n(ks.length)} 件（${ks.slice(0, 5).map((k) => `「${k}」`).join("")}${ks.length > 5 ? " ほか" : ""}）` : "なし"]); }
  else rows.push(["保存したパターン", keep]);
  rows.push(["送料・手数料の設定", "fees" in d ? `${n(Object.keys(d.fees).length)} 店` : keep]);
  rows.push(["仕入れ値", "buyPrices" in d ? `${n(Object.keys(d.buyPrices).length)} 商品` : keep]);
  const p = d.profitSet;
  rows.push(["計算の設定", p ? `査定減額 ${p.cut}%・買取送料 ${n(p.ship)} 円・ポイント ${p.pt}${p.unit === "yen" ? " 円" : "%"}` : keep]);
  rows.push(["見た目", "skin" in d ? (d.skin === "board" ? "取引所" : "いつもの") : keep]);
  return rows;
}
// 確認画面に出す、暗号化の状態の一言（res = syncClean の結果に enc を足したもの）
const syncEncNote = (res) => (res.enc ? "暗号化されています（このサイトのパスワードで開けました）"
  : res.v < 2 ? "暗号化されていない古い形式です（2026-09-29 の最初の版の画面で作ったもの）。取り込んだ後、この古いリンク・ファイルは消してください"
    : "暗号化されていません（パスワードなしの画面で作ったもの）");

// ---- 控え（画面）----
// 取り込み・元に戻すで書く設定の保存の名前（syncCollect().data の項目と同じ名前）
const SYNC_KEYS = ["favs", "hiddenShops", "includeStore", "patterns", "fees", "cart", "cartName", "buyPrices", "profitSet", "skin"];
// 取り込み・元に戻すで書く保存（設定・「元に戻す」の控え・更新の印）。保存できない項目があった時は、書く前のこの文字列に全部戻す
const SYNC_STORE = [...SYNC_KEYS, "settingsUndo", "settingsRev"];
const syncRaw = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
// 端末の保存を読めるか（サイトのデータを保存しない設定等では localStorage を読むと例外。容量不足の時は読める）
const syncCanRead = () => { try { localStorage.getItem("settingsUndo"); return true; } catch { return false; } };
// 「元に戻す」の控え: {at, raw: {保存の名前: 取り込む前の保存値の生の文字列 | null（無かった）}, after: 取り込んだ直後の形の目印}。
// raw は取り込みで書く項目だけ。戻す時は検査を通さずにそのまま書き戻す（2026-09-29 ASTRA 指摘: 以前は画面の値の形 snap で持ち、戻す時に
// 読み込みの検査（syncClean）を通していたので、1,001 字の名前のパターンなど検査で弾かれる値が「元に戻す」で消えていた）。
// 以前の版の控え {at, snap: 画面の値の形（全項目）, after?} も読む（戻す時は保存と同じ JSON にして書く）
const syncUndoKeys = (u) => (isObj(u.raw) ? SYNC_KEYS.filter((k) => k in u.raw && (typeof u.raw[k] === "string" || u.raw[k] === null))
  : isObj(u.snap) ? SYNC_KEYS.filter((k) => k in u.snap) : []);
const syncUndoGet = () => { const u = store.get("settingsUndo", null); return isObj(u) && syncUndoKeys(u).length ? u : null; };
const syncUndoPut = (u) => Object.fromEntries(syncUndoKeys(u).map((k) => [k, isObj(u.raw) ? u.raw[k] : JSON.stringify(u.snap[k])]));
// 取り込んだ後に、戻す項目を変えたか（元に戻すと、その変更も戻る）
const syncLater = (u) => u.after !== syncSig(syncPick(syncCollect().data, syncUndoKeys(u)));
// 保存の名前 → 画面に出す名前（app.js の store.label。在庫リストとその名前は 1 つにまとめる）
const syncLabels = (ks) => [...new Set(ks.map((k) => (k === "cartName" ? "在庫リスト"
  : (store.label && store.label[k]) || ({ settingsUndo: "「元に戻す」の控え", settingsRev: "別のタブへの知らせ" })[k] || k)))];
// 画面の値（app.js・cart.js・skin.js が保存するのと同じ形）。保存できていない項目を「元に戻す」の控えに入れる・もう一度保存してみる時に使う
const syncScreen = { favs: () => [...favs], hiddenShops: () => [...hidden], includeStore: () => includeStore, patterns: () => cart.patterns,
  fees: () => cart.fees, cart: () => cart.items, cartName: () => cart.name, buyPrices: () => buyPrices, profitSet: () => profitSet, skin: () => skinGet() };
// 取り込み・元に戻すの印（別のタブが読み直すきっかけ）。"settingsRev" は取り込み・元に戻すのたびに書く時刻＋乱数で、「元に戻す」の控えを
// 残せない取り込みでも変わる（2026-09-29 ASTRA 指摘: 以前は "settingsUndo" の変化だけを見ていたので、控えの無い端末で控えなしに取り込むと
// 別のタブが読み直さず、古い値で上書きしていた）。"settingsUndo" も見る（更新の前の版の画面が取り込んだ時も知る）
const syncMark = () => `${syncRaw("settingsRev")}\n${syncRaw("settingsUndo")}`;
// この画面の値を読んだ時の印（app.js・cart.js が保存値を読むのと同じ、画面を開いた時に読む）
let syncSeen = syncMark();
// 暗号化に使う鍵（パスワードで開いたサイトの鍵）と反復回数。パスワードなしのサイトは null（暗号化しない）
const syncKey = () => (st.mode && st.mode.encrypted && st.key ? st.key : null);
const syncIter = () => st.mode.iter;
// 端末へ書いて、書けたかを確かめる（容量不足・非公開モードで黙って失われないように）。s = 書く文字列（null は消す）。
// 既に同じなら書かない（戻す時に、書き換わっていない項目まで書き直して、容量不足で「戻せなかった」扱いにしない）
function syncPutRaw(k, s) {
  try {
    if (localStorage.getItem(k) === s) return true;
    if (s === null) localStorage.removeItem(k); else localStorage.setItem(k, s);
    return localStorage.getItem(k) === s;
  } catch { return false; }
}
function syncPut(k, v) { return syncPutRaw(k, JSON.stringify(v)); }
const syncBump = () => syncPut("settingsRev", `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`);
const syncRawGet = () => Object.fromEntries(SYNC_STORE.map((k) => [k, syncRaw(k)]));
// 生の文字列 raw（{保存の名前: 文字列 | null（消す）}）にする。小さくなる項目から書く（戻す途中で容量を超えないように。戻し終えた形は、前に
// 保存できていた形）。→ 書けなかった項目の名前（2026-09-29 ASTRA 指摘: 以前は戻す書き込みの失敗を捨て、混ざったまま「何も変えていません」と出ていた）
function syncRawPut(raw) {
  const now = Object.fromEntries(Object.keys(raw).map((k) => [k, (syncRaw(k) || "").length]));
  const ks = Object.keys(raw).sort((a, b) => ((raw[a] || "").length - now[a]) - ((raw[b] || "").length - now[b]));
  return ks.filter((k) => !syncPutRaw(k, raw[k]));
}
// 取り込めなかった・戻せなかった時に、保存値を書く前の生の文字列 raw に戻し、画面の値を scr（書く前の画面の値）に、保存できていない印を
// miss0（書く前）に戻す。戻しきれなかった項目は、画面（前の値）と保存値（書いた値）が違うので、保存できていない印を付ける。→ 戻しきれなかった項目
function syncBack(raw, scr, miss0) {
  const bad = syncRawPut(raw);
  store.miss = new Map(miss0);
  for (const k of bad) if (k in syncScreen) store.miss.set(k, syncRaw(k));
  syncApply(scr, false);
  syncSeen = syncMark();
  return bad;
}
// 戻す書き込みも失敗した時（保存値が前の値と新しい値の混ざった形のまま）の知らせ。what = 「取り込めませんでした」等、before = 「取り込む前」等
const syncMixed = (what, before, bad, retry) => `この端末の保存の容量が足りないため、${what}。<b>${before}の状態にも戻しきれず、保存されている設定の一部（${esc(syncLabels(bad).join("・"))}）だけが変わった可能性があります。</b>` +
  `画面の設定は${before}のままです（この画面を閉じると、保存されている方の設定で開きます）。不要なパターンなどを消してから、${retry}か、控えのファイルを読み込み直してください。`;
// 画面の値を d にする（含まれていない項目は今のまま。足し合わせは syncMerge で作った値を渡す）。write なら端末にも保存する。→ 端末に保存できなかった項目の名前
// write = false は、別のタブで取り込んだ値の読み直し（syncReload）と、保存できなかった時の取り込む前への戻しに使う
// 書けた項目は、保存できていない印（store.miss）を外す（画面の値＝保存値になった）
function syncApply(d, write = true) {
  const miss = [], put = (k, v, label) => { if (!write) return; if (syncPut(k, v)) store.miss.delete(k); else miss.push(label); };
  if ("favs" in d) { favs = new Set(d.favs); put("favs", [...favs], "★"); }
  if ("hiddenShops" in d) { hidden = new Set(d.hiddenShops); put("hiddenShops", [...hidden], "比較から外した店"); }
  if ("includeStore" in d) { includeStore = d.includeStore; put("includeStore", includeStore, "来店のみの扱い"); }
  if ("patterns" in d) { cart.patterns = d.patterns; put("patterns", cart.patterns, "保存したパターン"); }
  if ("fees" in d) { cart.fees = d.fees; put("fees", cart.fees, "送料・手数料の設定"); }
  if ("cart" in d) cart.items = d.cart.map((x) => ({ ...x }));
  if ("cartName" in d) cart.name = d.cartName;
  if ("cart" in d || "cartName" in d) { put("cart", cart.items, "在庫リスト"); put("cartName", cart.name, "在庫リストの名前"); }
  if ("buyPrices" in d) { for (const k of Object.keys(buyPrices)) delete buyPrices[k]; Object.assign(buyPrices, d.buyPrices); put("buyPrices", buyPrices, "仕入れ値"); }
  if ("profitSet" in d) { profitSet = cleanProfitSet(d.profitSet); put("profitSet", profitSet, "計算の設定"); }
  if ("skin" in d) put("skin", d.skin, "見た目");  // 書けたかを確かめる（skinSet の保存は失敗を知らせない）
  // 画面に反映（比較する店の選択・一覧・在庫リストの数・開いていれば売り先計算）
  cartBadge();
  if (st.status) { renderShopPick(); applyHidden(); }
  if (!$("cartPanel").hidden) cartRender();
  // 見た目は一覧を絞り直した後に切り替える（skinSet は今の一覧 st.rows を描き直す。外した店を変えた直後の古い一覧を描くと、
  // 比較できる価格が 1 つも無くなった商品で止まっていた。2026-09-29 画面試験で見つけた: 置き換え→元に戻すで外した店が変わる時）
  if ("skin" in d && d.skin !== skinGet()) skinSet(d.skin, false);
  return miss;
}
// 端末の保存値（読み方は app.js・cart.js・skin-init.js の読み込みと同じ。壊れた値は既定値）。形は syncCollect().data と同じ
function syncReadStore() {
  const bp = store.get("buyPrices", {}), buy = nullObj(), nm = store.get("cartName", "");
  if (isObj(bp)) for (const [k, x] of Object.entries(bp)) if (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1e10) buy[k] = Math.round(x);
  return { favs: store.strs("favs"), hiddenShops: store.strs("hiddenShops"), includeStore: store.get("includeStore", false) === true,
    cart: cleanItems(store.get("cart", [])), cartName: typeof nm === "string" ? nm : "", patterns: cleanPatterns(store.get("patterns", {})),
    fees: cleanFees(store.get("fees", {})), buyPrices: buy, profitSet: cleanProfitSet(store.get("profitSet", null)), skin: store.pick("skin", SKIN_KEYS, "board") };
}
// この画面の値が端末の保存値と違えば（別のタブ・ウィンドウで取り込んだ・元に戻した・★などを変えた）、保存値を読み直す。→ 読み直したか
// （2026-09-29 独立 QA: 前から開いていたタブが取り込む前の値を持ったまま ★・仕入れ値・在庫リストを変えると、その項目を古い値で上書きして、
//   別のタブで取り込んだ設定が黙って消えていた。スマホでリンクを開くと新しいタブになり、前のタブが残りやすい。パスワードの入力を待つ間の取り込みも同じ。
//   また、古い値のまま取り込む・元に戻すと、別のタブでの変更を控え・足し合わせに入れずに上書きしていた）
// force = 取り込み・元に戻す・書き出し・リンク・小窓を開く時（いつも見る）。force でない時（storage の知らせ・画面に戻った時）は
// 取り込み・元に戻すの印（syncMark）が変わった時だけ見る。別のタブでの ★ 等の操作をいつも読み直すのは app.js の範囲
// 保存できなかった項目（app.js の store.miss。画面の値の方が新しい）は、保存値がその時のままなら保存値で上書きしない（2026-09-29 ASTRA 指摘:
// ★の保存が容量不足で失敗すると、書き出す前の読み直しで古い保存値に戻り、控えから消えていた）。この画面の操作の前（force）は、もう一度
// 保存してみる（その後に容量が空いていれば保存できる）。別のタブがその後に書き換えていたら、そちらが新しいので読み直す
function syncReload(force = false) {
  if (!st.status) return false;
  if (!syncCanRead()) return false;  // 端末の保存を使えない時は読み直さない（画面だけで使っている値を既定値で消さない）
  const now = syncMark();
  if (!force && now === syncSeen) return false;
  syncSeen = now;
  const scr = syncCollect().data, keep = [];
  for (const k of SYNC_KEYS) {
    if (!store.miss.has(k)) continue;
    if (syncRaw(k) !== store.miss.get(k)) { store.miss.delete(k); continue; }  // 別のタブが後から書いた: そちらを読む
    if (force && store.set(k, syncScreen[k]())) continue;  // 今度は保存できた
    keep.push(k);
  }
  const d = syncReadStore();
  for (const k of keep) d[k] = scr[k];
  if (syncSig(d) === syncSig(scr)) return false;
  syncApply(d, false);
  toast("別のタブで変えた設定を、この画面にも反映しました");
  const sh = $("syncSheet"), note = "別のタブで設定が変わったため、この画面の設定を読み直しました";
  if (sh && !sh.hidden) {
    if (syncConfirm.res && $("syncPlan")) { syncPlanShow(); syncMsg(esc(note + "。「取り込むと」を確かめてから、もう一度「取り込む」を押してください"), "err"); }
    else syncMain(note);
  }
  return true;
}
const syncMsg = (html, cls = "") => { const m = $("syncMsg"); m.className = "syncmsg " + cls; m.innerHTML = html; m.hidden = !html; };
function syncOpen(opener) { syncReload(true); syncMain(); sheetOpen($("syncSheet"), opener); }
function syncMain(note = "") {
  const u = syncUndoGet(), enc = !!syncKey();
  const later = u && syncLater(u);  // 取り込んだ後に、戻す項目を変えたか（元に戻すと、その変更も戻る）
  const unsaved = syncLabels(SYNC_KEYS.filter((k) => store.miss.has(k)));  // この端末に保存できていない設定（画面の値の方が新しい）
  $("syncBody").innerHTML = `
    ${unsaved.length ? `<p class="warnbox">この端末に保存できていない設定があります: ${esc(unsaved.join("・"))}（保存の容量不足など）。この画面を閉じると消えます。
      「書き出す」「リンク」はこの画面の設定で作ります。不要なパターンなどを消してから、この小窓を開き直すと保存し直します。</p>` : ""}
    <p class="muted">★・比較する店・来店のみの扱い・在庫リスト・保存したパターン・送料の設定・仕入れ値・計算の設定・見た目を 1 つにまとめます。
      <b>パスワードは入れません</b>（受け取った端末では、パスワードで開いてから取り込みます）。
      ${enc ? "ファイル・リンクの中身はこのサイトのパスワードで暗号化します。パスワードを知らない人は中身を読めません。ただし、パスワードを知っている人（家族など）には読めます。"
        : "この画面はパスワードなしで開いているため、ファイル・リンクは暗号化されません（持っている人は誰でも中身を読めます）。"}</p>
    <section class="syncsec"><h3>① 控えのファイル</h3>
      <p class="muted">この端末の設定をファイルに保存します。別の端末やブラウザで「読み込む」と同じ設定にできます（今の設定と足し合わせるか、置き換えるかを選べます）。PC の買い替えや、ブラウザのデータを消す前の控えにも。</p>
      <div class="syncacts"><button type="button" class="primary" data-sync="export">書き出す（ファイルを保存）</button>
        <label class="filebtn">読み込む（ファイルを選ぶ）<input type="file" id="syncFile" accept=".json,application/json"></label></div></section>
    <section class="syncsec"><h3>② 別の端末に引き継ぐ</h3>
      <p class="muted">同じ中身を詰めたリンクと QR コードを作ります。スマホのカメラで QR を読むか、リンクを自分宛てに送って開き、パスワードを入れると取り込めます。</p>
      <div class="syncacts"><button type="button" data-sync="link">リンクと QR コードを作る</button></div>
      <div id="syncLinkOut"></div></section>
    ${u ? `<section class="syncsec"><h3>元に戻す</h3><p class="muted">${esc(fmtDay(u.at))} に取り込む前の設定（${esc(syncLabels(syncUndoKeys(u)).join("・"))}）が残っています。${later ? "<b>取り込んだ後にこれらを変えた分も、取り込む前の状態に戻ります。</b>" : ""}</p>
      <div class="syncacts"><button type="button" data-sync="undo">取り込む前の設定に戻す</button></div></section>` : ""}`;
  syncMsg(note, note ? "ok" : "");
  $("syncFile").onchange = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) syncFromFile(f); };
}
function syncShowErr(e, what) {
  const msg = e instanceof SyncErr ? e.message : `読み取れませんでした（${esc(String((e && e.name) || "不明なエラー"))}）`;
  syncMain(); syncMsg(`${esc(what)}を取り込めませんでした: ${esc(msg)}`, "err");
}
async function syncFromFile(f) {
  if (f.size > SYNC_MAX_BYTES) return syncShowErr(new SyncErr("大きすぎます（5 MB まで）。取り込みませんでした"), "控えのファイル");
  syncMsg("ファイルを確かめています…");
  try { syncConfirm(await syncOpenFile(new Uint8Array(await f.arrayBuffer()), syncKey()), "file"); }
  catch (e) { syncShowErr(e, "控えのファイル"); }
}
// 何が入っているかを見せて、取り込み方を選んで取り込むかを尋ねる（mode = 最初に選んでおく取り込み方）
function syncConfirm(res, from, mode = "merge") {
  const rows = syncSummary(res.data, siteName);
  $("syncBody").innerHTML = `
    <p><b>${from === "link" ? "引き継ぎリンク" : "控えのファイル"}の中身</b> <span class="muted">（作成 ${res.created ? esc(fmtDay(res.created)) : "日時不明"}）</span></p>
    <p class="${res.enc ? "muted" : "warnbox"} syncenc">${esc(syncEncNote(res))}</p>
    <table class="synctbl"><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>
    ${res.bad.length ? `<p class="warnbox">読めなかった項目（今のままにします）: ${esc(res.bad.join("・"))}</p>` : ""}
    <fieldset class="syncmode"><legend>取り込み方</legend>
      <label><input type="radio" name="syncMode" value="merge"${mode === "replace" ? "" : " checked"}> <span><b>足し合わせる</b>（おすすめ）<br><span class="muted">★・外した店・仕入れ値・パターンは今の分も残します。送料・計算の設定・見た目は受け取った側にします</span></span></label>
      <label><input type="radio" name="syncMode" value="replace"${mode === "replace" ? " checked" : ""}> <span><b>置き換える</b><br><span class="muted">含まれている項目を、受け取った中身で丸ごと置き換えます（今の ★・仕入れ値などは消えます）</span></span></label>
    </fieldset>
    <p class="syncplanh"><b>取り込むと</b></p><div id="syncPlan"></div>
    <p class="muted">どちらでも、取り込む前の設定は「1 つ前の控え」として残り、「元に戻す」で戻せます。</p>
    <div class="sheetacts"><button type="button" data-sync="cancel">やめる</button><button type="button" class="primary" data-sync="apply">取り込む</button></div>`;
  syncMsg("");
  syncConfirm.res = res; syncConfirm.from = from;
  syncPlanShow();
  $("syncBody").querySelectorAll('input[name="syncMode"]').forEach((r) => { r.onchange = () => syncPlanShow(); });
  const b = $("syncBody").querySelector('[data-sync="apply"]'); if (b) b.focus({ preventScroll: true });
}
const syncModeGet = () => { const r = $("syncBody").querySelector('input[name="syncMode"]:checked'); return r && r.value === "replace" ? "replace" : "merge"; };
function syncPlanShow() {
  const el = $("syncPlan"), res = syncConfirm.res;
  if (!el || !res) return;
  const b = $("syncBody").querySelector('[data-sync="apply"]');
  try {
    const rows = syncPlan(syncCollect().data, res.data, syncModeGet(), siteName);
    el.innerHTML = `<table class="synctbl"><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>`;
    if (b) b.disabled = false;
  } catch (e) {
    el.innerHTML = `<p class="warnbox">${esc(e instanceof SyncErr ? e.message : "取り込んだ後の形を作れませんでした")}</p>`;
    if (b) b.disabled = true;
  }
}
function syncDoApply() {
  if (syncReload(true)) return;  // 別のタブで設定が変わっていた: 読み直して「取り込むと」を作り直した（古い値のまま取り込むと、そちらの変更を上書きする）
  const res = syncConfirm.res, from = syncConfirm.from, mode = syncModeGet();
  if (!res) return syncMain();
  const snap = syncCollect().data, raw = syncRawGet(), at = new Date().toISOString();
  let d;
  try { d = mode === "merge" ? syncMerge(snap, res.data).data : res.data; } catch (e) { return syncPlanShow(); }
  syncConfirm.res = null;  // 2 度押しで 2 回取り込まない（戻した時は stay が確認画面ごと出し直す）
  // 端末の保存そのものを使えない時は、以前と同じく画面の値だけ変える（この画面を閉じるまで。★ などの操作も同じく保存されない）
  if (!syncCanRead()) {
    syncApply(d, false);
    syncMain(`${mode === "merge" ? "足し合わせて" : "置き換えて"}取り込みました。<br><b class="err">この端末には設定を保存できないため（ブラウザの設定でサイトのデータの保存を止めている等）、この画面を閉じるまでの間だけ使えます。</b>`);
    return toast("設定を取り込みました（この画面を閉じるまで）");
  }
  // 保存できない項目が 1 つでもあれば、保存値も画面の値も取り込む前に全部戻す（2026-09-29 独立 QA: 一部だけ保存されると、再読み込みの後に
  // 取り込んだ値と前の値が混ざっていた。例: 在庫リストは受け取った側で保存され、前のリストを残したパターンは保存されず前のリストが消える）。
  // 戻す書き込みも失敗した時は、混ざった可能性を正直に出す（2026-09-29 ASTRA 指摘）
  // 「元に戻す」の控えは、取り込みで書く項目（在庫リストとその名前は一緒に書く）の取り込む前の保存値を、生の文字列のまま持つ。保存できていなかった
  // 項目（store.miss）は画面の値（保存値より新しい）
  const miss0 = new Map(store.miss);
  const keys = SYNC_KEYS.filter((k) => k in d || ((k === "cart" || k === "cartName") && ("cart" in d || "cartName" in d)));
  const undoRaw = Object.fromEntries(keys.map((k) => [k, store.miss.has(k) ? JSON.stringify(syncScreen[k]()) : raw[k]]));
  const stay = (msg) => { syncConfirm(res, from, mode); syncMsg(msg, "err"); };
  const mixed = (bad) => stay(syncMixed("取り込めませんでした", "取り込む前", bad, "もう一度「取り込む」を押す"));
  let undo = syncPut("settingsUndo", { at, raw: undoRaw }), miss = undo ? syncApply(d) : ["「元に戻す」の控え"];
  if (miss.length) {
    const bad = syncBack(raw, snap, miss0);
    if (bad.length) return mixed(bad);
    if (!confirm("この端末の保存の容量が足りないため、取り込む前の設定を「元に戻す」用に控えたままでは取り込めません。\n控えを残さずに取り込みますか？（取り込むと「元に戻す」は使えません）"))
      return stay("取り込みませんでした（何も変えていません）。");
    try { localStorage.removeItem("settingsUndo"); } catch {}
    undo = false; miss = syncApply(d);
    if (miss.length) {
      const bad2 = syncBack(raw, snap, miss0);
      if (bad2.length) return mixed(bad2);
      return stay(`この端末の保存の容量が足りないため、取り込めませんでした（何も変えていません。書けなかった項目: ${esc(miss.join("・"))}）。不要なパターンなどを消すか、「置き換える」でお試しください。`);
    }
  }
  // 取り込んだ直後の形の目印を控えに足す（元に戻す時に、取り込んだ後で戻す項目を変えたかを見る）。足せなくても控えはそのまま使える
  if (undo) syncPut("settingsUndo", { at, raw: undoRaw, after: syncSig(syncPick(syncCollect().data, keys)) });
  // 別のタブに知らせる（控えを残せない取り込みでも。書けない時は、別のタブを再読み込みするよう案内する）
  const told = syncBump();
  syncSeen = syncMark();
  syncMain(`${mode === "merge" ? "足し合わせて" : "置き換えて"}取り込みました。${undo ? "" : "（「元に戻す」の控えは残していません）"}` +
    (told ? "" : `<br><b class="err">この端末の保存の容量が足りず、別のタブへの知らせを書けませんでした。このサイトを別のタブでも開いている時は、そのタブを再読み込みしてください。</b>`));
  if (syncUndoGet()) syncMsg($("syncMsg").innerHTML + ` <button type="button" class="linkbtn" data-sync="undo">元に戻す</button>`, "ok");
  toast("設定を取り込みました");
}
function syncDoUndo() {
  if (syncReload(true)) return;  // 別のタブで設定が変わっていた: 読み直した画面で、もう一度押してもらう
  const u = syncUndoGet();
  if (!u) return syncMain();
  const put = syncUndoPut(u), keys = Object.keys(put);
  // 取り込んだ後に戻す項目を変えていたら、その変更も戻ることを確かめる（2026-09-29 独立 QA: 何日も後に押すと、その間に足した ★・仕入れ値なども黙って消えていた）
  if (syncLater(u) && !confirm(`取り込んだ後に変えた設定のうち、${syncLabels(keys).join("・")}は、取り込む前の状態に戻ります。\n戻しますか？`)) return;
  const cur = syncCollect().data, raw = syncRawGet(), miss0 = new Map(store.miss);
  try { localStorage.removeItem("settingsUndo"); } catch {}  // 先に消して、戻す値を書く場所を空ける（控えの中身は put にある）
  // 取り込む前の保存値を、生の文字列のまま書き戻す（検査を通さない。読み込みの検査で弾かれる値も失わない。2026-09-29 ASTRA 指摘）
  const miss = syncRawPut(put);
  if (miss.length) {  // 一部だけ戻った形を残さない（控えも元の文字列に戻す）
    const bad = syncBack(raw, cur, miss0);
    syncMain();
    return syncMsg(bad.length ? syncMixed("元に戻せませんでした", "元に戻す前", bad, syncUndoGet() ? "もう一度「元に戻す」を押す" : "設定を確かめる")
      : `この端末の保存の容量が足りないため、元に戻せませんでした（何も変えていません。書けなかった項目: ${esc(syncLabels(miss).join("・"))}）。不要なパターンなどを消してから、もう一度お試しください。`, "err");
  }
  // 戻した項目だけ、画面の値を保存値から読み直す（他の項目は画面のまま。保存できていない値も消さない）
  for (const k of keys) store.miss.delete(k);
  syncApply(syncPick(syncReadStore(), keys), false);
  const told = syncBump();
  syncSeen = syncMark();
  syncMain(`取り込む前の設定に戻しました。` + (told ? "" : `<br><b class="err">この端末の保存の容量が足りず、別のタブへの知らせを書けませんでした。このサイトを別のタブでも開いている時は、そのタブを再読み込みしてください。</b>`));
  toast("取り込む前の設定に戻しました");
}
const jstDate = () => { const d = jst(Date.now()); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; };
async function syncExport() {
  syncReload(true);  // 別のタブで設定を変えていたら、その値で作る（この画面で保存できていない項目は画面の値のまま）
  const obj = syncCollect(), name = `kaitori-settings-${jstDate()}.json`, key = syncKey();
  const warn = syncCheckOut(obj);  // 受け取る側と同じ上限で確かめる（超える時は理由を出して作らない）
  syncMsg("ファイルを作っています…");
  const text = await syncFileText(obj, key, key ? syncIter() : 0);
  syncCheckFile(text);
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.hidden = true; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  const d = obj.data;
  syncMsg(`「${esc(name)}」を保存しました（★ ${num(d.favs.length)} 件・在庫リスト ${num(d.cart.length)} 商品・パターン ${num(Object.keys(d.patterns).length)} 件・仕入れ値 ${num(Object.keys(d.buyPrices).length)} 商品）。<br>` +
    (key ? `<b>仕入れ値が含まれます。</b>このサイトのパスワードで暗号化しました。パスワードを知らない人は中身を読めません。ただし、パスワードを知っている人（家族など）には読めます。`
      : `<b>仕入れ値が含まれます（暗号化していないファイルです）。他の人に渡さないでください。</b>`) + syncWarnOut(warn), "ok");
}
// 控え・リンクは作れたが、読み込む側で読めない項目がある時の一言（名前が 1,000 字を超えるパターン等）
const syncWarnOut = (warn) => (warn.length ? `<br><b class="err">読み込む側で読めない項目があります: ${esc(warn.join("・"))}。パターンの名前を 1,000 字以内にしてから作り直すと入ります。</b>` : "");
// ---- 引き継ぎリンク・QR コード ----
// QR コードの部品（qrcode-generator 1.4.4）は押した時だけ読む。版を固定し、中身が変わっていないかを integrity で確かめる（index.html の CSP も同じ URL）
const QR_URL = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";  // 版を変える時は index.html の CSP（script-src）も同じに直す
const QR_SRI = "sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k";
let qrLoading = null;
function loadQr(limit = 20000) {
  if (typeof window.qrcode === "function") return Promise.resolve(window.qrcode);
  return (qrLoading ||= new Promise((ok, ng) => {
    const s = document.createElement("script");
    const fail = () => { qrLoading = null; clearTimeout(t); s.remove(); ng(new Error("qr")); };
    const t = setTimeout(fail, limit);
    s.src = QR_URL; s.integrity = QR_SRI; s.crossOrigin = "anonymous"; s.referrerPolicy = "no-referrer";
    s.onload = () => { clearTimeout(t); typeof window.qrcode === "function" ? ok(window.qrcode) : fail(); };
    s.onerror = fail;
    document.head.append(s);
  }));
}
// QR の SVG（部品の isDark から自分で組み立てる。文字列をそのまま差し込まない）
function qrSvg(q, cell = 4, margin = 4) {
  const n = q.getModuleCount(), size = n * cell + margin * 2;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c * cell + margin},${r * cell + margin}h${cell}v${cell}h-${cell}z`;
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="引き継ぎリンクの QR コード"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
async function syncLink() {
  syncReload(true);  // 別のタブで設定を変えていたら、その値で作る（読み直すと小窓を描き直すので、出し先はその後で取る）
  const out = $("syncLinkOut"), key = syncKey(), obj = syncCollect();
  const warn = syncCheckOut(obj);  // 受け取る側と同じ上限で確かめる（超える時は理由を出して作らない）
  out.innerHTML = `<p class="muted">リンクを作っています…</p>`;
  const packed = await syncPack(obj, key, key ? syncIter() : 0);
  const url = location.origin + location.pathname + "#sync=" + packed;
  if (url.length > SYNC_LINK_MAX) { out.innerHTML = `<p class="warnbox">中身が大きすぎてリンクにできません。① の控えのファイルを使ってください。</p>`; return; }
  const fitsQr = url.length <= QR_MAX;
  // 版 2: リンクの中身はサイトのパスワードで暗号化する（パスワードを知らない人には読めない。知っている家族には読める）。
  // パスワードなしのサイトでは暗号化できない（2026-09-29 独立 QA: 以前の版は暗号化しておらず、リンクがあれば誰でも読めた）
  out.innerHTML = `<p class="warnbox"><b>仕入れ値・在庫リスト（商品名と個数）が含まれます。</b><br>${key
    ? "このリンクの中身はサイトのパスワードで暗号化しています。パスワードを知らない人は中身を読めません。ただし、パスワードを知っている人（家族など）には読めます。"
    : "この画面はパスワードなしで開いているため、リンクは暗号化されていません。リンクを手に入れた人は誰でも中身を読めます。他の人に渡さないでください。"}（サイトの価格は入っていません）</p>
    <div class="synclink"><input type="text" readonly value="${esc(url)}" aria-label="引き継ぎリンク"><button type="button" data-sync="copy">コピー</button></div>
    <p class="muted">${num(url.length)} 文字${packed[0] === "e" ? "（圧縮・暗号化済み）" : packed[0] === "z" ? "（圧縮済み）" : ""}。受け取る端末でこのリンクを開き、パスワードを入れると、中身を確かめてから取り込めます。${syncWarnOut(warn)}</p>
    <div class="syncqr">${fitsQr ? `<p class="muted">QR コードを作っています…</p>` : `<p class="warnbox">QR コードに入らない大きさです。リンクを自分宛てに送るか、① の控えのファイルを使ってください。</p>`}</div>`;
  if (!fitsQr) return;
  const box = out.querySelector(".syncqr");
  try {
    const qrcode = await loadQr();
    const q = qrcode(0, "L"); q.addData(url, "Byte"); q.make();
    if (box.isConnected) box.innerHTML = `<div class="qrbox">${qrSvg(q)}</div>${url.length > 1200 ? `<p class="muted">大きな QR コードです。読みにくい時は画面を明るくして近づけるか、リンクを送ってください。</p>` : ""}`;
  } catch {
    if (box.isConnected) box.innerHTML = `<p class="warnbox">QR コードを作れませんでした（通信を確かめてください）。リンクを自分宛てに送るか、① の控えのファイルを使ってください。</p>`;
  }
}
async function syncCopy(btn) {
  const inp = $("syncLinkOut").querySelector("input");
  if (!inp) return;
  try { await navigator.clipboard.writeText(inp.value); toast("引き継ぎリンクをコピーしました。他の人に渡さないでください"); }
  catch { inp.focus(); inp.select(); toast("リンクを選びました。コピーしてください"); }
}
// 引き継ぎリンク（#sync=…）で開かれたら: 見つけたらすぐ（パスワードの入力の前でも）URL から消し、中身はこの画面のメモリにだけ持つ
// （2026-09-29 ASTRA 指摘: 暗号化されていない版 1 のリンクが、パスワードを入れるまで URL＝アドレス欄に残っていた。版にかかわらず同じ）。
// パスワードで開けた後（st.status が読めた後）に中身を確かめて（暗号化されていればサイトの鍵で開いて）取り込むかを尋ねる。
// 入力の前に再読み込み・閉じると中身は消える（リンクを開き直す）
let syncPending = null;
function syncFromHash() {
  const m = /^#sync=(.*)$/s.exec(location.hash);
  if (m) { history.replaceState(null, "", location.pathname + location.search); syncPending = m[1]; }
  if (syncPending === null || !st.status) return;
  const s = syncPending;
  syncPending = null;
  syncOpen();
  syncMsg("引き継ぎリンクを確かめています…");
  syncUnpack(s, syncKey()).then((res) => syncConfirm(res, "link"), (e) => syncShowErr(e, "引き継ぎリンク"));
}
function syncBind() {
  const sh = $("syncSheet");
  sh.addEventListener("click", (e) => {
    if (e.target === sh || e.target.closest("[data-close]")) return sheetClose(sh);
    const b = e.target.closest("[data-sync]");
    if (!b) return;
    const act = b.dataset.sync;
    if (act === "export") syncExport().catch((e) => syncMsg(e instanceof SyncErr ? esc(e.message) : "ファイルを作れませんでした。もう一度お試しください", "err"));
    else if (act === "link") syncLink().catch((e) => { const o = $("syncLinkOut"); if (o) o.innerHTML = `<p class="warnbox">${e instanceof SyncErr ? esc(e.message) : "リンクを作れませんでした。① の控えのファイルを使ってください。"}</p>`; });
    else if (act === "copy") syncCopy(b);
    else if (act === "apply") syncDoApply();
    else if (act === "cancel") { syncConfirm.res = null; syncMain(); }
    else if (act === "undo") syncDoUndo();
  });
  $("syncOpenBtn").onclick = (e) => syncOpen(e.currentTarget);
}
// ボタンと小窓の操作は読み込んだらすぐ付ける（app.js はパスワードで開いた時に下のボタンを出すので、以前は syncReady が付けるまでの
// 最大 0.3 秒、押しても何も起きなかった。2026-09-29 独立 QA。小窓が開くのはパスワードで開けた後だけ）
syncBind();
// 引き継ぎリンクは、パスワードの入力の前に URL から消す（中身はメモリへ。開けた後に syncReady が取り込むかを尋ねる）。入力を待つ間に貼られたリンクも同じ
syncFromHash();
addEventListener("hashchange", syncFromHash);
// app.js の起動が終わったら（パスワードで開けて status が読めたら）ボタンを出し、引き継ぎリンクを見る
(function syncReady() {
  if (!st.status) return setTimeout(syncReady, 300);
  $("foot").hidden = false; $("forgetPw").hidden = !st.mode.encrypted;
  syncReload(true);  // パスワードの入力を待つ間に、別のタブで取り込んでいたら読み直す
  syncFromHash();
  // 別のタブの取り込み・元に戻すを知る（"settingsRev" は最後に、"settingsUndo" は取り込みの最初と最後に書く）。続けて届く他の項目の
  // 知らせを少し待ってから読み直す。裏に回っていた画面は、戻った時にも確かめる
  addEventListener("storage", (e) => { if (e.key === "settingsRev" || e.key === "settingsUndo") { clearTimeout(syncReload.t); syncReload.t = setTimeout(() => syncReload(), 250); } });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncReload(); });
})();
