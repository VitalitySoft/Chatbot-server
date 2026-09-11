(() => {
  const API_BASE = window.location.origin;
  const sessionToken = sessionStorage.getItem("admin_session_token");
  const websiteId = sessionStorage.getItem("admin_website_id");

  if (!sessionToken || !websiteId) {
    window.location.href = "index.html";
    return;
  }

  document.getElementById("siteSlugOut").textContent = websiteId;
  document.getElementById("siteNameOut").textContent = websiteId;
  fetch(`${API_BASE}/api/website-config/${websiteId}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      if (cfg && cfg.businessName) document.getElementById("siteNameOut").textContent = cfg.businessName;
    })
    .catch(() => {
      // non-fatal -- the Website ID is already shown
    });

  function formatAskerLabel(entry) {
    return entry.askerType === "customer" ? entry.askerId : "Guest";
  }

  let allEntries = [];
  let activeFilter = "all";

  function render() {
    const list = document.getElementById("conversationsList");
    const empty = document.getElementById("conversationsEmptyState");
    const entries = allEntries.filter((e) => {
      if (activeFilter === "unanswered") return !e.wasAnswered;
      if (activeFilter === "answered") return e.wasAnswered;
      return true;
    });

    if (entries.length === 0) {
      list.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    list.innerHTML = "";
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "convo-row";
      row.innerHTML = `
        <div class="convo-top">
          <span class="convo-asker"></span>
          <span class="convo-badge"></span>
          <span class="convo-time"></span>
        </div>
        <div class="convo-q"></div>
        <div class="convo-a"></div>
      `;
      const askerEl = row.querySelector(".convo-asker");
      askerEl.textContent = formatAskerLabel(entry);
      askerEl.classList.toggle("customer", entry.askerType === "customer");
      const badgeEl = row.querySelector(".convo-badge");
      badgeEl.textContent = entry.wasAnswered ? "Answered" : "Unanswered";
      badgeEl.classList.toggle("answered", entry.wasAnswered);
      row.querySelector(".convo-time").textContent = new Date(entry.createdAt).toLocaleString();
      row.querySelector(".convo-q").textContent = entry.message;
      row.querySelector(".convo-a").textContent = entry.answer;
      list.appendChild(row);
    }
  }

  document.querySelectorAll(".filters .btn-secondary").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filters .btn-secondary").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.dataset.filter;
      render();
    });
  });

  async function loadConversations() {
    const errorEl = document.getElementById("conversationsError");
    try {
      const resp = await fetch(`${API_BASE}/api/admin/${websiteId}/conversations`, {
        headers: { "X-Admin-Session": sessionToken },
      });
      if (resp.status === 401) {
        sessionStorage.removeItem("admin_session_token");
        sessionStorage.removeItem("admin_website_id");
        window.location.href = "index.html";
        return;
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || "Request failed");
      allEntries = data;
      render();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
    }
  }

  loadConversations();
})();
