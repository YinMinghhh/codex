use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use anyhow::Result;
use anyhow::anyhow;
use async_stream::stream;
use axum::Json;
use axum::Router;
use axum::extract::Path as AxumPath;
use axum::extract::Query;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Html;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::response::Sse;
use axum::response::sse::Event;
use axum::response::sse::KeepAlive;
use axum::routing::get;
use codex_rollout_trace::ConversationItem;
use codex_rollout_trace::ConversationPart;
use codex_rollout_trace::ConversationRole;
use codex_rollout_trace::MANIFEST_FILE_NAME;
use codex_rollout_trace::RAW_EVENT_LOG_FILE_NAME;
use codex_rollout_trace::RawEventSeq;
use codex_rollout_trace::RawTraceEvent;
use codex_rollout_trace::RolloutTrace;
use codex_rollout_trace::replay_bundle;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::time::MissedTickBehavior;

const INDEX_HTML: &str = include_str!("../assets/index.html");
const APP_JS: &str = include_str!("../assets/app.js");
const STYLE_CSS: &str = include_str!("../assets/style.css");

#[derive(Debug, Clone)]
pub struct TraceViewerConfig {
    pub trace_root: Option<PathBuf>,
    pub bundle: Option<PathBuf>,
    pub port: u16,
    pub open: bool,
}

pub async fn serve(config: TraceViewerConfig) -> Result<()> {
    let state = Arc::new(ViewerState::new(config.trace_root, config.bundle)?);
    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/style.css", get(style_css))
        .route("/api/bundles", get(list_bundles))
        .route("/api/bundles/{bundle_id}/state", get(bundle_state))
        .route(
            "/api/bundles/{bundle_id}/payload/{raw_payload_id}",
            get(raw_payload),
        )
        .route("/api/bundles/{bundle_id}/events", get(bundle_events))
        .route("/api/bundles/{bundle_id}/stream", get(bundle_stream))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], config.port));
    let listener = TcpListener::bind(addr).await?;
    let local_addr = listener.local_addr()?;
    let url = format!("http://{local_addr}/");
    eprintln!("codex trace viewer listening on {url}");
    if config.open {
        open_url_best_effort(&url);
    }
    axum::serve(listener, app).await?;
    Ok(())
}

pub fn reduce_bundle_to_path(bundle: &Path, output: &Path) -> Result<()> {
    let state = replay_bundle(bundle)?;
    let json = serde_json::to_vec_pretty(&state)?;
    std::fs::write(output, json)
        .with_context(|| format!("failed to write reduced trace to {}", output.display()))?;
    Ok(())
}

async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn app_js() -> Response {
    (
        [(axum::http::header::CONTENT_TYPE, "text/javascript")],
        APP_JS,
    )
        .into_response()
}

async fn style_css() -> Response {
    ([(axum::http::header::CONTENT_TYPE, "text/css")], STYLE_CSS).into_response()
}

async fn list_bundles(
    State(state): State<Arc<ViewerState>>,
) -> Result<Json<Vec<BundleSummary>>, HttpError> {
    Ok(Json(state.list_bundles()?))
}

async fn bundle_state(
    State(state): State<Arc<ViewerState>>,
    AxumPath(bundle_id): AxumPath<String>,
) -> Result<Json<Value>, HttpError> {
    let bundle_path = state.bundle_path(&bundle_id)?;
    let reduced = replay_bundle(&bundle_path)
        .with_context(|| format!("failed to replay {}", bundle_path.display()))?;
    Ok(Json(json!({
        "bundle": summarize_bundle(bundle_id, &bundle_path)?,
        "state": reduced,
    })))
}

async fn raw_payload(
    State(state): State<Arc<ViewerState>>,
    AxumPath((bundle_id, raw_payload_id)): AxumPath<(String, String)>,
) -> Result<Json<Value>, HttpError> {
    let bundle_path = state.bundle_path(&bundle_id)?;
    let reduced = replay_bundle(&bundle_path)
        .with_context(|| format!("failed to replay {}", bundle_path.display()))?;
    let payload_ref = reduced
        .raw_payloads
        .get(&raw_payload_id)
        .ok_or_else(|| HttpError::not_found(format!("unknown raw payload {raw_payload_id}")))?;
    let payload_path = safe_bundle_child(&bundle_path, Path::new(&payload_ref.path))?;
    let bytes = tokio::fs::read(&payload_path)
        .await
        .with_context(|| format!("failed to read {}", payload_path.display()))?;
    let value = serde_json::from_slice(&bytes).unwrap_or_else(|err| {
        json!({
            "parse_error": err.to_string(),
            "raw_text": String::from_utf8_lossy(&bytes),
        })
    });
    Ok(Json(json!({
        "payloadRef": payload_ref,
        "payload": value,
    })))
}

#[derive(Debug, Deserialize)]
struct EventsQuery {
    #[serde(rename = "afterSeq")]
    after_seq: Option<RawEventSeq>,
}

