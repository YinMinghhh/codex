const state = {
  sessions: [],
  bundles: [],
  sessionId: null,
  bundleId: null,
  trace: null,
  traces: [],
  selectedInferenceId: null,
  selectedInferenceKey: null,
  requestPayload: null,
  assemblyPayload: null,
  selectedComponent: null,
  selectedCategory: null,
  streams: [],
  selectionRevision: 0,
};

const $ = (id) => document.getElementById(id);
const LONG_TEXT_LIMIT = 420;
const LONG_TEXT_PREVIEW = 260;
const CONTEXT_CATEGORY_ORDER = [
  "model_scaffold",
  "tool_schemas",
  "runtime_context",
  "project_user_context",
  "conversation",
  "tool_io",
  "model_state",
  "other",
];
const CONTEXT_CATEGORY_LABELS = {
  model_scaffold: "Model scaffold",
  tool_schemas: "Tool schemas",
  runtime_context: "Runtime context",
  project_user_context: "Project/user context",
  conversation: "Conversation",
  tool_io: "Tool I/O",
  model_state: "Model state",
  other: "Other",
};

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
  const data = await fetchJson("/api/sessions");
  state.sessions = Array.isArray(data) ? data : data.sessions || [];
  state.bundles = state.sessions.flatMap((session) => session.bundles || []);
  if (state.sessionId && !state.sessions.some((session) => session.id === state.sessionId)) {
    state.sessionId = null;
    state.bundleId = null;
  }
  if (!state.sessionId && state.sessions.length > 0) {
    state.sessionId = state.sessions[0].id;
  }
  renderBundles();
  if (state.sessionId) {
    await selectSession(state.sessionId);
  }
}

function renderBundles() {
  const list = $("bundleList");
  if (state.sessions.length === 0) {
    list.innerHTML = `<p class="empty">No trace sessions found.</p>`;
    return;
  }

  list.innerHTML = state.sessions
    .map((session) => {
      const selected = session.id === state.sessionId ? " selected" : "";
      const displayName = session.display_name || `Session ${shortId(session.id)}`;
      const subtitle = session.subtitle || formatTime(session.started_at_unix_ms);
      const bundles = session.bundles || [];
      return `
        <section class="session-group${selected}" data-session="${escapeHtml(session.id)}">
          <button class="session-button" data-session="${escapeHtml(session.id)}">
            <div class="bundle-title">
              <span class="bundle-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
              <span class="status-pill" title="${escapeHtml(`${session.bundle_count || bundles.length} trace bundles`)}">${escapeHtml(`${session.bundle_count || bundles.length} traces`)}</span>
            </div>
            <div class="bundle-meta">
              <span>${escapeHtml(subtitle)}</span>
              <span class="bundle-id" title="${escapeHtml(session.id)}">${escapeHtml(shortId(session.id))}</span>
            </div>
          </button>
          <div class="session-traces">
            ${bundles.map(renderBundleTrace).join("")}
          </div>
        </section>`;
    })
    .join("");

  list.querySelectorAll("button.session-button").forEach((button) => {
    button.addEventListener("click", () => selectSession(button.dataset.session).catch(showError));
  });
  list.querySelectorAll("button.bundle").forEach((button) => {
    button.addEventListener("click", () => selectBundleTrace(button.dataset.bundle).catch(showError));
  });
}

function renderBundleTrace(bundle) {
  const selected = bundle.id === state.bundleId ? " selected" : "";
  const displayName = `Trace ${bundle.trace_id ? shortId(bundle.trace_id) : shortId(bundle.id)}`;
  const subtitle = formatTime(bundle.started_at_unix_ms);
  const short = bundle.short_id || shortId(bundle.id);
  return `
        <button class="bundle trace-row${selected}" data-bundle="${escapeHtml(bundle.id)}">
          <div class="bundle-title">
            <span class="bundle-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
            <span class="status-pill" title="${escapeHtml(statusTitle(bundle.status))}">${escapeHtml(statusLabel(bundle.status))}</span>
          </div>
          <div class="bundle-meta">
            <span title="${escapeHtml(subtitle)}">${escapeHtml(subtitle)}</span>
            <span class="bundle-id" title="${escapeHtml(bundle.id)}">${escapeHtml(short)}</span>
          </div>
        </button>`;
}

