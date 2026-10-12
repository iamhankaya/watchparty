// CSP inline script'e izin vermediği için tema başlatma ayrı dosyada; senkron yüklenmeli (async/defer/module yok).
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem("wp:theme");
  } catch (e) {}
  if (theme !== "dark" && theme !== "light")
    theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
})();
