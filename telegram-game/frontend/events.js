/* Network event bar. Damage and points stay on the server. */
(function (root, factory) {
  var api = factory();
  if (root) root.ZyronEvents = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function barRatio(active) {
    if (!active) return 0;
    var monster = active.kind === "bug_monster";
    var raw = monster
      ? (active.maxHp ? Number(active.hp) / Number(active.maxHp) : 0)
      : (active.goal ? Number(active.progress) / Number(active.goal) : 0);
    if (!(raw > 0)) return 0;
    if (raw > 1) return 1;
    return raw;
  }

  function sparkCount(active) {
    return active && active.defeated ? 8 : 0;
  }

  return { barRatio: barRatio, sparkCount: sparkCount };
});
