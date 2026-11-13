//! Run `tests/build-test-deps.sh` then
//! `cargo test --test sandbox -- --ignored --nocapture --test-threads=1`.

use anyhow::Result;
use near_sdk::serde_json::{json, Value};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};

const NEAR: u128 = 10u128.pow(24);

async fn fast_forward_past(
    worker: &Worker<near_workspaces::network::Sandbox>,
    target_timestamp_ns: u64,
) -> Result<()> {
    for _ in 0..100 {
        let current_timestamp_ns = worker.view_block().await?.timestamp();
        if current_timestamp_ns > target_timestamp_ns {
            return Ok(());
        }
        worker.fast_forward(10).await?;
    }
    anyhow::bail!(
        "sandbox timestamp did not pass {target_timestamp_ns}; latest was {}",
        worker.view_block().await?.timestamp()
    )
}

fn wasm(relative: &str) -> Vec<u8> {
    std::fs::read(format!("{}/{}", env!("CARGO_MANIFEST_DIR"), relative))
        .expect("build WASM with tests/build-test-deps.sh first")
}

fn spec(on_unavailable: &str) -> String {
    json!({"version":1,"outcomes":["Yes","No"],
        "observation":{"at":"2020-01-01T00:00:00Z"},
        "retry":{"max_attempts":3,"every":"1s"},
        "on_unavailable":on_unavailable})
    .to_string()
}

fn resolved(hash: &str) -> String {
    json!({"v":1,"resolver_version":"0.1.0","spec_hash":hash,"mode":"resolve",
        "status":"resolved","outcome":"Yes","outcome_index":0,
        "value":null,"retry_after":null,"reason":"test","sources":[],"jurors":null})
    .to_string()
}

fn retry(hash: &str) -> String {
    json!({"v":1,"resolver_version":"0.1.0","spec_hash":hash,"mode":"resolve",
        "status":"retry_after","outcome":null,"outcome_index":null,
        "value":null,"retry_after":"2020-01-01T00:00:00Z","reason":"retry","sources":[],"jurors":null}).to_string()
}

fn unresolvable(hash: &str) -> String {
    json!({"v":1,"resolver_version":"0.1.0","spec_hash":hash,"mode":"resolve",
        "status":"unresolvable","outcome":null,"outcome_index":null,
        "value":null,"retry_after":null,"reason":"missing","sources":[],"jurors":null})
    .to_string()
}

struct Setup {
    worker: Worker<near_workspaces::network::Sandbox>,
    root: Account,
    caller: Account,
    noa: Contract,
    outlayer: Contract,
    court: Contract,
}

