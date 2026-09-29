use super::*;
use crate::bbs_sync::relay::discovery::Page;
use serde_json::json;

pub(super) fn ready_snapshot(
    r: &Rig,
    at: u64,
    wake: &str,
    local_ready: bool,
    remote_ready: bool,
) -> Snapshot {
    let peer = r.actor.initial.peer(&r.peer).unwrap();
    let local = r.actor.own();
    let bytes = serde_json::to_vec(&json!({
        "boot": "rendezvous-boot-0001",
        "items": [{
            "device": r.peer,
            "announcement": {
                "device": r.peer, "membership": peer.remote_membership_id,
                "requestId": "rendezvous-announcement-0001", "fingerprint": "f".repeat(64),
                "instance": "rendezvous-remote-0001", "revision": "a".repeat(64), "peerVersion": 4
            },
            "currentWake": wake,
            "wake": {
                "id": wake, "group": peer.group_id, "client": local, "server": r.peer,
                "clientMembership": peer.local_membership_id,
                "serverMembership": peer.remote_membership_id,
                "clientInstance": r.actor.instance, "serverInstance": "rendezvous-remote-0001",
                "createdAt": at, "expiresAt": at + 120_000
            },
            "handshake": {
                "ready": {"client": local_ready, "server": remote_ready},
                "client": null, "server": null, "session": null, "closed": false
            }
        }], "next": null
    }))
    .unwrap();
    let page = Page::decode(&bytes, &peer.group_id, &local, None).unwrap();
    Snapshot {
        boot: page.boot,
        items: page
            .items
            .into_iter()
            .map(|item| (item.device.clone(), item))
            .collect(),
    }
}

async fn fixed_phase_ready(phase_seconds: u64) {
    let mut r = Rig::new().await;
    // Seed the real failure path at its cap. Only the phase of the next allowed
    // active attempt is injected; no product timeout or retry interval changes.
    for _ in 0..7 {
        r.actor.fail(&r.peer, Error::Timeout);
    }
    let at = now();
    r.actor.schedule.peers.get_mut(&r.peer).unwrap().retry_at = at + phase_seconds * 1000;
    let snapshot = ready_snapshot(&r, at, &"b".repeat(64), false, true);
    r.actor.adopt_snapshot(snapshot);
    // The other endpoint is in its 60-second window. At our normal discovery
    // opportunity it is ready, even though our own active retry is still gated.
    let discovered_at = at + 30_000;
    assert!(r.actor.candidates(discovered_at).contains(&r.peer),
        "phase={phase_seconds}s: remote Ready must allow bounded passive admission before active retry");
    assert_eq!(
        r.actor.schedule.peers[&r.peer].retry_at,
        at + phase_seconds * 1000,
        "discovery must not erase active backoff"
    );
    assert!(
        r.actor.verification.contains(&r.peer),
        "Ready is not completed sync"
    );
}

#[tokio::test]
async fn fixed_phase_060_seconds_accepts_remote_ready() {
    fixed_phase_ready(60).await;
}

#[tokio::test]
async fn fixed_phase_120_seconds_accepts_remote_ready() {
    fixed_phase_ready(120).await;
}

#[tokio::test]
async fn fixed_phase_180_seconds_accepts_remote_ready() {
    fixed_phase_ready(180).await;
}

#[tokio::test]
async fn fixed_phase_300_seconds_accepts_remote_ready() {
    fixed_phase_ready(300).await;
}

#[tokio::test]
async fn exchange_timeout_does_not_stop_due_discovery() {
    let mut r = Rig::new().await;
    for _ in 0..7 {
        r.actor.service_error(ServiceTask::Exchange, Error::Timeout);
    }
    assert!(r.actor.service_retry() >= now() + 299_000);
    r.actor.needs_refresh = false;
    r.actor.poll_at = now();
    r.actor.tick().unwrap();
    assert!(
        r.actor.meta.is_some(),
        "a due read must not be blocked by Exchange's 300-second timeout backoff"
    );
    // The future is not polled: this regression performs no DNS/HTTP.
}