async function selectSession(sessionId, preferredBundleId = null) {
  closeStreams();

  state.sessionId = sessionId;
  state.bundleId = preferredBundleId;
  state.trace = null;
  state.traces = [];
  state.selectedInferenceId = null;
  state.selectedInferenceKey = null;
  state.requestPayload = null;
  state.assemblyPayload = null;
  state.selectedComponent = null;
  state.selectedCategory = null;
  renderBundles();
  await loadSessionState(preferredBundleId);
  startStreams();
}

async function selectBundleTrace(bundleId) {
  const session = state.sessions.find((candidate) =>
    (candidate.bundles || []).some((bundle) => bundle.id === bundleId),
  );
  if (!session) {
    return;
  }
  if (state.sessionId !== session.id) {
    await selectSession(session.id, bundleId);
    return;
  }
  state.bundleId = bundleId;
  const firstKey = firstInferenceKeyForBundle(bundleId);
  if (firstKey) {
    await selectInference(firstKey);
  } else {
    renderBundles();
    renderTimeline();
  }
}

async function loadSessionState(preferredBundleId = null) {
  const session = selectedSession();
  if (!session) {
    return;
  }

  const traces = [];
  for (const bundle of session.bundles || []) {
    const data = await fetchJson(`/api/bundles/${encodeURIComponent(bundle.id)}/state`);
    traces.push({
      bundle: data.bundle || bundle,
      trace: data.state,
    });
  }
  state.traces = traces.sort((left, right) => {
    const leftTime = left.bundle?.started_at_unix_ms || left.trace?.started_at_unix_ms || 0;
    const rightTime = right.bundle?.started_at_unix_ms || right.trace?.started_at_unix_ms || 0;
    return leftTime - rightTime || String(left.bundle?.id || "").localeCompare(String(right.bundle?.id || ""));
  });
  renderTimeline();

  const calls = inferenceEntries();
  const preferredKey = preferredBundleId ? firstInferenceKeyForBundle(preferredBundleId) : null;
  const currentBundleKey = state.bundleId ? firstInferenceKeyForBundle(state.bundleId) : null;
  const nextInference =
    state.selectedInferenceKey && calls.some((entry) => entry.key === state.selectedInferenceKey)
      ? state.selectedInferenceKey
      : preferredKey || currentBundleKey || calls[0]?.key;
  if (nextInference) {
    await selectInference(nextInference);
  } else {
    state.trace = state.traces[0]?.trace || null;
    state.bundleId = state.traces[0]?.bundle?.id || null;
    renderBundles();
    renderRequest();
    renderInspector();
  }
}

function selectedSession() {
  return state.sessions.find((session) => session.id === state.sessionId) || null;
}

function closeStreams() {
  for (const stream of state.streams) {
    stream.close();
  }
  state.streams = [];
}

function startStreams() {
  const session = selectedSession();
  if (!session) {
    return;
  }

  closeStreams();
  for (const bundle of session.bundles || []) {
    const stream = new EventSource(`/api/bundles/${encodeURIComponent(bundle.id)}/stream`);
    stream.onmessage = debounceRefresh;
    stream.addEventListener("events", debounceRefresh);
    stream.addEventListener("error", debounceRefresh);
    stream.onerror = () => {
      debounceRefresh();
    };
    state.streams.push(stream);
  }
}

let refreshTimer = null;
function debounceRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    loadSessionState().catch(showError);
  }, 250);
}

