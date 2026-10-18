/* Day, dusk, and night from the player's local clock. Country and GPS are not read. */
(function (root, factory) {
  var api = factory();
  if (root) root.ZyronSky = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function skyFor(hour) {
    var h = Number(hour);
    if (!isFinite(h)) h = 12;
    h = ((Math.floor(h) % 24) + 24) % 24;
    if (h >= 20 || h < 5) return "night";
    if (h < 8 || h >= 17) return "dusk";
    return "day";
  }

  function apply(doc, date) {
    var when = date || new Date();
    var sky = skyFor(when.getHours());
    if (doc && doc.documentElement) doc.documentElement.setAttribute("data-sky", sky);
    return sky;
  }

  return { skyFor: skyFor, apply: apply };
});
