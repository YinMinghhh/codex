//! Trace-only prompt/request provenance helpers.
//!
//! This module never changes model-visible request bytes. It builds a sidecar
//! description that rollout tracing can persist next to the exact raw request.

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;

use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ModelInfo;
use codex_protocol::protocol::ContextWindowBreakdown;
use codex_protocol::protocol::ContextWindowCategory;
use codex_protocol::protocol::ContextWindowComponent;
use codex_protocol::protocol::ContextWindowMappingConfidence;
use codex_protocol::protocol::ContextWindowSegment;
use codex_protocol::protocol::ContextWindowTarget;
use codex_protocol::protocol::ContextWindowTextRange;
use codex_rollout_trace::PromptAssemblyMapping;
use codex_rollout_trace::PromptAssemblyStep;
use codex_rollout_trace::PromptAssemblyTrace;
use codex_rollout_trace::PromptComponent;
use codex_rollout_trace::PromptMappingConfidence;
use codex_rollout_trace::PromptTarget;
use codex_rollout_trace::PromptTextRange;
use serde_json::Value;
use serde_json::json;

use crate::client_common::Prompt;

const PREVIEW_CHARS: usize = 240;

pub(crate) fn text_component(
    source: impl Into<String>,
    label: impl Into<String>,
    text: &str,
    metadata: Value,
) -> PromptComponent {
    let source = source.into();
    let label = label.into();
    let content_hash = content_hash(text);
    PromptComponent {
        id: format!("{source}:{content_hash}"),
        source,
        label,
        target: PromptTarget::request_pointer(""),
        content_hash,
        preview: preview(text),
        metadata,
    }
}

pub(crate) fn components_for_items(
    source: &str,
    label: &str,
    items: &[ResponseItem],
    metadata: Value,
) -> Vec<PromptComponent> {
    let mut components = Vec::new();
    for item in items {
        match item {
            ResponseItem::Message { content, .. } => {
                for content_item in content {
                    match content_item {
                        ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                            components.push(text_component(source, label, text, metadata.clone()));
                        }
                        ContentItem::InputImage { image_url, .. } => {
                            components.push(text_component(
                                source,
                                label,
                                image_url,
                                metadata.clone(),
                            ));
                        }
                    }
                }
            }
            item => {
                let text = serde_json::to_string(item).unwrap_or_else(|err| {
                    format!("failed to serialize response item for prompt trace: {err}")
                });
                components.push(text_component(source, label, &text, metadata.clone()));
            }
        }
    }
    components
}

pub(crate) fn build_prompt_assembly_trace(
    request: &impl serde::Serialize,
    prompt: &Prompt,
    model_info: &ModelInfo,
    codex_turn_id: &str,
    transport: &str,
) -> PromptAssemblyTrace {
    let request = serde_json::to_value(request).unwrap_or_else(|err| {
        json!({
            "serialization_error": err.to_string(),
        })
    });
    let mut components = Vec::new();
    components.push(text_component(
        "model_info",
        "selected model metadata",
        &model_info.slug,
        json!({
            "transport": transport,
            "context_window": model_info.context_window,
            "supports_parallel_tool_calls": model_info.supports_parallel_tool_calls,
            "supports_reasoning_summaries": model_info.supports_reasoning_summaries,
            "support_verbosity": model_info.support_verbosity,
        }),
    ));
    if let Some(component) = components.last_mut() {
        component.target = PromptTarget::request_pointer("/model");
    }

    components.push(text_component(
        "base_instructions",
        "base instructions",
        &prompt.base_instructions.text,
        json!({
            "transport": transport,
        }),
    ));
    if let Some(component) = components.last_mut() {
        component.target = PromptTarget::request_pointer("/instructions");
    }

    components.extend(components_for_request_input(
        request.get("input"),
        &prompt.trace_components,
    ));
    components.extend(components_for_tools(request.get("tools")));
    components.extend(components_for_request_settings(&request, transport));
    let (assembly_steps, mappings) = build_assembly_mappings(&request, &components);

    PromptAssemblyTrace {
        inference_call_id: String::new(),
        codex_turn_id: codex_turn_id.to_string(),
        model_info: serde_json::to_value(model_info).unwrap_or_else(|err| {
            json!({
                "serialization_error": err.to_string(),
            })
        }),
        base_instructions: prompt.base_instructions.text.clone(),
        components,
        assembly_steps,
        mappings,
        final_request_payload_id: String::new(),
    }
}

