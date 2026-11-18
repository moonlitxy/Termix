(function () {
  var EN = {
    "nav.features": "Features",
    "nav.security": "Security",
    "nav.download": "Download",
    "nav.faq": "FAQ",
    "hero.badge": "Tauri 2 · Rust · React",
    "hero.title": "Your SSH workflow, in one window",
    "hero.sub": "Multi-tab terminal, SFTP, port forwarding and system monitoring in one app. 5–15MB installer and about a third of Electron's memory footprint.",
    "hero.download": "Download latest",
    "hero.github": "View source",
    "hero.meta1": "macOS · Windows",
    "hero.meta2": "Local-only, no telemetry",
    "hero.meta3": "Chinese & English UI",
    "features.title": "Everything you touch every day",
    "features.sub": "Not everything for everyone — the frequent paths, made smooth.",
    "f.term.title": "Multi-tab terminal",
    "f.term.desc": "Split panes, duplicate tabs, in-terminal search, log export, auto-reconnect and keepalive.",
    "f.sftp.title": "SFTP & local files",
    "f.sftp.desc": "List first, folder sizes later — big directories open instantly. Resume, queue and two-way drag & drop.",
    "f.fwd.title": "Three forwarding types",
    "f.fwd.desc": "Local, remote and dynamic SOCKS5, toggleable anytime with busy-port detection.",
    "f.mon.title": "System monitoring",
    "f.mon.desc": "CPU chart, memory and disk in a unified large unit, top processes and partitions at a glance.",
    "f.auth.title": "Complete auth support",
    "f.auth.desc": "Password, key, keyboard-interactive (2FA) and SSH Agent, plus single-level jump hosts and agent forwarding.",
    "f.migrate.title": "Painless migration",
    "f.migrate.desc": "Import ~/.ssh/config in one click; every change is auto-backed up and restorable.",
    "sec.title": "Security and data stay with you",
    "sec.1": "Master password derives a key with PBKDF2 and encrypts secrets using AES-256-GCM",
    "sec.2": "Host-key TOFU checks; fingerprint changes require explicit confirmation",
    "sec.3": "Sessions and groups live in a local SQLite file, never uploaded",
    "sec.4": "10 rolling local backups; import and export never leave your machine",
    "sec.5": "Updates over direct, mirror or proxy channels, each testable in-app",
    "sec.panelTitle": "Installer size",
    "sec.size1": "5–15 MB",
    "sec.size2": "80 MB+",
    "sec.size2Label": "Typical Electron app",
    "sec.note": "On the same machine: faster startup and roughly one third of the resident memory.",
    "dl.title": "Download Termix",
    "dl.sub": "Pick your platform — installers come from GitHub Releases.",
    "dl.mac": "Download for macOS",
    "dl.win": "Download for Windows",
    "dl.winFmt": "NSIS installer",
    "dl.hint": "If macOS blocks the first launch, allow it under System Settings → Privacy & Security.",
    "faq.title": "FAQ",
    "faq.q1": "Do you collect my data?",
    "faq.a1": "No. There is no telemetry and no account system; connections, secrets and backups stay on your device.",
    "faq.q2": "Does it support 2FA and jump hosts?",
    "faq.a2": "Yes. Keyboard-interactive auth prompts for codes while connecting; any saved session can act as a single-level jump host.",
    "faq.q3": "Can I import my existing SSH config?",
    "faq.a3": "Yes — read ~/.ssh/config in one click or import a file; Host, HostName, User, Port and IdentityFile are recognised.",
    "faq.q4": "What if updating fails?",
    "faq.a4": "In Settings → Updates, switch to a mirror or configure a proxy and use “Test connection” first.",
    "footer.repo": "GitHub",
    "footer.releases": "Releases",
    "footer.issues": "Issues",
  };

  var nodes = document.querySelectorAll("[data-i18n]");
  var originals = {};
  nodes.forEach(function (node, i) {
    originals[i] = node.textContent;
  });

  var KEY = "termix.site.lang";
  var toggle = document.getElementById("lang-toggle");

  function apply(lang) {
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    nodes.forEach(function (node, i) {
      var key = node.getAttribute("data-i18n");
      node.textContent =
        lang === "en" && EN[key] ? EN[key] : originals[i];
    });
    if (toggle) toggle.textContent = lang === "en" ? "中文" : "EN";
    try {
      localStorage.setItem(KEY, lang);
    } catch (e) {
      /* ignore */
    }
  }

  var saved = "zh";
  try {
    var fromQuery = new URLSearchParams(location.search).get("lang");
    var stored = fromQuery || localStorage.getItem(KEY);
    if (stored === "en" || stored === "zh") {
      saved = stored;
    } else {
      var nav = (navigator.language || "zh").toLowerCase();
      saved = nav.indexOf("zh") === 0 ? "zh" : "en";
    }
  } catch (e) {
    /* ignore */
  }
  apply(saved);

  if (toggle) {
    toggle.addEventListener("click", function () {
      apply(document.documentElement.lang === "en" ? "zh" : "en");
    });
  }
  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());
})();
