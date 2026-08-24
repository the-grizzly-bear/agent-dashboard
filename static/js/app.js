// Theme colors live only in CSS (extra.css) — read back via getComputedStyle
// below instead of duplicating hex values here, so there's one source of
// truth and no risk of the picker preview drifting out of sync with what
// the theme actually looks like.
const THEME_IDS = ["nord-night", "nord-snow", "nord-aurora", "discord"];
const THEME_LABELS = { "nord-night": "Nord Night", "nord-snow": "Nord Snow", "nord-aurora": "Nord Aurora", discord: "Discord" };

const state = {
  agents: [],
  chats: [],
  activeChatId: null,
  ws: null,
  streamingEl: null,
  openMenuId: null,
  mode: "chat",
  models: [],
};

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

async function api(path, options = {}) {
  const resp = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  if (!resp.ok) throw new Error((await resp.text()) || resp.statusText);
  if (resp.status === 204) return null;
  return resp.json();
}

// ---------- generic modal helpers ----------
function wireModal(btnId, backdropId, closeId, onOpen) {
  document.getElementById(btnId).addEventListener("click", async () => {
    if (onOpen) await onOpen();
    document.getElementById(backdropId).classList.remove("hidden");
  });
  document.getElementById(closeId).addEventListener("click", () => {
    document.getElementById(backdropId).classList.add("hidden");
  });
  document.getElementById(backdropId).addEventListener("click", (e) => {
    if (e.target.id === backdropId) e.currentTarget.classList.add("hidden");
  });
}

function confirmModal(message, { title = "Confirm", confirmLabel = "Delete" } = {}) {
  return new Promise((resolve) => {
    document.getElementById("confirm-modal-title").textContent = title;
    document.getElementById("confirm-modal-message").textContent = message;
    const yesBtn = document.getElementById("confirm-modal-yes");
    yesBtn.textContent = confirmLabel;
    const backdrop = document.getElementById("confirm-modal-backdrop");
    backdrop.classList.remove("hidden");

    function cleanup(result) {
      backdrop.classList.add("hidden");
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
      closeBtn.removeEventListener("click", onNo);
      resolve(result);
    }
    const onYes = () => cleanup(true);
    const onNo = () => cleanup(false);
    const noBtn = document.getElementById("confirm-modal-no");
    const closeBtn = document.getElementById("confirm-modal-close");
    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
    closeBtn.addEventListener("click", onNo);
  });
}

// ---------- theme modal ----------
function applyTheme(id) {
  document.documentElement.setAttribute("data-theme", id);
  localStorage.setItem("theme", id);
  document.querySelectorAll(".theme-card").forEach((el) => el.classList.toggle("active", el.dataset.theme === id));
}

function readThemeColors(id) {
  const root = document.documentElement;
  const active = root.getAttribute("data-theme");
  root.setAttribute("data-theme", id);
  const cs = getComputedStyle(root);
  const colors = {
    bg: cs.getPropertyValue("--bg").trim(),
    panel: cs.getPropertyValue("--panel").trim(),
    accent: cs.getPropertyValue("--accent").trim(),
    agents: Array.from({ length: 7 }, (_, i) => cs.getPropertyValue(`--agent-${i + 1}`).trim()),
  };
  root.setAttribute("data-theme", active);
  return colors;
}

function renderThemeModal() {
  const grid = document.getElementById("theme-modal-grid");
  const current = localStorage.getItem("theme") || "nord-night";
  grid.innerHTML = THEME_IDS.map((id) => {
    const c = readThemeColors(id);
    const swatch = (hex, sm) => `
      <div class="theme-swatch${sm ? " theme-swatch-sm" : ""}">
        <span class="theme-swatch-dot" style="background:${hex}"></span>
        <span class="theme-swatch-hex">${hex}</span>
      </div>`;
    return `
    <div class="theme-card ${id === current ? "active" : ""}" data-theme="${id}">
      <div class="theme-card-name">${THEME_LABELS[id] || id}</div>
      <div class="theme-swatch-row">${[c.bg, c.panel, c.accent].map((h) => swatch(h)).join("")}</div>
      <div class="theme-card-label">Agent palette</div>
      <div class="theme-swatch-grid">${c.agents.map((h) => swatch(h, true)).join("")}</div>
    </div>`;
  }).join("");
  grid.querySelectorAll(".theme-card").forEach((el) => el.addEventListener("click", () => applyTheme(el.dataset.theme)));
}