pub(crate) fn build_context_window_breakdown(
    request: &impl serde::Serialize,
    trace: &PromptAssemblyTrace,
    model_context_window: Option<i64>,
    reported_input_tokens: Option<i64>,
) -> ContextWindowBreakdown {
    let request = serde_json::to_value(request).unwrap_or_else(|err| {
        json!({
            "serialization_error": err.to_string(),
        })
    });
    let mut mappings_by_component = HashMap::<String, VecDeque<&PromptAssemblyMapping>>::new();
    for mapping in &trace.mappings {
        mappings_by_component
            .entry(mapping.component_id.clone())
            .or_default()
            .push_back(mapping);
    }
    let mut components = Vec::new();
    let mut seen_targets = HashSet::<String>::new();

    for component in &trace.components {
        let mapping = mappings_by_component
            .get_mut(&component.id)
            .and_then(VecDeque::pop_front);
        let target = mapping
            .map(|mapping| &mapping.target)
            .unwrap_or(&component.target);
        let pointer = &target.request_json_pointer;
        let value_exists = request.pointer(pointer).is_some();
        let value = request.pointer(pointer).cloned().unwrap_or(Value::Null);
        let estimated_bytes = value_estimated_bytes(&value, value_exists);
        let estimated_tokens = bytes_to_estimated_tokens(estimated_bytes);
        let category = context_window_category(component, &value);
        seen_targets.insert(pointer.clone());
        components.push(ContextWindowComponent {
            id: component.id.clone(),
            category,
            source: component.source.clone(),
            label: component.label.clone(),
            target: ContextWindowTarget {
                request_json_pointer: pointer.clone(),
                input_index: target.input_index,
                content_index: target.content_index,
                tool_name: target.tool_name.clone(),
                text_range: mapping
                    .and_then(|mapping| mapping.text_range.as_ref().map(context_window_text_range)),
            },
            mapping_confidence: mapping
                .map(|mapping| context_window_mapping_confidence(&mapping.confidence)),
            assembly_step_ids: mapping
                .map(|mapping| mapping.step_ids.clone())
                .unwrap_or_default(),
            estimated_tokens,
            estimated_bytes,
            content_hash: component.content_hash.clone(),
            value,
        });
    }

    components.extend(untraced_scaffold_components(&request, &seen_targets));

    let estimated_total_tokens = components
        .iter()
        .map(|component| component.estimated_tokens)
        .sum();
    let segments = ContextWindowCategory::ORDERED
        .into_iter()
        .filter_map(|category| {
            let category_components = components
                .iter()
                .filter(|component| component.category == category);
            let estimated_tokens = category_components
                .clone()
                .map(|component| component.estimated_tokens)
                .sum::<i64>();
            if estimated_tokens == 0 {
                return None;
            }
            let estimated_bytes = category_components
                .map(|component| component.estimated_bytes)
                .sum();
            Some(ContextWindowSegment {
                category,
                label: category.label().to_string(),
                estimated_tokens,
                estimated_bytes,
                percent_of_reported_input: None,
            })
        })
        .collect();

    ContextWindowBreakdown {
        model_context_window,
        reported_input_tokens: None,
        estimated_total_tokens,
        segments,
        components,
    }
    .with_reported_input_tokens(reported_input_tokens)
}

fn build_assembly_mappings(
    request: &Value,
    components: &[PromptComponent],
) -> (Vec<PromptAssemblyStep>, Vec<PromptAssemblyMapping>) {
    components
        .iter()
        .enumerate()
        .map(|(index, component)| {
            let step = PromptAssemblyStep {
                id: format!("step:{index}"),
                source: component.source.clone(),
                label: component.label.clone(),
                target: component.target.clone(),
                metadata: json!({
                    "component_id": component.id.clone(),
                }),
            };
            let target_value = request.pointer(&component.target.request_json_pointer);
            let confidence = mapping_confidence(component, target_value);
            let mapping = PromptAssemblyMapping {
                component_id: component.id.clone(),
                step_ids: vec![step.id.clone()],
                target: component.target.clone(),
                text_range: text_range_for_mapping(target_value, &confidence),
                confidence,
                preview: component.preview.clone(),
            };
            (step, mapping)
        })
        .unzip()
}

