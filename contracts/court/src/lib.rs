use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise,
};

const NEAR: u128 = 10u128.pow(24);
const RESERVE: u128 = NEAR / 10;
const STORAGE_BUFFER: u64 = 2_000;
const MAX_SPEC: usize = 16 * 1024;
const MAX_RESULT: usize = 32 * 1024;
const GAS_LINK: Gas = Gas::from_tgas(25);
const GAS_VERDICT: Gas = Gas::from_tgas(50);
const GAS_FORWARD: Gas = Gas::from_tgas(15);
const GAS_FORWARD_CB: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(20);

#[ext_contract(ext_noa)]
#[allow(dead_code)]
trait Noa {
    fn get_market(&self, market_id: u64) -> Option<Value>;
    fn resolve_market(&mut self, market_id: u64, winning_outcome: u8);
    fn void_market(&mut self, market_id: u64);
}

#[ext_contract(ext_outlayer)]
#[allow(dead_code)]
trait OutLayer {
    #[allow(clippy::too_many_arguments)]
    fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<String>,
        payer_account_id: Option<AccountId>,
        params: Option<Value>,
    );
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait Ft {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[derive(BorshStorageKey, BorshSerialize)]
enum Key {
    Specs,
    Items,
    Verdicts,
    Credits,
}

#[near(serializers = [borsh])]
#[derive(Serialize, Deserialize, Clone, Debug, near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct SecretsRef {
    pub profile: String,
    pub account_id: AccountId,
}

#[derive(
    BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, near_sdk::NearSchema,
)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct SpecEntry {
    pub spec_json: String,
    pub spec_hash: String,
    /// Legacy aggregate count. Authorization uses `get_credits`, not this field.
    pub credits: u32,
    pub registered_by: AccountId,
    pub observation_at_ns: u64,
    pub outcomes: Vec<String>,
    pub retry_max_attempts: Option<u8>,
    pub retry_every_ns: u64,
    pub on_unavailable: String,
}

#[derive(
    BorshDeserialize,
    BorshSerialize,
    Serialize,
    Deserialize,
    Clone,
    Debug,
    PartialEq,
    Eq,
    near_sdk::NearSchema,
)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub enum Status {
    Linked,
    Pending,
    RetryScheduled,
    Resolved,
    Unresolvable,
    Voided,
}

#[derive(
    BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, near_sdk::NearSchema,
)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct Callback {
    pub contract_id: AccountId,
    pub method: String,
}

#[derive(
    BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, near_sdk::NearSchema,
)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct Item {
    pub id: String,
    pub market_id: Option<u64>,
    pub spec_hash: String,
    pub status: Status,
    pub attempts: u8,
    pub pending_seq: u64,
    pub retry_at_ns: u64,
    pub resolution_deadline_ns: Option<u64>,
    pub expiration_ns: Option<u64>,
    pub creator: AccountId,
    pub linked_by: AccountId,
    pub last_error: Option<String>,
    pub outcome_index: Option<u8>,
    pub forwarded: Option<bool>,
    pub void_pending: bool,
    pub callback: Option<Callback>,
    pub callback_sent: bool,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct VerdictRecord {
    pub id: String,
    pub verdict: ValueString,
    pub tee: bool,
    pub submitted_by: String,
    pub attempt: u8,
    pub received_at_ns: u64,
    pub outlayer: Option<ValueString>,
    pub applied_on_unavailable: bool,
}

// JSON is kept as a string in borsh state; the public view expands it.
#[derive(
    BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, near_sdk::NearSchema,
)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct ValueString(pub String);

