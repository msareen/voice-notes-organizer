/* Service worker registration and the "install this as an app" banner.
   Browsers only fire beforeinstallprompt when the page is otherwise
   eligible (manifest + service worker + engagement heuristics), so this
   banner surfaces that moment instead of relying on the user to notice the
   address bar's own install icon. */

/**
 * `beforeinstallprompt` is a Chromium extension to the spec, so it isn't in
 * TypeScript's DOM library - only the two members used here are declared.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function initPwa(): void {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(function () {
      // Installability/offline fallback is a nice-to-have, not required for
      // the app to work - a failed registration shouldn't be user-facing.
    });
  }

  // Already running standalone (installed, or the banner was dismissed and
  // the browser remembers) - nothing to offer.
  if (window.matchMedia("(display-mode: standalone)").matches) return;

  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    showInstallBanner(event as BeforeInstallPromptEvent);
  });
}

function showInstallBanner(installEvent: BeforeInstallPromptEvent): void {
  if (document.getElementById("pwaInstall")) return;

  var bar = document.createElement("div");
  bar.id = "pwaInstall";
  bar.className = "pwa-install";

  var text = document.createElement("span");
  text.textContent = "Install Voice Notes as an app for quicker launching.";
  bar.appendChild(text);

  var actions = document.createElement("span");
  actions.className = "pwa-install-actions";

  var install = document.createElement("button");
  install.className = "btn primary";
  install.type = "button";
  install.textContent = "Install";
  install.addEventListener("click", function () {
    bar.remove();
    installEvent.prompt();
  });
  actions.appendChild(install);

  var dismiss = document.createElement("button");
  dismiss.className = "btn";
  dismiss.type = "button";
  dismiss.textContent = "Not now";
  dismiss.addEventListener("click", function () {
    bar.remove();
  });
  actions.appendChild(dismiss);

  bar.appendChild(actions);
  document.body.appendChild(bar);
}
