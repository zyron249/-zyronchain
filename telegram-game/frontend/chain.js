/* Chain Builder board helpers. The server owns the blueprint and the points. */
(function (root, factory) {
  var api = factory();
  if (root) root.ZyronChain = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var BLOCKS = ["blue", "chrome", "void", "ice", "gold"];

  function prefixLength(expected, placed) {
    var n = 0;
    expected = expected || [];
    placed = placed || [];
    for (var i = 0; i < expected.length && i < placed.length; i += 1) {
      if (expected[i] !== placed[i]) break;
      n += 1;
    }
    return n;
  }

  function tray(sequence, attempt) {
    var list = (sequence || []).slice();
    if (list.length < 2) return list;
    var shift = Math.abs(Number(attempt) || 1) % list.length;
    if (shift === 0) shift = 1;
    return list.slice(shift).concat(list.slice(0, shift));
  }

  return { BLOCKS: BLOCKS, prefixLength: prefixLength, tray: tray };
});
