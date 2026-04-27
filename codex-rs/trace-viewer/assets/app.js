const state = {
  bundles: [],
  bundleId: null,
  trace: null,
  selectedInferenceId: null,
  requestPayload: null,
  assemblyPayload: null,
  selectedComponent: null,
  stream: null,
};

const $ = (id) => document.getElementById(id);
const LONG_TEXT_LIMIT = 420;
const LONG_TEXT_PREVIEW = 260;

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shortId(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function formatTime(unixMs) {
  if (!unixMs) {
    return "";
  }
  return new Date(unixMs).toLocaleString();
}

function statusLabel(status) {
  if (!status) {
    return "unknown";
  }
  if (status.startsWith("partial:")) {
    return "partial";
  }
  return status;
}

function statusTitle(status) {
  return status || "unknown";
}

async function loadBundles() {
  const data = await fetchJson("/api/bundles");
  state.bundles = Array.isArray(data) ? data : data.bundles || [];
  if (!state.bundleId && state.bundles.length > 0) {
    state.bundleId = state.bundles[0].id;
  }
  renderBundles();
  if (state.bundleId) {
    await selectBundle(state.bundleId);
  }
}

function renderBundles() {
  const list = $("bundleList");
  if (state.bundles.length === 0) {
    list.innerHTML = `<p class="empty">No trace bundles found.</p>`;
    return;
  }

  list.innerHTML = state.bundles
    .map((bundle) => {
      const selected = bundle.id === state.bundleId ? " selected" : "";
      const displayName = bundle.display_name || `Trace ${shortId(bundle.id)}`;
      const subtitle = bundle.subtitle || formatTime(bundle.started_at_unix_ms);
      const short = bundle.short_id || shortId(bundle.id);
      return `
        <button class="bundle${selected}" data-bundle="${escapeHtml(bundle.id)}">
          <div class="bundle-title">
            <span class="bundle-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
            <span class="status-pill" title="${escapeHtml(statusTitle(bundle.status))}">${escapeHtml(statusLabel(bundle.status))}</span>
          </div>
          <div class="bundle-meta">
            <span>${escapeHtml(subtitle)}</span>
            <span class="bundle-id" title="${escapeHtml(bundle.id)}">${escapeHtml(short)}</span>
          </div>
        </button>`;
    })
    .join("");

  list.querySelectorAll("button.bundle").forEach((button) => {
    button.addEventListener("click", () => selectBundle(button.dataset.bundle));
  });
}

async function selectBundle(bundleId) {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }

  state.bundleId = bundleId;
  state.trace = null;
  state.selectedInferenceId = null;
  state.requestPayload = null;
  state.assemblyPayload = null;
  state.selectedComponent = null;
  renderBundles();
  await loadBundleState();
  startStream();
}

async function loadBundleState() {
  if (!state.bundleId) {
    return;
  }

  const data = await fetchJson(`/api/bundles/${encodeURIComponent(state.bundleId)}/state`);
  state.trace = data.state;
  renderTimeline();

  const calls = state.trace?.inference_calls || {};
  const nextInference =
    state.selectedInferenceId && calls[state.selectedInferenceId]
      ? state.selectedInferenceId
      : Object.keys(calls)[0];
  if (nextInference) {
    await selectInference(nextInference);
  } else {
    renderRequest();
    renderInspector();
  }
}

function startStream() {
  if (!state.bundleId) {
    return;
  }

  state.stream = new EventSource(`/api/bundles/${encodeURIComponent(state.bundleId)}/stream`);
  state.stream.onmessage = debounceRefresh;
  state.stream.addEventListener("events", debounceRefresh);
  state.stream.addEventListener("error", debounceRefresh);
  state.stream.onerror = () => {
    debounceRefresh();
  };
}

let refreshTimer = null;
function debounceRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    loadBundleState().catch(showError);
  }, 250);
}

