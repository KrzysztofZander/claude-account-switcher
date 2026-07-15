(function () {
  const vscode = acquireVsCodeApi();
  let state = { accounts: [], warnThreshold: 80 };

  const listEl = document.getElementById("list");
  const emptyEl = document.getElementById("empty");

  document.getElementById("addBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "add" });
  });
  document.getElementById("loginBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "login" });
  });
  document.getElementById("sayHiBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "sayHiAll" });
  });
  document.getElementById("refreshBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "refreshAll" });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "state") {
      state = msg;
      render();
    }
  });

  function fmtReset(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    const diff = t - Date.now();
    if (diff <= 0) return "resets soon";
    const mins = Math.round(diff / 60000);
    if (mins < 60) return `resets in ${mins} min`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    if (hours < 24) return `resets in ${hours}h ${rem}m`;
    const days = Math.floor(hours / 24);
    return `resets in ${days}d ${hours % 24}h`;
  }

  function fmtAgo(ts) {
    if (!ts) return "no data";
    const diff = Date.now() - ts;
    const s = Math.round(diff / 1000);
    if (s < 60) return `updated ${s}s ago`;
    const m = Math.round(s / 60);
    return `updated ${m} min ago`;
  }

  function meter(w, warn) {
    const cls = w.percent >= warn ? "danger" : w.percent >= warn * 0.75 ? "warn" : "";
    const wrap = document.createElement("div");
    wrap.className = "meter";

    const label = document.createElement("div");
    label.className = "meter-label";
    const left = document.createElement("span");
    left.textContent = w.label;
    const right = document.createElement("span");
    right.textContent = w.percent + "%";
    label.append(left, right);

    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.className = "fill " + cls;
    fill.style.width = Math.min(100, Math.max(0, w.percent)) + "%";
    bar.appendChild(fill);

    wrap.append(label, bar);
    const reset = fmtReset(w.resetsAt);
    if (reset) {
      const r = document.createElement("div");
      r.className = "reset";
      r.textContent = reset;
      wrap.appendChild(r);
    }
    return wrap;
  }

  function iconButton(text, title, onClick) {
    const b = document.createElement("button");
    b.className = "icon-btn";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  function card(acc, warn) {
    const el = document.createElement("div");
    el.className = "card" + (acc.isActive ? " active" : "");

    const head = document.createElement("div");
    head.className = "card-head";

    const title = document.createElement("div");
    title.className = "title";
    const name = document.createElement("span");
    name.textContent = acc.label;
    title.appendChild(name);
    if (acc.isActive) {
      const badge = document.createElement("span");
      badge.className = "badge active";
      badge.textContent = "active";
      title.appendChild(badge);
    } else if (acc.subscriptionType) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = acc.subscriptionType;
      title.appendChild(badge);
    }
    head.appendChild(title);

    const headBtns = document.createElement("div");
    headBtns.appendChild(
      iconButton("⟳", "Refresh usage limits", () =>
        vscode.postMessage({ type: "refresh", id: acc.id })
      )
    );
    head.appendChild(headBtns);
    el.appendChild(head);

    if (acc.windows && acc.windows.length) {
      for (const w of acc.windows) {
        el.appendChild(meter(w, warn));
      }
    } else if (!acc.error) {
      const s = document.createElement("div");
      s.className = "sub";
      s.style.marginTop = "8px";
      s.textContent = "No usage data — click ⟳";
      el.appendChild(s);
    }

    if (acc.error) {
      const e = document.createElement("div");
      e.className = "error";
      e.textContent = "⚠ " + acc.error;
      el.appendChild(e);
    }

    const foot = document.createElement("div");
    foot.className = "sub";
    foot.style.marginTop = "6px";
    foot.textContent = fmtAgo(acc.fetchedAt);
    el.appendChild(foot);

    const actions = document.createElement("div");
    actions.className = "actions";

    const win = document.createElement("button");
    win.textContent = "Window";
    win.title = "Open this account in an independent VS Code window";
    win.addEventListener("click", () => vscode.postMessage({ type: "openWindow", id: acc.id }));
    actions.appendChild(win);

    if (!acc.isActive) {
      const sw = document.createElement("button");
      sw.className = "primary";
      sw.textContent = "Switch";
      sw.addEventListener("click", () => vscode.postMessage({ type: "switch", id: acc.id }));
      actions.appendChild(sw);

      const hi = document.createElement("button");
      hi.textContent = "Hi";
      hi.title = "Run a one-turn Haiku warmup without switching accounts";
      hi.addEventListener("click", () => vscode.postMessage({ type: "sayHi", id: acc.id }));
      actions.appendChild(hi);
    }
    actions.appendChild(
      iconButton("✎", "Rename", () => vscode.postMessage({ type: "rename", id: acc.id }))
    );
    actions.appendChild(
      iconButton("🗑", "Remove profile", () => vscode.postMessage({ type: "remove", id: acc.id }))
    );
    el.appendChild(actions);

    return el;
  }

  function render() {
    listEl.innerHTML = "";
    const accounts = state.accounts || [];
    if (accounts.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");
    for (const acc of accounts) {
      listEl.appendChild(card(acc, state.warnThreshold || 80));
    }
  }

  // Refresh countdowns every minute.
  setInterval(render, 60000);

  vscode.postMessage({ type: "ready" });
})();
