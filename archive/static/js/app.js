const state = {
  agents: [],
  conversations: [],
  activeConversationId: null,
  ws: null,
  streamingEl: null,
  sessionSearchQuery: "",
};

function initTheme() {
  const saved = localStorage.getItem("theme") || "slate";
  document.documentElement.setAttribute("data-theme", saved);
  document.querySelectorAll(".theme-swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === saved);
    btn.addEventListener("click", () => {
      document.documentElement.setAttribute("data-theme", btn.dataset.theme);
      localStorage.setItem("theme", btn.dataset.theme);
      document.querySelectorAll(".theme-swatch").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
}
initTheme();

function initRailCollapse() {
  const rail = document.getElementById("rail");
  const collapsed = localStorage.getItem("railCollapsed") === "1";
  rail.classList.toggle("collapsed", collapsed);
  document.getElementById("collapse-rail-btn").addEventListener("click", () => {
    const isCollapsed = rail.classList.toggle("collapsed");
    localStorage.setItem("railCollapsed", isCollapsed ? "1" : "0");
  });
}
initRailCollapse();

const modalBackdrop = document.getElementById("modal-backdrop");
const modal = document.getElementById("modal");

function openModal(html) {
  modal.innerHTML = html;
  modalBackdrop.classList.remove("hidden");
}
function closeModal() {
  modalBackdrop.classList.add("hidden");
  modal.innerHTML = "";
}
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal();
});

async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(detail || resp.statusText);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ---------- Tabs ----------
document.querySelectorAll(".rail-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".rail-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "agents") loadAgents();
    if (btn.dataset.tab === "models") loadModelsTab();
    if (btn.dataset.tab === "settings") loadSettingsTab();
  });
});

// ---------- Agents ----------
async function loadAgents() {
  state.agents = await api("/api/agents");
  renderAgents();
}

function renderAgents() {
  const grid = document.getElementById("agents-list");
  if (!state.agents.length) {
    grid.innerHTML = `<div class="empty">No agents yet. Create one to get started.</div>`;
    return;
  }
  grid.innerHTML = state.agents
    .map(
      (a) => `
    <div class="agent-card" style="border-left:3px solid ${a.color}">
      <div class="name">${escapeHtml(a.name)}</div>
      <div class="model">${escapeHtml(a.model)} · temp ${a.temperature}</div>
      <div class="persona">${escapeHtml(a.persona)}</div>
      <div class="actions">
        <button data-edit="${a.id}">Edit</button>
        <button data-delete="${a.id}" class="danger">Delete</button>
      </div>
    </div>`
    )
    .join("");

  grid.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", () => openAgentModal(state.agents.find((a) => a.id === btn.dataset.edit)))
  );
  grid.querySelectorAll("[data-delete]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this agent?")) return;
      await api(`/api/agents/${btn.dataset.delete}`, { method: "DELETE" });
      loadAgents();
    })
  );
}

document.getElementById("new-agent-btn").addEventListener("click", () => openAgentModal(null));

async function openAgentModal(agent) {
  let models = [];
  try {
    models = await api("/api/models");
  } catch {
    models = [];
  }
  const modelOptions = models.length
    ? models.map((m) => `<option value="${m.name}" ${agent && agent.model === m.name ? "selected" : ""}>${m.name}</option>`).join("")
    : `<option value="${agent ? agent.model : ""}">${agent ? agent.model : "no models found — pull one in Models tab"}</option>`;

  openModal(`
    <h3>${agent ? "Edit Agent" : "New Agent"}</h3>
    <form id="agent-form">
      <div class="field"><label>Name</label><input name="name" value="${agent ? escapeHtml(agent.name) : ""}" required /></div>
      <div class="field"><label>Model</label><select name="model">${modelOptions}</select></div>
      <div class="field"><label>Persona / system prompt</label><textarea name="persona" rows="5" required>${agent ? escapeHtml(agent.persona) : ""}</textarea></div>
      <div class="field"><label>Temperature</label><input name="temperature" type="number" step="0.1" min="0" max="2" value="${agent ? agent.temperature : 0.7}" /></div>
      <div class="field"><label>Color</label><input name="color" type="color" value="${agent ? agent.color : "#5b8def"}" /></div>
      <div class="actions">
        <button type="button" id="cancel-agent">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>
  `);

  document.getElementById("cancel-agent").addEventListener("click", closeModal);
  document.getElementById("agent-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      name: fd.get("name"),
      model: fd.get("model"),
      persona: fd.get("persona"),
      temperature: parseFloat(fd.get("temperature")),
      color: fd.get("color"),
    };
    if (agent) {
      await api(`/api/agents/${agent.id}`, { method: "PUT", body: JSON.stringify(body) });
    } else {
      await api("/api/agents", { method: "POST", body: JSON.stringify(body) });
    }
    closeModal();
    loadAgents();
  });
}

