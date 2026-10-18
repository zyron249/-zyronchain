/* Personal chain galaxy. Positions come from the block count, never from a location. */
(function (root, factory) {
  var api = factory();
  if (root) root.ZyronMap = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function galaxy(blocks, seed) {
    var count = Math.max(0, Math.min(48, Number(blocks) || 0));
    var spin = Math.abs(Number(seed) || 1) % 997;
    var nodes = [];
    for (var i = 0; i < count; i += 1) {
      var angle = ((i * 137.5) + spin) * Math.PI / 180;
      var radius = 10 + (i % 8) * 4.2;
      var x = 50 + Math.cos(angle) * radius;
      var y = 50 + Math.sin(angle) * radius * 0.72;
      nodes.push({
        x: Math.round(Math.max(8, Math.min(92, x)) * 10) / 10,
        y: Math.round(Math.max(12, Math.min(88, y)) * 10) / 10
      });
    }
    return nodes;
  }

  return { galaxy: galaxy };
});