function inferenceEntries() {
  return state.traces
    .flatMap(({ bundle, trace }) =>
      Object.values(trace.inference_calls || {}).map((record) => {
        const inference = inferenceRecord(record);
        const inferenceId = inference.inference_call_id || record.inference_call_id;
        return {
          key: scopedKey(bundle.id, inferenceId),
          bundle,
          trace,
          record,
          inference,
          seq: inference.execution?.started_seq ?? 0,
          startedAt: bundle.started_at_unix_ms || trace.started_at_unix_ms || 0,
        };
      }),
    )
    .sort(compareTimelineEntries);
}

function firstInferenceKeyForBundle(bundleId) {
  return inferenceEntries().find((entry) => entry.bundle.id === bundleId)?.key || null;
}

function scopedKey(scope, id) {
  return `${scope || "unknown"}::${id || "unknown"}`;
}

function compareTimelineEntries(left, right) {
  return (
    (left.startedAt || 0) - (right.startedAt || 0) ||
    (left.seq || 0) - (right.seq || 0) ||
    String(left.id || "").localeCompare(String(right.id || ""))
  );
}

function traceLabel(bundle) {
  return `trace ${bundle.trace_id ? shortId(bundle.trace_id) : shortId(bundle.id)}`;
}

function timelineGroups() {
  if (state.traces.length === 0) {
    return [];
  }

  const inferences = inferenceEntries()
    .map((entry) => {
      const { bundle, inference, record } = entry;
      const traceName = traceLabel(bundle);
      return {
        kind: "inference",
        seq: entry.seq,
        startedAt: entry.startedAt,
        id: entry.key,
        inferenceId: inference.inference_call_id,
        turnId: inference.codex_turn_id,
        turnKey: scopedKey(bundle.id, inference.codex_turn_id),
        bundleId: bundle.id,
        trace: traceName,
        title: `${inference.inference_call_id || "inference"} - ${inference.model || "model"} / ${inference.provider_name || "provider"}`,
        meta: `${(inference.request_item_ids || []).length} input items / ${traceName}`,
        record,
        inference,
        traceState: entry.trace,
      };
    })
    .sort(compareTimelineEntries);
  const tools = state.traces.flatMap(({ bundle, trace }) =>
    Object.values(trace.tool_calls || {}).map((call) => {
      const id = call.tool_call_id || call.call_id;
      const turnId = call.started_by_codex_turn_id || call.codex_turn_id;
      return {
        kind: "tool",
        seq: call.execution?.started_seq ?? call.started_seq ?? 0,
        startedAt: bundle.started_at_unix_ms || trace.started_at_unix_ms || 0,
        id: scopedKey(bundle.id, id),
        turnId,
        turnKey: scopedKey(bundle.id, turnId),
        bundleId: bundle.id,
        trace: traceLabel(bundle),
        title: toolCallTitle(call),
        meta: `${call.execution?.status || call.status || ""} / ${traceLabel(bundle)}`,
      };
    }),
  );
  const compactions = state.traces.flatMap(({ bundle, trace }) =>
    Object.values(trace.compactions || {}).map((compaction) => ({
      kind: "compaction",
      seq: compaction.installed_seq ?? compaction.started_seq ?? compaction.ended_seq ?? 0,
      startedAt: bundle.started_at_unix_ms || trace.started_at_unix_ms || 0,
      id: scopedKey(bundle.id, compaction.compaction_id),
      turnId: compaction.codex_turn_id,
      turnKey: scopedKey(bundle.id, compaction.codex_turn_id),
      bundleId: bundle.id,
      trace: traceLabel(bundle),
      title: compaction.compaction_id,
      meta: `${compaction.thread_id || ""} / ${traceLabel(bundle)}`,
    })),
  );
  const items = [...inferences, ...tools, ...compactions].sort(compareTimelineEntries);
  const turns = state.traces
    .flatMap(({ bundle, trace }) =>
      Object.values(trace.codex_turns || trace.turns || {}).map((turn) => ({
        ...turn,
        seq: turn.execution?.started_seq ?? turn.started_seq ?? turn.execution?.ended_seq ?? turn.ended_seq ?? 0,
        startedAt: bundle.started_at_unix_ms || trace.started_at_unix_ms || 0,
        status: turn.execution?.status || turn.status || "",
        bundleId: bundle.id,
        trace: traceLabel(bundle),
        traceState: trace,
        turnKey: scopedKey(bundle.id, turn.codex_turn_id),
      })),
    )
    .sort(compareTimelineEntries);

  if (turns.length === 0) {
    return [
      {
        id: "ungrouped",
        title: "Ungrouped events",
        meta: `${items.length} events`,
        seq: 0,
        startedAt: 0,
        trace: "",
        items,
      },
    ];
  }

  const groups = turns.map((turn) => {
    const turnInferences = inferences.filter((item) => item.turnKey === turn.turnKey);
    return {
      id: turn.turnKey,
      title: turnTitle(turn, turnInferences),
      meta: turnMeta(turn, turnInferences),
      seq: turn.seq,
      startedAt: turn.startedAt,
      trace: turn.trace,
      bundleId: turn.bundleId,
      items: [],
    };
  });
  const groupsByTurn = new Map(groups.map((group) => [group.id, group]));
  const ungroupedItems = [];
  for (const item of items) {
    const group = groupsByTurn.get(item.turnKey);
    if (group) {
      group.items.push(item);
    } else {
      ungroupedItems.push(item);
    }
  }
  if (ungroupedItems.length > 0) {
    groups.push({
      id: "ungrouped",
      title: "Ungrouped events",
      meta: `${ungroupedItems.length} events`,
      seq: Number.MAX_SAFE_INTEGER,
      startedAt: Number.MAX_SAFE_INTEGER,
      trace: "",
      items: ungroupedItems,
    });
  }
  return groups
    .filter((group) => group.items.length > 0)
    .sort(compareTimelineEntries);
}

