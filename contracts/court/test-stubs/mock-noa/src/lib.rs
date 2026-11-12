use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::LookupMap;
use near_sdk::{assert_one_yocto, env, near, AccountId, PanicOnDefault};

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct Outcome {
    pub id: u8,
    pub name: String,
}

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, near_sdk::NearSchema)]
#[abi(json)]
#[serde(crate = "near_sdk::serde")]
pub struct Market {
    pub id: u64,
    pub creator: AccountId,
    pub title: String,
    pub metadata_hash: String,
    pub outcomes: Vec<Outcome>,
    pub expiration_time: u64,
    pub resolution_deadline: u64,
    pub resolver: AccountId,
    pub status: String,
    pub winning_outcome: Option<u8>,
    pub pending_proposal: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockNoa {
    owner: AccountId,
    markets: LookupMap<u64, Market>,
    next_market: u64,
    last_callback: Option<String>,
    callback_count: u32,
}

#[near]
impl MockNoa {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            markets: LookupMap::new(b"m"),
            next_market: 0,
            last_callback: None,
            callback_count: 0,
        }
    }

    pub fn create_market(
        &mut self,
        title: String,
        metadata_hash: String,
        outcomes: Vec<String>,
        expiration_time: u64,
        resolution_deadline: u64,
        resolver: AccountId,
    ) -> u64 {
        assert!(outcomes.len() >= 2);
        assert!(expiration_time < resolution_deadline);
        self.next_market += 1;
        let id = self.next_market;
        self.markets.insert(
            id,
            Market {
                id,
                creator: env::predecessor_account_id(),
                title,
                metadata_hash,
                outcomes: outcomes
                    .into_iter()
                    .enumerate()
                    .map(|(id, name)| Outcome { id: id as u8, name })
                    .collect(),
                expiration_time,
                resolution_deadline,
                resolver,
                status: "Active".into(),
                winning_outcome: None,
                pending_proposal: false,
            },
        );
        id
    }

    pub fn get_market(&self, market_id: u64) -> Option<Market> {
        self.markets.get(&market_id).cloned()
    }

    #[payable]
    pub fn resolve_market(&mut self, market_id: u64, winning_outcome: u8) {
        assert_one_yocto();
        let mut market = self
            .markets
            .get(&market_id)
            .cloned()
            .expect("Market not found");
        assert_eq!(
            env::predecessor_account_id(),
            market.resolver,
            "Only resolver can resolve market"
        );
        assert_eq!(market.status, "Active", "Market is not active");
        assert!(
            env::block_timestamp() > market.expiration_time,
            "Cannot resolve before expiration"
        );
        assert!(
            env::block_timestamp() <= market.resolution_deadline,
            "Resolution deadline has passed"
        );
        assert!(
            (winning_outcome as usize) < market.outcomes.len(),
            "Invalid winning outcome"
        );
        assert!(!market.pending_proposal, "Resolution already proposed");
        market.pending_proposal = true;
        market.winning_outcome = Some(winning_outcome);
        self.markets.insert(market_id, market);
    }

    #[payable]
    pub fn void_market(&mut self, market_id: u64) {
        assert_one_yocto();
        let mut market = self
            .markets
            .get(&market_id)
            .cloned()
            .expect("Market not found");
        assert!(
            env::predecessor_account_id() == self.owner
                || env::predecessor_account_id() == market.resolver,
            "Only owner or resolver can void market"
        );
        assert_eq!(market.status, "Active", "Market is not active");
        assert!(
            env::block_timestamp() > market.resolution_deadline,
            "Cannot void before resolution deadline"
        );
        assert!(!market.pending_proposal, "Resolution proposal pending");
        market.status = "Void".into();
        self.markets.insert(market_id, market);
    }

    pub fn on_court_verdict(&mut self, request_id: String, verdict: near_sdk::serde_json::Value) {
        self.last_callback = Some(
            near_sdk::serde_json::json!({"request_id":request_id,"verdict":verdict}).to_string(),
        );
        self.callback_count += 1;
    }

    pub fn last_callback(&self) -> Option<String> {
        self.last_callback.clone()
    }
    pub fn callback_count(&self) -> u32 {
        self.callback_count
    }
}
