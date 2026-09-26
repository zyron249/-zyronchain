(function () {
  var root = document.querySelector("#app");
  if (!root) return;
  window.setTimeout(function () {
    if (root.dataset.booted) return;
    root.replaceChildren();
    var buildMeta = document.querySelector('meta[name="zyron-build"]');
    var build = buildMeta ? buildMeta.getAttribute("content") || "" : "";
    var card = document.createElement("section");
    card.className = "gate gate-brand";
    var logo = document.createElement("img");
    logo.className = "logo logo-panel";
    logo.alt = "ZYRON";
    logo.width = 156;
    logo.height = 156;
    logo.src = "/assets/logo.png?v=" + encodeURIComponent(build);
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
    card.append(logo, title, copy, button);
    root.append(card);
  }, 8000);
})();