#[derive(Serialize, Deserialize, near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct VerdictView {
    pub id: String,
    pub verdict: Value,
    pub tee: bool,
    pub submitted_by: String,
    pub attempt: u8,
    pub received_at_ns: u64,
    pub outlayer: Option<Value>,
    pub applied_on_unavailable: bool,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct SpecInput {
    version: u8,
    outcomes: Vec<String>,
    observation: Observation,
    retry: Option<Retry>,
    on_unavailable: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Observation {
    at: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Retry {
    max_attempts: u8,
    every: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct MarketInfo {
    id: u64,
    creator: AccountId,
    metadata_hash: String,
    outcomes: Vec<MarketOutcome>,
    expiration_time: u64,
    resolution_deadline: u64,
    resolver: AccountId,
    status: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct MarketOutcome {
    id: u8,
    name: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Court {
    owner: AccountId,
    noa_contract: AccountId,
    outlayer_contract: AccountId,
    resolver_source: String,
    secrets_ref: Option<SecretsRef>,
    treasury: AccountId,
    min_deposit: u128,
    max_attempts: u8,
    resource_limits: String,
    outlayer_deposit: u128,
    outlayer_gas_tgas: u64,
    resolution_fee: u128,
    trusted_keeper: Option<AccountId>,
    next_request: u64,
    specs: LookupMap<String, SpecEntry>,
    items: LookupMap<String, Item>,
    verdicts: LookupMap<String, VerdictRecord>,
}

#[near]
impl Court {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn init(
        owner: AccountId,
        noa_contract: AccountId,
        outlayer_contract: AccountId,
        resolver_source: Value,
        secrets_ref: Option<SecretsRef>,
        treasury: AccountId,
        min_deposit: U128,
        max_attempts: u8,
    ) -> Self {
        require!(max_attempts > 0, "max_attempts must be positive");
        require!(min_deposit.0 > 0, "min_deposit must be positive");
        require!(
            resolver_source.is_object(),
            "resolver_source must be an object"
        );
        Self {
            owner,
            noa_contract,
            outlayer_contract,
            resolver_source: resolver_source.to_string(),
            secrets_ref,
            treasury,
            min_deposit: min_deposit.0,
            max_attempts,
            resource_limits: json!({"max_instructions":10_000_000_000u64,"max_memory_mb":128,"max_execution_seconds":60}).to_string(),
            outlayer_deposit: NEAR / 100,
            outlayer_gas_tgas: 100,
            resolution_fee: NEAR / 20,
            trusted_keeper: None,
            next_request: 0,
            specs: LookupMap::new(Key::Specs),
            items: LookupMap::new(Key::Items),
            verdicts: LookupMap::new(Key::Verdicts),
        }
    }

    #[payable]
    pub fn set_resolver_source(&mut self, resolver_source: Value) {
        self.assert_owner();
        require!(
            resolver_source.is_object(),
            "resolver_source must be an object"
        );
        self.resolver_source = resolver_source.to_string();
    }

    #[payable]
    pub fn set_secrets_ref(&mut self, secrets_ref: Option<SecretsRef>) {
        self.assert_owner();
        self.secrets_ref = secrets_ref;
    }

    #[payable]
    pub fn set_min_deposit(&mut self, min_deposit: U128) {
        self.assert_owner();
        require!(min_deposit.0 > 0, "min_deposit must be positive");
        self.min_deposit = min_deposit.0;
    }

    #[payable]
    pub fn set_trusted_keeper(&mut self, trusted_keeper: Option<AccountId>) {
        self.assert_owner();
        self.trusted_keeper = trusted_keeper;
    }

    #[payable]
    pub fn set_owner(&mut self, owner: AccountId) {
        self.assert_owner();
        self.owner = owner;
    }

    #[payable]
    pub fn set_outlayer_params(
        &mut self,
        resource_limits: Option<Value>,
        outlayer_deposit: Option<U128>,
        outlayer_gas_tgas: Option<u64>,
        resolution_fee: Option<U128>,
    ) {
        self.assert_owner();
        if let Some(limits) = resource_limits {
            require!(limits.is_object(), "resource_limits must be an object");
            self.resource_limits = limits.to_string();
        }
        if let Some(deposit) = outlayer_deposit {
            self.outlayer_deposit = deposit.0;
        }
        if let Some(gas) = outlayer_gas_tgas {
            require!((20..=250).contains(&gas), "outlayer_gas_tgas out of bounds");
            self.outlayer_gas_tgas = gas;
        }
        if let Some(fee) = resolution_fee {
            self.resolution_fee = fee.0;
        }
    }

    #[payable]
    pub fn withdraw(&mut self, token: Option<AccountId>, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "amount must be positive");
        match token {
            Some(ft) => ext_ft::ext(ft)
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(Gas::from_tgas(15))
                .ft_transfer(self.treasury.clone(), amount, None),
            None => {
                let floor = self.balance_floor();
                require!(
                    env::account_balance().as_yoctonear() >= floor.saturating_add(amount.0),
                    "withdraw would breach storage and reserve floor"
                );
                Promise::new(self.treasury.clone()).transfer(NearToken::from_yoctonear(amount.0))
            }
        }
    }

    #[payable]
    pub fn register_spec(&mut self, spec_json: String) -> String {
        self.require_min_deposit();
        let before = env::storage_usage();
        let hash = spec_hash(&spec_json);
        let payer = env::predecessor_account_id();
        if let Some(mut existing) = self.specs.get(&hash).cloned() {
            existing.credits = existing.credits.checked_add(1).expect("credit overflow");
            self.specs.insert(hash.clone(), existing);
        } else {
            let spec = parse_spec(&spec_json, hash.clone(), payer.clone());
            self.specs.insert(hash.clone(), spec);
        }
        let mut credits = Self::credits_map();
        let key = (hash.clone(), payer);
        let balance = credits.get(&key).copied().unwrap_or(0);
        credits.insert(key, balance.checked_add(1).expect("credit overflow"));
        credits.flush();
        self.take_deposit(before);
        emit("spec_registered", json!({"spec_hash":hash}));
        hash
    }

    #[payable]
    pub fn request_resolution(&mut self, spec_json: String, callback: Option<Callback>) -> String {
        self.require_min_deposit();
        if let Some(ref cb) = callback {
            require!(valid_method(&cb.method), "invalid callback method");
        }
        let before = env::storage_usage();
        let hash = spec_hash(&spec_json);
        if self.specs.get(&hash).is_none() {
            let mut spec = parse_spec(&spec_json, hash.clone(), env::predecessor_account_id());
            spec.credits = 0; // This request consumes the credit paid for by this call.
            self.specs.insert(hash.clone(), spec);
        }
        self.next_request = self
            .next_request
            .checked_add(1)
            .expect("request id overflow");
        let id = format!("req:{}", self.next_request);
        let caller = env::predecessor_account_id();
        self.items.insert(
            id.clone(),
            Item {
                id: id.clone(),
                market_id: None,
                spec_hash: hash,
                status: Status::Linked,
                attempts: 0,
                pending_seq: 0,
                retry_at_ns: 0,
                resolution_deadline_ns: None,
                expiration_ns: None,
                creator: caller.clone(),
                linked_by: caller,
                last_error: None,
                outcome_index: None,
                forwarded: None,
                void_pending: false,
                callback,
                callback_sent: false,
            },
        );
        self.take_deposit(before);
        id
    }

    pub fn link_market(&mut self, market_id: u64, spec_hash: Option<String>) -> Promise {
        require!(
            env::prepaid_gas().as_tgas() >= 60,
            "link requires at least 60 TGas"
        );
        require!(
            self.items.get(&market_key(market_id)).is_none(),
            "market already linked"
        );
        ext_noa::ext(self.noa_contract.clone())
            .with_static_gas(Gas::from_tgas(10))
            .get_market(market_id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_LINK)
                    .on_market_info(market_id, env::predecessor_account_id(), spec_hash),
            )
    }

    #[private]
    pub fn on_market_info(
        &mut self,
        market_id: u64,
        caller: AccountId,
        spec_hash: Option<String>,
    ) -> bool {
        let result = (|| -> Result<(), String> {
            let bytes = env::promise_result_checked(0, MAX_RESULT)
                .map_err(|_| "get_market failed or result too large")?;
            let market: MarketInfo =
                serde_json::from_slice(&bytes).map_err(|_| "invalid market JSON")?;
            if market.id != market_id {
                return Err("market id mismatch".into());
            }
            if market.status != "Active" {
                return Err("market is not Active".into());
            }
            if market.resolver != env::current_account_id() {
                return Err("wrong resolver".into());
            }
            if self.items.get(&market_key(market_id)).is_some() {
                return Err("market already linked".into());
            }
            let from_metadata = market.metadata_hash.strip_prefix("noacourt:");
            let hash = match (from_metadata, spec_hash) {
                (Some(metadata), Some(provided)) if metadata != provided => {
                    return Err("metadata spec_hash mismatch".into())
                }
                (Some(metadata), _) => metadata.to_string(),
                (None, Some(provided)) if caller == market.creator => provided,
                (None, Some(_)) => return Err("explicit spec_hash requires market creator".into()),
                (None, None) => {
                    return Err("metadata is not noacourt and no spec_hash supplied".into())
                }
            };
            let mut spec = self
                .specs
                .get(&hash)
                .cloned()
                .ok_or("spec not registered")?;
            let mut credits = Self::credits_map();
            let credit_key = (hash.clone(), market.creator.clone());
            let creator_credits = credits.get(&credit_key).copied().unwrap_or(0);
            if creator_credits == 0 {
                return Err("creator has no credit for spec".into());
            }
            if market.outcomes.len() != spec.outcomes.len()
                || market.outcomes.iter().enumerate().any(|(i, outcome)| {
                    outcome.id as usize != i || outcome.name != spec.outcomes[i]
                })
            {
                return Err("outcomes mismatch".into());
            }
            if market.expiration_time > spec.observation_at_ns {
                return Err("expiration after observation".into());
            }
            if market.resolution_deadline <= market.expiration_time {
                return Err("invalid market deadline".into());
            }
            credits.insert(credit_key, creator_credits - 1);
            credits.flush();
            spec.credits = spec.credits.saturating_sub(1);
            self.specs.insert(hash.clone(), spec);
            self.items.insert(
                market_key(market_id),
                Item {
                    id: format!("noa:{market_id}"),
                    market_id: Some(market_id),
                    spec_hash: hash,
                    status: Status::Linked,
                    attempts: 0,
                    pending_seq: 0,
                    retry_at_ns: 0,
                    resolution_deadline_ns: Some(market.resolution_deadline),
                    expiration_ns: Some(market.expiration_time),
                    creator: market.creator,
                    linked_by: caller,
                    last_error: None,
                    outcome_index: None,
                    forwarded: None,
                    void_pending: false,
                    callback: None,
                    callback_sent: false,
                },
            );
            emit("market_linked", json!({"market_id":market_id}));
            Ok(())
        })();
        if let Err(reason) = result {
            env::log_str(&format!("link rejected: {reason}"));
            emit(
                "link_rejected",
                json!({"market_id":market_id,"reason":reason}),
            );
            return false;
        }
        true
    }

    pub fn trigger(&mut self, market_id: u64) -> Promise {
        self.trigger_id(market_key(market_id))
    }

    pub fn trigger_request(&mut self, request_id: String) -> Promise {
        require!(request_id.starts_with("req:"), "invalid request id");
        self.trigger_id(request_id)
    }

    #[private]
    pub fn on_verdict(&mut self, id: String, seq: u64) {
        let Some(item) = self.items.get(&id) else {
            env::log_str("stale verdict: missing item");
            return;
        };
        if item.status != Status::Pending || item.pending_seq != seq {
            env::log_str("stale verdict ignored");
            return;
        }
        let result = env::promise_result_checked(0, MAX_RESULT)
            .map_err(|error| format!("outlayer result: {error:?}"))
            .and_then(|bytes| parse_outlayer(&bytes));
        self.process_verdict(id, result, true, "outlayer".into());
    }

    pub fn retry_forward(&mut self, market_id: u64) -> Promise {
        let id = market_key(market_id);
        let mut item = self.items.get(&id).cloned().expect("market not linked");
        require!(
            item.status == Status::Resolved && item.forwarded == Some(false),
            "forward is not retryable"
        );
        require!(
            env::block_timestamp() <= item.resolution_deadline_ns.unwrap_or(0),
            "resolution deadline passed"
        );
        let index = item.outcome_index.expect("missing outcome");
        item.forwarded = None;
        self.items.insert(id, item);
        self.forward(market_id, index)
    }

    #[private]
    pub fn on_forwarded(&mut self, market_id: u64) {
        let id = market_key(market_id);
        let Some(mut item) = self.items.get(&id).cloned() else {
            return;
        };
        if item.status != Status::Resolved || item.forwarded.is_some() {
            return;
        }
        let ok = env::promise_result_checked(0, 0).is_ok();
        item.forwarded = Some(ok);
        if !ok {
            item.last_error = Some("Noa resolve_market failed".into());
        }
        self.items.insert(id, item);
        emit("forwarded", json!({"market_id":market_id,"success":ok}));
    }

    pub fn void(&mut self, market_id: u64) -> Promise {
        let id = market_key(market_id);
        let mut item = self.items.get(&id).cloned().expect("market not linked");
        let failed_forward = item.status == Status::Resolved && item.forwarded == Some(false);
        require!(
            failed_forward
                || !matches!(
                    item.status,
                    Status::Resolved | Status::Voided | Status::Pending
                ),
            "market cannot be voided"
        );
        require!(!item.void_pending, "void already pending");
        require!(
            env::block_timestamp() > item.resolution_deadline_ns.expect("not a market"),
            "resolution deadline not passed"
        );
        item.void_pending = true;
        self.items.insert(id, item);
        ext_noa::ext(self.noa_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FORWARD)
            .void_market(market_id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FORWARD_CB)
                    .on_voided(market_id),
            )
    }

    #[private]
    pub fn on_voided(&mut self, market_id: u64) {
        let id = market_key(market_id);
        let Some(mut item) = self.items.get(&id).cloned() else {
            return;
        };
        if !item.void_pending {
            return;
        }
        item.void_pending = false;
        if env::promise_result_checked(0, 0).is_ok() {
            item.status = Status::Voided;
            emit("voided", json!({"market_id":market_id}));
        } else {
            item.last_error = Some("Noa void_market failed".into());
            env::log_str("Noa void_market failed");
        }
        self.items.insert(id, item);
    }

    pub fn submit_keeper_verdict(&mut self, id: String, verdict_json: String) {
        let caller = env::predecessor_account_id();
        require!(
            self.trusted_keeper.as_ref() == Some(&caller),
            "trusted keeper only"
        );
        require!(
            verdict_json.len() <= MAX_RESULT as usize,
            "verdict too large"
        );
        let mut item = self.items.get(&id).cloned().expect("item not found");
        require!(
            matches!(
                item.status,
                Status::Linked | Status::RetryScheduled | Status::Pending
            ),
            "item is final"
        );
        let spec = self.specs.get(&item.spec_hash).expect("spec not found");
        require!(
            env::block_timestamp() >= spec.observation_at_ns,
            "observation not reached"
        );
        require!(env::block_timestamp() >= item.retry_at_ns, "retry not due");
        if let Some(deadline) = item.resolution_deadline_ns {
            require!(
                env::block_timestamp() <= deadline,
                "resolution deadline passed"
            );
        }
        require!(
            item.attempts < self.effective_max(spec),
            "attempts exhausted"
        );
        item.attempts += 1;
        item.pending_seq = item.pending_seq.checked_add(1).expect("sequence overflow");
        item.status = Status::Pending;
        self.items.insert(id.clone(), item);
        self.process_verdict(
            id,
            parse_outlayer(verdict_json.as_bytes()),
            false,
            format!("keeper:{caller}"),
        );
    }

    pub fn get_spec(&self, spec_hash: String) -> Option<SpecEntry> {
        self.specs.get(&spec_hash).cloned()
    }

    pub fn get_credits(&self, spec_hash: String, account_id: AccountId) -> u32 {
        Self::credits_map()
            .get(&(spec_hash, account_id))
            .copied()
            .unwrap_or(0)
    }

    pub fn get_market(&self, market_id: u64) -> Option<Item> {
        self.items.get(&market_key(market_id)).cloned()
    }

    pub fn get_request(&self, request_id: String) -> Option<Item> {
        if !request_id.starts_with("req:") {
            return None;
        }
        self.items.get(&request_id).cloned()
    }

    pub fn get_verdict(&self, id: String) -> Option<VerdictView> {
        self.verdicts.get(&id).map(|record| VerdictView {
            id: record.id.clone(),
            verdict: serde_json::from_str(&record.verdict.0).expect("stored verdict JSON"),
            tee: record.tee,
            submitted_by: record.submitted_by.clone(),
            attempt: record.attempt,
            received_at_ns: record.received_at_ns,
            outlayer: record
                .outlayer
                .as_ref()
                .map(|value| serde_json::from_str(&value.0).expect("stored outlayer JSON")),
            applied_on_unavailable: record.applied_on_unavailable,
        })
    }

    pub fn get_config(&self) -> Value {
        json!({
            "version":"1.0.0", "owner":self.owner, "noa_contract":self.noa_contract,
            "outlayer_contract":self.outlayer_contract,
            "resolver_source":serde_json::from_str::<Value>(&self.resolver_source).unwrap(),
            "secrets_ref":self.secrets_ref, "treasury":self.treasury,
            "min_deposit":U128(self.min_deposit), "max_attempts":self.max_attempts,
            "resource_limits":serde_json::from_str::<Value>(&self.resource_limits).unwrap(),
            "outlayer_deposit":U128(self.outlayer_deposit),
            "outlayer_gas_tgas":self.outlayer_gas_tgas,
            "resolution_fee":U128(self.resolution_fee), "trusted_keeper":self.trusted_keeper,
        })
    }
}

impl Court {
    fn credits_map() -> LookupMap<(String, AccountId), u32> {
        LookupMap::new(Key::Credits)
    }

    fn assert_owner(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn require_min_deposit(&self) {
        require!(
            env::attached_deposit().as_yoctonear() >= self.min_deposit,
            "insufficient deposit"
        );
    }

    fn take_deposit(&mut self, before: u64) {
        // `store::LookupMap` buffers writes until drop. Flush before charging storage.
        self.specs.flush();
        self.items.flush();
        let bytes = env::storage_usage().saturating_sub(before) as u128;
        let storage_cost = env::storage_byte_cost()
            .as_yoctonear()
            .saturating_mul(bytes);
        let kept = storage_cost
            .checked_add(self.resolution_fee)
            .expect("deposit overflow");
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= kept,
            "deposit below storage plus resolution fee"
        );
        let refund = attached - kept;
        if refund > 0 {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }
    }

    fn balance_floor(&self) -> u128 {
        env::storage_byte_cost()
            .as_yoctonear()
            .saturating_mul(env::storage_usage().saturating_add(STORAGE_BUFFER) as u128)
            .saturating_add(RESERVE)
    }

    fn effective_max(&self, spec: &SpecEntry) -> u8 {
        self.max_attempts
            .min(spec.retry_max_attempts.unwrap_or(self.max_attempts))
    }

    fn trigger_id(&mut self, id: String) -> Promise {
        let mut item = self.items.get(&id).cloned().expect("item not found");
        require!(
            matches!(item.status, Status::Linked | Status::RetryScheduled),
            "item not triggerable"
        );
        let spec = self.specs.get(&item.spec_hash).expect("spec not found");
        let now = env::block_timestamp();
        require!(now >= spec.observation_at_ns, "observation not reached");
        require!(now >= item.retry_at_ns, "retry not due");
        if let Some(deadline) = item.resolution_deadline_ns {
            require!(now <= deadline, "resolution deadline passed");
        }
        require!(
            item.attempts < self.effective_max(spec),
            "attempts exhausted"
        );
        let callback_gas_tgas = GAS_VERDICT.as_tgas().min(280 - self.outlayer_gas_tgas);
        let need = self
            .outlayer_gas_tgas
            .saturating_add(callback_gas_tgas)
            .saturating_add(15);
        require!(
            env::prepaid_gas().as_tgas() >= need,
            "insufficient prepaid gas"
        );
        require!(
            env::account_balance().as_yoctonear()
                >= self.balance_floor().saturating_add(self.outlayer_deposit),
            "insufficient contract balance"
        );
        item.attempts += 1;
        item.pending_seq = item.pending_seq.checked_add(1).expect("sequence overflow");
        item.status = Status::Pending;
        let attempt = item.attempts;
        let seq = item.pending_seq;
        self.items.insert(id.clone(), item);
        let input = json!({"mode":"resolve","spec_json":spec.spec_json,"context":{"request_id":id,"attempt":attempt,"now":null}}).to_string();
        emit("triggered", json!({"id":id,"attempt":attempt}));
        ext_outlayer::ext(self.outlayer_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(self.outlayer_deposit))
            .with_static_gas(Gas::from_tgas(self.outlayer_gas_tgas))
            .request_execution(
                serde_json::from_str(&self.resolver_source).unwrap(),
                Some(serde_json::from_str(&self.resource_limits).unwrap()),
                Some(input),
                self.secrets_ref.as_ref().map(|reference| json!(reference)),
                Some("Json".into()),
                Some(env::current_account_id()),
                None,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(callback_gas_tgas))
                    .on_verdict(id, seq),
            )
    }

    fn process_verdict(
        &mut self,
        id: String,
        parsed: Result<Value, String>,
        tee: bool,
        submitted_by: String,
    ) {
        let mut item = self.items.get(&id).cloned().expect("item not found");
        let spec = self
            .specs
            .get(&item.spec_hash)
            .expect("spec not found")
            .clone();
        let now = env::block_timestamp();
        let raw = parsed.as_ref().ok().cloned();
        let verdict = match parsed.and_then(|value| validate_verdict(value, &spec)) {
            Ok(value) => value,
            Err(reason) => {
                self.reject_verdict(item, reason, &spec, now, raw, tee, submitted_by);
                return;
            }
        };
        let status = verdict["status"].as_str().unwrap();
        let mut applied = false;
        let outcome_index = match status {
            "resolved" => Some(verdict["outcome_index"].as_u64().unwrap() as u8),
            "retry_after" => {
                if item.attempts < self.effective_max(&spec) {
                    let at = parse_rfc3339(verdict["retry_after"].as_str().unwrap()).unwrap();
                    item.status = Status::RetryScheduled;
                    item.retry_at_ns = at.max(now);
                    None
                } else {
                    applied = true;
                    self.apply_unavailable(&mut item, &spec)
                }
            }
            _ => {
                applied = true;
                self.apply_unavailable(&mut item, &spec)
            }
        };
        let outlayer = if tee {
            Some(ValueString(
                json!({
                    "contract":self.outlayer_contract,
                    "source":serde_json::from_str::<Value>(&self.resolver_source).unwrap(),
                    "secrets_ref":self.secrets_ref,
                    "deposit":U128(self.outlayer_deposit),
                })
                .to_string(),
            ))
        } else {
            None
        };
        let record = VerdictRecord {
            id: id.clone(),
            verdict: ValueString(verdict.to_string()),
            tee,
            submitted_by,
            attempt: item.attempts,
            received_at_ns: now,
            outlayer,
            applied_on_unavailable: applied,
        };
        self.verdicts.insert(id.clone(), record);
        item.last_error = None;
        if let Some(index) = outcome_index {
            item.status = Status::Resolved;
            item.outcome_index = Some(index);
            if let Some(market_id) = item.market_id {
                item.forwarded = None;
                self.items.insert(id.clone(), item);
                self.forward(market_id, index).detach();
            } else {
                self.send_callback_once(&mut item);
                self.items.insert(id.clone(), item);
            }
        } else {
            if item.status == Status::Unresolvable {
                self.send_callback_once(&mut item);
            }
            self.items.insert(id.clone(), item);
        }
        emit(
            "verdict_received",
            json!({"id":id,"status":status,"tee":tee}),
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn reject_verdict(
        &mut self,
        mut item: Item,
        reason: String,
        spec: &SpecEntry,
        now: u64,
        raw: Option<Value>,
        tee: bool,
        submitted_by: String,
    ) {
        env::log_str(&format!("verdict rejected: {reason}"));
        item.last_error = Some(reason.clone());
        let exhausted = item.attempts >= self.effective_max(spec);
        if !exhausted {
            item.status = Status::RetryScheduled;
            item.retry_at_ns = now.saturating_add(spec.retry_every_ns);
        } else {
            let index = self.apply_unavailable(&mut item, spec);
            if let Some(index) = index {
                item.status = Status::Resolved;
                item.outcome_index = Some(index);
                if let Some(market_id) = item.market_id {
                    item.forwarded = None;
                    self.forward(market_id, index).detach();
                }
            }
        }
        let stored = raw.or_else(|| {
            exhausted.then(|| {
                json!({
                    "v":1,"mode":"resolve","spec_hash":spec.spec_hash,
                    "status":"unresolvable","reason":reason,"sources":[],
                    "outcome":null,"outcome_index":null,"retry_after":null,
                })
            })
        });
        if let Some(raw) = stored {
            let outlayer = if tee {
                Some(ValueString(
                    json!({
                        "contract":self.outlayer_contract,
                        "source":serde_json::from_str::<Value>(&self.resolver_source).unwrap(),
                        "secrets_ref":self.secrets_ref,
                        "deposit":U128(self.outlayer_deposit),
                    })
                    .to_string(),
                ))
            } else {
                None
            };
            self.verdicts.insert(
                item.id.clone(),
                VerdictRecord {
                    id: item.id.clone(),
                    verdict: ValueString(raw.to_string()),
                    tee: tee && !exhausted,
                    submitted_by,
                    attempt: item.attempts,
                    received_at_ns: now,
                    outlayer,
                    applied_on_unavailable: exhausted,
                },
            );
        }
        if exhausted && item.market_id.is_none() {
            self.send_callback_once(&mut item);
        }
        let id = item.id.clone();
        self.items.insert(id.clone(), item);
        emit("verdict_rejected", json!({"id":id,"reason":reason}));
    }

    fn apply_unavailable(&self, item: &mut Item, spec: &SpecEntry) -> Option<u8> {
        if spec.on_unavailable == "void" {
            item.status = Status::Unresolvable;
            None
        } else {
            Some(
                spec.outcomes
                    .iter()
                    .position(|name| *name == spec.on_unavailable)
                    .unwrap() as u8,
            )
        }
    }

    fn forward(&self, market_id: u64, index: u8) -> Promise {
        ext_noa::ext(self.noa_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FORWARD)
            .resolve_market(market_id, index)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FORWARD_CB)
                    .on_forwarded(market_id),
            )
    }

    fn send_callback_once(&self, item: &mut Item) {
        if item.callback_sent {
            return;
        }
        let Some(callback) = &item.callback else {
            return;
        };
        let Some(record) = self.get_verdict(item.id.clone()) else {
            return;
        };
        item.callback_sent = true;
        Promise::new(callback.contract_id.clone())
            .function_call(
                callback.method.clone(),
                json!({"request_id":item.id,"verdict":record})
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_CALLBACK,
            )
            .detach();
        emit(
            "callback_sent",
            json!({"id":item.id,"contract_id":callback.contract_id}),
        );
    }
}

fn market_key(market_id: u64) -> String {
    format!("noa:{market_id}")
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard":"noacourt","version":"1.0.0","event":event,"data":[data]})
    ));
}

