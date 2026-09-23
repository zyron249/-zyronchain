(function () {
  var root = document.querySelector("#app");
  if (!root) return;
  window.setTimeout(function () {
    if (root.dataset.booted) return;
    root.replaceChildren();
    var card = document.createElement("section");
    card.className = "gate";
    var title = document.createElement("h1");
    title.textContent = "ZYRON NODE did not finish loading";
    var copy = document.createElement("p");
    copy.textContent = "Close this screen and open Play Zyron again so the current app can load.";
    var button = document.createElement("button");
    button.className = "primary";
    button.type = "button";
    button.textContent = "Reload";
    button.addEventListener("click", function () {
      var url = new URL(window.location.href);
      url.searchParams.set("v", String(Date.now()));
      window.location.replace(url.pathname + "?" + url.searchParams.toString());
    });
    card.append(title, copy, button);
    root.append(card);
  }, 8000);
})();
