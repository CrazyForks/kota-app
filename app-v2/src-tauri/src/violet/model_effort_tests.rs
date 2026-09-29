use super::*;

fn records(shell: &str) -> Vec<JsonValue> {
    let fixture: JsonValue =
        serde_json::from_str(include_str!("fixtures/model-effort-native.json")).unwrap();
    fixture[shell].as_array().unwrap().clone()
}

fn setup(shell: &str) -> (PathBuf, ProjectAgent, NativeSource) {
    let root = std::env::temp_dir().join(format!("fable-caption-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let agent = ProjectAgent {
        agent_id: "agent-fable-caption".into(),
        shell: shell.into(),
        cwd: root.clone(),
        session_id: None,
    };
    let source = NativeSource {
        kind: format!("{shell}-jsonl"),
        session_id: "session-fable-caption".into(),
        path: root.join("native.jsonl"),
        aux_path: None,
    };
    (root, agent, source)
}

fn jsonl(records: &[JsonValue]) -> String {
    records.iter().map(|record| format!("{record}\n")).collect()
}

fn assert_captions(events: &[NativeEvent], expected: &[(&str, Option<&str>, Option<&str>)]) {
    let actual = events
        .iter()
        .filter(|event| event.role == "assistant" && event.kind == "message")
        .map(|event| {
            (
                event.text.as_str(),
                event.model.as_deref(),
                event.effort.as_deref(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);
    for event in events {
        if event.role != "assistant" || event.kind != "message" {
            assert!(event.model.is_none() && event.effort.is_none());
        }
        // Follow the actual native -> history JSON -> room DTO projection.
        let message = event_to_message(event.clone());
        let history = chathistory_event_from_message(&message, None);
        let json = serde_json::to_value(&history).unwrap();
        let restored =
            message_from_chathistory_event(serde_json::from_value(json.clone()).unwrap());
        assert_eq!(restored.model, event.model);
        assert_eq!(restored.effort, event.effort);
        if event.model.is_none() {
            assert!(json.get("model").is_none());
        }
        if event.effort.is_none() {
            assert!(json.get("effort").is_none());
        }
    }
}

fn assert_jsonl_fixture(shell: &str, expected: &[(&str, Option<&str>, Option<&str>)]) {
    let (root, agent, source) = setup(shell);
    fs::write(&source.path, jsonl(&records(shell))).unwrap();
    let events = parse_source(&root, &agent, &source, &[]).unwrap();
    assert_captions(&events, expected);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn claude_fixture_uses_record_model_and_effort_not_synthetic_or_progress() {
    assert_jsonl_fixture(
        "claude",
        &[
            ("First answer.", Some("claude-fable-5-1"), Some("max")),
            ("Synthetic answer.", None, None),
            ("Model only.", Some("claude-fable-5-2"), None),
        ],
    );
}

#[test]
fn codex_fixture_uses_preceding_turn_context_and_clears_absent_effort() {
    assert_jsonl_fixture(
        "codex",
        &[
            ("First answer.", Some("gpt-fable-6"), Some("xhigh")),
            ("Model only.", Some("gpt-fable-7"), None),
        ],
    );
}

#[test]
fn kimi_fixture_keeps_request_effort_strings_verbatim() {
    assert_jsonl_fixture(
        "kimi",
        &[
            ("First answer.", Some("kimi-fable-3"), Some("high")),
            ("Max answer.", Some("kimi-fable-3"), Some("max")),
            ("On answer.", Some("kimi-fable-4"), Some("on")),
            ("Model only.", Some("kimi-fable-4"), None),
        ],
    );
}

#[test]
fn pi_fixture_uses_message_model_and_thinking_level_on_active_path_only() {
    assert_jsonl_fixture(
        "pi",
        &[
            ("First answer.", Some("pi-fable-1"), Some("xhigh")),
            ("New branch.", Some("pi-fable-2"), Some("off")),
        ],
    );
}

#[test]
fn antigravity_fixture_reads_setting_label_without_guessing_unknown_formats() {
    assert_jsonl_fixture(
        "antigravity",
        &[
            ("First answer.", Some("Gemini 3.8 Flash"), Some("High")),
            ("Same setting.", Some("Gemini 3.8 Flash"), Some("High")),
            ("Model only.", Some("Fable Model"), None),
            ("Unknown setting.", None, None),
        ],
    );
}

#[test]
fn opencode_fixture_uses_model_id_without_effort_in_both_storage_formats() {
    let (root, agent, mut source) = setup("opencode");
    let message = &records("opencode")[0];
    let part = serde_json::json!({"id":"fable-part","type":"text","text":"First answer."});
    let db_path = root.join("native.db");
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);").unwrap();
    conn.execute(
        "INSERT INTO message VALUES (?1, ?2, ?3, ?4)",
        params![
            "fable-open-final",
            source.session_id,
            1767225600000_i64,
            message.to_string()
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            "fable-part",
            source.session_id,
            "fable-open-final",
            1767225600000_i64,
            part.to_string()
        ],
    )
    .unwrap();
    drop(conn);
    source.kind = "opencode-sqlite".into();
    source.path = db_path;
    assert_captions(
        &parse_source(&root, &agent, &source, &[]).unwrap(),
        &[("First answer.", Some("gpt-fable-open"), None)],
    );
    let messages = root.join("messages");
    let parts = root.join("parts");
    fs::create_dir_all(&messages).unwrap();
    fs::create_dir_all(parts.join("fable-open-final")).unwrap();
    fs::write(messages.join("fable-open-final.json"), message.to_string()).unwrap();
    fs::write(
        parts.join("fable-open-final/fable-part.json"),
        part.to_string(),
    )
    .unwrap();
    source.kind = "opencode-message-dir".into();
    source.path = messages;
    source.aux_path = Some(parts);
    assert_captions(
        &parse_source(&root, &agent, &source, &[]).unwrap(),
        &[("First answer.", Some("gpt-fable-open"), None)],
    );
    fs::remove_dir_all(root).unwrap();
}

fn first_answer(shell: &str) -> (JsonValue, &'static str, &'static str) {
    match shell {
        "codex" => (records(shell)[3].clone(), "gpt-fable-6", "xhigh"),
        "kimi" => (records(shell)[3].clone(), "kimi-fable-3", "high"),
        "antigravity" => (records(shell)[2].clone(), "Gemini 3.8 Flash", "High"),
        _ => unreachable!(),
    }
}

#[test]
fn model_context_survives_two_incremental_passes_and_stays_source_local() {
    for shell in ["codex", "kimi", "antigravity"] {
        let (root, agent, source) = setup(shell);
        let first = jsonl(&records(shell)[..1]);
        fs::write(&source.path, &first).unwrap();
        parse_source(&root, &agent, &source, &[]).unwrap();
        let cursor_path = source_cursor_path(&root, &source_cache_key(&source)).unwrap();
        let cursor = read_source_cursor(&cursor_path).unwrap().unwrap();
        let (answer, model, effort) = first_answer(shell);
        assert_eq!(cursor.offset, first.len() as u64);
        assert_eq!(cursor.model.as_deref(), Some(model));
        assert_eq!(cursor.effort.as_deref(), Some(effort));
        // Independent calls must read the cursor, not rely on in-memory state.
        OpenOptions::new()
            .append(true)
            .open(&source.path)
            .unwrap()
            .write_all(jsonl(&[answer.clone()]).as_bytes())
            .unwrap();
        let events = parse_source(&root, &agent, &source, &[]).unwrap();
        assert_captions(&events, &[("First answer.", Some(model), Some(effort))]);
        let mut other = source.clone();
        other.path = root.join("other.jsonl");
        other.session_id = "session-fable-other".into();
        fs::write(&other.path, jsonl(&[answer])).unwrap();
        assert_captions(
            &parse_source(&root, &agent, &other, &[]).unwrap(),
            &[("First answer.", None, None)],
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn source_truncation_resets_caption_with_offset() {
    for shell in ["codex", "kimi", "antigravity"] {
        let (root, agent, source) = setup(shell);
        fs::write(&source.path, jsonl(&records(shell))).unwrap();
        parse_source(&root, &agent, &source, &[]).unwrap();
        // Re-seed known values at the end so every provider tests a nonempty state.
        OpenOptions::new()
            .append(true)
            .open(&source.path)
            .unwrap()
            .write_all(jsonl(&records(shell)[..1]).as_bytes())
            .unwrap();
        parse_source(&root, &agent, &source, &[]).unwrap();
        let (answer, _, _) = first_answer(shell);
        fs::write(&source.path, jsonl(&[answer])).unwrap();
        assert_captions(
            &parse_source(&root, &agent, &source, &[]).unwrap(),
            &[("First answer.", None, None)],
        );
        let cursor =
            read_source_cursor(&source_cursor_path(&root, &source_cache_key(&source)).unwrap())
                .unwrap()
                .unwrap();
        assert!(cursor.model.is_none() && cursor.effort.is_none());
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn old_cursor_and_frozen_history_are_not_backfilled() {
    assert_eq!(PARSED_EVENT_CACHE_VERSION, "8");
    let (root, agent, source) = setup("codex");
    let data = records("codex");
    let old_bytes = jsonl(&data[..1]);
    fs::write(&source.path, &old_bytes).unwrap();
    let key = source_cache_key(&source);
    let cursor_path = source_cursor_path(&root, &key).unwrap();
    fs::write(&cursor_path, serde_json::json!({
        "path":path_string(&source.path), "offset":old_bytes.len(), "line_index":1, "updated_at":now_iso()
    }).to_string()).unwrap();
    let old = event(
        &agent,
        &source,
        "assistant",
        "message",
        "2025-12-31T00:00:00Z",
        "fable-old",
        "Frozen answer.".into(),
    );
    write_cached_native_events(
        &parsed_event_cache_path(&root, &key).unwrap(),
        &[old.clone()],
    )
    .unwrap();
    OpenOptions::new()
        .append(true)
        .open(&source.path)
        .unwrap()
        .write_all(jsonl(&[data[3].clone()]).as_bytes())
        .unwrap();
    let events = parse_source(&root, &agent, &source, &[]).unwrap();
    assert_captions(
        &events,
        &[
            ("Frozen answer.", None, None),
            ("First answer.", None, None),
        ],
    );
    assert_eq!(
        serde_json::to_value(&events[0]).unwrap(),
        serde_json::to_value(&old).unwrap()
    );
    fs::remove_dir_all(root).unwrap();
}