// ---------- Conversations / Sessions ----------
async function loadConversations() {
  state.conversations = await api("/api/conversations");
  renderConversationList();
}

function renderConversationList() {
  const list = document.getElementById("conversation-list");
  const query = (state.sessionSearchQuery || "").toLowerCase();
  const filtered = query
    ? state.conversations.filter((c) => c.topic.toLowerCase().includes(query))
    : state.conversations;
  list.innerHTML = filtered
    .map(
      (c) => `
    <li class="conversation-item ${c.id === state.activeConversationId ? "active" : ""}" data-id="${c.id}">
      <button class="delete-conversation" data-id="${c.id}" title="Delete session">&times;</button>
      <span class="topic">${escapeHtml(c.topic)}</span>
      <span class="meta">${c.status} · ${new Date(c.created_at).toLocaleString()}</span>
    </li>`
    )
    .join("");
  list.querySelectorAll(".conversation-item").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest(".delete-conversation")) return;
      selectConversation(el.dataset.id);
    })
  );
  list.querySelectorAll(".delete-conversation").forEach((el) =>
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this session? This cannot be undone.")) return;
      await api(`/api/conversations/${el.dataset.id}`, { method: "DELETE" });
      if (state.activeConversationId === el.dataset.id) {
        state.activeConversationId = null;
        if (state.ws) state.ws.close();
        document.getElementById("run-active").classList.add("hidden");
        document.getElementById("run-empty").classList.remove("hidden");
      }
      loadConversations();
    })
  );
}

document.getElementById("session-search").addEventListener("input", (e) => {
  state.sessionSearchQuery = e.target.value;
  renderConversationList();
});

document.getElementById("new-run-btn").addEventListener("click", async () => {
  if (!state.agents.length) await loadAgents();
  if (!state.agents.length) {
    alert("Create at least one agent first.");
    return;
  }
  openModal(`
    <h3>New Session</h3>
    <form id="run-form">
      <div class="field">
        <label>Topic / opening prompt</label>
        <textarea name="topic" rows="4" required placeholder="e.g. Is now a good time to buy Nvidia?" autofocus></textarea>
      </div>
      <div class="field">
        <div class="participants-header">
          <label>Participants</label>
          <div class="participants-toggle">
            <button type="button" id="select-all-agents">All</button>
            <button type="button" id="select-no-agents">None</button>
          </div>
        </div>
        <div class="checkbox-list agent-checkbox-list">
          ${state.agents
            .map(
              (a) => `<label class="checkbox agent-checkbox" style="border-left:3px solid ${a.color}">
                <input type="checkbox" name="agent_ids" value="${a.id}" checked /> ${escapeHtml(a.name)}
              </label>`
            )
            .join("")}
        </div>
      </div>
      <div class="actions">
        <button type="button" id="cancel-run">Cancel</button>
        <button type="submit" class="primary">Start Session</button>
      </div>
    </form>
  `);
  document.getElementById("cancel-run").addEventListener("click", closeModal);
  document.getElementById("select-all-agents").addEventListener("click", () => {
    document.querySelectorAll('input[name="agent_ids"]').forEach((el) => (el.checked = true));
  });
  document.getElementById("select-no-agents").addEventListener("click", () => {
    document.querySelectorAll('input[name="agent_ids"]').forEach((el) => (el.checked = false));
  });
  document.getElementById("run-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const agentIds = fd.getAll("agent_ids");
    if (!agentIds.length) {
      alert("Pick at least one agent.");
      return;
    }
    const body = { topic: fd.get("topic"), agent_ids: agentIds };
    const conversation = await api("/api/conversations", { method: "POST", body: JSON.stringify(body) });
    closeModal();
    await loadConversations();
    selectConversation(conversation.id);
  });
});