function timelineItems() {
  if (!state.trace) {
    return [];
  }

  const items = [];
  for (const turn of Object.values(state.trace.turns || {})) {
    items.push({
      kind: "turn",
      seq: turn.started_seq ?? turn.ended_seq ?? 0,
      id: turn.codex_turn_id,
      title: turn.codex_turn_id,
      meta: turn.thread_id,
    });
  }
  for (const call of Object.values(state.trace.inference_calls || {})) {
    const inference = inferenceRecord(call);
    items.push({
      kind: "inference",
      seq: inference.execution?.started_seq ?? 0,
      id: inference.inference_call_id,
      title: `${inference.model || "model"} / ${inference.provider_name || "provider"}`,
      meta: `${(inference.request_item_ids || []).length} input items`,
    });
  }
  for (const compaction of Object.values(state.trace.compactions || {})) {
    items.push({
      kind: "compaction",
      seq: compaction.started_seq ?? compaction.ended_seq ?? 0,
      id: compaction.compaction_id,
      title: compaction.compaction_id,
      meta: compaction.thread_id,
    });
  }
  for (const call of Object.values(state.trace.tool_calls || {})) {
    items.push({
      kind: "tool",
      seq: call.started_seq ?? 0,
      id: call.call_id,
      title: call.tool_name,
      meta: call.status,
    });
  }

  items.sort((a, b) => a.seq - b.seq);
  return items;
}

function renderTimeline() {
  const timeline = $("timeline");
  const items = timelineItems();
  if (items.length === 0) {
    timeline.innerHTML = `<p class="empty">No events yet.</p>`;
    return;
  }

  timeline.innerHTML = items
    .map((item) => {
      const active =
        item.kind === "inference" && item.id === state.selectedInferenceId ? " active" : "";
      return `
        <button class="timeline-item${active}" data-kind="${escapeHtml(item.kind)}" data-id="${escapeHtml(item.id)}">
          <div class="timeline-row">
            <span class="kind">${escapeHtml(item.kind)}</span>
            <span class="seq">#${escapeHtml(item.seq)}</span>
          </div>
          <strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>
          <span class="muted" title="${escapeHtml(item.meta || "")}">${escapeHtml(item.meta || "")}</span>
        </button>`;
    })
    .join("");

  timeline.querySelectorAll("button.timeline-item").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.kind === "inference") {
        selectInference(button.dataset.id).catch(showError);
      }
    });
  });
}

async function selectInference(inferenceId) {
  const record = state.trace?.inference_calls?.[inferenceId];
  if (!record) {
    return;
  }
  const inference = inferenceRecord(record);

  state.selectedInferenceId = inferenceId;
  state.selectedComponent = null;
  state.requestPayload = null;
  state.assemblyPayload = null;

  const requestPayloadId = record.request_payload_id || inference.raw_request_payload_id;
  const assemblyPayloadId = record.prompt_assembly_payload_id || inference.prompt_assembly_payload_id;

  if (requestPayloadId) {
    state.requestPayload = await fetchJson(
      `/api/bundles/${encodeURIComponent(state.bundleId)}/payload/${encodeURIComponent(requestPayloadId)}`,
    );
  }
  if (assemblyPayloadId) {
    state.assemblyPayload = await fetchJson(
      `/api/bundles/${encodeURIComponent(state.bundleId)}/payload/${encodeURIComponent(assemblyPayloadId)}`,
    );
  }

  renderTimeline();
  renderRequest();
  renderInspector();
}

function renderRequest() {
  const record = state.trace?.inference_calls?.[state.selectedInferenceId];
  if (!record) {
    $("requestTitle").textContent = "No inference selected";
    $("requestMeta").textContent = "";
    renderJsonInto($("requestJson"), null);
    $("inputList").innerHTML = "";
    $("toolList").innerHTML = "";
    $("componentGraph").innerHTML = "";
    return;
  }
  const inference = inferenceRecord(record);

  $("requestTitle").textContent = inference.inference_call_id;
  $("requestMeta").textContent = `${inference.model || "unknown model"} via ${inference.provider_name || "unknown provider"}`;

  const request = state.requestPayload?.payload || state.requestPayload || null;
  renderJsonInto($("requestJson"), request);
  renderInput(request?.input || []);
  renderTools(request?.tools || []);
  renderComponents();
}