function toolCallTitle(call) {
  if (call.tool_name) {
    return call.tool_name;
  }
  if (call.summary?.label) {
    return call.summary.label;
  }
  if (call.kind?.type) {
    return call.kind.type;
  }
  return call.tool_call_id || call.call_id || "tool";
}

function turnTitle(turn, inferences) {
  const firstInference = inferences[0];
  const userMessage = firstInference
    ? latestRealUserMessage(firstInference.inference?.request_item_ids || [], firstInference.traceState)
    : null;
  return userMessage || shortId(turn.codex_turn_id) || "Codex turn";
}

function turnMeta(turn, inferences) {
  const status = turn.status ? ` - ${turn.status}` : "";
  return `${inferences.length} inference${inferences.length === 1 ? "" : "s"}${status} / ${turn.trace || ""}`;
}

function latestRealUserMessage(itemIds, trace = state.trace) {
  const conversationItems = trace?.conversation_items || {};
  for (let index = itemIds.length - 1; index >= 0; index -= 1) {
    const item = conversationItems[itemIds[index]];
    if (item?.role !== "user") {
      continue;
    }
    const preview = conversationItemPreview(item);
    if (preview && !isContextScaffold(preview)) {
      return truncateText(preview, 88);
    }
  }
  return null;
}

function conversationItemPreview(item) {
  const parts = item?.body?.parts || [];
  const text = parts
    .map((part) => part.text || part.summary || part.label || part.source || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function isContextScaffold(text) {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("# AGENTS.md instructions") ||
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<permissions instructions>") ||
    trimmed.startsWith("<skill") ||
    trimmed.startsWith("<skills") ||
    trimmed.startsWith("<plugins") ||
    trimmed.startsWith("## Skills") ||
    trimmed.startsWith("### Available plugins")
  );
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function renderTimelineItem(item) {
  const active =
    item.kind === "inference" && item.id === state.selectedInferenceKey ? " active" : "";
  return `
    <button class="timeline-item${active}" data-kind="${escapeHtml(item.kind)}" data-id="${escapeHtml(item.id)}">
      <div class="timeline-row">
        <span class="kind">${escapeHtml(item.kind)}</span>
        <span class="seq">#${escapeHtml(item.seq)}</span>
      </div>
      <strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>
      <span class="muted" title="${escapeHtml(item.meta || "")}">${escapeHtml(item.meta || "")}</span>
    </button>`;
}

function renderTimeline() {
  const timeline = $("timeline");
  const groups = timelineGroups();
  if (groups.length === 0) {
    timeline.innerHTML = `<p class="empty">No events yet.</p>`;
    return;
  }

  timeline.innerHTML = groups
    .map((group, index) => {
      return `
        <section class="timeline-group">
          <div class="timeline-group-header">
            <div>
              <span class="kind">turn ${escapeHtml(index + 1)}</span>
              <span class="trace-chip">${escapeHtml(group.trace || "")}</span>
              <strong title="${escapeHtml(group.title)}">${escapeHtml(group.title)}</strong>
            </div>
            <span class="muted" title="${escapeHtml(group.id)}">${escapeHtml(group.meta)}</span>
          </div>
          <div class="timeline-group-items">
            ${group.items.map(renderTimelineItem).join("")}
          </div>
        </section>`;
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

async function selectInference(inferenceKey) {
  const selectionRevision = state.selectionRevision + 1;
  state.selectionRevision = selectionRevision;
  const entries = inferenceEntries();
  const entry =
    entries.find((candidate) => candidate.key === inferenceKey) ||
    entries.find(
      (candidate) =>
        candidate.inference.inference_call_id === inferenceKey && candidate.bundle.id === state.bundleId,
    );
  if (!entry) {
    return;
  }
  const record = entry.record;
  const inference = entry.inference;

  state.bundleId = entry.bundle.id;
  state.trace = entry.trace;
  state.selectedInferenceId = inference.inference_call_id;
  state.selectedInferenceKey = entry.key;
  state.selectedComponent = null;
  state.selectedCategory = null;
  state.requestPayload = null;
  state.assemblyPayload = null;

  const requestPayloadId = record.request_payload_id || inference.raw_request_payload_id;
  const assemblyPayloadId = record.prompt_assembly_payload_id || inference.prompt_assembly_payload_id;

  if (requestPayloadId) {
    const requestPayload = await fetchJson(
      `/api/bundles/${encodeURIComponent(entry.bundle.id)}/payload/${encodeURIComponent(requestPayloadId)}`,
    );
    if (selectionRevision !== state.selectionRevision) {
      return;
    }
    state.requestPayload = requestPayload;
  }
  if (assemblyPayloadId) {
    const assemblyPayload = await fetchJson(
      `/api/bundles/${encodeURIComponent(entry.bundle.id)}/payload/${encodeURIComponent(assemblyPayloadId)}`,
    );
    if (selectionRevision !== state.selectionRevision) {
      return;
    }
    state.assemblyPayload = assemblyPayload;
  }

  if (selectionRevision !== state.selectionRevision) {
    return;
  }
  renderBundles();
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
  $("componentGraph").className = "stack";
  const breakdown = buildContextBreakdown();
  const components = breakdown.components;
  if (!Array.isArray(components) || components.length === 0) {
    $("componentGraph").innerHTML = `<p class="empty">No prompt assembly trace recorded.</p>`;
    return;
  }

  const filteredComponents = state.selectedCategory
    ? components.filter((component) => component.category === state.selectedCategory)
    : components;
  const bar = renderContextBar(breakdown);
  const filters = renderContextFilters(breakdown);
  const cards = filteredComponents
    .map((component) => {
      const selected = state.selectedComponent?.id === component.id ? " selected" : "";
      const source = component.source || "unknown";
      const label = component.label || component.id;
      const target = component.target ? renderTarget(component.target) : "";
      return `
        <button class="component${selected}" data-component="${escapeHtml(component.id)}">
          <div class="timeline-row">
            <span class="kind">${escapeHtml(source)}</span>
            <span class="muted">${escapeHtml(CONTEXT_CATEGORY_LABELS[component.category] || component.category)}</span>
          </div>
          <strong>${escapeHtml(label)}</strong>
          <span class="muted">${escapeHtml(target)}</span>
          <p>${escapeHtml(component.preview || "")}</p>
          <div class="component-stats">
            <span>${escapeHtml(formatTokens(component.estimatedTokens))} est</span>
            <span>${escapeHtml(String(component.estimatedBytes))} bytes</span>
            <span>${escapeHtml(component.content_hash || "")}</span>
          </div>
        </button>`;
    })
    .join("");
  $("componentGraph").innerHTML = `
    <section class="context-breakdown">
      ${bar}
      ${filters}
    </section>
    <div class="component-grid">${cards}</div>`;

  $("componentGraph").querySelectorAll("button.context-segment, button.context-filter").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCategory = button.dataset.category || null;
      renderComponents();
    });
  });

  $("componentGraph").querySelectorAll("button.component").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedComponent = components.find((component) => component.id === button.dataset.component);
      renderComponents();
      renderInspector();
    });
  });
}