async function selectConversation(id) {
  state.activeConversationId = id;
  renderConversationList();
  document.getElementById("run-empty").classList.add("hidden");
  document.getElementById("run-active").classList.remove("hidden");

  const conversation = await api(`/api/conversations/${id}`);
  document.getElementById("run-topic").textContent = conversation.topic;
  setStatusBadge(conversation.status);

  const messages = await api(`/api/conversations/${id}/messages`);
  const transcript = document.getElementById("transcript");
  transcript.innerHTML = "";
  messages.forEach(renderMessage);
  transcript.scrollTop = transcript.scrollHeight;

  connectWs(id);
}

function setStatusBadge(status) {
  document.getElementById("run-status").textContent = status;
}

function renderMessage(m) {
  const transcript = document.getElementById("transcript");
  const div = document.createElement("div");
  const roleClass = m.role === "user" ? "user" : m.role === "system" ? "system" : "agent";
  div.className = `msg ${roleClass}`;
  const thinkingHtml = m.thinking
    ? `<details><summary>thinking</summary><div class="thinking">${escapeHtml(m.thinking)}</div></details>`
    : "";
  const time = m.created_at
    ? new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";
  div.innerHTML = `
    <div class="author" style="color:${m.agent_color || "#888"}">${escapeHtml(m.agent_name || "System")} <span class="timestamp">${time}</span></div>
    <div class="bubble">${escapeHtml(m.content)}</div>
    ${thinkingHtml}
  `;
  transcript.appendChild(div);
  transcript.scrollTop = transcript.scrollHeight;
}

function startStreamingBubble(payload) {
  const transcript = document.getElementById("transcript");
  const div = document.createElement("div");
  div.className = "msg agent streaming";
  div.innerHTML = `
    <div class="author" style="color:${payload.agent_color || "#888"}">${escapeHtml(payload.agent_name || "Agent")}</div>
    <div class="bubble"></div>
  `;
  transcript.appendChild(div);
  transcript.scrollTop = transcript.scrollHeight;
  state.streamingEl = div;
}

function appendStreamingDelta(payload) {
  if (!state.streamingEl) return;
  const bubble = state.streamingEl.querySelector(".bubble");
  bubble.textContent += payload.text;
  const transcript = document.getElementById("transcript");
  transcript.scrollTop = transcript.scrollHeight;
}

function connectWs(conversationId) {
  if (state.ws) state.ws.close();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/conversations/${conversationId}`);
  ws.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "stream_start") startStreamingBubble(payload);
    if (payload.type === "delta") appendStreamingDelta(payload);
    if (payload.type === "message") {
      if (state.streamingEl) {
        state.streamingEl.remove();
        state.streamingEl = null;
      }
      renderMessage(payload.message);
    }
    if (payload.type === "status") setStatusBadge(payload.status);
    if (payload.type === "error") {
      if (state.streamingEl) {
        state.streamingEl.remove();
        state.streamingEl = null;
      }
      const transcript = document.getElementById("transcript");
      const div = document.createElement("div");
      div.className = "msg system";
      div.innerHTML = `<div class="bubble">${escapeHtml(payload.detail)}</div>`;
      transcript.appendChild(div);
    }
  };
  state.ws = ws;
}

document.getElementById("stop-run-btn").addEventListener("click", async () => {
  if (!state.activeConversationId) return;
  await api(`/api/conversations/${state.activeConversationId}/stop`, { method: "POST" });
});

document.getElementById("delete-run-btn").addEventListener("click", async () => {
  if (!state.activeConversationId) return;
  if (!confirm("Delete this session? This cannot be undone.")) return;
  await api(`/api/conversations/${state.activeConversationId}`, { method: "DELETE" });
  const id = state.activeConversationId;
  state.activeConversationId = null;
  if (state.ws) state.ws.close();
  document.getElementById("run-active").classList.add("hidden");
  document.getElementById("run-empty").classList.remove("hidden");
  state.conversations = state.conversations.filter((c) => c.id !== id);
  renderConversationList();
});

document.getElementById("rename-run-btn").addEventListener("click", async () => {
  if (!state.activeConversationId) return;
  const current = document.getElementById("run-topic").textContent;
  const next = prompt("Rename session:", current);
  if (!next || next === current) return;
  await api(`/api/conversations/${state.activeConversationId}`, { method: "PATCH", body: JSON.stringify({ topic: next }) });
  document.getElementById("run-topic").textContent = next;
  await loadConversations();
});

function transcriptAsText() {
  return Array.from(document.querySelectorAll("#transcript .msg"))
    .map((el) => {
      const author = el.querySelector(".author")?.textContent.trim() || "";
      const bubble = el.querySelector(".bubble")?.textContent.trim() || "";
      return `**${author}**\n${bubble}`;
    })
    .join("\n\n");
}

document.getElementById("copy-run-btn").addEventListener("click", async () => {
  await navigator.clipboard.writeText(transcriptAsText());
});

document.getElementById("export-run-btn").addEventListener("click", () => {
  const title = document.getElementById("run-topic").textContent;
  const text = `# ${title}\n\n${transcriptAsText()}\n`;
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title.slice(0, 60).replace(/[^a-z0-9]+/gi, "-")}.md`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("print-run-btn").addEventListener("click", () => {
  window.print();
});

document.getElementById("inject-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("inject-input");
  const content = input.value.trim();
  if (!content || !state.activeConversationId) return;
  input.value = "";
  await api(`/api/conversations/${state.activeConversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
});

