"use strict";
// 見た目（着せ替え）を、画面を描く前に決める（index.html の <head> で CSS より先に読む。CSP でインラインの script は使えないので別ファイル）。
// 端末ごとの選択は localStorage の "skin"（JSON の文字列 "board" | "classic"。app.js の store と同じ形）。読めない・無い時は既定の「取引所」。
//   board   = 取引所（<html data-skin="board">。skin-board.css が効く。端末の明暗設定にかかわらず黒地）
//   classic = いつもの（data-skin を付けない＝ 2026-09-29 までの見た目そのまま）
(function () {
  let v = null;
  try { v = JSON.parse(localStorage.getItem("skin")); } catch (e) { v = null; }
  if (v === "classic") document.documentElement.removeAttribute("data-skin");
  else document.documentElement.setAttribute("data-skin", "board");
})();
