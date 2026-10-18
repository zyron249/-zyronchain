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
  function board(className) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("class", className);
    return svg;
  }
  function dot(x, y, r) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    node.setAttribute("cx", String(x));
    node.setAttribute("cy", String(y));
    node.setAttribute("r", String(r));
    node.setAttribute("class", "map-dot");
    return node;
  }
  var sky = board("galaxy");
  var nodes = window.ZyronMap.galaxy(18, 11);
  nodes.forEach(function (node, index) {
    if (index) {
      var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(nodes[index - 1].x));
      line.setAttribute("y1", String(nodes[index - 1].y));
      line.setAttribute("x2", String(node.x));
      line.setAttribute("y2", String(node.y));
      line.setAttribute("class", "map-link");
      sky.append(line);
    }
    sky.append(dot(node.x, node.y, index % 6 === 0 ? 1.8 : 1.1));
  });
  var world = board("world-map");
  [{ code: "US", x: 20, y: 40 }, { code: "DE", x: 52, y: 34 }, { code: "JP", x: 86, y: 40 }].forEach(function (place) {
    var mark = dot(place.x, place.y, 2.2);
    mark.setAttribute("data-country", place.code);
    world.append(mark);
  });
  stage.append(el("article", { class: "card", "data-map": "1", "data-galaxy": "1" }, [
    el("h2", { text: "Your chain" }),
    el("p", { class: "fine", text: "18 blocks in your galaxy. Your completed blocks, drawn as light." }),
    sky,
    el("h2", { text: "Builders by country" }),
    el("p", { class: "fine", text: "Country only, and only if you opt in. No precise location." }),
    world
  ]));
})();