applyTheme(localStorage.getItem("theme") || "nord-night");
wireModal("theme-btn", "theme-modal-backdrop", "theme-modal-close", renderThemeModal);

// ---------- sidebar collapse ----------
document.getElementById("sidebar-toggle").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("collapsed");
});

// ---------- memory ----------
const MEMORY_TYPES = ["preference", "fact", "conclusion"];

function splitMemoryType(content) {
  const idx = content.indexOf(":");
  if (idx > 0) {
    const type = content.slice(0, idx).trim().toLowerCase();
    if (MEMORY_TYPES.includes(type)) return { type, fact: content.slice(idx + 1).trim() };
  }
  return { type: "fact", fact: content };
}

function memoryItemHtml(m) {
  const { type, fact } = splitMemoryType(m.content);
  return `<li><span class="memory-type-badge memory-type-${type}">${type}</span><span class="memory-content">${escapeHtml(fact)}</span><button class="list-delete-btn" data-id="${m.id}">&times;</button></li>`;
}

async function renderMemoryModal() {
  const list = document.getElementById("memory-list");
  const memories = await api("/api/memory");
  if (!memories.length) {
    list.innerHTML = `<div class="memory-empty">Nothing stored yet.</div>`;
    return;
  }
  const groups = new Map();
  for (const m of memories) {
    const key = m.topic || "General";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const topics = [...groups.keys()].sort((a, b) => (a === "General") - (b === "General") || a.localeCompare(b));
  list.innerHTML = topics
    .map(
      (topic) => `
    <div class="memory-group">
      <div class="memory-group-label">${escapeHtml(topic)}</div>
      <ul class="memory-list">${groups.get(topic).map(memoryItemHtml).join("")}</ul>
    </div>`
    )
    .join("");
  list.querySelectorAll("[data-id]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api(`/api/memory/${btn.dataset.id}`, { method: "DELETE" });
      renderMemoryModal();
    })
  );
}
wireModal("memory-btn", "memory-modal-backdrop", "memory-modal-close", renderMemoryModal);

document.getElementById("memory-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("memory-input");
  const topicInput = document.getElementById("memory-topic-input");
  const content = input.value.trim();
  if (!content) return;
  const topic = topicInput.value.trim();
  input.value = "";
  topicInput.value = "";
  await api("/api/memory", { method: "POST", body: JSON.stringify({ content, topic }) });
  renderMemoryModal();
});

// ---------- settings ----------
function formatBytes(bytes) {
  if (!bytes) return "";
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}

async function loadModels() {
  try {
    state.models = await api("/api/models");
  } catch {
    state.models = [];
  }
  renderModelSelect();
}

function renderModelSelect() {
  const select = document.getElementById("model-select");
  const current = select.value;
  select.innerHTML = state.models.length
    ? state.models.map((m) => `<option value="${m.name}">${m.name}</option>`).join("")
    : `<option value="">no models — check Settings</option>`;
  if (state.models.some((m) => m.name === current)) select.value = current;
}

async function renderSettingsModelList() {
  const list = document.getElementById("settings-model-list");
  await loadModels();
  list.innerHTML = state.models.length
    ? state.models
        .map(
          (m) => `
    <li>
      <span>${escapeHtml(m.name)}</span>
      <span class="model-meta">${formatBytes(m.size)}</span>
      <button class="list-delete-btn" data-delete-model="${escapeHtml(m.name)}" title="Delete model">&times;</button>
    </li>`
        )
        .join("")
    : `<li><span style="opacity:0.6">No models pulled yet.</span></li>`;

  list.querySelectorAll("[data-delete-model]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const ok = await confirmModal(`Delete ${btn.dataset.deleteModel}? This removes it from disk.`, {
        title: "Delete model",
      });
      if (!ok) return;
      await api(`/api/models/${encodeURIComponent(btn.dataset.deleteModel)}`, { method: "DELETE" });
      renderSettingsModelList();
    })
  );
}

