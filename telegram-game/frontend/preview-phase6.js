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
  var cipher = el("article", { class: "card", "data-cipher": "1" }, [
    el("h2", { text: "Daily cipher" }),
    el("p", { class: "cipher-mask", text: "B _ _ _ _ R" }),
    el("p", { class: "fine", text: "Guess the builder word. The server checks it. 8 Zyron Points." }),
    el("input", { "data-cipher-guess": "1", value: "BUILDER" }),
    el("button", { class: "primary", text: "Submit guess" })
  ]);
  var active = { kind: "bug_monster", hp: 48, maxHp: 120, progress: 0, goal: 120, defeated: false, title: "Bug monster" };
  var ratio = window.ZyronEvents.barRatio(active);
  var bar = el("div", { class: "bar hp-bar" }, [el("i")]);
  bar.firstChild.style.width = (ratio * 100) + "%";
  var event = el("article", { class: "card", "data-event": "bug_monster" }, [
    el("h2", { text: "Bug monster" }),
    el("p", { class: "fine", text: "Shared HP. Every builder's strike counts. Zyron Points only, not ZYN." }),
    bar,
    el("p", { "data-hp": "1", text: active.hp + " / " + active.maxHp + " HP" }),
    el("button", { class: "primary", text: "Strike" })
  ]);
  stage.append(cipher);
  stage.append(event);
  window.setTimeout(function () {
    active.hp = 0;
    active.defeated = true;
    bar.firstChild.style.width = "0%";
    event.querySelector("[data-hp]").textContent = "0 / 120 HP";
    event.className = "card is-cleared";
    var burst = el("div", { class: "event-burst", "data-event-burst": "1" });
    var sparks = window.ZyronEvents.sparkCount(active);
    for (var i = 0; i < sparks; i += 1) {
      var spark = el("i", { class: "event-spark" });
      spark.style.setProperty("--deg", String((360 / sparks) * i) + "deg");
      burst.append(spark);
    }
    event.append(burst);
    event.append(el("div", { class: "event-boom", text: "Cleared" }));
    event.append(el("button", { class: "primary", text: "Claim goal" }));
  }, 4200);
})();