async fn bundle_events(
    State(state): State<Arc<ViewerState>>,
    AxumPath(bundle_id): AxumPath<String>,
    Query(query): Query<EventsQuery>,
) -> Result<Json<Vec<RawTraceEvent>>, HttpError> {
    let bundle_path = state.bundle_path(&bundle_id)?;
    Ok(Json(read_events_after(
        &bundle_path,
        query.after_seq.unwrap_or(0),
    )?))
}

async fn bundle_stream(
    State(state): State<Arc<ViewerState>>,
    AxumPath(bundle_id): AxumPath<String>,
    Query(query): Query<EventsQuery>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, HttpError> {
    let bundle_path = state.bundle_path(&bundle_id)?;
    let mut last_seq = query.after_seq.unwrap_or(0);
    let event_stream = stream! {
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            match read_events_after(&bundle_path, last_seq) {
                Ok(events) if !events.is_empty() => {
                    if let Some(seq) = events.last().map(|event| event.seq) {
                        last_seq = seq;
                    }
                    match Event::default().event("events").json_data(json!({ "events": events })) {
                        Ok(event) => yield Ok(event),
                        Err(err) => yield Ok(Event::default().event("error").data(err.to_string())),
                    }
                }
                Ok(_) => {}
                Err(err) => {
                    yield Ok(Event::default().event("error").data(err.to_string()));
                }
            }
        }
    };
    Ok(Sse::new(event_stream).keep_alive(KeepAlive::default()))
}

#[derive(Debug, Clone)]
struct ViewerState {
    mode: ViewerMode,
}

#[derive(Debug, Clone)]
enum ViewerMode {
    Root(PathBuf),
    Single(PathBuf),
}

impl ViewerState {
    fn new(trace_root: Option<PathBuf>, bundle: Option<PathBuf>) -> Result<Self> {
        let mode = match (trace_root, bundle) {
            (Some(trace_root), None) => ViewerMode::Root(trace_root),
            (None, Some(bundle)) => ViewerMode::Single(bundle),
            (Some(_), Some(_)) => {
                return Err(anyhow!("use either --trace-root or --bundle, not both"));
            }
            (None, None) => {
                return Err(anyhow!("missing --trace-root or --bundle"));
            }
        };
        Ok(Self { mode })
    }

    fn list_bundles(&self) -> Result<Vec<BundleSummary>> {
        match &self.mode {
            ViewerMode::Single(bundle) => {
                Ok(vec![summarize_bundle("current".to_string(), bundle)?])
            }
            ViewerMode::Root(root) => {
                let mut bundles = Vec::new();
                for entry in std::fs::read_dir(root)
                    .with_context(|| format!("failed to list {}", root.display()))?
                {
                    let entry = entry?;
                    let path = entry.path();
                    if !path.join(MANIFEST_FILE_NAME).is_file() {
                        continue;
                    }
                    let id = entry.file_name().to_string_lossy().into_owned();
                    if let Ok(summary) = summarize_bundle(id, &path) {
                        bundles.push(summary);
                    }
                }
                bundles.sort_by(|left, right| {
                    right
                        .started_at_unix_ms
                        .cmp(&left.started_at_unix_ms)
                        .then_with(|| left.id.cmp(&right.id))
                });
                Ok(bundles)
            }
        }
    }