async function openSettingsModal() {
  const settings = await api("/api/settings");
  document.getElementById("setting-ollama-host").value = settings.ollama_host || "";
  document.getElementById("setting-global-rules").value = settings.global_rules || "";
  document.getElementById("setting-uw-bearer-token").value = settings.uw_bearer_token || "";
  document.getElementById("setting-uw-sh").value = settings.uw_sh || "";
  await renderSettingsModelList();
}
wireModal("settings-btn", "settings-modal-backdrop", "settings-modal-close", openSettingsModal);

document.getElementById("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      ollama_host: document.getElementById("setting-ollama-host").value,
      global_rules: document.getElementById("setting-global-rules").value,
      uw_bearer_token: document.getElementById("setting-uw-bearer-token").value,
      uw_sh: document.getElementById("setting-uw-sh").value,
    }),
  });
  document.getElementById("settings-modal-backdrop").classList.add("hidden");
});

document.getElementById("pull-model-btn").addEventListener("click", async () => {
  const input = document.getElementById("pull-model-input");
  const name = input.value.trim();
  if (!name) return;
  const status = document.getElementById("pull-status");
  status.textContent = `Pulling ${name}…`;
  await api("/api/models/pull", { method: "POST", body: JSON.stringify({ name }) });
  const poll = setInterval(async () => {
    await loadModels();
    if (state.models.some((m) => m.name === name)) {
      clearInterval(poll);
      status.textContent = `${name} ready.`;
      renderSettingsModelList();
    }
  }, 4000);
});

// ---------- agents ----------
async function loadAgents() {
  state.agents = await api("/api/agents");
  return state.agents;
}

function agentListItemHtml(a) {
  return `
    <li class="agent-list-item">
      <span class="agent-color-dot" style="background:${a.color}"></span>
      <div class="agent-info">
        <div class="agent-name">${escapeHtml(a.name)}</div>
        <div class="agent-model">${escapeHtml(a.model)} · temp ${a.temperature}</div>
      </div>
      <div class="agent-actions">
        <button data-edit-agent="${a.id}">Edit</button>
        <button class="danger-item" data-delete-agent="${a.id}">Delete</button>
      </div>
    </li>`;
}

async function renderAgentsList() {
  await loadAgents();
  const body = document.getElementById("agents-modal-body");
  body.innerHTML = `
    <div class="agents-toolbar"><button type="button" id="new-agent-btn" class="primary-btn">+ New Agent</button></div>
    <ul class="agent-list">${state.agents.map(agentListItemHtml).join("") || '<li style="opacity:0.6;padding:8px">No agents yet.</li>'}</ul>
  `;
  document.getElementById("new-agent-btn").addEventListener("click", () => renderAgentForm(null));
  body.querySelectorAll("[data-edit-agent]").forEach((btn) =>
    btn.addEventListener("click", () => renderAgentForm(state.agents.find((a) => a.id === btn.dataset.editAgent)))
  );
  body.querySelectorAll("[data-delete-agent]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const ok = await confirmModal("Delete this agent?", { title: "Delete agent" });
      if (!ok) return;
      await api(`/api/agents/${btn.dataset.deleteAgent}`, { method: "DELETE" });
      renderAgentsList();
    })
  );
}

