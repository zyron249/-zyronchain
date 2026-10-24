/* Cosmetic builder appearance. The server decides what is owned and equipped. */
(function (root, factory) {
  var api = factory();
  if (root) root.ZyronWardrobe = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var FREE = { helmet: "stock", pickaxe: "stock", color: "electric" };

  function appearance(loadout) {
    loadout = loadout || {};
    return {
      helmet: loadout.helmet || FREE.helmet,
      pickaxe: loadout.pickaxe || FREE.pickaxe,
      color: loadout.color || FREE.color,
      mask: loadout.wolfMask ? "wolf" : "none"
    };
  }

  function attrs(loadout) {
    var look = appearance(loadout);
    return {
      "data-helmet": look.helmet,
      "data-pick": look.pickaxe,
      "data-color": look.color,
      "data-mask": look.mask
    };
  }

  return { FREE: FREE, appearance: appearance, attrs: attrs };
});
