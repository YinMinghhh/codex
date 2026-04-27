use crate::history_cell::HistoryCell;
use crate::status::format_tokens_compact;
use codex_protocol::protocol::ContextWindowBreakdown;
use codex_protocol::protocol::ContextWindowCategory;
use codex_protocol::protocol::ContextWindowComponent;
use codex_protocol::protocol::ContextWindowSegment;
use codex_protocol::protocol::TokenUsageInfo;
use ratatui::prelude::*;
use ratatui::style::Stylize;
use std::fmt;

pub(crate) fn new_context_window_output(token_info: Option<&TokenUsageInfo>) -> ContextWindowCell {
    ContextWindowCell {
        token_info: token_info.cloned(),
    }
}

#[derive(Clone)]
pub(crate) struct ContextWindowCell {
    token_info: Option<TokenUsageInfo>,
}

impl fmt::Debug for ContextWindowCell {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ContextWindowCell").finish_non_exhaustive()
    }
}

impl HistoryCell for ContextWindowCell {
    fn display_lines(&self, width: u16) -> Vec<Line<'static>> {
        let mut lines = Vec::new();
        lines.push(vec!["/context".magenta().bold(), " context window".bold()].into());
        let Some(breakdown) = self
            .token_info
            .as_ref()
            .and_then(|info| info.context_window_breakdown.as_ref())
        else {
            lines.push(
                "No context breakdown recorded yet. Send a message first."
                    .dim()
                    .into(),
            );
            return lines;
        };

        lines.push(
            "Local debug data: final request fragments can contain prompts, paths, tool output, API responses, and secrets."
                .red()
                .into(),
        );
        lines.extend(summary_lines(breakdown));
        lines.push(bar_line(breakdown, width));
        lines.push("".into());
        lines.push("Segments".bold().into());
        for segment in &breakdown.segments {
            lines.push(segment_line(segment));
        }
        lines.push("".into());
        lines.push("Components".bold().into());
        for component in &breakdown.components {
            lines.extend(component_lines(component, width));
        }
        lines
    }
}

fn summary_lines(breakdown: &ContextWindowBreakdown) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let reported = breakdown
        .reported_input_tokens
        .map(format_tokens_compact)
        .unwrap_or_else(|| "unknown".to_string());
    let estimated = format_tokens_compact(breakdown.estimated_total_tokens);
    let window = breakdown
        .model_context_window
        .map(format_tokens_compact)
        .unwrap_or_else(|| "unknown".to_string());
    lines.push(
        vec![
            "Server input: ".dim(),
            reported.into(),
            "  Estimated components: ".dim(),
            estimated.into(),
            "  Window: ".dim(),
            window.into(),
        ]
        .into(),
    );
    if let (Some(reported), Some(window)) = (
        breakdown.reported_input_tokens,
        breakdown.model_context_window,
    ) {
        let headroom = window.saturating_sub(reported);
        lines.push(
            vec![
                "Headroom: ".dim(),
                format_tokens_compact(headroom).into(),
                "  Used: ".dim(),
                format!("{:.1}%", percent(reported, window)).into(),
            ]
            .into(),
        );
    }
    lines
}

fn segment_line(segment: &ContextWindowSegment) -> Line<'static> {
    let percent = segment
        .percent_of_reported_input
        .map(|value| format!(" ({value:.1}%)"))
        .unwrap_or_default();
    vec![
        "  ".into(),
        category_marker(segment.category),
        " ".into(),
        segment.label.clone().bold(),
        "  ".dim(),
        format!("{} est", format_tokens_compact(segment.estimated_tokens)).into(),
        format!(" / {} bytes", segment.estimated_bytes).dim(),
        percent.dim(),
    ]
    .into()
}

fn component_lines(component: &ContextWindowComponent, width: u16) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    lines.push(
        vec![
            "  ".into(),
            category_marker(component.category),
            " ".into(),
            component.label.clone().bold(),
            "  ".dim(),
            component.target.request_json_pointer.clone().cyan(),
        ]
        .into(),
    );
    lines.push(
        vec![
            "    source ".dim(),
            component.source.clone().into(),
            "  hash ".dim(),
            component.content_hash.clone().dim(),
            "  est ".dim(),
            format!(
                "{} / {} bytes",
                format_tokens_compact(component.estimated_tokens),
                component.estimated_bytes
            )
            .into(),
        ]
        .into(),
    );
    let value = serde_json::to_string_pretty(&component.value)
        .unwrap_or_else(|err| format!("failed to render request fragment: {err}"));
    lines.extend(wrap_prefixed(&value, "    value ", "          ", width));
    lines
}

fn wrap_prefixed(
    text: &str,
    first_prefix: &'static str,
    rest_prefix: &'static str,
    width: u16,
) -> Vec<Line<'static>> {
    let wrap_width = width.saturating_sub(rest_prefix.len() as u16).max(20) as usize;
    let options = textwrap::Options::new(wrap_width)
        .break_words(true)
        .word_splitter(textwrap::WordSplitter::NoHyphenation);
    let mut lines = Vec::new();
    for (index, source_line) in text.lines().enumerate() {
        let wrapped = textwrap::wrap(source_line, &options);
        if wrapped.is_empty() {
            let prefix = if index == 0 {
                first_prefix
            } else {
                rest_prefix
            };
            lines.push(prefix.dim().into());
            continue;
        }
        for (wrapped_index, wrapped_line) in wrapped.into_iter().enumerate() {
            let prefix = if index == 0 && wrapped_index == 0 {
                first_prefix
            } else {
                rest_prefix
            };
            lines.push(vec![prefix.dim(), wrapped_line.into_owned().into()].into());
        }
    }
    lines
}