impl Setup {
    async fn new() -> Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;
        let caller = root
            .create_subaccount("caller")
            .initial_balance(NearToken::from_near(30))
            .transact()
            .await?
            .into_result()?;
        let noa_account = root
            .create_subaccount("noa")
            .initial_balance(NearToken::from_near(20))
            .transact()
            .await?
            .into_result()?;
        let outlayer_account = root
            .create_subaccount("outlayer")
            .initial_balance(NearToken::from_near(20))
            .transact()
            .await?
            .into_result()?;
        let court_account = root
            .create_subaccount("court")
            .initial_balance(NearToken::from_near(20))
            .transact()
            .await?
            .into_result()?;
        let noa = noa_account
            .deploy(&wasm("target/near/mock_noa/mock_noa.wasm"))
            .await?
            .into_result()?;
        let outlayer = outlayer_account
            .deploy(&wasm(
                "target/near/mock_court_outlayer/mock_court_outlayer.wasm",
            ))
            .await?
            .into_result()?;
        let court = court_account
            .deploy(&wasm("target/near/noa_court.wasm"))
            .await?
            .into_result()?;
        noa.call("new")
            .args_json(json!({"owner":root.id()}))
            .transact()
            .await?
            .into_result()?;
        outlayer.call("new").transact().await?.into_result()?;
        court
            .call("init")
            .args_json(json!({
                "owner":root.id(),"noa_contract":noa.id(),"outlayer_contract":outlayer.id(),
                "resolver_source":{"Project":{"project_id":"owner.test/name","version_key":null}},
                "secrets_ref":null,"treasury":root.id(),"min_deposit":(NEAR/10).to_string(),
                "max_attempts":3
            }))
            .transact()
            .await?
            .into_result()?;
        Ok(Self {
            worker,
            root,
            caller,
            noa,
            outlayer,
            court,
        })
    }

    async fn register(&self, on_unavailable: &str) -> Result<String> {
        let outcome = self
            .caller
            .call(self.court.id(), "register_spec")
            .args_json(json!({"spec_json":spec(on_unavailable)}))
            .deposit(NearToken::from_near(1))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
        println!(
            "register_spec total gas burnt: {} TGas",
            outcome.total_gas_burnt.as_tgas()
        );
        Ok(outcome.json::<String>()?)
    }

    async fn create_and_link(&self, hash: &str, deadline: u64) -> Result<u64> {
        let outcome = self
            .caller
            .call(self.noa.id(), "create_market")
            .args_json(
                json!({"title":"Test","metadata_hash":format!("noacourt:{hash}"),
                "outcomes":["Yes","No"],"expiration_time":1u64,
                "resolution_deadline":deadline,"resolver":self.court.id()}),
            )
            .transact()
            .await?
            .into_result()?;
        let market_id = outcome.json::<u64>()?;
        let outcome = self
            .root
            .call(self.court.id(), "link_market")
            .args_json(json!({"market_id":market_id,"spec_hash":null}))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
        println!(
            "link_market total gas burnt: {} TGas",
            outcome.total_gas_burnt.as_tgas()
        );
        let value: Value = self
            .court
            .view("get_market")
            .args_json(json!({"market_id":market_id}))
            .await?
            .json()?;
        assert_eq!(value["status"], "Linked");
        assert_eq!(value["creator"], json!(self.caller.id()));
        assert_eq!(value["linked_by"], json!(self.root.id()));
        Ok(market_id)
    }

    async fn set_response(&self, response: String) -> Result<()> {
        self.outlayer
            .call("set_response")
            .args_json(json!({"response":response,"fail":false}))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn set_failure(&self) -> Result<()> {
        self.outlayer
            .call("set_response")
            .args_json(json!({"response":"null","fail":true}))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn trigger(&self, market_id: u64) -> Result<()> {
        let outcome = self
            .caller
            .call(self.court.id(), "trigger")
            .args_json(json!({"market_id":market_id}))
            .gas(Gas::from_tgas(250))
            .transact()
            .await?
            .into_result()?;
        println!(
            "trigger total gas burnt (OutLayer and callbacks): {} TGas",
            outcome.total_gas_burnt.as_tgas()
        );
        Ok(())
    }
}

#[tokio::test]
#[ignore = "requires a local near-sandbox binary; run build-test-deps.sh first"]
async fn court_lifecycles_and_gas() -> Result<()> {
    let setup = Setup::new().await?;
    let deadline = setup
        .worker
        .view_block()
        .await?
        .timestamp()
        .checked_add(120_000_000_000)
        .expect("sandbox timestamp overflow");

    let hash = setup.register("void").await?;
    let attacker_market = setup
        .root
        .call(setup.noa.id(), "create_market")
        .args_json(json!({
            "title":"Unpaid copy",
            "metadata_hash":format!("noacourt:{hash}"),
            "outcomes":["Yes","No"],
            "expiration_time":1u64,
            "resolution_deadline":deadline,
            "resolver":setup.court.id()
        }))
        .transact()
        .await?
        .into_result()?
        .json::<u64>()?;
    let rejected = setup
        .caller
        .call(setup.court.id(), "link_market")
        .args_json(json!({"market_id":attacker_market,"spec_hash":null}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert!(!rejected.json::<bool>()?);
    assert!(rejected
        .logs()
        .iter()
        .any(|line| line.contains("creator has no credit for spec")));
    let rejected_item: Value = setup
        .court
        .view("get_market")
        .args_json(json!({"market_id":attacker_market}))
        .await?
        .json()?;
    assert!(rejected_item.is_null());
    let victim_credits: u32 = setup
        .court
        .view("get_credits")
        .args_json(json!({"spec_hash":hash,"account_id":setup.caller.id()}))
        .await?
        .json()?;
    assert_eq!(victim_credits, 1);

    let short_market = setup
        .caller
        .call(setup.noa.id(), "create_market")
        .args_json(json!({
            "title":"Retry window too short",
            "metadata_hash":format!("noacourt:{hash}"),
            "outcomes":["Yes","No"],
            "expiration_time":1u64,
            "resolution_deadline":1_577_837_102_000_000_000u64,
            "resolver":setup.court.id()
        }))
        .transact()
        .await?
        .into_result()?
        .json::<u64>()?;
    let short_link = setup
        .root
        .call(setup.court.id(), "link_market")
        .args_json(json!({"market_id":short_market,"spec_hash":null}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert!(!short_link.json::<bool>()?);
    assert!(short_link
        .logs()
        .iter()
        .any(|line| line.contains("resolution window too short for retries")));
    let still_available: u32 = setup
        .court
        .view("get_credits")
        .args_json(json!({"spec_hash":hash,"account_id":setup.caller.id()}))
        .await?
        .json()?;
    assert_eq!(still_available, 1);

    let market_id = setup.create_and_link(&hash, deadline).await?;
    let spent_credits: u32 = setup
        .court
        .view("get_credits")
        .args_json(json!({"spec_hash":hash,"account_id":setup.caller.id()}))
        .await?
        .json()?;
    assert_eq!(spent_credits, 0);
    setup.set_response(resolved(&hash)).await?;
    setup.trigger(market_id).await?;
    let market: Value = setup
        .noa
        .view("get_market")
        .args_json(json!({"market_id":market_id}))
        .await?
        .json()?;
    assert_eq!(market["winning_outcome"], 0);
    assert_eq!(market["pending_proposal"], true);
    let item: Value = setup
        .court
        .view("get_market")
        .args_json(json!({"market_id":market_id}))
        .await?
        .json()?;
    assert_eq!(item["forwarded"], true);

    let null_hash = setup.register("void").await?;
    let null_market = setup.create_and_link(&null_hash, deadline).await?;
    setup.set_response("null".into()).await?;
    setup.trigger(null_market).await?;
    let item: Value = setup
        .court
        .view("get_market")
        .args_json(json!({"market_id":null_market}))
        .await?
        .json()?;
    assert_eq!(item["status"], "RetryScheduled");
    assert_eq!(item["attempts"], 1);
    assert_eq!(item["last_error"], "outlayer_execution_failed");
    setup.set_response(resolved(&null_hash)).await?;
    fast_forward_past(&setup.worker, item["retry_at_ns"].as_u64().unwrap()).await?;
    setup.trigger(null_market).await?;
    let market: Value = setup
        .noa
        .view("get_market")
        .args_json(json!({"market_id":null_market}))
        .await?
        .json()?;
    assert_eq!(market["winning_outcome"], 0);

    let failure_hash = setup.register("void").await?;
    let failure_market = setup.create_and_link(&failure_hash, deadline).await?;
    setup.set_failure().await?;
    setup.trigger(failure_market).await?;
    let item: Value = setup
        .court
        .view("get_market")
        .args_json(json!({"market_id":failure_market}))
        .await?
        .json()?;
    assert_eq!(item["status"], "RetryScheduled");
    assert_eq!(item["attempts"], 1);
    assert_eq!(item["last_error"], "outlayer_execution_failed");
    setup.set_response(resolved(&failure_hash)).await?;
    fast_forward_past(&setup.worker, item["retry_at_ns"].as_u64().unwrap()).await?;
    setup.trigger(failure_market).await?;
    let item: Value = setup
        .court
        .view("get_market")
        .args_json(json!({"market_id":failure_market}))
        .await?
        .json()?;
    assert_eq!(item["status"], "Resolved");
    assert_eq!(item["attempts"], 2);
    assert_eq!(item["forwarded"], true);
    assert!(item["last_error"].is_null());
    let market: Value = setup
        .noa
        .view("get_market")
        .args_json(json!({"market_id":failure_market}))
        .await?
        .json()?;
    assert_eq!(market["winning_outcome"], 0);
    assert_eq!(market["pending_proposal"], true);

    let retry_hash = setup.register("void").await?;
    let retry_market = setup.create_and_link(&retry_hash, deadline).await?;
    setup.set_response(retry(&retry_hash)).await?;
    setup.trigger(retry_market).await?;
    let item: Value = setup
        .court
        .view("get_market")
        .args_json(json!({"market_id":retry_market}))
        .await?
        .json()?;
    assert_eq!(item["status"], "RetryScheduled");
    setup.set_response(resolved(&retry_hash)).await?;
    fast_forward_past(&setup.worker, item["retry_at_ns"].as_u64().unwrap()).await?;
    setup.trigger(retry_market).await?;
    let market: Value = setup
        .noa
        .view("get_market")
        .args_json(json!({"market_id":retry_market}))
        .await?
        .json()?;
    assert_eq!(market["winning_outcome"], 0);

    let void_hash = setup.register("void").await?;
    let void_deadline = setup
        .worker
        .view_block()
        .await?
        .timestamp()
        .checked_add(5_000_000_000)
        .expect("sandbox timestamp overflow");
    let void_market = setup.create_and_link(&void_hash, void_deadline).await?;
    setup.set_response(unresolvable(&void_hash)).await?;
    setup.trigger(void_market).await?;
    fast_forward_past(&setup.worker, void_deadline).await?;
    setup
        .caller
        .call(setup.court.id(), "void")
        .args_json(json!({"market_id":void_market}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let market: Value = setup
        .noa
        .view("get_market")
        .args_json(json!({"market_id":void_market}))
        .await?
        .json()?;
    assert_eq!(market["status"], "Void");

    let generic_hash = setup.register("void").await?;
    let outcome = setup.caller.call(setup.court.id(), "request_resolution")
        .args_json(json!({"spec_json":spec("void"),"callback":{"contract_id":setup.noa.id(),"method":"on_court_verdict"}}))
        .deposit(NearToken::from_near(1)).gas(Gas::from_tgas(100)).transact().await?.into_result()?;
    let request_id = outcome.json::<String>()?;
    setup.set_response(resolved(&generic_hash)).await?;
    setup
        .caller
        .call(setup.court.id(), "trigger_request")
        .args_json(json!({"request_id":request_id}))
        .gas(Gas::from_tgas(250))
        .transact()
        .await?
        .into_result()?;
    let receipt: Value = setup
        .court
        .view("get_verdict")
        .args_json(json!({"id":request_id}))
        .await?
        .json()?;
    assert_eq!(receipt["verdict"]["spec_hash"], generic_hash);
    let count: u32 = setup.noa.view("callback_count").await?.json()?;
    assert_eq!(count, 1);

    let mismatch_hash = setup.register("void").await?;
    let mismatch_market = setup.create_and_link(&mismatch_hash, deadline).await?;
    setup.set_response(resolved("sha256:wrong")).await?;
    setup.trigger(mismatch_market).await?;
    let item: Value = setup
        .court
        .view("get_market")
        .args_json(json!({"market_id":mismatch_market}))
        .await?
        .json()?;
    assert_eq!(item["status"], "RetryScheduled");

    setup
        .root
        .call(setup.court.id(), "set_trusted_keeper")
        .args_json(json!({"trusted_keeper":setup.caller.id()}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let keeper_market_hash = setup.register("void").await?;
    let keeper_market = setup.create_and_link(&keeper_market_hash, deadline).await?;
    let outcome = setup
        .caller
        .call(setup.court.id(), "submit_keeper_verdict")
        .args_json(json!({
            "id":format!("noa:{keeper_market}"),
            "verdict_json":resolved(&keeper_market_hash)
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    println!(
        "submit_keeper_verdict (Noa-linked market) total gas burnt: {} TGas",
        outcome.total_gas_burnt.as_tgas()
    );
    let market: Value = setup
        .noa
        .view("get_market")
        .args_json(json!({"market_id":keeper_market}))
        .await?
        .json()?;
    assert_eq!(market["winning_outcome"], 0);
    assert_eq!(market["pending_proposal"], true);
    let item: Value = setup
        .court
        .view("get_market")
        .args_json(json!({"market_id":keeper_market}))
        .await?
        .json()?;
    assert_eq!(item["forwarded"], true);
    let record: Value = setup
        .court
        .view("get_verdict")
        .args_json(json!({"id":format!("noa:{keeper_market}")}))
        .await?
        .json()?;
    assert_eq!(record["tee"], false);
    assert!(record["submitted_by"]
        .as_str()
        .unwrap()
        .starts_with("keeper:"));
    let outcome = setup
        .caller
        .call(setup.court.id(), "request_resolution")
        .args_json(json!({"spec_json":spec("void"),"callback":null}))
        .deposit(NearToken::from_near(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let keeper_id = outcome.json::<String>()?;
    let outcome = setup
        .caller
        .call(setup.court.id(), "submit_keeper_verdict")
        .args_json(json!({"id":keeper_id,"verdict_json":resolved(&generic_hash)}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    println!(
        "submit_keeper_verdict total gas burnt: {} TGas",
        outcome.total_gas_burnt.as_tgas()
    );
    let record: Value = setup
        .court
        .view("get_verdict")
        .args_json(json!({"id":keeper_id}))
        .await?
        .json()?;
    assert_eq!(record["tee"], false);

    let linked_attempt = setup
        .caller
        .call(setup.court.id(), "void_unlinked")
        .args_json(json!({"market_id":market_id}))
        .gas(Gas::from_tgas(80))
        .transact()
        .await?;
    assert!(linked_attempt.into_result().is_err());

    let unlinked_hash = setup.register("void").await?;
    let unlinked_deadline = setup
        .worker
        .view_block()
        .await?
        .timestamp()
        .checked_add(20_000_000_000)
        .expect("sandbox timestamp overflow");
    let unlinked_market = setup
        .caller
        .call(setup.noa.id(), "create_market")
        .args_json(json!({
            "title":"Closes after observation",
            "metadata_hash":format!("noacourt:{unlinked_hash}"),
            "outcomes":["Yes","No"],
            "expiration_time":1_577_923_200_000_000_000u64,
            "resolution_deadline":unlinked_deadline,
            "resolver":setup.court.id()
        }))
        .transact()
        .await?
        .into_result()?
        .json::<u64>()?;
    let rejected_link = setup
        .root
        .call(setup.court.id(), "link_market")
        .args_json(json!({"market_id":unlinked_market,"spec_hash":null}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert!(!rejected_link.json::<bool>()?);
    assert!(rejected_link
        .logs()
        .iter()
        .any(|line| line.contains("expiration after observation")));
    let before_deadline = setup
        .caller
        .call(setup.court.id(), "void_unlinked")
        .args_json(json!({"market_id":unlinked_market}))
        .gas(Gas::from_tgas(80))
        .transact()
        .await?
        .into_result()?;
    assert!(!before_deadline.json::<bool>()?);
    let market: Value = setup
        .noa
        .view("get_market")
        .args_json(json!({"market_id":unlinked_market}))
        .await?
        .json()?;
    assert_eq!(market["status"], "Active");
    fast_forward_past(&setup.worker, unlinked_deadline).await?;
    let voided = setup
        .caller
        .call(setup.court.id(), "void_unlinked")
        .args_json(json!({"market_id":unlinked_market}))
        .gas(Gas::from_tgas(80))
        .transact()
        .await?
        .into_result()?;
    println!(
        "void_unlinked total gas burnt (Noa view, void and callbacks): {} TGas",
        voided.total_gas_burnt.as_tgas()
    );
    assert!(
        voided.json::<bool>()?,
        "void_unlinked logs: {:?}",
        voided.logs()
    );
    let market: Value = setup
        .noa
        .view("get_market")
        .args_json(json!({"market_id":unlinked_market}))
        .await?
        .json()?;
    assert_eq!(market["status"], "Void");
    let court_item: Value = setup
        .court
        .view("get_market")
        .args_json(json!({"market_id":unlinked_market}))
        .await?
        .json()?;
    assert!(court_item.is_null());
    Ok(())
}