function buildContextBreakdown() {
  const rawComponents = state.assemblyPayload?.payload?.components || state.assemblyPayload?.components || [];
  const request = state.requestPayload?.payload || state.requestPayload || {};
  const components = Array.isArray(rawComponents)
    ? rawComponents.map((component) => {
        const pointer = component.target?.request_json_pointer || "";
        const value = jsonPointerGet(request, pointer);
        const exists = value !== undefined;
        const fragment = exists ? value : null;
        const estimatedBytes = estimateValueBytes(fragment, exists);
        return {
          ...component,
          category: contextCategory(component, fragment),
          value: fragment,
          estimatedBytes,
          estimatedTokens: bytesToEstimatedTokens(estimatedBytes),
        };
      })
    : [];
  const segments = CONTEXT_CATEGORY_ORDER
    .map((category) => {
      const categoryComponents = components.filter((component) => component.category === category);
      const estimatedTokens = categoryComponents.reduce((sum, component) => sum + component.estimatedTokens, 0);
      const estimatedBytes = categoryComponents.reduce((sum, component) => sum + component.estimatedBytes, 0);
      return {
        category,
        label: CONTEXT_CATEGORY_LABELS[category],
        estimatedTokens,
        estimatedBytes,
      };
    })
    .filter((segment) => segment.estimatedTokens > 0 || segment.estimatedBytes > 0);
  return {
    components,
    segments,
    estimatedTotalTokens: components.reduce((sum, component) => sum + component.estimatedTokens, 0),
  };
}

