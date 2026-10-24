(function () {
  var stage = document.getElementById("stage");
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (attrs[key] == null) return;
      if (key === "class") node.className = attrs[key];
      else if (key === "text") node.textContent = String(attrs[key]);
      else node.setAttribute(key, String(attrs[key]));
    });
    (children || []).forEach(function (child) { if (child) node.append(child); });
    return node;
  }
  var card = {
    id: "streak_7",
    title: "7-day streak",
    line: "7-day streak on ZYRON NODE. Zyron Points stay off-chain and separate from ZYN."
  };
  var links = window.ZyronCards.shareLinks(card);
  var canvas = el("canvas", { "data-share-canvas": "1" });
  var sheet = el("article", { class: "card", "data-share-sheet": "1", "data-card": "streak_7" }, [
    el("h2", { text: card.title }),
    el("p", { class: "fine", text: card.line }),
    canvas,
    el("button", { class: "primary", text: "Share on Telegram", "data-share": "telegram", href: links.telegram }),
    el("button", { class: "ghost", text: "Share on X", "data-share": "x", href: links.x }),
    el("p", { class: "fine", text: "Gold node reached" })
  ]);
  stage.append(sheet);
  window.ZyronCards.paint(canvas, card);
})();
