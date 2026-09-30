use super::*;

struct Rollout {
    root: PathBuf,
    agent: ProjectAgent,
    source: NativeSource,
}

impl Rollout {
    fn new(records: &[JsonValue]) -> Self {
        let root = std::env::temp_dir().join(format!("fable-sandbox-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let agent = ProjectAgent {
            agent_id: "agent-fable-sandbox".into(),
            shell: "codex".into(),
            cwd: root.clone(),
            session_id: None,
        };
        let source = NativeSource {
            kind: "codex-jsonl".into(),
            session_id: "session-fable-sandbox".into(),
            path: root.join("native.jsonl"),
            aux_path: None,
        };
        fs::write(&source.path, jsonl(records)).unwrap();
        Self {
            root,
            agent,
            source,
        }
    }

    fn append(&self, records: &[JsonValue]) {
        OpenOptions::new()
            .append(true)
            .open(&self.source.path)
            .unwrap()
            .write_all(jsonl(records).as_bytes())
            .unwrap();
    }

    fn parse(&self) -> Vec<NativeEvent> {
        parse_source(&self.root, &self.agent, &self.source, &[]).unwrap()
    }

    fn cursor_path(&self) -> PathBuf {
        source_cursor_path(&self.root, &source_cache_key(&self.source)).unwrap()
    }

    fn cursor(&self) -> SourceCursor {
        read_source_cursor(&self.cursor_path()).unwrap().unwrap()
    }
}

impl Drop for Rollout {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn jsonl(records: &[JsonValue]) -> String {
    records.iter().map(|record| format!("{record}\n")).collect()
}

fn context(second: u8, policy: Option<&str>) -> JsonValue {
    let mut record = serde_json::json!({
        "type": "turn_context",
        "timestamp": format!("2026-01-01T00:00:{second:02}.123Z"),
        "payload": {
            "turn_id": format!("turn-fable-{second}"),
            "model": "gpt-fable",
            "effort": "high",
            "permission_profile": { "type": "managed" }
        }
    });
    if let Some(policy) = policy {
        record["payload"]["sandbox_policy"] = serde_json::json!({ "type": policy });
    }
    record
}

#[test]
fn sandbox_downgrade_survives_incremental_reads_and_does_not_repeat() {
    let rollout = Rollout::new(&[context(0, Some("danger-full-access"))]);
    assert!(rollout.parse().is_empty());
    assert_eq!(
        rollout.cursor().codex_sandbox_policy.as_deref(),
        Some("danger-full-access")
    );

    rollout.append(&[context(1, Some("workspace-write"))]);
    let events = rollout.parse();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].actor_intent.as_deref(), Some("sandbox-downgrade"));
    assert_eq!(
        events[0].native_event_id.as_deref(),
        Some("sandbox-downgrade:session-fable-sandbox:turn-fable-1")
    );
    assert_eq!(
        rollout.cursor().codex_sandbox_policy.as_deref(),
        Some("workspace-write")
    );
    assert_eq!(
        serde_json::to_value(rollout.parse()).unwrap(),
        serde_json::to_value(&events).unwrap()
    );

    rollout.append(&[
        context(2, Some("workspace-write")),
        context(3, Some("workspace-write")),
    ]);
    assert_eq!(
        serde_json::to_value(rollout.parse()).unwrap(),
        serde_json::to_value(events).unwrap()
    );
}

#[test]
fn sandbox_downgrade_initial_scan_only_establishes_baseline() {
    for records in [
        vec![context(1, Some("workspace-write"))],
        vec![
            context(0, Some("danger-full-access")),
            context(1, Some("workspace-write")),
        ],
    ] {
        let rollout = Rollout::new(&records);
        assert!(rollout.parse().is_empty());
        assert_eq!(
            rollout.cursor().codex_sandbox_policy.as_deref(),
            Some("workspace-write")
        );
        rollout.append(&[context(2, Some("workspace-write"))]);
        assert!(rollout.parse().is_empty());
        // Later transitions in a single incremental batch still count.
        rollout.append(&[
            context(3, Some("danger-full-access")),
            context(4, Some("workspace-write")),
        ]);
        assert_eq!(rollout.parse().len(), 1);
    }
}