async function renderAgentForm(agent) {
  if (!state.models.length) await loadModels();
  const modelOptions = state.models.length
    ? state.models.map((m) => `<option value="${m.name}" ${agent && agent.model === m.name ? "selected" : ""}>${m.name}</option>`).join("")
    : `<option value="">no models — check Settings</option>`;
  const body = document.getElementById("agents-modal-body");
  body.innerHTML = `
    <form class="agent-form" id="agent-form">
      <label>Name<input name="name" value="${agent ? escapeHtml(agent.name) : ""}" required /></label>
      <label>Model<select name="model">${modelOptions}</select></label>
      <label>Persona / system prompt<textarea name="persona" rows="5" required>${agent ? escapeHtml(agent.persona) : ""}</textarea></label>
      <label>Temperature<input name="temperature" type="number" step="0.1" min="0" max="2" value="${agent ? agent.temperature : 0.7}" /></label>
      <label>Color<input name="color" type="color" value="${agent ? agent.color : "#5b8def"}" /></label>
      <div class="agent-form-actions">
        <button type="button" class="secondary-btn" id="cancel-agent-form">Cancel</button>
        <button type="submit" class="primary-btn">Save</button>
      </div>
    </form>
  `;
  document.getElementById("cancel-agent-form").addEventListener("click", renderAgentsList);
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
    renderAgentsList();
  });
}
wireModal("agents-btn", "agents-modal-backdrop", "agents-modal-close", renderAgentsList);

// ---------- consensus participant picker ----------
function openParticipantPicker(topicText) {
  loadAgents().then((agents) => {
    if (!agents.length) {
      alert("No agents exist yet — create one first (Agents in the sidebar).");
      return;
    }
    const list = document.getElementById("participant-list");
    list.innerHTML = agents
      .map(
        (a) => `
      <li class="participant-item" data-toggle="${a.id}">
        <label style="display:flex;align-items:center;cursor:pointer;width:100%">
          <input type="checkbox" value="${a.id}" checked />
          <span class="agent-color-dot" style="background:${a.color};margin-right:8px"></span>
          ${escapeHtml(a.name)}
        </label>
      </li>`
      )
      .join("");
    document.getElementById("participant-modal-backdrop").classList.remove("hidden");

    const startBtn = document.getElementById("participant-start-btn");
    const onStart = async () => {
      const ids = Array.from(list.querySelectorAll('input[type="checkbox"]:checked')).map((el) => el.value);
      if (!ids.length) {
        alert("Pick at least one agent.");
        return;
      }
      document.getElementById("participant-modal-backdrop").classList.add("hidden");
      startBtn.removeEventListener("click", onStart);
      await startConsensusChat(topicText, ids);
    };
    startBtn.addEventListener("click", onStart);
  });
}
document.getElementById("participant-modal-close").addEventListener("click", () => {
  document.getElementById("participant-modal-backdrop").classList.add("hidden");
});
document.getElementById("participant-modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "participant-modal-backdrop") e.currentTarget.classList.add("hidden");
});

// ---------- mode toggle ----------
document.querySelectorAll(".mode-toggle-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    state.mode = btn.dataset.mode;
    document.querySelectorAll(".mode-toggle-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.getElementById("model-select").classList.toggle("hidden", state.mode !== "chat");
  })
);

// ---------- chat list ----------
async function loadChats() {
  state.chats = await api("/api/conversations");
  renderChatList();
}

function renderChatList() {
  const list = document.getElementById("chat-list");
  list.innerHTML = state.chats
    .map(
      (c) => `
    <li class="chat-list-item ${c.id === state.activeChatId ? "active" : ""}" data-id="${c.id}">
      <span class="chat-list-title">${escapeHtml(c.topic)}</span>
      <button class="chat-list-menu-btn" data-menu="${c.id}" title="More">&#8942;</button>
      ${
        state.openMenuId === c.id
          ? `<div class="chat-item-menu" data-menu-panel="${c.id}">
               <button data-rename="${c.id}">Rename</button>
               <button class="danger-item" data-delete="${c.id}">Delete</button>
             </div>`
          : ""
      }
    </li>`
    )
    .join("");

  list.querySelectorAll(".chat-list-item").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest(".chat-list-menu-btn") || e.target.closest(".chat-item-menu")) return;
      openChat(el.dataset.id);
    })
  );
  list.querySelectorAll("[data-menu]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      state.openMenuId = state.openMenuId === el.dataset.menu ? null : el.dataset.menu;
      renderChatList();
    })
  );
  list.querySelectorAll("[data-rename]").forEach((el) =>
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const chat = state.chats.find((c) => c.id === el.dataset.rename);
      const next = prompt("Rename chat:", chat.topic);
      state.openMenuId = null;
      if (next && next !== chat.topic) {
        await api(`/api/conversations/${chat.id}`, { method: "PATCH", body: JSON.stringify({ topic: next }) });
        if (state.activeChatId === chat.id) document.getElementById("chat-title").textContent = next;
      }
      loadChats();
    })
  );
  list.querySelectorAll("[data-delete]").forEach((el) =>
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      state.openMenuId = null;
      const ok = await confirmModal("Delete this chat? This cannot be undone.", { title: "Delete chat" });
      if (!ok) return;
      await api(`/api/conversations/${el.dataset.delete}`, { method: "DELETE" });
      if (state.activeChatId === el.dataset.delete) resetToNewChat();
      loadChats();
    })
  );
}