function renderContextBar(breakdown) {
  const total = Math.max(1, breakdown.estimatedTotalTokens);
  const segments = breakdown.segments
    .map((segment) => {
      const width = Math.max(2, (segment.estimatedTokens / total) * 100);
      const selected = state.selectedCategory === segment.category ? " selected" : "";
      const title = `${segment.label}: ${formatTokens(segment.estimatedTokens)} estimated tokens`;
      return `<button class="context-segment ${segment.category}${selected}" data-category="${escapeHtml(segment.category)}" style="--segment-width:${width}%" title="${escapeHtml(title)}"></button>`;
    })
    .join("");
  return `
    <div class="context-summary">
      <strong>Context composition</strong>
      <span>${escapeHtml(formatTokens(breakdown.estimatedTotalTokens))} estimated tokens from traced components</span>
    </div>
    <div class="context-bar">${segments}</div>`;
}

function renderContextFilters(breakdown) {
  const allSelected = state.selectedCategory ? "" : " selected";
  const filters = breakdown.segments
    .map((segment) => {
      const selected = state.selectedCategory === segment.category ? " selected" : "";
      return `
        <button class="context-filter${selected}" data-category="${escapeHtml(segment.category)}">
          <span class="dot ${escapeHtml(segment.category)}"></span>
          ${escapeHtml(segment.label)}
          <span>${escapeHtml(formatTokens(segment.estimatedTokens))}</span>
        </button>`;
    })
    .join("");
  return `
    <div class="context-filters">
      <button class="context-segment context-filter${allSelected}" data-category="">All</button>
      ${filters}
    </div>`;
}