fn valid_method(method: &str) -> bool {
    !method.is_empty()
        && method.len() <= 64
        && method
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn spec_hash(spec_json: &str) -> String {
    let hash = env::sha256(spec_json.as_bytes());
    let mut result = String::from("sha256:");
    for byte in hash {
        result.push_str(&format!("{byte:02x}"));
    }
    result
}

fn parse_spec(spec_json: &str, spec_hash: String, registered_by: AccountId) -> SpecEntry {
    require!(spec_json.len() <= MAX_SPEC, "spec too large");
    let parsed: SpecInput = serde_json::from_str(spec_json).expect("invalid spec JSON");
    require!(parsed.version == 1, "unsupported spec version");
    require!(
        (2..=10).contains(&parsed.outcomes.len()),
        "outcomes must have 2..=10 entries"
    );
    require!(
        parsed.outcomes.iter().all(|name| !name.is_empty()),
        "empty outcome name"
    );
    for (index, name) in parsed.outcomes.iter().enumerate() {
        require!(
            !parsed.outcomes[..index].contains(name),
            "duplicate outcome name"
        );
    }
    require!(
        parsed.on_unavailable == "void" || parsed.outcomes.contains(&parsed.on_unavailable),
        "invalid on_unavailable"
    );
    let observation_at_ns = parse_rfc3339(&parsed.observation.at).expect("invalid observation.at");
    let (retry_max_attempts, retry_every_ns) = match parsed.retry {
        Some(retry) => {
            require!(
                retry.max_attempts > 0,
                "retry.max_attempts must be positive"
            );
            (
                Some(retry.max_attempts),
                parse_duration(&retry.every).expect("invalid retry.every"),
            )
        }
        None => (None, 0),
    };
    SpecEntry {
        spec_json: spec_json.to_string(),
        spec_hash,
        credits: 1,
        registered_by,
        observation_at_ns,
        outcomes: parsed.outcomes,
        retry_max_attempts,
        retry_every_ns,
        on_unavailable: parsed.on_unavailable,
    }
}

fn parse_outlayer(bytes: &[u8]) -> Result<Value, String> {
    let mut value: Value =
        serde_json::from_slice(bytes).map_err(|_| "invalid verdict JSON".to_string())?;
    for _ in 0..4 {
        match value {
            Value::String(ref text) => {
                value = serde_json::from_str(text)
                    .map_err(|_| "invalid nested verdict JSON".to_string())?
            }
            Value::Object(ref mut map) if map.contains_key("success") => {
                if map.get("success").and_then(Value::as_bool) != Some(true) {
                    return Err(format!(
                        "outlayer: {}",
                        map.get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("worker failed")
                            .chars()
                            .take(100)
                            .collect::<String>()
                    ));
                }
                value = map.remove("output").unwrap_or(Value::Null);
            }
            _ => break,
        }
    }
    if !value.is_object() {
        return Err("verdict must be an object".into());
    }
    Ok(value)
}

fn validate_verdict(value: Value, spec: &SpecEntry) -> Result<Value, String> {
    if value["v"].as_u64() != Some(1) {
        return Err("bad verdict version".into());
    }
    if value["mode"].as_str() != Some("resolve") {
        return Err("bad verdict mode".into());
    }
    if value["spec_hash"].as_str() != Some(spec.spec_hash.as_str()) {
        return Err("spec_hash mismatch".into());
    }
    match value["status"].as_str() {
        Some("resolved") => {
            let index = usize::try_from(
                value["outcome_index"]
                    .as_u64()
                    .ok_or("missing outcome_index")?,
            )
            .map_err(|_| "outcome_index out of range")?;
            if index >= spec.outcomes.len()
                || value["outcome"].as_str() != Some(spec.outcomes[index].as_str())
            {
                return Err("outcome mismatch".into());
            }
        }
        Some("retry_after") => {
            let at = value["retry_after"].as_str().ok_or("missing retry_after")?;
            parse_rfc3339(at).ok_or("invalid retry_after")?;
        }
        Some("unresolvable") => {}
        _ => return Err("bad verdict status".into()),
    }
    Ok(value)
}

fn parse_duration(input: &str) -> Option<u64> {
    if input.len() < 2 {
        return None;
    }
    let (digits, unit) = input.split_at(input.len() - 1);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let number: u64 = digits.parse().ok()?;
    let seconds = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86400,
        _ => return None,
    };
    number.checked_mul(seconds)?.checked_mul(1_000_000_000)
}

