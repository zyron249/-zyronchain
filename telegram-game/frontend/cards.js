/* Share-card drawing. The server supplies the line. This file does not invent rewards. */
(function (root, factory) {
  var api = factory();
  if (root) root.ZyronCards = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function shareLinks(card) {
    var text = (card && card.line) || "";
    var page = "https://t.me/ZyronNodeBot";
    return {
      telegram: "https://t.me/share/url?url=" + encodeURIComponent(page) + "&text=" + encodeURIComponent(text),
      x: "https://twitter.com/intent/tweet?text=" + encodeURIComponent(text)
    };
  }

  function paint(canvas, card) {
    if (!canvas || !canvas.getContext) return;
    var size = 720;
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#0a0a0b";
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = "#ffcc33";
    ctx.lineWidth = 8;
    ctx.strokeRect(28, 28, size - 56, size - 56);
    ctx.beginPath();
    ctx.arc(size / 2, 210, 72, 0, Math.PI * 2);
    ctx.strokeStyle = "#f9b700";
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.fillStyle = "#faf8f2";
    ctx.font = "700 64px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Z", size / 2, 232);
    ctx.font = "700 42px sans-serif";
    wrap(ctx, (card && card.title) || "ZYRON NODE", size / 2, 360, 560, 50);
    ctx.fillStyle = "#c2bcae";
    ctx.font = "28px sans-serif";
    wrap(ctx, (card && card.line) || "", size / 2, 470, 560, 36);
    ctx.fillStyle = "#ffcc33";
    ctx.font = "22px sans-serif";
    ctx.fillText("ZYRON NODE", size / 2, 650);
  }

  function wrap(ctx, text, x, y, width, lineHeight) {
    var words = String(text).split(/\s+/);
    var line = "";
    var drawn = 0;
    words.forEach(function (word) {
      var next = line ? line + " " + word : word;
      if (ctx.measureText(next).width > width && line) {
        ctx.fillText(line, x, y + drawn * lineHeight);
        line = word;
        drawn += 1;
      } else line = next;
    });
    if (line && drawn < 4) ctx.fillText(line, x, y + drawn * lineHeight);
  }

  return { shareLinks: shareLinks, paint: paint };
});