// ---------- Settings ----------
async function loadSettingsTab() {
  const settings = await api("/api/settings");
  document.getElementById("setting-ollama-host").value = settings.ollama_host || "";
  document.getElementById("setting-discord-webhook").value = settings.discord_webhook_url || "";
  document.getElementById("setting-mirror-agents").checked = settings.discord_mirror_agents === "1";
  document.getElementById("setting-mirror-user").checked = settings.discord_mirror_user === "1";
}

document.getElementById("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    ollama_host: document.getElementById("setting-ollama-host").value,
    discord_webhook_url: document.getElementById("setting-discord-webhook").value,
    discord_mirror_agents: document.getElementById("setting-mirror-agents").checked,
    discord_mirror_user: document.getElementById("setting-mirror-user").checked,
  };
  await api("/api/settings", { method: "PUT", body: JSON.stringify(body) });
  alert("Settings saved.");
});

// ---------- Models ----------
function formatBytes(bytes) {
  if (!bytes) return "";
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}

async function loadModelsTab() {
  const grid = document.getElementById("model-list");
  if (!state.agents.length) await loadAgents();
  try {
    const models = await api("/api/models");
    if (!models.length) {
      grid.innerHTML = `<div class="empty">No models pulled yet.</div>`;
      return;
    }
    grid.innerHTML = models
      .map((m) => {
        const usedBy = state.agents.filter((a) => a.model === m.name);
        const tags = usedBy.length
          ? usedBy.map((a) => `<span class="used-by-tag">${escapeHtml(a.name)}</span>`).join("")
          : `<span class="used-by-tag">unused</span>`;
        return `
          <div class="model-card">
            <div class="name">${escapeHtml(m.name)}</div>
            <div class="meta">${formatBytes(m.size)}</div>
            <div class="used-by">${tags}</div>
          </div>`;
      })
      .join("");
  } catch (err) {
    grid.innerHTML = `<div class="empty">Could not reach Ollama: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("pull-model-btn").addEventListener("click", async () => {
  const input = document.getElementById("pull-model-input");
  const name = input.value.trim();
  if (!name) return;
  const status = document.getElementById("pull-status");
  status.textContent = `Pulling ${name}… this can take a while.`;
  await api("/api/models/pull", { method: "POST", body: JSON.stringify({ name }) });
  const poll = setInterval(async () => {
    const models = await api("/api/models");
    if (models.some((m) => m.name === name)) {
      clearInterval(poll);
      status.textContent = `${name} ready.`;
      loadModelsTab();
    }
  }, 4000);
});

// ---------- init ----------
loadConversations();
loadAgents();
setInterval(() => {
  if (document.getElementById("tab-runs").classList.contains("active")) loadConversations();
}, 5000);
