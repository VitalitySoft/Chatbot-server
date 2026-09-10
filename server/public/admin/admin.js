(() => {
  const API_BASE = window.location.origin;

  let sessionToken = sessionStorage.getItem("admin_session_token");
  let websiteId = sessionStorage.getItem("admin_website_id");
  let editingId = null;

  const loginView = document.getElementById("loginView");
  const appView = document.getElementById("appView");
  const loginError = document.getElementById("loginError");
  const formError = document.getElementById("formError");

  function showApp() {
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");
    document.getElementById("siteSlugOut").textContent = websiteId;
    document.getElementById("siteNameOut").textContent = websiteId;
    loadBusinessName();
    loadItems();
    loadDocuments();
    loadSettings();
    loadUnanswered();
  }

  function showLogin() {
    appView.classList.add("hidden");
    loginView.classList.remove("hidden");
  }

  async function api(path, options = {}) {
    const resp = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(sessionToken ? { "X-Admin-Session": sessionToken } : {}),
        ...(options.headers || {}),
      },
    });
    if (resp.status === 401) {
      sessionToken = null;
      websiteId = null;
      sessionStorage.removeItem("admin_session_token");
      sessionStorage.removeItem("admin_website_id");
      showLogin();
      throw new Error("Session expired, please log in again");
    }
    if (resp.status === 204) return null;
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  async function loadBusinessName() {
    try {
      const cfg = await fetch(`${API_BASE}/api/website-config/${websiteId}`).then((r) => (r.ok ? r.json() : null));
      if (cfg && cfg.businessName) document.getElementById("siteNameOut").textContent = cfg.businessName;
    } catch {
      // non-fatal -- the Website ID is already shown
    }
  }

  document.getElementById("loginBtn").addEventListener("click", async () => {
    loginError.classList.add("hidden");
    const site = document.getElementById("loginWebsiteId").value.trim();
    const username = document.getElementById("loginUsername").value.trim();
    const password = document.getElementById("loginPassword").value;
    try {
      const resp = await fetch(`${API_BASE}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ websiteId: site, username, password }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Login failed");
      sessionToken = data.sessionToken;
      websiteId = site;
      sessionStorage.setItem("admin_session_token", sessionToken);
      sessionStorage.setItem("admin_website_id", websiteId);
      showApp();
    } catch (err) {
      loginError.textContent = err.message;
      loginError.classList.remove("hidden");
    }
  });

  document.getElementById("logoutBtn").addEventListener("click", () => {
    sessionToken = null;
    websiteId = null;
    sessionStorage.removeItem("admin_session_token");
    sessionStorage.removeItem("admin_website_id");
    showLogin();
  });

  function resetForm() {
    editingId = null;
    document.getElementById("itemTitle").value = "";
    document.getElementById("itemContent").value = "";
    document.getElementById("formTitle").textContent = "Add an article";
    document.getElementById("saveBtn").textContent = "Add Article";
    document.getElementById("cancelEditBtn").classList.add("hidden");
    formError.classList.add("hidden");
  }

  document.getElementById("cancelEditBtn").addEventListener("click", resetForm);

  document.getElementById("saveBtn").addEventListener("click", async () => {
    formError.classList.add("hidden");
    const title = document.getElementById("itemTitle").value.trim();
    const content = document.getElementById("itemContent").value.trim();
    if (!title || !content) {
      formError.textContent = "Both title and content are required.";
      formError.classList.remove("hidden");
      return;
    }
    try {
      if (editingId) {
        await api(`/api/admin/${websiteId}/knowledge/${editingId}`, { method: "PUT", body: JSON.stringify({ title, content }) });
      } else {
        await api(`/api/admin/${websiteId}/knowledge`, { method: "POST", body: JSON.stringify({ title, content }) });
      }
      const resolvingId = pendingUnansweredId;
      pendingUnansweredId = null;
      resetForm();
      loadItems();
      if (resolvingId) resolveUnanswered(resolvingId, { silent: true });
    } catch (err) {
      formError.textContent = err.message;
      formError.classList.remove("hidden");
    }
  });

  function startEdit(item) {
    editingId = item.id;
    document.getElementById("itemTitle").value = item.title;
    document.getElementById("itemContent").value = item.content;
    document.getElementById("formTitle").textContent = "Edit article";
    document.getElementById("saveBtn").textContent = "Save Changes";
    document.getElementById("cancelEditBtn").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function removeItem(id) {
    if (!confirm("Delete this article?")) return;
    try {
      await api(`/api/admin/${websiteId}/knowledge/${id}`, { method: "DELETE" });
      loadItems();
    } catch (err) {
      alert(err.message);
    }
  }

  async function loadItems() {
    const list = document.getElementById("itemList");
    const empty = document.getElementById("emptyState");
    try {
      const items = await api(`/api/admin/${websiteId}/knowledge`);
      document.getElementById("itemCount").textContent = items.length;
      list.innerHTML = "";
      empty.classList.toggle("hidden", items.length > 0);
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML = `
          <div>
            <div class="row-title"></div>
            <div class="row-sub"></div>
          </div>
          <div class="row-actions">
            <button class="btn-secondary edit-btn">Edit</button>
            <button class="btn-danger delete-btn">Delete</button>
          </div>
        `;
        row.querySelector(".row-title").textContent = item.title;
        row.querySelector(".row-sub").textContent = item.content;
        row.querySelector(".edit-btn").addEventListener("click", () => startEdit(item));
        row.querySelector(".delete-btn").addEventListener("click", () => removeItem(item.id));
        list.appendChild(row);
      }
    } catch (err) {
      list.innerHTML = `<p class="error">${err.message}</p>`;
    }
  }

  // -- Documents --------------------------------------------------------

  const uploadError = document.getElementById("uploadError");
  const uploadStatus = document.getElementById("uploadStatus");
  const fileInput = document.getElementById("fileInput");

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;

    uploadError.classList.add("hidden");
    uploadStatus.classList.remove("hidden");
    uploadStatus.className = "muted-note";
    uploadStatus.textContent = "Uploading and reading the document...";

    const formData = new FormData();
    formData.append("file", file);

    try {
      const resp = await fetch(`${API_BASE}/api/admin/${websiteId}/documents`, {
        method: "POST",
        headers: { "X-Admin-Session": sessionToken },
        body: formData,
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 401) {
        showLogin();
        throw new Error("Session expired, please log in again");
      }
      if (!resp.ok) throw new Error(data.error || "Upload failed");

      uploadStatus.className = "success-note";
      uploadStatus.textContent = `Added ${data.chunkCount} knowledge chunk${data.chunkCount === 1 ? "" : "s"} from "${data.filename}".`;
      loadItems();
      loadDocuments();
    } catch (err) {
      uploadStatus.classList.add("hidden");
      uploadError.textContent = err.message;
      uploadError.classList.remove("hidden");
    } finally {
      fileInput.value = "";
    }
  });

  async function openDocument(doc, forceDownload) {
    try {
      const resp = await fetch(`${API_BASE}/api/admin/${websiteId}/documents/${doc.id}/file`, {
        headers: { "X-Admin-Session": sessionToken },
      });
      if (resp.status === 401) {
        showLogin();
        throw new Error("Session expired, please log in again");
      }
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || "Could not open file");
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      if (forceDownload) {
        const a = document.createElement("a");
        a.href = url;
        a.download = doc.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        window.open(url, "_blank");
      }
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err) {
      alert(err.message);
    }
  }

  async function removeDocument(id) {
    if (!confirm("Delete this document? Its extracted knowledge will also be removed.")) return;
    try {
      await api(`/api/admin/${websiteId}/documents/${id}`, { method: "DELETE" });
      loadItems();
      loadDocuments();
    } catch (err) {
      alert(err.message);
    }
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function loadDocuments() {
    const list = document.getElementById("docList");
    const empty = document.getElementById("docEmptyState");
    try {
      const docs = await api(`/api/admin/${websiteId}/documents`);
      document.getElementById("docCount").textContent = docs.length;
      list.innerHTML = "";
      empty.classList.toggle("hidden", docs.length > 0);
      for (const doc of docs) {
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML = `
          <div>
            <div class="row-title"></div>
            <div class="row-meta"></div>
          </div>
          <div class="row-actions">
            <button class="btn-secondary view-btn">View</button>
            <button class="btn-secondary download-btn">Download</button>
            <button class="btn-danger delete-btn">Delete</button>
          </div>
        `;
        row.querySelector(".row-title").textContent = doc.filename;
        row.querySelector(".row-meta").textContent = `${formatBytes(doc.sizeBytes)} · ${doc.chunkIds.length} knowledge chunk${doc.chunkIds.length === 1 ? "" : "s"} · uploaded ${new Date(doc.uploadedAt).toLocaleString()}`;
        row.querySelector(".view-btn").addEventListener("click", () => openDocument(doc, false));
        row.querySelector(".download-btn").addEventListener("click", () => openDocument(doc, true));
        row.querySelector(".delete-btn").addEventListener("click", () => removeDocument(doc.id));
        list.appendChild(row);
      }
    } catch (err) {
      list.innerHTML = `<p class="error">${err.message}</p>`;
    }
  }

  // -- Unanswered questions ------------------------------------------------

  let pendingUnansweredId = null;

  function answerUnanswered(item) {
    pendingUnansweredId = item.id;
    document.getElementById("itemTitle").value = item.message;
    document.getElementById("itemContent").focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function resolveUnanswered(id, opts = {}) {
    try {
      await api(`/api/admin/${websiteId}/unanswered/${id}/resolve`, { method: "POST" });
      loadUnanswered();
    } catch (err) {
      if (!opts.silent) alert(err.message);
    }
  }

  async function dismissUnanswered(id) {
    try {
      await api(`/api/admin/${websiteId}/unanswered/${id}`, { method: "DELETE" });
      loadUnanswered();
    } catch (err) {
      alert(err.message);
    }
  }

  async function loadUnanswered() {
    const list = document.getElementById("unansweredList");
    const empty = document.getElementById("unansweredEmptyState");
    const countEl = document.getElementById("unansweredCount");
    const flag = document.getElementById("unansweredFlag");
    const flagCount = document.getElementById("unansweredFlagCount");
    try {
      const items = await api(`/api/admin/${websiteId}/unanswered`);
      countEl.textContent = items.length;
      flag.classList.toggle("hidden", items.length === 0);
      flagCount.textContent = items.length;
      list.innerHTML = "";
      empty.classList.toggle("hidden", items.length > 0);
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "row unanswered-row";
        row.innerHTML = `
          <div>
            <div class="row-title"></div>
            <div class="row-meta"></div>
          </div>
          <div class="row-actions">
            <button class="btn-secondary answer-btn">Answer</button>
            <button class="btn-danger dismiss-btn">Dismiss</button>
          </div>
        `;
        row.querySelector(".row-title").textContent = item.message;
        row.querySelector(".row-meta").textContent = `asked ${item.count}× · last ${new Date(item.lastAskedAt).toLocaleDateString()}`;
        row.querySelector(".answer-btn").addEventListener("click", () => answerUnanswered(item));
        row.querySelector(".dismiss-btn").addEventListener("click", () => dismissUnanswered(item.id));
        list.appendChild(row);
      }
    } catch (err) {
      list.innerHTML = `<p class="error">${err.message}</p>`;
    }
  }

  // -- Database connection (advanced) ------------------------------------

  async function loadSettings() {
    try {
      const settings = await api(`/api/admin/${websiteId}/settings`);
      document.getElementById("customApiUrlInput").value = settings.customApiUrl || "";
    } catch (err) {
      // non-fatal -- leave the field blank rather than blocking the page
    }
  }

  document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
    const settingsError = document.getElementById("settingsError");
    const settingsStatus = document.getElementById("settingsStatus");
    settingsError.classList.add("hidden");
    settingsStatus.classList.add("hidden");
    const customApiUrl = document.getElementById("customApiUrlInput").value.trim();
    try {
      await api(`/api/admin/${websiteId}/settings`, { method: "PUT", body: JSON.stringify({ customApiUrl }) });
      settingsStatus.className = "success-note";
      settingsStatus.textContent = customApiUrl ? "Saved. Your database is now connected." : "Saved. Database connection removed.";
      settingsStatus.classList.remove("hidden");
    } catch (err) {
      settingsError.textContent = err.message;
      settingsError.classList.remove("hidden");
    }
  });

  if (sessionToken && websiteId) showApp();
})();