    fn bundle_path(&self, bundle_id: &str) -> Result<PathBuf, HttpError> {
        match &self.mode {
            ViewerMode::Single(bundle) => {
                if bundle_id == "current" {
                    Ok(bundle.clone())
                } else {
                    Err(HttpError::not_found(format!("unknown bundle {bundle_id}")))
                }
            }
            ViewerMode::Root(root) => {
                if !is_safe_path_segment(bundle_id) {
                    return Err(HttpError::bad_request("invalid bundle id"));
                }
                let path = root.join(bundle_id);
                if path.join(MANIFEST_FILE_NAME).is_file() {
                    Ok(path)
                } else {
                    Err(HttpError::not_found(format!("unknown bundle {bundle_id}")))
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct BundleSummary {
    id: String,
    display_name: String,
    subtitle: String,
    short_id: String,
    path: String,
    trace_id: Option<String>,
    rollout_id: Option<String>,
    root_thread_id: Option<String>,
    started_at_unix_ms: i64,
    status: String,
}

fn summarize_bundle(id: String, bundle_path: &Path) -> Result<BundleSummary> {
    let manifest_path = bundle_path.join(MANIFEST_FILE_NAME);
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(&manifest_path)
            .with_context(|| format!("failed to read {}", manifest_path.display()))?,
    )?;
    let trace_id = manifest
        .get("trace_id")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let rollout_id = manifest
        .get("rollout_id")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let root_thread_id = manifest
        .get("root_thread_id")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let started_at_unix_ms = manifest
        .get("started_at_unix_ms")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let reduced = replay_bundle(bundle_path);
    let reduced_status = reduced
        .as_ref()
        .map(|trace| format!("{:?}", trace.status).to_lowercase())
        .unwrap_or_else(|err| format!("partial: {err}"));
    let (display_name, subtitle) = reduced
        .as_ref()
        .ok()
        .map(bundle_labels_from_trace)
        .unwrap_or_else(|| {
            let fallback_id = trace_id.as_deref().unwrap_or(&id);
            (
                format!("Trace {}", short_identifier(fallback_id)),
                root_thread_id
                    .as_deref()
                    .map(|thread_id| format!("thread {}", short_identifier(thread_id)))
                    .unwrap_or_else(|| "trace bundle".to_string()),
            )
        });
    Ok(BundleSummary {
        short_id: short_identifier(&id),
        id,
        display_name,
        subtitle,
        path: bundle_path.display().to_string(),
        trace_id,
        rollout_id,
        root_thread_id,
        started_at_unix_ms,
        status: reduced_status,
    })
}

fn bundle_labels_from_trace(trace: &RolloutTrace) -> (String, String) {
    let thread = trace.threads.get(&trace.root_thread_id);
    let mut display_name = thread
        .and_then(|thread| thread.nickname.as_deref())
        .map(str::trim)
        .filter(|nickname| !nickname.is_empty() && *nickname != "Codex")
        .map(ToString::to_string);
    if display_name.is_none()
        && let Some(user_preview) = thread.and_then(|thread| {
            thread
                .conversation_item_ids
                .iter()
                .filter_map(|item_id| trace.conversation_items.get(item_id))
                .filter(|item| item.role == ConversationRole::User)
                .filter_map(conversation_item_preview)
                .find(|preview| {
                    let preview = preview.trim_start();
                    !preview.starts_with("# AGENTS.md instructions")
                        && !preview.starts_with("<environment_context>")
                        && !preview.starts_with("<permissions instructions>")
                })
        })
    {
        display_name = Some(user_preview);
    }
    let display_name =
        display_name.unwrap_or_else(|| format!("Trace {}", short_identifier(&trace.trace_id)));
    let subtitle = thread
        .and_then(|thread| thread.default_model.as_deref())
        .map(|model| format!("{model} / {}", short_identifier(&trace.root_thread_id)))
        .unwrap_or_else(|| format!("thread {}", short_identifier(&trace.root_thread_id)));
    (display_name, subtitle)
}

fn conversation_item_preview(item: &ConversationItem) -> Option<String> {
    let mut fragments = Vec::new();
    for part in &item.body.parts {
        match part {
            ConversationPart::Text { text } | ConversationPart::Summary { text } => {
                fragments.push(text.as_str());
            }
            ConversationPart::Encoded { label, .. }
            | ConversationPart::PayloadRef { label, .. } => {
                fragments.push(label.as_str());
            }
            ConversationPart::Json { summary, .. } => {
                fragments.push(summary.as_str());
            }
            ConversationPart::Code { source, .. } => {
                fragments.push(source.as_str());
            }
        }
    }
    let collapsed = fragments
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.is_empty() {
        None
    } else if collapsed.chars().count() <= 72 {
        Some(collapsed)
    } else {
        Some(format!(
            "{}...",
            collapsed.chars().take(69).collect::<String>()
        ))
    }
}

fn short_identifier(value: &str) -> String {
    if value.chars().count() <= 18 {
        return value.to_string();
    }
    let start = value.chars().take(8).collect::<String>();
    let end = value
        .chars()
        .rev()
        .take(8)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{start}...{end}")
}

fn read_events_after(bundle_path: &Path, after_seq: RawEventSeq) -> Result<Vec<RawTraceEvent>> {
    let log_path = bundle_path.join(RAW_EVENT_LOG_FILE_NAME);
    let content = match std::fs::read_to_string(&log_path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(err).with_context(|| format!("failed to read {}", log_path.display()));
        }
    };
    let mut events = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<RawTraceEvent>(line) else {
            continue;
        };
        if event.seq > after_seq {
            events.push(event);
        }
    }
    Ok(events)
}

fn safe_bundle_child(bundle_path: &Path, relative_path: &Path) -> Result<PathBuf, HttpError> {
    if !relative_path.is_relative()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(HttpError::bad_request("invalid payload path"));
    }
    Ok(bundle_path.join(relative_path))
}

fn is_safe_path_segment(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('/')
        && !value.contains('\\')
        && value != "."
        && value != ".."
}

fn open_url_best_effort(url: &str) {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", "", url]);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };

    let _ = command.spawn();
}

#[derive(Debug)]
struct HttpError {
    status: StatusCode,
    message: String,
}

impl HttpError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }
}

impl<E> From<E> for HttpError
where
    E: Into<anyhow::Error>,
{
    fn from(error: E) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.into().to_string(),
        }
    }
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({
                "error": self.message,
            })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn safe_path_segment_rejects_traversal() {
        assert!(is_safe_path_segment("bundle-1"));
        assert!(!is_safe_path_segment("../bundle-1"));
        assert!(!is_safe_path_segment("nested/bundle-1"));
        assert!(!is_safe_path_segment("nested\\bundle-1"));
    }

    #[test]
    fn reduce_bundle_reports_missing_manifest() -> Result<()> {
        let temp = TempDir::new()?;
        let output = temp
            .path()
            .join(codex_rollout_trace::REDUCED_STATE_FILE_NAME);
        let result = reduce_bundle_to_path(temp.path(), &output);
        assert!(result.is_err());
        Ok(())
    }
}