#[test]
fn sandbox_downgrade_requires_consecutive_explicit_policies() {
    for policy in [
        None,
        Some("managed"),
        Some("read-only"),
        Some("future-policy"),
    ] {
        let rollout = Rollout::new(&[context(0, Some("danger-full-access"))]);
        assert!(rollout.parse().is_empty());
        rollout.append(&[context(1, policy)]);
        assert!(rollout.parse().is_empty());
        assert_eq!(rollout.cursor().codex_sandbox_policy.as_deref(), policy);
        rollout.append(&[context(2, Some("workspace-write"))]);
        assert!(rollout.parse().is_empty());
    }

    // Neither managed nor disabled supplies a missing sandbox_policy.
    for profile in ["managed", "disabled"] {
        let mut first = context(0, None);
        first["payload"]["permission_profile"]["type"] = profile.into();
        let rollout = Rollout::new(&[first]);
        assert!(rollout.parse().is_empty());
        rollout.append(&[context(1, Some("workspace-write"))]);
        assert!(rollout.parse().is_empty());
    }
}

#[test]
fn sandbox_downgrade_two_transitions_in_one_time_bucket_keep_distinct_ids() {
    let rollout = Rollout::new(&[context(0, Some("danger-full-access"))]);
    assert!(rollout.parse().is_empty());
    rollout.append(&[
        context(1, Some("workspace-write")),
        context(2, Some("danger-full-access")),
        context(3, Some("workspace-write")),
    ]);
    let mut events = rollout.parse();
    assert_eq!(events.len(), 2);
    assert_ne!(events[0].native_event_id, events[1].native_event_id);
    events.push(events[0].clone());
    assert_eq!(dedupe_native_events(events.clone()).len(), 2);
    let messages = events.into_iter().map(event_to_message).collect();
    let messages = dedupe_room_messages(messages);
    assert_eq!(messages.len(), 2);
    assert_eq!(
        messages[0].id,
        "sandbox-downgrade:session-fable-sandbox:turn-fable-1"
    );
    assert_eq!(
        messages[1].id,
        "sandbox-downgrade:session-fable-sandbox:turn-fable-3"
    );
}

#[test]
fn sandbox_downgrade_is_source_local_and_resets_after_truncation() {
    let rollout = Rollout::new(&[
        context(0, Some("danger-full-access")),
        context(1, Some("danger-full-access")),
        context(2, Some("danger-full-access")),
    ]);
    assert!(rollout.parse().is_empty());
    for same_session in [true, false] {
        let mut other = rollout.source.clone();
        other.path = rollout.root.join(format!("other-{same_session}.jsonl"));
        if !same_session {
            other.session_id = "session-fable-other".into();
        }
        fs::write(&other.path, jsonl(&[context(3, Some("workspace-write"))])).unwrap();
        assert!(parse_source(&rollout.root, &rollout.agent, &other, &[])
            .unwrap()
            .is_empty());
    }
    assert_eq!(
        rollout.cursor().codex_sandbox_policy.as_deref(),
        Some("danger-full-access")
    );

    fs::write(
        &rollout.source.path,
        jsonl(&[
            context(3, Some("danger-full-access")),
            context(4, Some("workspace-write")),
        ]),
    )
    .unwrap();
    assert!(fs::metadata(&rollout.source.path).unwrap().len() < rollout.cursor().offset);
    assert!(rollout.parse().is_empty());
    assert_eq!(
        rollout.cursor().codex_sandbox_policy.as_deref(),
        Some("workspace-write")
    );
    rollout.append(&[
        context(5, Some("danger-full-access")),
        context(6, Some("workspace-write")),
    ]);
    assert_eq!(rollout.parse().len(), 1);
}

#[test]
fn sandbox_downgrade_old_cursor_and_cached_events_are_not_backfilled() {
    assert_eq!(PARSED_EVENT_CACHE_VERSION, "8");
    let rollout = Rollout::new(&[context(0, Some("danger-full-access"))]);
    assert!(rollout.parse().is_empty());
    let mut cursor = serde_json::to_value(rollout.cursor()).unwrap();
    cursor
        .as_object_mut()
        .unwrap()
        .remove("codex_sandbox_policy");
    fs::write(rollout.cursor_path(), cursor.to_string()).unwrap();

    let old = event(
        &rollout.agent,
        &rollout.source,
        "assistant",
        "message",
        "2026-01-01T00:00:00Z",
        "fable-frozen",
        "Frozen answer.".into(),
    );
    let old_json = serde_json::to_value(&old).unwrap();
    assert!(old_json.get("actor_intent").is_none());
    write_cached_native_events(
        &parsed_event_cache_path(&rollout.root, &source_cache_key(&rollout.source)).unwrap(),
        &[old],
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(rollout.parse()).unwrap(),
        serde_json::json!([old_json.clone()])
    );
    assert!(rollout.cursor().codex_sandbox_policy.is_none());
    rollout.append(&[context(1, Some("workspace-write"))]);
    assert_eq!(
        serde_json::to_value(rollout.parse()).unwrap(),
        serde_json::json!([old_json])
    );
}

