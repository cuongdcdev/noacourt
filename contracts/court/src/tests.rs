#![allow(unused_must_use)]

use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use std::panic::{catch_unwind, AssertUnwindSafe};

const COURT: &str = "court.test";
const OWNER: &str = "owner.test";
const CREATOR: &str = "creator.test";
const OTHER: &str = "other.test";
const NOA: &str = "noa.test";
const OUTLAYER: &str = "outlayer.test";
const T: u64 = 1_794_564_000_000_000_000;
const SECOND: u64 = 1_000_000_000;

fn account(value: &str) -> AccountId {
    value.parse().unwrap()
}

fn context(caller: &str, now: u64, deposit: u128) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(account(COURT))
        .predecessor_account_id(account(caller))
        .signer_account_id(account(caller))
        .block_timestamp(now)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(20))
        .prepaid_gas(Gas::from_tgas(300));
    builder
}

fn set(caller: &str, now: u64, deposit: u128) {
    testing_env!(context(caller, now, deposit).build());
}

fn result(now: u64, result: PromiseResult) {
    testing_env!(
        context(COURT, now, 0).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn court() -> Court {
    set(OWNER, T - 100 * SECOND, 0);
    Court::init(
        account(OWNER),
        account(NOA),
        account(OUTLAYER),
        json!({"Project":{"project_id":"owner.test/name","version_key":null}}),
        None,
        account(OWNER),
        U128(NEAR / 10),
        3,
    )
}

fn spec(unavailable: &str) -> String {
    json!({"version":1,"outcomes":["Yes","No"],
        "observation":{"at":"2026-11-13T10:00:00Z"},
        "on_unavailable":unavailable,"retry":{"max_attempts":3,"every":"30s"}})
    .to_string()
}

fn register(court: &mut Court, unavailable: &str) -> String {
    set(CREATOR, T - 100 * SECOND, NEAR);
    court.register_spec(spec(unavailable))
}

fn market(hash: &str) -> Value {
    json!({"id":7,"creator":CREATOR,"title":"Test","metadata_hash":format!("noacourt:{hash}"),
        "outcomes":[{"id":0,"name":"Yes"},{"id":1,"name":"No"}],
        "expiration_time":T - SECOND,"resolution_deadline":T + 200 * SECOND,
        "resolver":COURT,"status":"Active","winning_outcome":null})
}

fn link(court: &mut Court, hash: &str, value: Value) -> bool {
    set(OTHER, T - 50 * SECOND, 0);
    court.link_market(7, None);
    result(
        T - 50 * SECOND,
        PromiseResult::Successful(value.to_string().into_bytes()),
    );
    let linked = court.on_market_info(7, account(OTHER), None);
    if linked {
        assert_eq!(court.get_market(7).unwrap().spec_hash, hash);
    }
    linked
}

fn verdict(hash: &str, status: &str) -> Value {
    json!({"v":1,"resolver_version":"0.1.0","spec_hash":hash,"mode":"resolve",
        "status":status,"outcome":"Yes","outcome_index":0,
        "retry_after":"2026-11-13T10:00:40Z","reason":"test","sources":[],"jurors":null})
}

fn resolve_result(court: &mut Court, value: Value, now: u64) {
    let item = court.get_market(7).unwrap();
    result(
        now,
        PromiseResult::Successful(value.to_string().into_bytes()),
    );
    court.on_verdict(item.id, item.pending_seq);
}

fn panics(f: impl FnOnce()) -> bool {
    catch_unwind(AssertUnwindSafe(f)).is_err()
}

fn function_calls() -> Vec<(String, String, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|receipt| {
            let receiver = receipt.receiver_id.to_string();
            receipt
                .actions
                .into_iter()
                .filter_map(move |action| match action {
                    MockAction::FunctionCallWeight {
                        method_name,
                        attached_deposit,
                        ..
                    } => Some((
                        receiver.clone(),
                        String::from_utf8(method_name).unwrap(),
                        attached_deposit.as_yoctonear(),
                    )),
                    _ => None,
                })
        })
        .collect()
}

#[test]
fn date_and_duration_parsers() {
    assert_eq!(parse_rfc3339("2026-11-13T10:00:00Z"), Some(T));
    assert_eq!(
        parse_rfc3339("2026-11-13T10:00:00.123+00:00"),
        Some(T + 123_000_000)
    );
    assert_eq!(
        parse_rfc3339("2024-02-29T00:00:00Z"),
        Some(1_709_164_800_000_000_000)
    );
    for value in [
        "2026-02-29T00:00:00Z",
        "2026-11-13T25:00:00Z",
        "2026-11-13T10:00:00+01:00",
        "2026-11-13T10:00:00.1234567890Z",
    ] {
        assert_eq!(parse_rfc3339(value), None);
    }
    assert_eq!(parse_duration("30s"), Some(30 * SECOND));
    assert_eq!(parse_duration("5m"), Some(300 * SECOND));
    assert_eq!(parse_duration("2h"), Some(7200 * SECOND));
    assert_eq!(parse_duration("1d"), Some(86400 * SECOND));
    assert_eq!(parse_duration("1w"), None);
}

#[test]
fn deposit_credit_hash_and_refund() {
    let mut court = court();
    let raw = spec("void");
    set(CREATOR, T - 100 * SECOND, NEAR / 20);
    assert!(panics(|| {
        court.register_spec(raw.clone());
    }));
    let hash = spec_hash(&raw);
    assert!(court.get_spec(hash.clone()).is_none());
    set(CREATOR, T - 100 * SECOND, NEAR);
    let before = env::storage_usage();
    assert_eq!(court.register_spec(raw.clone()), hash);
    let storage_bytes = env::storage_usage() - before;
    let expected_refund =
        NEAR - NEAR / 20 - storage_bytes as u128 * env::storage_byte_cost().as_yoctonear();
    assert!(get_created_receipts().iter().any(|receipt| receipt.receiver_id == account(CREATOR) && receipt.actions.iter().any(|action| matches!(action, MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == expected_refund))));
    assert_eq!(court.get_spec(hash.clone()).unwrap().credits, 1);
    assert_eq!(court.get_credits(hash.clone(), account(CREATOR)), 1);
    assert_eq!(court.get_credits(hash.clone(), account(OTHER)), 0);
    set(CREATOR, T - 100 * SECOND, NEAR);
    court.register_spec(raw);
    assert_eq!(court.get_spec(hash.clone()).unwrap().credits, 2);
    assert_eq!(court.get_credits(hash, account(CREATOR)), 2);
}

#[test]
fn credit_prefix_and_market_creator_ownership() {
    assert_eq!(near_sdk::borsh::to_vec(&Key::Verdicts).unwrap(), vec![2]);
    assert_eq!(near_sdk::borsh::to_vec(&Key::Credits).unwrap(), vec![3]);

    let mut court = court();
    let hash = register(&mut court, "void");
    let mut attacker_market = market(&hash);
    attacker_market["creator"] = json!(OTHER);
    assert!(!link(&mut court, &hash, attacker_market));
    assert!(get_logs()
        .iter()
        .any(|line| line.contains("creator has no credit for spec")));
    assert!(court.get_market(7).is_none());
    assert_eq!(court.get_credits(hash.clone(), account(CREATOR)), 1);
    assert_eq!(court.get_credits(hash.clone(), account(OTHER)), 0);
    assert_eq!(court.get_spec(hash.clone()).unwrap().credits, 1);

    assert!(link(&mut court, &hash, market(&hash)));
    assert_eq!(court.get_market(7).unwrap().linked_by, account(OTHER));
    assert_eq!(court.get_credits(hash.clone(), account(CREATOR)), 0);
    assert_eq!(court.get_spec(hash).unwrap().credits, 0);
}

#[test]
fn repeat_registration_credits_each_payer_separately() {
    let mut court = court();
    let hash = register(&mut court, "void");
    set(OTHER, T - 100 * SECOND, NEAR);
    assert_eq!(court.register_spec(spec("void")), hash);
    assert_eq!(court.get_credits(hash.clone(), account(CREATOR)), 1);
    assert_eq!(court.get_credits(hash.clone(), account(OTHER)), 1);
    assert_eq!(court.get_spec(hash.clone()).unwrap().credits, 2);

    assert!(link(&mut court, &hash, market(&hash)));
    assert_eq!(court.get_credits(hash.clone(), account(CREATOR)), 0);
    assert_eq!(court.get_credits(hash.clone(), account(OTHER)), 1);
    assert_eq!(court.get_spec(hash).unwrap().credits, 1);
}

#[test]
fn invalid_specs_rejected() {
    let mut court = court();
    for value in [
        json!({"version":2,"outcomes":["Yes","No"],"observation":{"at":"2026-11-13T10:00:00Z"},"on_unavailable":"void"}),
        json!({"version":1,"outcomes":["Yes"],"observation":{"at":"2026-11-13T10:00:00Z"},"on_unavailable":"void"}),
        json!({"version":1,"outcomes":["Yes","No"],"observation":{"at":"bad"},"on_unavailable":"void"}),
        json!({"version":1,"outcomes":["Yes","No"],"observation":{"at":"2026-11-13T10:00:00Z"},"on_unavailable":"Maybe"}),
    ] {
        let raw = value.to_string();
        set(CREATOR, T - 100 * SECOND, NEAR);
        assert!(panics(|| {
            court.register_spec(raw.clone());
        }));
        assert!(court.get_spec(spec_hash(&raw)).is_none());
    }
}

#[test]
fn link_rejections_and_creator_fallback() {
    let mut court = court();
    let hash = register(&mut court, "void");
    let mut value = market(&hash);
    value["resolver"] = json!(OTHER);
    assert!(!link(&mut court, &hash, value));
    assert!(get_logs()
        .iter()
        .any(|line| line.contains("wrong resolver")));
    let mut value = market(&hash);
    value["outcomes"][0]["name"] = json!("Maybe");
    assert!(!link(&mut court, &hash, value));
    let mut value = market(&hash);
    value["metadata_hash"] = json!("noacourt:sha256:wrong");
    assert!(!link(&mut court, &hash, value));
    let mut value = market(&hash);
    value["expiration_time"] = json!(T + SECOND);
    assert!(!link(&mut court, &hash, value));
    let mut value = market(&hash);
    value["metadata_hash"] = json!("other metadata");
    set(OTHER, T - 50 * SECOND, 0);
    court.link_market(7, Some(hash.clone()));
    result(
        T - 50 * SECOND,
        PromiseResult::Successful(value.to_string().into_bytes()),
    );
    assert!(!court.on_market_info(7, account(OTHER), Some(hash.clone())));
    set(CREATOR, T - 50 * SECOND, 0);
    court.link_market(7, Some(hash.clone()));
    result(
        T - 50 * SECOND,
        PromiseResult::Successful(value.to_string().into_bytes()),
    );
    assert!(court.on_market_info(7, account(CREATOR), Some(hash.clone())));
    assert_eq!(court.get_spec(hash.clone()).unwrap().credits, 0);
    assert_eq!(court.get_credits(hash.clone(), account(CREATOR)), 0);
    set(CREATOR, T - 50 * SECOND, 0);
    assert!(panics(|| {
        court.link_market(7, Some(hash));
    }));
}

#[test]
fn trigger_and_verdict_lifecycle() {
    let mut court = court();
    let hash = register(&mut court, "void");
    assert!(link(&mut court, &hash, market(&hash)));
    set(OTHER, T - SECOND, 0);
    assert!(panics(|| {
        court.trigger(7);
    }));
    set(OTHER, T, 0);
    court.trigger(7);
    assert!(panics(|| {
        court.trigger(7);
    }));
    let first_seq = court.get_market(7).unwrap().pending_seq;
    resolve_result(&mut court, verdict("sha256:bad", "resolved"), T + SECOND);
    assert_eq!(court.get_market(7).unwrap().status, Status::RetryScheduled);
    assert!(court
        .get_market(7)
        .unwrap()
        .last_error
        .as_ref()
        .unwrap()
        .contains("spec_hash"));
    set(OTHER, T + 31 * SECOND, 0);
    court.trigger(7);
    result(T + 32 * SECOND, PromiseResult::Failed);
    court.on_verdict("noa:7".into(), court.get_market(7).unwrap().pending_seq);
    assert_eq!(court.get_market(7).unwrap().status, Status::RetryScheduled);
    set(OTHER, T + 63 * SECOND, 0);
    court.trigger(7);
    resolve_result(&mut court, verdict(&hash, "resolved"), T + 64 * SECOND);
    assert_eq!(court.get_market(7).unwrap().status, Status::Resolved);
    assert!(function_calls()
        .iter()
        .any(|(receiver, method, deposit)| receiver == NOA
            && method == "resolve_market"
            && *deposit == 1));
    result(T + 65 * SECOND, PromiseResult::Successful(vec![]));
    court.on_forwarded(7);
    assert_eq!(court.get_market(7).unwrap().forwarded, Some(true));
    result(
        T + 66 * SECOND,
        PromiseResult::Successful(verdict(&hash, "resolved").to_string().into_bytes()),
    );
    court.on_verdict("noa:7".into(), first_seq);
    assert_eq!(court.get_market(7).unwrap().status, Status::Resolved);
    set(OTHER, T + 67 * SECOND, 0);
    assert!(panics(|| {
        court.trigger(7);
    }));
}

#[test]
fn retry_after_unavailable_and_void() {
    let mut court = court();
    let hash = register(&mut court, "void");
    assert!(link(&mut court, &hash, market(&hash)));
    set(OTHER, T, 0);
    court.trigger(7);
    resolve_result(&mut court, verdict(&hash, "retry_after"), T + SECOND);
    assert_eq!(court.get_market(7).unwrap().status, Status::RetryScheduled);
    assert_eq!(court.get_market(7).unwrap().retry_at_ns, T + 40 * SECOND);
    set(OTHER, T + 39 * SECOND, 0);
    assert!(panics(|| {
        court.trigger(7);
    }));
    set(OTHER, T + 40 * SECOND, 0);
    court.trigger(7);
    resolve_result(&mut court, verdict(&hash, "unresolvable"), T + 41 * SECOND);
    assert_eq!(court.get_market(7).unwrap().status, Status::Unresolvable);
    set(OTHER, T + 200 * SECOND, 0);
    assert!(panics(|| {
        court.void(7);
    }));
    set(OTHER, T + 201 * SECOND, 0);
    court.void(7);
    assert!(function_calls()
        .iter()
        .any(|(receiver, method, deposit)| receiver == NOA
            && method == "void_market"
            && *deposit == 1));
    result(T + 202 * SECOND, PromiseResult::Successful(vec![]));
    court.on_voided(7);
    assert_eq!(court.get_market(7).unwrap().status, Status::Voided);
}

#[test]
fn unavailable_outcome_and_forward_failure() {
    let mut court = court();
    let hash = register(&mut court, "No");
    assert!(link(&mut court, &hash, market(&hash)));
    set(OTHER, T, 0);
    court.trigger(7);
    resolve_result(&mut court, verdict(&hash, "unresolvable"), T + SECOND);
    assert_eq!(court.get_market(7).unwrap().outcome_index, Some(1));
    assert!(
        court
            .get_verdict("noa:7".into())
            .unwrap()
            .applied_on_unavailable
    );
    result(T + 2 * SECOND, PromiseResult::Failed);
    court.on_forwarded(7);
    assert_eq!(court.get_market(7).unwrap().forwarded, Some(false));
    set(OTHER, T + 3 * SECOND, 0);
    court.retry_forward(7);
    assert_eq!(court.get_market(7).unwrap().forwarded, None);
}

#[test]
fn failed_forward_can_be_voided_after_deadline() {
    let mut court = court();
    let hash = register(&mut court, "void");
    assert!(link(&mut court, &hash, market(&hash)));
    set(OTHER, T, 0);
    court.trigger(7);
    resolve_result(&mut court, verdict(&hash, "resolved"), T + SECOND);
    result(T + 2 * SECOND, PromiseResult::Failed);
    court.on_forwarded(7);
    assert_eq!(court.get_market(7).unwrap().forwarded, Some(false));

    set(OTHER, T + 200 * SECOND, 0);
    assert!(panics(|| {
        court.void(7);
    }));
    set(OTHER, T + 201 * SECOND, 0);
    court.void(7);
    assert!(court.get_market(7).unwrap().void_pending);
    assert!(panics(|| {
        court.void(7);
    }));
    assert!(function_calls().iter().any(|(receiver, method, deposit)| {
        receiver == NOA && method == "void_market" && *deposit == 1
    }));
    result(T + 202 * SECOND, PromiseResult::Successful(vec![]));
    court.on_voided(7);
    assert_eq!(court.get_market(7).unwrap().status, Status::Voided);
}

#[test]
fn exhausted_attempts_deadline_and_stale_pending_callback() {
    let mut court = court();
    let hash = register(&mut court, "void");
    assert!(link(&mut court, &hash, market(&hash)));
    set(OTHER, T, 0);
    court.trigger(7);
    let first_seq = court.get_market(7).unwrap().pending_seq;
    result(
        T + SECOND,
        PromiseResult::Successful(verdict(&hash, "resolved").to_string().into_bytes()),
    );
    court.on_verdict("noa:7".into(), first_seq + 1);
    assert_eq!(court.get_market(7).unwrap().status, Status::Pending);
    result(T + SECOND, PromiseResult::Failed);
    court.on_verdict("noa:7".into(), first_seq);
    set(OTHER, T + 31 * SECOND, 0);
    court.trigger(7);
    result(T + 32 * SECOND, PromiseResult::Failed);
    court.on_verdict("noa:7".into(), court.get_market(7).unwrap().pending_seq);
    set(OTHER, T + 62 * SECOND, 0);
    court.trigger(7);
    result(T + 63 * SECOND, PromiseResult::Failed);
    court.on_verdict("noa:7".into(), court.get_market(7).unwrap().pending_seq);
    assert_eq!(court.get_market(7).unwrap().status, Status::Unresolvable);
    assert!(
        court
            .get_verdict("noa:7".into())
            .unwrap()
            .applied_on_unavailable
    );
    set(OTHER, T + 64 * SECOND, 0);
    assert!(panics(|| {
        court.trigger(7);
    }));
    set(OTHER, T + 201 * SECOND, 0);
    court.void(7);
    result(T + 202 * SECOND, PromiseResult::Failed);
    court.on_voided(7);
    assert_eq!(court.get_market(7).unwrap().status, Status::Unresolvable);
    set(OTHER, T + 203 * SECOND, 0);
    court.void(7);
}

#[test]
fn trigger_after_deadline_is_rejected() {
    let mut court = court();
    let hash = register(&mut court, "void");
    assert!(link(&mut court, &hash, market(&hash)));
    set(OTHER, T + 201 * SECOND, 0);
    assert!(panics(|| {
        court.trigger(7);
    }));
}

#[test]
fn generic_callback_once_and_keeper_visibility() {
    let mut court = court();
    set(CREATOR, T - 100 * SECOND, NEAR);
    let id = court.request_resolution(
        spec("void"),
        Some(Callback {
            contract_id: account(NOA),
            method: "on_court_verdict".into(),
        }),
    );
    assert_eq!(id, "req:1");
    let hash = court.get_request(id.clone()).unwrap().spec_hash;
    assert_eq!(court.get_spec(hash.clone()).unwrap().credits, 0);
    assert_eq!(court.get_credits(hash.clone(), account(CREATOR)), 0);
    set(OTHER, T, 0);
    court.trigger_request(id.clone());
    let seq = court.get_request(id.clone()).unwrap().pending_seq;
    result(
        T + SECOND,
        PromiseResult::Successful(
            json!({"success":true,"output":verdict(&hash,"resolved").to_string()})
                .to_string()
                .into_bytes(),
        ),
    );
    court.on_verdict(id.clone(), seq);
    let record = court.get_verdict(id.clone()).unwrap();
    assert_eq!(record.verdict["spec_hash"], hash);
    assert!(record.tee);
    assert!(court.get_request(id.clone()).unwrap().callback_sent);
    assert_eq!(
        function_calls()
            .iter()
            .filter(|(_, method, _)| method == "on_court_verdict")
            .count(),
        1
    );
    result(
        T + 2 * SECOND,
        PromiseResult::Successful(verdict(&hash, "resolved").to_string().into_bytes()),
    );
    court.on_verdict(id, seq);
    assert_eq!(
        function_calls()
            .iter()
            .filter(|(_, method, _)| method == "on_court_verdict")
            .count(),
        0
    );

    set(OWNER, T, 1);
    court.set_trusted_keeper(Some(account(OTHER)));
    set(CREATOR, T, NEAR);
    let second = court.request_resolution(spec("void"), None);
    set(CREATOR, T + SECOND, 0);
    assert!(panics(|| court.submit_keeper_verdict(
        second.clone(),
        verdict(&hash, "resolved").to_string()
    )));
    set(OTHER, T + SECOND, 0);
    court.submit_keeper_verdict(second.clone(), verdict(&hash, "resolved").to_string());
    let record = court.get_verdict(second).unwrap();
    assert!(!record.tee);
    assert!(record.submitted_by.starts_with("keeper:"));
}

#[test]
fn keeper_supersedes_pending_outlayer_callback() {
    let mut court = court();
    let hash = register(&mut court, "void");
    assert!(link(&mut court, &hash, market(&hash)));
    set(OWNER, T, 1);
    court.set_trusted_keeper(Some(account(OTHER)));
    set(CREATOR, T, 0);
    court.trigger(7);
    let old_seq = court.get_market(7).unwrap().pending_seq;
    set(OTHER, T + SECOND, 0);
    court.submit_keeper_verdict("noa:7".into(), verdict(&hash, "resolved").to_string());
    assert_eq!(court.get_market(7).unwrap().pending_seq, old_seq + 1);
    assert!(!court.get_verdict("noa:7".into()).unwrap().tee);
    result(
        T + 2 * SECOND,
        PromiseResult::Successful(verdict(&hash, "unresolvable").to_string().into_bytes()),
    );
    court.on_verdict("noa:7".into(), old_seq);
    assert_eq!(court.get_market(7).unwrap().status, Status::Resolved);
}

#[test]
fn owner_methods_are_protected() {
    let mut court = court();
    set(OTHER, T, 1);
    assert!(panics(|| court.set_min_deposit(U128(NEAR))));
    assert!(panics(|| court.set_trusted_keeper(Some(account(OTHER)))));
    assert!(panics(|| court.set_resolver_source(json!({}))));
    assert!(panics(|| court.set_secrets_ref(None)));
    assert!(panics(|| court.set_owner(account(OTHER))));
    assert!(panics(|| court.set_outlayer_params(
        None,
        None,
        Some(20),
        None
    )));
    assert!(panics(|| {
        court.withdraw(None, U128(1));
    }));
    set(OWNER, T, 1);
    court.set_outlayer_params(None, None, Some(200), Some(U128(NEAR / 10)));
    assert_eq!(court.get_config()["outlayer_gas_tgas"], 200);
    court.set_min_deposit(U128(NEAR / 5));
    assert_eq!(court.get_config()["min_deposit"], (NEAR / 5).to_string());
}