function renderInput(input) {
  if (!Array.isArray(input) || input.length === 0) {
    $("inputList").innerHTML = `<p class="empty">No input items in request.</p>`;
    return;
  }

  $("inputList").innerHTML = input
    .map((item, index) => {
      const title = item.role || item.type || "item";
      return `
        <article class="card">
          <h3>#${index} ${escapeHtml(title)}</h3>
          ${renderJsonPanel(item, `Input #${index}`)}
        </article>`;
    })
    .join("");
}

function renderTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    $("toolList").innerHTML = `<p class="empty">No tools in request.</p>`;
    return;
  }

  $("toolList").innerHTML = tools
    .map((tool) => {
      const title = tool.name || tool.type || "tool";
      return `
        <article class="card">
          <h3>${escapeHtml(title)}</h3>
          ${renderJsonPanel(tool, `Tool ${title}`)}
        </article>`;
    })
    .join("");
}

function renderComponents() {
  const components = state.assemblyPayload?.payload?.components || state.assemblyPayload?.components || [];
  if (!Array.isArray(components) || components.length === 0) {
    $("componentGraph").innerHTML = `<p class="empty">No prompt assembly trace recorded.</p>`;
    return;
  }

  $("componentGraph").innerHTML = components
    .map((component) => {
      const selected = state.selectedComponent?.id === component.id ? " selected" : "";
      const source = component.source || "unknown";
      const label = component.label || component.id;
      const target = component.target ? renderTarget(component.target) : "";
      return `
        <button class="component${selected}" data-component="${escapeHtml(component.id)}">
          <div class="timeline-row">
            <span class="kind">${escapeHtml(source)}</span>
            <span class="muted">${escapeHtml(component.content_hash || "")}</span>
          </div>
          <strong>${escapeHtml(label)}</strong>
          <span class="muted">${escapeHtml(target)}</span>
          <p>${escapeHtml(component.preview || "")}</p>
        </button>`;
    })
    .join("");

  $("componentGraph").querySelectorAll("button.component").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedComponent = components.find((component) => component.id === button.dataset.component);
      renderComponents();
      renderInspector();
    });
  });
}

function renderTarget(target) {
  const parts = [];
  if (target.request_json_pointer) {
    parts.push(target.request_json_pointer);
  }
  if (target.input_index !== undefined && target.input_index !== null) {
    parts.push(`input[${target.input_index}]`);
  }
  if (target.content_index !== undefined && target.content_index !== null) {
    parts.push(`content[${target.content_index}]`);
  }
  if (target.tool_name) {
    parts.push(`tool:${target.tool_name}`);
  }
  return parts.join(" / ");
}

function renderInspector() {
  const inspector = $("inspector");
  if (state.selectedComponent) {
    inspector.innerHTML = `
      <h3>Component</h3>
      ${renderRows({
        id: state.selectedComponent.id,
        source: state.selectedComponent.source,
        label: state.selectedComponent.label,
        target: state.selectedComponent.target ? renderTarget(state.selectedComponent.target) : "",
        hash: state.selectedComponent.content_hash,
      })}
      ${renderJsonPanel(state.selectedComponent, "Prompt component")}`;
    return;
  }

  const record = state.trace?.inference_calls?.[state.selectedInferenceId];
  if (!record) {
    inspector.innerHTML = `<p class="empty">Select a request, payload, or component.</p>`;
    return;
  }
  const inference = inferenceRecord(record);
  const requestPayloadId = record.request_payload_id || inference.raw_request_payload_id;
  const assemblyPayloadId = record.prompt_assembly_payload_id || inference.prompt_assembly_payload_id;

  inspector.innerHTML = `
    <h3>Inference</h3>
    ${renderRows({
      id: inference.inference_call_id,
      model: inference.model,
      provider: inference.provider_name,
      requestPayload: requestPayloadId,
      promptAssembly: assemblyPayloadId,
      status: inference.execution?.status,
    })}
    ${renderJsonPanel(record, "Inference trace")}`;
}

function inferenceRecord(record) {
  return record.call || record;
}

function renderRows(rows) {
  return Object.entries(rows)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `
      <div class="row">
        <span>${escapeHtml(key)}</span>
        <code>${escapeHtml(value)}</code>
      </div>`)
    .join("");
}

function renderJsonInto(container, value) {
  if (value === null || value === undefined) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = renderJsonValue(value, { root: true });
}

function renderJsonPanel(value, title) {
  return `
    <div class="json-panel embedded-panel" data-json-title="${escapeHtml(title)}">
      <div class="json-panel-toolbar">
        <button data-json-long-collapse title="Collapse every long string in this JSON">Collapse text</button>
        <button data-json-long-expand title="Expand every long string in this JSON">Expand text</button>
        <button class="json-fullscreen" data-json-fullscreen title="Open this JSON in full screen">Full screen</button>
      </div>
      <div class="json-viewer embedded">${renderJsonValue(value, { root: true })}</div>
    </div>`;
}

function renderJsonValue(value, options = {}) {
  const root = options.root || false;
  const key = options.key ?? null;
  const isLast = options.isLast ?? true;
  const comma = isLast ? "" : `<span class="json-comma">,</span>`;
  const summaryComma = isLast ? "" : `<span class="json-summary-comma">,</span>`;
  const keyHtml =
    key === null
      ? ""
      : `<span class="json-key">"${escapeHtml(key)}"</span><span class="json-punctuation">: </span>`;

  if (Array.isArray(value) || isPlainObject(value)) {
    const isArray = Array.isArray(value);
    const entries = isArray ? value.map((item, index) => [index, item]) : Object.entries(value);
    const openBracket = isArray ? "[" : "{";
    const closeBracket = isArray ? "]" : "}";
    const countLabel = `${entries.length} ${isArray ? "items" : "keys"}`;
    const children = entries
      .map(([childKey, childValue], index) =>
        renderJsonValue(childValue, {
          key: isArray ? null : childKey,
          isLast: index === entries.length - 1,
        }),
      )
      .join("");

    return `
      <details class="json-node${root ? " root" : ""}" open>
        <summary>
          ${keyHtml}<span class="json-bracket">${openBracket}</span><span class="json-count"> ${escapeHtml(countLabel)}</span><span class="json-closed-preview"> ... <span class="json-bracket">${closeBracket}</span></span>${summaryComma}
        </summary>
        <div class="json-children">${children}</div>
        <div class="json-row"><span class="json-bracket">${closeBracket}</span>${comma}</div>
      </details>`;
  }

  return `<div class="json-row">${keyHtml}${renderPrimitive(value)}${comma}</div>`;
}

function renderPrimitive(value) {
  if (typeof value === "string") {
    return renderJsonString(value);
  }
  if (typeof value === "number") {
    return `<span class="json-number">${escapeHtml(String(value))}</span>`;
  }
  if (typeof value === "boolean") {
    return `<span class="json-bool">${value}</span>`;
  }
  if (value === null) {
    return `<span class="json-null">null</span>`;
  }
  return `<span class="json-string">${escapeHtml(JSON.stringify(value))}</span>`;
}

function renderJsonString(value) {
  const encoded = JSON.stringify(value);
  if (encoded.length <= LONG_TEXT_LIMIT) {
    return `<span class="json-string">${escapeHtml(encoded)}</span>`;
  }
  const preview = `${encoded.slice(0, LONG_TEXT_PREVIEW)}...`;
  return `
    <span class="json-string json-long-text" data-long-text>
      <span class="long-text-preview">${escapeHtml(preview)} <span class="long-text-meta">${encoded.length} chars</span></span>
      <span class="long-text-full">${escapeHtml(encoded)}</span>
      <button class="long-text-toggle" data-long-text-toggle title="Toggle this long string">Show</button>
    </span>`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function setJsonExpanded(containerId, expanded) {
  $(containerId).querySelectorAll("details.json-node").forEach((node) => {
    node.open = expanded;
  });
}

function setJsonExpandedIn(container, expanded) {
  container.querySelectorAll("details.json-node").forEach((node) => {
    node.open = expanded;
  });
}

function setLongTextExpanded(containerId, expanded) {
  setLongTextExpandedIn($(containerId), expanded);
}

function setLongTextExpandedIn(container, expanded) {
  container.querySelectorAll("[data-long-text]").forEach((node) => {
    node.classList.toggle("expanded", expanded);
    const toggle = node.querySelector("[data-long-text-toggle]");
    if (toggle) {
      toggle.textContent = expanded ? "Hide" : "Show";
    }
  });
}

function toggleLongText(button) {
  const node = button.closest("[data-long-text]");
  if (!node) {
    return;
  }
  const expanded = !node.classList.contains("expanded");
  node.classList.toggle("expanded", expanded);
  button.textContent = expanded ? "Hide" : "Show";
}

function jsonViewerForButton(button) {
  const panel = button.closest(".json-panel");
  return panel?.querySelector(".json-viewer") || $("jsonModalBody");
}

function openJsonFullscreen(button) {
  const panel = button.closest(".json-panel") || $("requestJson")?.closest(".json-panel");
  const viewer = panel?.querySelector(".json-viewer");
  if (!viewer) {
    return;
  }
  $("jsonModalTitle").textContent = panel.dataset.jsonTitle || "JSON Preview";
  $("jsonModalBody").innerHTML = viewer.innerHTML;
  $("jsonModal").hidden = false;
  document.body.classList.add("modal-open");
}

function closeJsonFullscreen() {
  $("jsonModal").hidden = true;
  $("jsonModalBody").innerHTML = "";
  document.body.classList.remove("modal-open");
}

function activeTabId() {
  return document.querySelector(".tabs button.active")?.dataset.tab || "json";
}

function showTab(tabId) {
  const panelId = tabId.endsWith("Tab") ? tabId : `${tabId}Tab`;
  document.querySelectorAll(".tabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabId || `${button.dataset.tab}Tab` === panelId);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === panelId);
  });
}

function showError(error) {
  $("timeline").innerHTML = `<pre class="error">${escapeHtml(String(error))}</pre>`;
}

$("refresh").addEventListener("click", () => loadBundles().catch(showError));
$("copyJson").addEventListener("click", async () => {
  const request = state.requestPayload?.payload || state.requestPayload;
  if (request) {
    await navigator.clipboard.writeText(JSON.stringify(request, null, 2));
  }
});
$("collapseJson").addEventListener("click", () => setJsonExpanded("requestJson", false));
$("expandJson").addEventListener("click", () => setJsonExpanded("requestJson", true));
$("collapseLongText").addEventListener("click", () => setLongTextExpanded("requestJson", false));
$("expandLongText").addEventListener("click", () => setLongTextExpanded("requestJson", true));
$("fullscreenJson").addEventListener("click", (event) => openJsonFullscreen(event.currentTarget));
$("collapseModalJson").addEventListener("click", () => setJsonExpandedIn($("jsonModalBody"), false));
$("expandModalJson").addEventListener("click", () => setJsonExpandedIn($("jsonModalBody"), true));
$("collapseModalLongText").addEventListener("click", () => setLongTextExpandedIn($("jsonModalBody"), false));
$("expandModalLongText").addEventListener("click", () => setLongTextExpandedIn($("jsonModalBody"), true));
$("closeJsonModal").addEventListener("click", closeJsonFullscreen);
$("jsonModal").addEventListener("click", (event) => {
  if (event.target === $("jsonModal")) {
    closeJsonFullscreen();
  }
});

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => showTab(button.dataset.tab));
});

document.addEventListener("click", (event) => {
  const longTextToggle = event.target.closest("[data-long-text-toggle]");
  if (longTextToggle) {
    toggleLongText(longTextToggle);
    return;
  }
  const collapseLongText = event.target.closest("[data-json-long-collapse]");
  if (collapseLongText) {
    setLongTextExpandedIn(jsonViewerForButton(collapseLongText), false);
    return;
  }
  const expandLongText = event.target.closest("[data-json-long-expand]");
  if (expandLongText) {
    setLongTextExpandedIn(jsonViewerForButton(expandLongText), true);
    return;
  }
  const fullscreenButton = event.target.closest("[data-json-fullscreen]");
  if (fullscreenButton) {
    openJsonFullscreen(fullscreenButton);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("jsonModal").hidden) {
    closeJsonFullscreen();
  }
});

showTab(activeTabId());
loadBundles().catch(showError);