fn bar_line(breakdown: &ContextWindowBreakdown, width: u16) -> Line<'static> {
    let bar_width = width.saturating_sub(16).clamp(12, 72) as usize;
    let total = breakdown
        .reported_input_tokens
        .unwrap_or(breakdown.estimated_total_tokens)
        .max(1);
    let mut spans = vec!["Usage ".dim()];
    for segment in &breakdown.segments {
        let cells = ((segment.estimated_tokens as f64 / total as f64) * bar_width as f64)
            .round()
            .max(1.0) as usize;
        spans.push(segment_bar(segment.category, cells));
    }
    let filled = spans
        .iter()
        .skip(1)
        .map(|span| span.content.len())
        .sum::<usize>();
    if filled < bar_width {
        spans.push("-".repeat(bar_width - filled).dim());
    }
    spans.into()
}

fn segment_bar(category: ContextWindowCategory, width: usize) -> Span<'static> {
    let text = "#".repeat(width);
    match category {
        ContextWindowCategory::ModelScaffold => text.dim(),
        ContextWindowCategory::ToolSchemas => text.cyan(),
        ContextWindowCategory::RuntimeContext => text.green(),
        ContextWindowCategory::ProjectUserContext => text.magenta(),
        ContextWindowCategory::Conversation => text.magenta(),
        ContextWindowCategory::ToolIo => text.red(),
        ContextWindowCategory::ModelState => text.cyan().italic(),
        ContextWindowCategory::Other => text.dim(),
    }
}

fn category_marker(category: ContextWindowCategory) -> Span<'static> {
    match category {
        ContextWindowCategory::ModelScaffold => "M".dim(),
        ContextWindowCategory::ToolSchemas => "T".cyan(),
        ContextWindowCategory::RuntimeContext => "R".green(),
        ContextWindowCategory::ProjectUserContext => "P".magenta(),
        ContextWindowCategory::Conversation => "C".magenta(),
        ContextWindowCategory::ToolIo => "I".red(),
        ContextWindowCategory::ModelState => "S".cyan().italic(),
        ContextWindowCategory::Other => "O".dim(),
    }
}

fn percent(value: i64, total: i64) -> f64 {
    if total <= 0 {
        0.0
    } else {
        value as f64 / total as f64 * 100.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::protocol::ContextWindowTarget;
    use codex_protocol::protocol::TokenUsage;
    use pretty_assertions::assert_eq;
    use serde_json::json;

    fn lines_to_text(lines: Vec<Line<'static>>) -> Vec<String> {
        lines
            .into_iter()
            .map(|line| {
                line.spans
                    .into_iter()
                    .map(|span| span.content.to_string())
                    .collect::<String>()
            })
            .collect()
    }

    #[test]
    fn renders_missing_breakdown_message() {
        let cell = new_context_window_output(None);

        let lines = lines_to_text(cell.display_lines(80));

        assert_eq!(
            lines,
            vec![
                "/context context window".to_string(),
                "No context breakdown recorded yet. Send a message first.".to_string(),
            ]
        );
    }

    #[test]
    fn renders_breakdown_segments_and_fragments() {
        let breakdown = ContextWindowBreakdown {
            model_context_window: Some(100),
            reported_input_tokens: Some(50),
            estimated_total_tokens: 12,
            segments: vec![ContextWindowSegment {
                category: ContextWindowCategory::ToolSchemas,
                label: "Tool schemas".to_string(),
                estimated_tokens: 12,
                estimated_bytes: 48,
                percent_of_reported_input: Some(24.0),
            }],
            components: vec![ContextWindowComponent {
                id: "tool:1".to_string(),
                category: ContextWindowCategory::ToolSchemas,
                source: "built_tools".to_string(),
                label: "shell".to_string(),
                target: ContextWindowTarget {
                    request_json_pointer: "/tools/0".to_string(),
                    input_index: None,
                    content_index: None,
                    tool_name: Some("shell".to_string()),
                },
                estimated_tokens: 12,
                estimated_bytes: 48,
                content_hash: "fnv1a64:0000000000000000".to_string(),
                value: json!({ "name": "shell", "description": "run commands" }),
            }],
        };
        let token_info = TokenUsageInfo {
            total_token_usage: TokenUsage::default(),
            last_token_usage: TokenUsage::default(),
            model_context_window: Some(100),
            context_window_breakdown: Some(breakdown),
        };
        let cell = new_context_window_output(Some(&token_info));

        let lines = lines_to_text(cell.display_lines(80));

        assert!(lines.iter().any(|line| line.contains("Server input: 50")));
        assert!(
            lines
                .iter()
                .any(|line| line.contains("Tool schemas  12 est / 48 bytes (24.0%)"))
        );
        assert!(lines.iter().any(|line| line.contains("/tools/0")));
        assert!(lines.iter().any(|line| line.contains("\"description\"")));
    }
}