fn mapping_confidence(
    component: &PromptComponent,
    target_value: Option<&Value>,
) -> PromptMappingConfidence {
    if component
        .metadata
        .get("classified")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return PromptMappingConfidence::ClassifiedFallback;
    }

    let Some(target_value) = target_value else {
        return PromptMappingConfidence::Derived;
    };

    if let Some(text) = target_value.as_str()
        && content_hash(text) == component.content_hash
    {
        if component.source == "model_info" {
            return PromptMappingConfidence::Derived;
        }
        return PromptMappingConfidence::ExactRange;
    }

    if content_hash(&value_to_compact_string(target_value)) == component.content_hash {
        return PromptMappingConfidence::ExactValue;
    }

    PromptMappingConfidence::Derived
}

fn text_range_for_mapping(
    target_value: Option<&Value>,
    confidence: &PromptMappingConfidence,
) -> Option<PromptTextRange> {
    match confidence {
        PromptMappingConfidence::ExactRange
        | PromptMappingConfidence::Derived
        | PromptMappingConfidence::ClassifiedFallback => {
            let text = target_value.and_then(Value::as_str)?;
            Some(PromptTextRange {
                start_byte: 0,
                end_byte: text.len(),
                start_char: 0,
                end_char: text.chars().count(),
            })
        }
        PromptMappingConfidence::ExactValue => None,
    }
}

fn context_window_text_range(range: &PromptTextRange) -> ContextWindowTextRange {
    ContextWindowTextRange {
        start_byte: range.start_byte,
        end_byte: range.end_byte,
        start_char: range.start_char,
        end_char: range.end_char,
    }
}

fn context_window_mapping_confidence(
    confidence: &PromptMappingConfidence,
) -> ContextWindowMappingConfidence {
    match confidence {
        PromptMappingConfidence::ExactRange => ContextWindowMappingConfidence::ExactRange,
        PromptMappingConfidence::ExactValue => ContextWindowMappingConfidence::ExactValue,
        PromptMappingConfidence::Derived => ContextWindowMappingConfidence::Derived,
        PromptMappingConfidence::ClassifiedFallback => {
            ContextWindowMappingConfidence::ClassifiedFallback
        }
    }
}

fn untraced_scaffold_components(
    request: &Value,
    seen_targets: &HashSet<String>,
) -> Vec<ContextWindowComponent> {
    [
        ("model", "/model"),
        ("request settings", "/temperature"),
        ("request settings", "/top_p"),
        ("request settings", "/max_output_tokens"),
        ("request settings", "/metadata"),
    ]
    .into_iter()
    .filter_map(|(label, pointer)| {
        if seen_targets.contains(pointer) {
            return None;
        }
        let value = request.pointer(pointer)?.clone();
        let estimated_bytes = value_estimated_bytes(&value, true);
        let estimated_tokens = bytes_to_estimated_tokens(estimated_bytes);
        Some(ContextWindowComponent {
            id: format!("model_scaffold:{pointer}"),
            category: ContextWindowCategory::ModelScaffold,
            source: "build_responses_request".to_string(),
            label: label.to_string(),
            target: ContextWindowTarget {
                request_json_pointer: pointer.to_string(),
                input_index: None,
                content_index: None,
                tool_name: None,
                text_range: None,
            },
            mapping_confidence: None,
            assembly_step_ids: Vec::new(),
            estimated_tokens,
            estimated_bytes,
            content_hash: content_hash(&value_to_compact_string(&value)),
            value,
        })
    })
    .collect()
}

fn value_estimated_bytes(value: &Value, exists: bool) -> i64 {
    if !exists {
        return 0;
    }
    match value {
        Value::String(text) => saturating_usize_to_i64(text.len()),
        _ => saturating_usize_to_i64(value_to_compact_string(value).len()),
    }
}