function jsonPointerGet(value, pointer) {
  if (!pointer) {
    return value;
  }
  if (!pointer.startsWith("/")) {
    return undefined;
  }
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => {
      if (current === undefined || current === null) {
        return undefined;
      }
      return current[part];
    }, value);
}

function estimateValueBytes(value, exists) {
  if (!exists) {
    return 0;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return new TextEncoder().encode(text || "").length;
}

function bytesToEstimatedTokens(bytes) {
  return Math.ceil(bytes / 4);
}

function contextCategory(component, value) {
  const pointer = component.target?.request_json_pointer || "";
  const source = component.source || "";
  if (pointer.startsWith("/tools/") || source === "built_tools") {
    return "tool_schemas";
  }
  if (["model_info", "base_instructions", "build_responses_request"].includes(source)) {
    return "model_scaffold";
  }
  if (["initial_context", "permissions", "environment", "collaboration_mode", "realtime", "git"].includes(source)) {
    return "runtime_context";
  }
  if (["agents_md", "memory", "skills", "plugins", "apps"].includes(source)) {
    return "project_user_context";
  }
  if (["tool_io", "tool_output", "function_call_output", "custom_tool_call_output", "browser_output", "shell_output"].includes(source)) {
    return "tool_io";
  }
  if (["model_state", "reasoning", "compaction", "encrypted_state"].includes(source)) {
    return "model_state";
  }
  if (source === "conversation_history") {
    return conversationCategory(value);
  }
  return "other";
}

function conversationCategory(value) {
  if (jsonContainsMarker(value, isToolIoMarker)) {
    return "tool_io";
  }
  if (jsonContainsMarker(value, isModelStateMarker)) {
    return "model_state";
  }
  return "conversation";
}

function jsonContainsMarker(value, predicate) {
  if (typeof value === "string") {
    return predicate(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => jsonContainsMarker(item, predicate));
  }
  if (isPlainObject(value)) {
    return Object.entries(value).some(([key, child]) => predicate(key) || jsonContainsMarker(child, predicate));
  }
  return false;
}

function isToolIoMarker(value) {
  return [
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
    "local_shell_call",
    "local_shell_call_output",
    "mcp_tool_call",
    "mcp_tool_call_output",
    "tool_call",
    "tool_call_output",
    "shell",
    "browser",
  ].includes(value);
}

function isModelStateMarker(value) {
  return ["reasoning", "reasoning_summary", "compaction", "encrypted_reasoning", "encrypted_state"].includes(value);
}

function formatTokens(value) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  if (Math.abs(value) < 1000) {
    return String(value);
  }
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
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
    const target = state.selectedComponent.target ? renderTarget(state.selectedComponent.target) : "";
    inspector.innerHTML = `
      <h3>Component</h3>
      ${renderRows({
        id: state.selectedComponent.id,
        category: CONTEXT_CATEGORY_LABELS[state.selectedComponent.category] || state.selectedComponent.category,
        source: state.selectedComponent.source,
        label: state.selectedComponent.label,
        target,
        hash: state.selectedComponent.content_hash,
        estimatedTokens: state.selectedComponent.estimatedTokens,
        estimatedBytes: state.selectedComponent.estimatedBytes,
      })}
      <h4>Final request fragment</h4>
      ${renderJsonPanel(state.selectedComponent.value, "Final request fragment")}
      <h4>Prompt component metadata</h4>
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