fn parse_rfc3339(input: &str) -> Option<u64> {
    let body = input
        .strip_suffix('Z')
        .or_else(|| input.strip_suffix("+00:00"))?;
    let bytes = body.as_bytes();
    if bytes.len() < 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let part = |a: usize, b: usize| -> Option<u32> {
        let value = bytes.get(a..b)?;
        if !value.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(value).ok()?.parse().ok()
    };
    let year = part(0, 4)? as i64;
    let month = part(5, 7)?;
    let day = part(8, 10)?;
    let hour = part(11, 13)?;
    let minute = part(14, 16)?;
    let second = part(17, 19)?;
    if year < 1970 || !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day == 0 || day > days_in_month[(month - 1) as usize] {
        return None;
    }
    let fraction = if bytes.len() == 19 {
        0
    } else {
        if bytes[19] != b'.' || bytes.len() > 29 || bytes.len() == 20 {
            return None;
        }
        let digits = &bytes[20..];
        if !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        let raw: u32 = std::str::from_utf8(digits).ok()?.parse().ok()?;
        raw.checked_mul(10u32.pow(9 - digits.len() as u32))?
    };
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year / 400;
    let yoe = adjusted_year - era * 400;
    let adjusted_month = month as i64 + if month > 2 { -3 } else { 9 };
    let doy = (153 * adjusted_month + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let seconds = (days as u64)
        .checked_mul(86400)?
        .checked_add(hour as u64 * 3600 + minute as u64 * 60 + second as u64)?;
    seconds
        .checked_mul(1_000_000_000)?
        .checked_add(fraction as u64)
}

#[cfg(test)]
mod tests;