document.addEventListener("click", () => {
  if (state.openMenuId) {
    state.openMenuId = null;
    renderChatList();
  }
});

// ---------- chat window ----------
const chatHistory = document.getElementById("chat-history");
const chatInput = document.getElementById("chat-input");
const chatForm = document.getElementById("message-form");
const chatContainer = document.getElementById("chat-container");

function setUrl(id) {
  const path = id ? `/chat/${id}` : "/";
  if (location.pathname !== path) history.pushState({}, "", path);
}

function resetToNewChat() {
  state.activeChatId = null;
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  chatHistory.innerHTML = '<div id="welcome-screen"></div>';
  document.getElementById("chat-title").textContent = "";
  setChatTopActions(null);
  chatContainer.classList.add("welcome-active");
  chatInput.value = "";
  renderChatList();
  chatInput.focus();
  setUrl(null);
}

document.getElementById("new-chat-btn").addEventListener("click", resetToNewChat);

function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Agent bubble accents come from the active theme's 7-color palette
// (--agent-1..--agent-7 in extra.css). This returns a var() reference,
// not a resolved hex, so bubbles already on screen re-color live when the
// theme switches instead of staying frozen at whatever it was on render.
// Slot is a stable hash of the agent's id (or model name in chat mode,
// which has no agent id).
function agentSlotColor(seed) {
  if (!seed) return "";
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const slot = (hash % 7) + 1;
  return `var(--agent-${slot})`;
}

function agentLabel(name, model) {
  if (!name) return "Agent";
  if (!model || model === name) return escapeHtml(name);
  return `${escapeHtml(name)} <span class="msg-model">· ${escapeHtml(model)}</span>`;
}

function searchSectionHtml(search) {
  if (!search) return "";
  const results = (search.results || [])
    .map(
      (r) => `
      <div class="search-result">
        <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.title)}</a>
        <div class="search-result-snippet">${escapeHtml(r.snippet)}</div>
        <div class="search-result-url">${escapeHtml(r.url)}</div>
      </div>`
    )
    .join("");
  return `<details class="msg-search"><summary>searched: "${escapeHtml(search.query)}"</summary><div class="search-results">${
    results || `<div class="search-result-snippet">No results.</div>`
  }</div></details>`;
}

function uwSectionHtml(uw) {
  if (!uw) return "";
  return `<details class="msg-search msg-uw"><summary>Unusual Whales: "${escapeHtml(uw.query)}"</summary><div class="search-results"><div class="search-result-snippet uw-result-text">${escapeHtml(
    uw.result || "No data."
  )}</div></div></details>`;
}