#[test]
fn sandbox_downgrade_timestamp_fallback_survives_cursor_replay() {
    let rollout = Rollout::new(&[context(0, Some("danger-full-access"))]);
    assert!(rollout.parse().is_empty());
    let mut previous_cursor = rollout.cursor();
    let mut next = context(1, Some("workspace-write"));
    next["payload"].as_object_mut().unwrap().remove("turn_id");
    rollout.append(&[next]);
    let events = rollout.parse();
    assert_eq!(events.len(), 1);
    let message = event_to_message(events[0].clone());
    assert!(message
        .id
        .starts_with("sandbox-downgrade:session-fable-sandbox:"));
    assert_eq!(message.timestamp, "2026-01-01T00:00:01.123Z");

    // Simulate a cache write succeeding before its cursor write, with a
    // different line counter on retry. Identity must not depend on that index.
    previous_cursor.line_index += 100;
    write_source_cursor(&rollout.cursor_path(), &previous_cursor).unwrap();
    let replayed = rollout.parse();
    assert_eq!(replayed.len(), 1);
    assert_eq!(event_to_message(replayed[0].clone()).id, message.id);
}

#[test]
fn sandbox_downgrade_does_not_invent_missing_or_invalid_timestamps() {
    for timestamp in [JsonValue::Null, JsonValue::String("not-a-time".into())] {
        let rollout = Rollout::new(&[context(0, Some("danger-full-access"))]);
        assert!(rollout.parse().is_empty());
        let mut next = context(1, Some("workspace-write"));
        next["timestamp"] = timestamp;
        rollout.append(&[next]);
        assert!(rollout.parse().is_empty());
        assert_eq!(
            rollout.cursor().codex_sandbox_policy.as_deref(),
            Some("workspace-write")
        );
        rollout.append(&[context(2, Some("workspace-write"))]);
        assert!(rollout.parse().is_empty());
    }
}

#[test]
fn sandbox_downgrade_contract_reaches_persisted_chathistory() {
    let rollout = Rollout::new(&[context(0, Some("danger-full-access"))]);
    assert!(rollout.parse().is_empty());
    rollout.append(&[context(1, Some("workspace-write"))]);
    let (room, _) = split_for_violet_outputs(rollout.parse(), &rollout.root);
    let messages = room.into_iter().map(event_to_message).collect::<Vec<_>>();
    write_chathistory_messages(&rollout.root, &messages).unwrap();
    write_chathistory_messages(&rollout.root, &messages).unwrap();
    let history = read_chathistory_event_file(
        &chathistory_events_dir(&rollout.root).join("2026-01-01.jsonl"),
    )
    .unwrap();
    assert_eq!(history.len(), 1);
    let notice = &history[0];
    assert_eq!(
        notice.id,
        "sandbox-downgrade:session-fable-sandbox:turn-fable-1"
    );
    assert_eq!(notice.role, "system");
    assert_eq!(notice.kind, "message");
    assert!(notice.display);
    assert_eq!(notice.shell, "codex");
    assert_eq!(notice.agent_id, "agent-fable-sandbox");
    assert_eq!(notice.actor_intent.as_deref(), Some("sandbox-downgrade"));
    assert_eq!(
        notice.text,
        "Codex session lost room access after a Codex update — refresh session to restore."
    );
    assert_eq!(notice.ts, "2026-01-01T00:00:01.123Z");
    assert_eq!(notice.source.session_id, "session-fable-sandbox");
    assert_eq!(
        notice.source.native_event_id.as_deref(),
        Some(notice.id.as_str())
    );
    let restored = message_from_chathistory_event(history.into_iter().next().unwrap());
    assert_eq!(restored.actor_intent, messages[0].actor_intent);
    assert_eq!(restored.id, messages[0].id);
}

#[test]
fn sandbox_downgrade_observation_is_codex_only() {
    for shell in ["claude", "kimi", "opencode", "pi", "antigravity"] {
        let mut model = MessageModel::default();
        assert!(!model.observe_jsonl(shell, &context(0, Some("danger-full-access"))));
        assert!(!model.observe_jsonl(shell, &context(1, Some("workspace-write"))));
        assert!(model.codex_sandbox_policy.is_none());
    }
}
