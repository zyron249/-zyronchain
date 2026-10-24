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
  var league = [
    { rank: 1, name: "North Pack", tag: "WOLF", score: "640", badge: "gold" },
    { rank: 2, name: "Chrome Ring", tag: "RING", score: "410", badge: "silver" },
    { rank: 3, name: "Blue Orbit", tag: "BLUE", score: "260", badge: "bronze" }
  ];
  var card = el("article", { class: "card", "data-squad": "1" }, [
    el("h2", { text: "Weekly squad league" }),
    el("p", { class: "fine", text: "Top three earn a badge. Zyron Points only, not ZYN." })
  ]);
  league.forEach(function (row) {
    card.append(el("div", { class: "rank-row league-row badge-" + row.badge, "data-badge": row.badge }, [
      el("span", { text: "#" + row.rank + " " + row.name + " · " + row.tag }),
      el("strong", { text: row.score })
    ]));
  });
  card.append(el("p", { class: "badge-on", text: "Team captain" }));
  var pips = el("div", { class: "chain-pips", "data-streak-chain": "7" });
  for (var i = 1; i <= 7; i += 1) pips.append(el("i", { class: "on", text: String(i) }));
  stage.append(card);
  stage.append(el("article", { class: "card" }, [
    el("h2", { text: "7-day chain" }),
    el("p", { class: "fine", text: "First 100 blocks · 7-day streak · Team captain" }),
    pips
  ]));
})();