function renderMessage(m) {
  const div = document.createElement("div");
  const role = m.role === "user" ? "user" : "ai";
  div.className = `msg msg-${role}`;
  if (role === "ai") {
    const accent = agentSlotColor(m.agent_id || m.agent_model);
    if (accent) div.style.setProperty("--msg-accent", accent);
  }
  const time = formatTime(m.created_at);
  const author =
    role === "ai" && m.agent_name
      ? `<div class="msg-author">${agentLabel(m.agent_name, m.agent_model)}${time ? ` <span class="msg-time">${time}</span>` : ""}</div>`
      : time
      ? `<div class="msg-author msg-author-user"><span class="msg-time">${time}</span></div>`
      : "";
  const thinking = m.thinking
    ? `<details class="msg-thinking"><summary>thinking</summary><div class="thinking-body">${escapeHtml(m.thinking)}</div></details>`
    : "";
  div.innerHTML = `${author}${escapeHtml(m.content)}${searchSectionHtml(m.search)}${uwSectionHtml(m.uw)}${thinking}`;
  chatHistory.appendChild(div);
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

function startStreamingBubble(payload) {
  const div = document.createElement("div");
  div.className = "msg msg-ai streaming";
  const streamAccent = agentSlotColor(payload.agent_id || payload.agent_model);
  if (streamAccent) div.style.setProperty("--msg-accent", streamAccent);
  div.innerHTML = `<div class="msg-author">${agentLabel(payload.agent_name, payload.agent_model)}</div><span class="stream-text"></span>`;
  chatHistory.appendChild(div);
  chatHistory.scrollTop = chatHistory.scrollHeight;
  state.streamingEl = div;
}

function startSearching(payload) {
  if (!state.streamingEl) return;
  state.streamingEl.dataset.searching = "1";
  const el = state.streamingEl.querySelector(".stream-text");
  el.textContent = `Searching: ${payload.query} …`;
  el.classList.add("msg-searching");
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

function startUwQuerying(payload) {
  if (!state.streamingEl) return;
  state.streamingEl.dataset.searching = "1";
  const el = state.streamingEl.querySelector(".stream-text");
  el.textContent = `Querying Unusual Whales: ${payload.query} …`;
  el.classList.add("msg-searching");
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

function appendDelta(payload) {
  if (!state.streamingEl) return;
  const el = state.streamingEl.querySelector(".stream-text");
  if (state.streamingEl.dataset.searching) {
    el.textContent = "";
    el.classList.remove("msg-searching");
    delete state.streamingEl.dataset.searching;
  }
  el.textContent += payload.text;
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

function connectWs(chatId) {
  if (state.ws) state.ws.close();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/conversations/${chatId}`);
  ws.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "stream_start") startStreamingBubble(payload);
    if (payload.type === "delta") appendDelta(payload);
    if (payload.type === "searching") startSearching(payload);
    if (payload.type === "uw_querying") startUwQuerying(payload);
    if (payload.type === "message") {
      if (state.streamingEl) {
        state.streamingEl.remove();
        state.streamingEl = null;
      }
      renderMessage(payload.message);
    }
    if (payload.type === "error") {
      if (state.streamingEl) {
        state.streamingEl.remove();
        state.streamingEl = null;
      }
      const div = document.createElement("div");
      div.className = "msg msg-ai";
      div.textContent = `Error: ${payload.detail}`;
      chatHistory.appendChild(div);
    }
    if (payload.type === "status") setChatTopActions({ status: payload.status, mode: state.activeChatMode });
  };
  state.ws = ws;
}

function setChatTopActions(chat) {
  const badge = document.getElementById("chat-status-badge");
  const stopBtn = document.getElementById("stop-chat-btn");
  const resumeBtn = document.getElementById("resume-chat-btn");
  const renameBtn = document.getElementById("rename-chat-btn");
  const deleteBtn = document.getElementById("delete-chat-btn");
  if (!chat) {
    [badge, stopBtn, resumeBtn, renameBtn, deleteBtn].forEach((el) => el.classList.add("hidden"));
    return;
  }
  state.activeChatMode = chat.mode;
  badge.textContent = chat.status.charAt(0).toUpperCase() + chat.status.slice(1);
  badge.className = `chat-status-badge ${chat.status === "running" ? "status-running" : ""}`;
  badge.classList.remove("hidden");
  renameBtn.classList.remove("hidden");
  deleteBtn.classList.remove("hidden");
  stopBtn.classList.toggle("hidden", chat.status !== "running");
  resumeBtn.classList.toggle("hidden", !(chat.mode === "consensus" && chat.status === "stopped"));
  stopBtn.disabled = false;
  stopBtn.textContent = "Stop";
  resumeBtn.disabled = false;
}

async function openChat(id) {
  state.activeChatId = id;
  chatContainer.classList.remove("welcome-active");
  renderChatList();
  const chat = state.chats.find((c) => c.id === id) || (await api(`/api/conversations/${id}`));
  document.getElementById("chat-title").textContent = chat.topic;
  setChatTopActions(chat);
  chatHistory.innerHTML = "";
  const messages = await api(`/api/conversations/${id}/messages`);
  messages.forEach(renderMessage);
  connectWs(id);
  setUrl(id);
}

async function startConsensusChat(text, agentIds) {
  chatContainer.classList.remove("welcome-active");
  chatHistory.innerHTML = "";
  document.getElementById("chat-title").textContent = text;
  const chat = await api("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ topic: text, mode: "consensus", agent_ids: agentIds }),
  });
  state.activeChatId = chat.id;
  setChatTopActions(chat);
  connectWs(chat.id);
  setUrl(chat.id);
  await loadChats();
  renderChatList();
}

document.getElementById("stop-chat-btn").addEventListener("click", async (e) => {
  if (!state.activeChatId) return;
  // Stop only takes effect once the agent mid-turn finishes generating, so
  // don't claim "stopped" yet — show a transitional state and let the
  // incoming WS "status" broadcast (fired when the loop actually exits)
  // correct it via setChatTopActions.
  e.target.disabled = true;
  e.target.textContent = "Stopping…";
  await api(`/api/conversations/${state.activeChatId}/stop`, { method: "POST" });
});

document.getElementById("rename-chat-btn").addEventListener("click", async () => {
  if (!state.activeChatId) return;
  const current = document.getElementById("chat-title").textContent;
  const next = prompt("Rename chat:", current);
  if (!next || next === current) return;
  await api(`/api/conversations/${state.activeChatId}`, { method: "PATCH", body: JSON.stringify({ topic: next }) });
  document.getElementById("chat-title").textContent = next;
  loadChats();
});

document.getElementById("resume-chat-btn").addEventListener("click", async (e) => {
  if (!state.activeChatId) return;
  e.target.disabled = true;
  const chat = await api(`/api/conversations/${state.activeChatId}/resume`, { method: "POST" });
  setChatTopActions(chat);
  connectWs(state.activeChatId);
});

document.getElementById("delete-chat-btn").addEventListener("click", async () => {
  if (!state.activeChatId) return;
  const ok = await confirmModal("Delete this chat? This cannot be undone.", { title: "Delete chat" });
  if (!ok) return;
  await api(`/api/conversations/${state.activeChatId}`, { method: "DELETE" });
  resetToNewChat();
  loadChats();
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  if (!state.activeChatId) {
    if (state.mode === "consensus") {
      chatInput.value = "";
      openParticipantPicker(text);
      return;
    }
    chatInput.value = "";
    chatContainer.classList.remove("welcome-active");
    chatHistory.innerHTML = "";
    document.getElementById("chat-title").textContent = text;

    const model = document.getElementById("model-select").value;
    if (!model) {
      alert("No models available — pull one in Settings first.");
      return;
    }
    const chat = await api("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ topic: text, mode: "chat", model }),
    });
    state.activeChatId = chat.id;
    setChatTopActions(chat);
    connectWs(chat.id);
    setUrl(chat.id);
    await loadChats();
    renderChatList();
  } else {
    chatInput.value = "";
    await api(`/api/conversations/${state.activeChatId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: text }),
    });
  }
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

// ---------- init ----------
function chatIdFromUrl() {
  const match = location.pathname.match(/^\/chat\/([^/]+)$/);
  return match ? match[1] : null;
}

window.addEventListener("popstate", () => {
  const id = chatIdFromUrl();
  if (id) openChat(id);
  else resetToNewChat();
});

loadChats();
loadModels();
const initialChatId = chatIdFromUrl();
if (initialChatId) openChat(initialChatId);