fn value_to_compact_string(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn saturating_usize_to_i64(value: usize) -> i64 {
    value.try_into().unwrap_or(i64::MAX)
}

fn bytes_to_estimated_tokens(bytes: i64) -> i64 {
    (bytes.saturating_add(3)) / 4
}

fn context_window_category(component: &PromptComponent, value: &Value) -> ContextWindowCategory {
    if component.target.request_json_pointer.starts_with("/tools/")
        || component.source == "built_tools"
    {
        return ContextWindowCategory::ToolSchemas;
    }

    match component.source.as_str() {
        "model_info" | "base_instructions" | "build_responses_request" => {
            ContextWindowCategory::ModelScaffold
        }
        "initial_context" | "permissions" | "environment" | "collaboration_mode" | "realtime"
        | "git" => ContextWindowCategory::RuntimeContext,
        "agents_md" | "memory" | "skills" | "plugins" | "apps" => {
            ContextWindowCategory::ProjectUserContext
        }
        "conversation_history" => conversation_category(value),
        "tool_io"
        | "tool_output"
        | "function_call_output"
        | "custom_tool_call_output"
        | "browser_output"
        | "shell_output" => ContextWindowCategory::ToolIo,
        "model_state" | "reasoning" | "compaction" | "encrypted_state" => {
            ContextWindowCategory::ModelState
        }
        _ => ContextWindowCategory::Other,
    }
}

fn conversation_category(value: &Value) -> ContextWindowCategory {
    let role_or_type = value
        .get("type")
        .or_else(|| value.get("role"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if is_tool_io_marker(role_or_type) {
        return ContextWindowCategory::ToolIo;
    }
    if is_model_state_marker(role_or_type) {
        return ContextWindowCategory::ModelState;
    }
    if value_contains_key_or_string(value, is_tool_io_marker) {
        return ContextWindowCategory::ToolIo;
    }
    if value_contains_key_or_string(value, is_model_state_marker) {
        return ContextWindowCategory::ModelState;
    }
    ContextWindowCategory::Conversation
}

fn value_contains_key_or_string(value: &Value, predicate: impl Fn(&str) -> bool + Copy) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, value)| {
            predicate(key)
                || value.as_str().is_some_and(predicate)
                || value_contains_key_or_string(value, predicate)
        }),
        Value::Array(values) => values
            .iter()
            .any(|value| value_contains_key_or_string(value, predicate)),
        Value::String(text) => predicate(text),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn is_tool_io_marker(value: &str) -> bool {
    matches!(
        value,
        "function_call"
            | "function_call_output"
            | "custom_tool_call"
            | "custom_tool_call_output"
            | "local_shell_call"
            | "local_shell_call_output"
            | "mcp_tool_call"
            | "mcp_tool_call_output"
            | "tool_call"
            | "tool_call_output"
            | "shell"
            | "browser"
    )
}

fn is_model_state_marker(value: &str) -> bool {
    matches!(
        value,
        "reasoning"
            | "reasoning_summary"
            | "compaction"
            | "encrypted_reasoning"
            | "encrypted_state"
    )
}

pub(crate) fn retarget_components_for_prompt_input(
    input: &[ResponseItem],
    registered_components: &[PromptComponent],
) -> Vec<PromptComponent> {
    let input_value = serde_json::to_value(input).unwrap_or_else(|_| Value::Array(Vec::new()));
    components_for_request_input(Some(&input_value), registered_components)
}

fn components_for_request_input(
    input: Option<&Value>,
    registered_components: &[PromptComponent],
) -> Vec<PromptComponent> {
    let Some(input) = input.and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut registered_by_hash = HashMap::<String, VecDeque<PromptComponent>>::new();
    for component in registered_components {
        registered_by_hash
            .entry(component.content_hash.clone())
            .or_default()
            .push_back(component.clone());
    }

    let mut components = Vec::new();
    for (input_index, item) in input.iter().enumerate() {
        match item.get("content").and_then(Value::as_array) {
            Some(content) => {
                for (content_index, part) in content.iter().enumerate() {
                    if let Some(text) = text_from_content_part(part) {
                        let target = PromptTarget::input_text(
                            format!("/input/{input_index}/content/{content_index}/text"),
                            input_index,
                            content_index,
                        );
                        components.push(component_for_text_at_target(
                            text,
                            target,
                            item.get("role").and_then(Value::as_str),
                            &mut registered_by_hash,
                        ));
                    }
                }
            }
            None => {
                let text = serde_json::to_string(item).unwrap_or_default();
                let target = PromptTarget::request_pointer(format!("/input/{input_index}"));
                components.push(component_for_text_at_target(
                    &text,
                    target,
                    item.get("type").and_then(Value::as_str),
                    &mut registered_by_hash,
                ));
            }
        }
    }

    components
}

fn component_for_text_at_target(
    text: &str,
    target: PromptTarget,
    role_or_type: Option<&str>,
    registered_by_hash: &mut HashMap<String, VecDeque<PromptComponent>>,
) -> PromptComponent {
    let hash = content_hash(text);
    if let Some(component) = registered_by_hash
        .get_mut(&hash)
        .and_then(VecDeque::pop_front)
    {
        return PromptComponent {
            target,
            ..component
        };
    }

    let (source, label) = classify_unregistered_text(text, role_or_type);
    let mut component = text_component(
        source,
        label,
        text,
        json!({
            "classified": true,
            "role_or_type": role_or_type,
        }),
    );
    component.target = target;
    component
}

fn text_from_content_part(part: &Value) -> Option<&str> {
    part.get("text")
        .and_then(Value::as_str)
        .or_else(|| part.get("image_url").and_then(Value::as_str))
}

fn classify_unregistered_text(
    text: &str,
    role_or_type: Option<&str>,
) -> (&'static str, &'static str) {
    if text.contains("AGENTS.md instructions for") || text.contains("--- project-doc ---") {
        ("agents_md", "AGENTS.md / project instructions")
    } else if text.contains("Available skills") || text.contains("<skills_instructions>") {
        ("skills", "skills instructions")
    } else if text.contains("Available plugins") || text.contains("<plugins_instructions>") {
        ("plugins", "plugins instructions")
    } else if text.contains("Apps (Connectors)") || text.contains("<apps_instructions>") {
        ("apps", "apps instructions")
    } else if text.contains("memory") || text.contains("Memory") {
        ("memory", "memory instructions")
    } else if role_or_type == Some("developer") {
        ("initial_context", "developer context")
    } else if role_or_type == Some("user") {
        ("conversation_history", "user/context input")
    } else {
        ("conversation_history", "conversation item")
    }
}

fn components_for_tools(tools: Option<&Value>) -> Vec<PromptComponent> {
    let Some(tools) = tools.and_then(Value::as_array) else {
        return Vec::new();
    };
    tools
        .iter()
        .enumerate()
        .map(|(index, tool)| {
            let text = serde_json::to_string(tool).unwrap_or_default();
            let tool_name = tool_name(tool);
            let mut component = text_component(
                "built_tools",
                tool_name.as_deref().unwrap_or("model-visible tool"),
                &text,
                json!({
                    "tool_index": index,
                }),
            );
            component.target = PromptTarget::tool(format!("/tools/{index}"), tool_name);
            component
        })
        .collect()
}

fn tool_name(tool: &Value) -> Option<String> {
    tool.get("name")
        .and_then(Value::as_str)
        .or_else(|| {
            tool.get("function")
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
        })
        .or_else(|| tool.get("type").and_then(Value::as_str))
        .map(ToString::to_string)
}

fn components_for_request_settings(request: &Value, transport: &str) -> Vec<PromptComponent> {
    [
        "tool_choice",
        "parallel_tool_calls",
        "reasoning",
        "store",
        "stream",
        "include",
        "service_tier",
        "prompt_cache_key",
        "text",
        "client_metadata",
        "previous_response_id",
        "generate",
    ]
    .into_iter()
    .filter_map(|field| {
        let value = request.get(field)?;
        let text = serde_json::to_string(value).unwrap_or_default();
        let mut component = text_component(
            "build_responses_request",
            field,
            &text,
            json!({
                "transport": transport,
            }),
        );
        component.target = PromptTarget::request_pointer(format!("/{field}"));
        Some(component)
    })
    .collect()
}

pub(crate) fn content_hash(text: &str) -> String {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    let mut hash = FNV_OFFSET;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("fnv1a64:{hash:016x}")
}

fn preview(text: &str) -> String {
    let mut chars = text.chars();
    let preview = chars.by_ref().take(PREVIEW_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{preview}...")
    } else {
        preview
    }
}

#[cfg(test)]
mod tests {
    use codex_protocol::models::ContentItem;
    use codex_protocol::protocol::ContextWindowCategory;
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    #[test]
    fn retargets_registered_component_to_input_text_pointer() {
        let component = text_component(
            "agents_md",
            "project instructions",
            "follow local rules",
            json!({ "path": "AGENTS.md" }),
        );
        let input = vec![ResponseItem::Message {
            id: None,
            role: "user".to_string(),
            content: vec![ContentItem::InputText {
                text: "follow local rules".to_string(),
            }],
            end_turn: None,
            phase: None,
        }];

        let components = retarget_components_for_prompt_input(&input, &[component]);

        assert_eq!(components.len(), 1);
        assert_eq!(components[0].source, "agents_md");
        assert_eq!(
            components[0].target.request_json_pointer,
            "/input/0/content/0/text"
        );
        assert_eq!(components[0].target.input_index, Some(0));
        assert_eq!(components[0].target.content_index, Some(0));
    }

    #[test]
    fn builds_context_window_breakdown_from_final_request_pointers() {
        let prompt = Prompt {
            base_instructions: codex_protocol::models::BaseInstructions {
                text: "base instructions".to_string(),
            },
            trace_components: vec![text_component(
                "memory",
                "memory instructions",
                "remember this",
                json!({ "kind": "memory" }),
            )],
            ..Prompt::default()
        };
        let model_info = serde_json::from_value(json!({
            "slug": "gpt-test",
            "display_name": "gpt-test",
            "description": "desc",
            "default_reasoning_level": "medium",
            "supported_reasoning_levels": [
                {"effort": "medium", "description": "medium"}
            ],
            "shell_type": "shell_command",
            "visibility": "list",
            "supported_in_api": true,
            "priority": 1,
            "upgrade": null,
            "base_instructions": "base instructions",
            "model_messages": null,
            "supports_reasoning_summaries": false,
            "support_verbosity": false,
            "default_verbosity": null,
            "apply_patch_tool_type": null,
            "truncation_policy": {"mode": "bytes", "limit": 10000},
            "supports_parallel_tool_calls": false,
            "supports_image_detail_original": false,
            "context_window": 128000,
            "auto_compact_token_limit": null,
            "experimental_supported_tools": []
        }))
        .expect("deserialize test model info");
        let request = json!({
            "model": "gpt-test",
            "instructions": "base instructions",
            "input": [{
                "role": "developer",
                "content": [{
                    "type": "input_text",
                    "text": "remember this"
                }]
            }, {
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "hello"
                }]
            }],
            "tools": [{
                "type": "function",
                "name": "shell",
                "description": "run commands"
            }],
            "previous_response_id": "resp_123"
        });

        let trace =
            build_prompt_assembly_trace(&request, &prompt, &model_info, "turn-1", "responses_http");
        let breakdown =
            build_context_window_breakdown(&request, &trace, Some(128_000), Some(1_000));
        let base_mapping = trace
            .mappings
            .iter()
            .find(|mapping| mapping.target.request_json_pointer == "/instructions")
            .expect("base instructions mapping");
        assert_eq!(base_mapping.confidence, PromptMappingConfidence::ExactRange);
        assert_eq!(
            base_mapping.text_range,
            Some(PromptTextRange {
                start_byte: 0,
                end_byte: "base instructions".len(),
                start_char: 0,
                end_char: "base instructions".chars().count(),
            })
        );
        let tool_mapping = trace
            .mappings
            .iter()
            .find(|mapping| mapping.target.request_json_pointer == "/tools/0")
            .expect("tool mapping");
        assert_eq!(tool_mapping.confidence, PromptMappingConfidence::ExactValue);
        assert_eq!(tool_mapping.text_range, None);

        assert_eq!(breakdown.model_context_window, Some(128_000));
        assert_eq!(breakdown.reported_input_tokens, Some(1_000));
        assert!(breakdown.estimated_total_tokens > 0);
        assert!(breakdown.components.iter().any(|component| {
            component.category == ContextWindowCategory::ProjectUserContext
                && component.target.request_json_pointer == "/input/0/content/0/text"
                && component.target.text_range
                    == Some(ContextWindowTextRange {
                        start_byte: 0,
                        end_byte: "remember this".len(),
                        start_char: 0,
                        end_char: "remember this".chars().count(),
                    })
                && component.mapping_confidence == Some(ContextWindowMappingConfidence::ExactRange)
                && component.assembly_step_ids.len() == 1
                && component.value == json!("remember this")
        }));
        assert!(breakdown.segments.iter().any(|segment| {
            segment.category == ContextWindowCategory::ToolSchemas
                && segment.estimated_tokens > 0
                && segment.percent_of_reported_input.is_some()
        }));
    }

    #[test]
    fn classifies_unregistered_input_mapping_as_fallback() {
        let prompt = Prompt {
            base_instructions: codex_protocol::models::BaseInstructions {
                text: "base".to_string(),
            },
            ..Prompt::default()
        };
        let model_info = serde_json::from_value(json!({
            "slug": "gpt-test",
            "display_name": "gpt-test",
            "description": "desc",
            "default_reasoning_level": "medium",
            "supported_reasoning_levels": [
                {"effort": "medium", "description": "medium"}
            ],
            "shell_type": "shell_command",
            "visibility": "list",
            "supported_in_api": true,
            "priority": 1,
            "upgrade": null,
            "base_instructions": "base",
            "model_messages": null,
            "supports_reasoning_summaries": false,
            "support_verbosity": false,
            "default_verbosity": null,
            "apply_patch_tool_type": null,
            "truncation_policy": {"mode": "bytes", "limit": 10000},
            "supports_parallel_tool_calls": false,
            "supports_image_detail_original": false,
            "context_window": 128000,
            "auto_compact_token_limit": null,
            "experimental_supported_tools": []
        }))
        .expect("deserialize test model info");
        let request = json!({
            "model": "gpt-test",
            "instructions": "base",
            "input": [{
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "hello from history"
                }]
            }]
        });

        let trace =
            build_prompt_assembly_trace(&request, &prompt, &model_info, "turn-1", "responses_http");
        let mapping = trace
            .mappings
            .iter()
            .find(|mapping| mapping.target.request_json_pointer == "/input/0/content/0/text")
            .expect("fallback mapping");

        assert_eq!(
            mapping.confidence,
            PromptMappingConfidence::ClassifiedFallback
        );
        assert_eq!(
            mapping.text_range,
            Some(PromptTextRange {
                start_byte: 0,
                end_byte: "hello from history".len(),
                start_char: 0,
                end_char: "hello from history".chars().count(),
            })
        );
    }

    #[test]
    fn prompt_assembly_trace_deserializes_without_mapping_fields() {
        let trace: PromptAssemblyTrace = serde_json::from_value(json!({
            "inference_call_id": "inference-1",
            "codex_turn_id": "turn-1",
            "model_info": {"slug": "gpt-test"},
            "base_instructions": "base",
            "components": [],
            "final_request_payload_id": "raw_payload:1"
        }))
        .expect("legacy prompt assembly trace should deserialize");

        assert_eq!(trace.assembly_steps, Vec::<PromptAssemblyStep>::new());
        assert_eq!(trace.mappings, Vec::<PromptAssemblyMapping>::new());
    }

    #[test]
    fn missing_context_window_pointer_uses_zero_cost_null_component() {
        let trace = PromptAssemblyTrace {
            inference_call_id: "inference-1".to_string(),
            codex_turn_id: "turn-1".to_string(),
            model_info: json!({ "slug": "gpt-test" }),
            base_instructions: String::new(),
            components: vec![PromptComponent {
                id: "missing".to_string(),
                source: "conversation_history".to_string(),
                label: "missing item".to_string(),
                target: PromptTarget::request_pointer("/input/99"),
                content_hash: "hash".to_string(),
                preview: String::new(),
                metadata: json!({}),
            }],
            assembly_steps: Vec::new(),
            mappings: Vec::new(),
            final_request_payload_id: "raw_payload:1".to_string(),
        };

        let breakdown = build_context_window_breakdown(&json!({ "input": [] }), &trace, None, None);

        assert_eq!(breakdown.estimated_total_tokens, 0);
        assert_eq!(breakdown.components[0].estimated_bytes, 0);
        assert_eq!(breakdown.components[0].value, serde_json::Value::Null);
    }
}
