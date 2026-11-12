use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOutLayer {
    response: String,
    fail: bool,
    last_request: Option<String>,
    requests: u32,
}

#[near]
impl MockOutLayer {
    #[init]
    pub fn new() -> Self {
        Self {
            response: "null".into(),
            fail: false,
            last_request: None,
            requests: 0,
        }
    }

    pub fn set_response(&mut self, response: String, fail: Option<bool>) {
        self.response = response;
        self.fail = fail.unwrap_or(false);
    }

    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<String>,
        payer_account_id: Option<AccountId>,
        params: Option<Value>,
    ) {
        assert!(
            env::attached_deposit() >= NearToken::from_millinear(10),
            "Minimum deposit is 0.01 NEAR"
        );
        assert!(resource_limits.is_some(), "resource_limits required");
        self.requests += 1;
        self.last_request = Some(
            json!({
                "source":source,"resource_limits":resource_limits,"input_data":input_data,
                "secrets_ref":secrets_ref,"response_format":response_format,
                "payer_account_id":payer_account_id,"params":params,
                "deposit":env::attached_deposit().as_yoctonear().to_string(),
                "predecessor":env::predecessor_account_id(),
            })
            .to_string(),
        );
        if self.fail {
            env::panic_str("mock worker failure");
        }
        let value: Value = serde_json::from_str(&self.response).expect("canned response JSON");
        env::value_return(serde_json::to_vec(&value).unwrap().as_slice());
    }

    pub fn last_request(&self) -> Option<String> {
        self.last_request.clone()
    }
    pub fn requests(&self) -> u32 {
        self.requests
    }
}
