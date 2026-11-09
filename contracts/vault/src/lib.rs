//! BaitNet Vault (M3 / D12).
//!
//! The owner deposits NEAR. A single agent account may move funds out with
//! `pay(to, amount)` — and only after the AlertRegistry says `to` is clean.
//! The agent is expected to sign with a function-call access key restricted to
//! this contract and the `pay` method, so even a fully prompt-injected agent
//! cannot pay a flagged address, exceed the limits, or move NEAR any other way.
//!
//! Flow: pay -> registry.check("near", to) -> on_check
//!   * Active L1/L2 alert, or registry unreachable -> `pay_blocked` event, tx fails
//!   * clean (None, or Disputed)                    -> transfer -> on_transfer -> `paid`

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue};

pub const EVENT_STANDARD: &str = "baitnet";
pub const EVENT_VERSION: &str = "1.0.0";

pub const NS_PER_DAY: u64 = 86_400 * 1_000_000_000;
pub const GAS_CHECK: Gas = Gas::from_tgas(10);
pub const GAS_ON_CHECK: Gas = Gas::from_tgas(30);
pub const GAS_ON_TRANSFER: Gas = Gas::from_tgas(10);
pub const GAS_FAIL: Gas = Gas::from_tgas(3);
/// Recommended gas for the agent's `pay` call.
pub const RECOMMENDED_PAY_GAS: Gas = Gas::from_tgas(100);

/// Subset of the registry's `AlertView` that the vault cares about.
/// Unknown fields are ignored so the registry view can grow.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RegistryAlert {
    pub id: u64,
    pub level: String,
    pub status: String,
}

impl RegistryAlert {
    pub fn blocks_payment(&self) -> bool {
        self.status == "Active" && (self.level == "L1" || self.level == "L2")
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct VaultConfig {
    pub owner: AccountId,
    pub agent: AccountId,
    pub registry: AccountId,
    pub per_tx_limit: U128,
    pub daily_limit: U128,
    /// UTC day index (block_timestamp / 1 day) the counter below belongs to.
    pub day: U64,
    /// Spent + in-flight today (counter resets when `day` changes).
    pub spent_today: U128,
    /// Reserved by pays waiting for the registry answer.
    pub pending: U128,
    /// Balance the agent could still move (excludes storage reserve and pending).
    pub available: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    agent: AccountId,
    registry: AccountId,
    per_tx_limit: u128,
    daily_limit: u128,
    day: u64,
    spent_today: u128,
    pending: u128,
}

#[near]
impl Vault {
    /// Only the contract account itself can initialize (deploy + init call).
    #[init]
    #[private]
    pub fn new(owner: AccountId, agent: AccountId, registry: AccountId, per_tx_limit: U128, daily_limit: U128) -> Self {
        validate_limits(per_tx_limit.0, daily_limit.0);
        require!(agent != owner, "ERR_AGENT_IS_OWNER");
        Self {
            owner,
            agent,
            registry,
            per_tx_limit: per_tx_limit.0,
            daily_limit: daily_limit.0,
            day: today(),
            spent_today: 0,
            pending: 0,
        }
    }

    // ----------------------------- funding -------------------------------

    /// Anyone (normally the owner) can top up the vault.
    #[payable]
    pub fn deposit(&mut self) {
        let amount = env::attached_deposit();
        require!(!amount.is_zero(), "ERR_ZERO_DEPOSIT");
        emit("deposit", json!({ "from": env::predecessor_account_id(), "amount": U128(amount.as_yoctonear()) }));
    }

    /// Owner withdraws (all available if `amount` is omitted).
    pub fn withdraw(&mut self, amount: Option<U128>) -> Promise {
        self.assert_owner();
        let available = self.available();
        let amount = amount.map(|a| a.0).unwrap_or(available);
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        require!(amount <= available, "ERR_INSUFFICIENT_BALANCE");
        emit("withdraw", json!({ "to": self.owner, "amount": U128(amount) }));
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount))
    }

    // ----------------------------- agent ---------------------------------

    /// Agent only. Not payable on purpose: function-call keys cannot attach
    /// deposits. Attach ~100 TGas. The transaction fails (final status
    /// Failure) when the payment is blocked; a `pay_blocked` event is still
    /// logged by the callback receipt.
    pub fn pay(&mut self, to: AccountId, amount: U128) -> Promise {
        require!(env::predecessor_account_id() == self.agent, "ERR_NOT_AGENT");
        let amount = amount.0;
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        require!(to != env::current_account_id(), "ERR_PAY_SELF");
        require!(amount <= self.per_tx_limit, "ERR_PER_TX_LIMIT");
        self.roll_day();
        require!(self.spent_today.saturating_add(amount) <= self.daily_limit, "ERR_DAILY_LIMIT");
        require!(amount <= self.available(), "ERR_INSUFFICIENT_BALANCE");

        // Reserve before the async call so concurrent pays cannot exceed limits.
        self.spent_today += amount;
        self.pending += amount;
        let day = self.day;
        emit("pay_requested", json!({ "to": to, "amount": U128(amount), "agent": self.agent }));

        Promise::new(self.registry.clone())
            .function_call(
                "check".to_string(),
                serde_json::to_vec(&json!({ "chain": "near", "address": to })).unwrap(),
                NearToken::from_yoctonear(0),
                GAS_CHECK,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_CHECK)
                    .on_check(to, U128(amount), U64(day)),
            )
    }

    #[private]
    pub fn on_check(
        &mut self,
        #[callback_result] result: Result<Option<RegistryAlert>, PromiseError>,
        to: AccountId,
        amount: U128,
        day: U64,
    ) -> Promise {
        let amount_u = amount.0;
        self.pending = self.pending.saturating_sub(amount_u);
        let blocked: Option<(String, serde_json::Value)> = match &result {
            Err(_) => Some(("registry_unavailable".into(), json!(null))),
            Ok(Some(alert)) if alert.blocks_payment() => Some((
                "flagged".into(),
                json!({ "alert_id": alert.id, "level": alert.level, "status": alert.status }),
            )),
            _ => None,
        };

        if let Some((reason, alert)) = blocked {
            self.release(amount_u, day.0);
            emit(
                "pay_blocked",
                json!({ "to": to, "amount": amount, "reason": reason, "alert": alert, "registry": self.registry }),
            );
            return fail(format!("PAY_BLOCKED: {} is flagged or could not be checked ({})", to, reason));
        }

        // Balance can only have dropped through withdraw since `pay`.
        if amount_u > self.available_with_pending(0) {
            self.release(amount_u, day.0);
            emit("pay_failed", json!({ "to": to, "amount": amount, "reason": "insufficient_balance" }));
            return fail("PAY_FAILED: insufficient balance".to_string());
        }

        let registry_status = match &result {
            Ok(Some(a)) => Some(a.status.clone()),
            _ => None,
        };
        Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount_u)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_TRANSFER)
                .on_transfer(to, amount, day, registry_status),
        )
    }

    #[private]
    pub fn on_transfer(
        &mut self,
        to: AccountId,
        amount: U128,
        day: U64,
        registry_status: Option<String>,
    ) -> PromiseOrValue<bool> {
        // A transfer's result is empty on success.
        match env::promise_result_checked(0, 0) {
            Ok(_) => {
                emit(
                    "paid",
                    json!({ "to": to, "amount": amount, "agent": self.agent, "registry_status": registry_status }),
                );
                PromiseOrValue::Value(true)
            }
            Err(_) => {
                // The runtime refunds the deposit to the vault.
                self.release(amount.0, day.0);
                emit("pay_failed", json!({ "to": to, "amount": amount, "reason": "transfer_failed" }));
                PromiseOrValue::Promise(fail(format!("PAY_FAILED: transfer to {} failed", to)))
            }
        }
    }

    /// Terminal failure so the caller's transaction status is Failure.
    #[private]
    pub fn fail_payment(&self, reason: String) {
        env::panic_str(&reason);
    }

    // ----------------------------- owner ---------------------------------

    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        require!(agent != self.owner, "ERR_AGENT_IS_OWNER");
        self.agent = agent;
        self.emit_config();
    }

    pub fn set_limits(&mut self, per_tx_limit: U128, daily_limit: U128) {
        self.assert_owner();
        validate_limits(per_tx_limit.0, daily_limit.0);
        self.per_tx_limit = per_tx_limit.0;
        self.daily_limit = daily_limit.0;
        self.emit_config();
    }

    pub fn set_registry(&mut self, registry: AccountId) {
        self.assert_owner();
        self.registry = registry;
        self.emit_config();
    }

    // ----------------------------- views ---------------------------------

    pub fn get_config(&self) -> VaultConfig {
        let (day, spent) = if today() == self.day { (self.day, self.spent_today) } else { (today(), 0) };
        VaultConfig {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            registry: self.registry.clone(),
            per_tx_limit: U128(self.per_tx_limit),
            daily_limit: U128(self.daily_limit),
            day: U64(day),
            spent_today: U128(spent),
            pending: U128(self.pending),
            available: U128(self.available()),
        }
    }
}

impl Vault {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "ERR_NOT_OWNER");
    }

    fn roll_day(&mut self) {
        let d = today();
        if d != self.day {
            self.day = d;
            self.spent_today = 0;
        }
    }

    /// Give back a reservation made on `day` (no-op if the day already rolled).
    fn release(&mut self, amount: u128, day: u64) {
        if day == self.day {
            self.spent_today = self.spent_today.saturating_sub(amount);
        }
    }

    fn available(&self) -> u128 {
        self.available_with_pending(self.pending)
    }

    fn available_with_pending(&self, pending: u128) -> u128 {
        let storage = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        env::account_balance()
            .as_yoctonear()
            .saturating_sub(env::account_locked_balance().as_yoctonear())
            .saturating_sub(storage)
            .saturating_sub(pending)
    }

    fn emit_config(&self) {
        emit(
            "config_updated",
            json!({
                "agent": self.agent,
                "registry": self.registry,
                "per_tx_limit": U128(self.per_tx_limit),
                "daily_limit": U128(self.daily_limit),
            }),
        );
    }
}

fn today() -> u64 {
    env::block_timestamp() / NS_PER_DAY
}

fn validate_limits(per_tx: u128, daily: u128) {
    require!(per_tx > 0 && daily > 0, "ERR_ZERO_LIMIT");
    require!(per_tx <= daily, "ERR_PER_TX_ABOVE_DAILY");
}

fn fail(reason: String) -> Promise {
    Promise::new(env::current_account_id()).function_call(
        "fail_payment".to_string(),
        serde_json::to_vec(&json!({ "reason": reason })).unwrap(),
        NearToken::from_yoctonear(0),
        GAS_FAIL,
    )
}

/// NEP-297 event log.
pub fn emit(event: &str, data: serde_json::Value) {
    let ev = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", ev));
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::mock::MockAction;
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

    const NEAR: u128 = 10u128.pow(24);
    const T0: u64 = 1_700_000_000_000_000_000;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(predecessor: &str, ts: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("vault.test"))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(predecessor))
            .account_balance(NearToken::from_near(100))
            .block_timestamp(ts);
        b
    }

    fn as_(who: &str) {
        testing_env!(ctx(who, T0).build());
    }

    fn with_result(result: PromiseResult) {
        testing_env!(
            ctx("vault.test", T0).build(),
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![result],
        );
    }

    fn setup() -> Vault {
        as_("vault.test");
        Vault::new(acc("owner.test"), acc("agent.test"), acc("registry.test"), U128(5 * NEAR), U128(8 * NEAR))
    }

    fn events() -> Vec<serde_json::Value> {
        get_logs()
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|j| serde_json::from_str(j).unwrap())
            .collect()
    }

    fn called_methods() -> Vec<(String, String)> {
        get_created_receipts()
            .iter()
            .flat_map(|r| {
                r.actions.iter().filter_map(move |a| match a {
                    MockAction::FunctionCallWeight { method_name, .. } => {
                        Some((r.receiver_id.to_string(), String::from_utf8(method_name.clone()).unwrap()))
                    }
                    MockAction::Transfer { .. } => Some((r.receiver_id.to_string(), "<transfer>".into())),
                    _ => None,
                })
            })
            .collect()
    }

    fn alert_json(level: &str, status: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "id": 7, "chain": "near", "address": "scam.test", "level": level, "category": "investment",
            "evidence_hash": "00", "evidence_hashes": ["00"], "status": status, "reporter": "bait.test",
            "created_at": "1", "updated_at": "1", "status_reason_hash": null
        }))
        .unwrap()
    }

    #[test]
    fn pay_calls_registry_check_and_reserves() {
        let mut v = setup();
        as_("agent.test");
        let _ = v.pay(acc("shop.test"), U128(2 * NEAR));
        let calls = called_methods();
        assert!(calls.contains(&("registry.test".into(), "check".into())));
        assert!(calls.contains(&("vault.test".into(), "on_check".into())));
        let c = v.get_config();
        assert_eq!(c.spent_today.0, 2 * NEAR);
        assert_eq!(c.pending.0, 2 * NEAR);
        assert_eq!(events()[0]["event"], "pay_requested");
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_AGENT")]
    fn owner_cannot_pay() {
        let mut v = setup();
        as_("owner.test");
        let _ = v.pay(acc("shop.test"), U128(NEAR));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_AGENT")]
    fn stranger_cannot_pay() {
        let mut v = setup();
        as_("mallory.test");
        let _ = v.pay(acc("mallory.test"), U128(NEAR));
    }

    #[test]
    #[should_panic(expected = "ERR_PER_TX_LIMIT")]
    fn per_tx_limit() {
        let mut v = setup();
        as_("agent.test");
        let _ = v.pay(acc("shop.test"), U128(5 * NEAR + 1));
    }

    #[test]
    #[should_panic(expected = "ERR_DAILY_LIMIT")]
    fn daily_limit_counts_in_flight() {
        let mut v = setup();
        as_("agent.test");
        let _ = v.pay(acc("shop.test"), U128(5 * NEAR));
        let _ = v.pay(acc("shop.test"), U128(4 * NEAR));
    }

    #[test]
    fn daily_limit_resets_next_day() {
        let mut v = setup();
        as_("agent.test");
        let _ = v.pay(acc("shop.test"), U128(5 * NEAR));
        // simulate the callback freeing the pending reservation
        with_result(PromiseResult::Successful(b"null".to_vec()));
        let _ = v.on_check(Ok(None), acc("shop.test"), U128(5 * NEAR), U64(T0 / NS_PER_DAY));
        testing_env!(ctx("agent.test", T0 + NS_PER_DAY).build());
        let _ = v.pay(acc("shop.test"), U128(5 * NEAR));
        assert_eq!(v.get_config().spent_today.0, 5 * NEAR);
    }

    #[test]
    #[should_panic(expected = "ERR_ZERO_AMOUNT")]
    fn zero_amount() {
        let mut v = setup();
        as_("agent.test");
        let _ = v.pay(acc("shop.test"), U128(0));
    }

    #[test]
    #[should_panic(expected = "ERR_INSUFFICIENT_BALANCE")]
    fn cannot_pay_more_than_balance() {
        as_("vault.test");
        let mut v = Vault::new(
            acc("owner.test"),
            acc("agent.test"),
            acc("registry.test"),
            U128(500 * NEAR),
            U128(500 * NEAR),
        );
        as_("agent.test");
        let _ = v.pay(acc("shop.test"), U128(200 * NEAR));
    }

    #[test]
    fn active_l1_blocks_and_releases() {
        let mut v = setup();
        as_("agent.test");
        let _ = v.pay(acc("scam.test"), U128(2 * NEAR));
        with_result(PromiseResult::Successful(alert_json("L1", "Active")));
        let alert: RegistryAlert = serde_json::from_slice(&alert_json("L1", "Active")).unwrap();
        let _ = v.on_check(Ok(Some(alert)), acc("scam.test"), U128(2 * NEAR), U64(T0 / NS_PER_DAY));
        let ev = events();
        assert_eq!(ev[0]["event"], "pay_blocked");
        assert_eq!(ev[0]["data"][0]["reason"], "flagged");
        assert_eq!(ev[0]["data"][0]["alert"]["alert_id"], 7);
        let calls = called_methods();
        assert!(calls.contains(&("vault.test".into(), "fail_payment".into())));
        assert!(!calls.iter().any(|(_, m)| m == "<transfer>"));
        let c = v.get_config();
        assert_eq!((c.spent_today.0, c.pending.0), (0, 0));
    }

    #[test]
    fn active_l2_blocks() {
        let a: RegistryAlert = serde_json::from_slice(&alert_json("L2", "Active")).unwrap();
        assert!(a.blocks_payment());
    }

    #[test]
    fn disputed_revoked_l3_do_not_block() {
        for (l, s) in [("L1", "Disputed"), ("L1", "Revoked"), ("L3", "Active")] {
            let a: RegistryAlert = serde_json::from_slice(&alert_json(l, s)).unwrap();
            assert!(!a.blocks_payment(), "{l} {s}");
        }
    }

    #[test]
    fn registry_failure_fails_closed() {
        let mut v = setup();
        as_("agent.test");
        let _ = v.pay(acc("shop.test"), U128(NEAR));
        with_result(PromiseResult::Failed);
        let _ = v.on_check(Err(PromiseError::Failed), acc("shop.test"), U128(NEAR), U64(T0 / NS_PER_DAY));
        assert_eq!(events()[0]["event"], "pay_blocked");
        assert_eq!(events()[0]["data"][0]["reason"], "registry_unavailable");
        assert!(called_methods().contains(&("vault.test".into(), "fail_payment".into())));
    }

    #[test]
    fn clean_address_transfers_then_emits_paid() {
        let mut v = setup();
        as_("agent.test");
        let _ = v.pay(acc("shop.test"), U128(NEAR));
        with_result(PromiseResult::Successful(b"null".to_vec()));
        let _ = v.on_check(Ok(None), acc("shop.test"), U128(NEAR), U64(T0 / NS_PER_DAY));
        let calls = called_methods();
        assert!(calls.contains(&("shop.test".into(), "<transfer>".into())));
        assert!(calls.contains(&("vault.test".into(), "on_transfer".into())));
        assert_eq!(v.get_config().pending.0, 0);
        assert_eq!(v.get_config().spent_today.0, NEAR);

        with_result(PromiseResult::Successful(vec![]));
        assert!(matches!(
            v.on_transfer(acc("shop.test"), U128(NEAR), U64(T0 / NS_PER_DAY), None),
            PromiseOrValue::Value(true)
        ));
        assert_eq!(events()[0]["event"], "paid");
        assert_eq!(events()[0]["standard"], "baitnet");
        assert_eq!(events()[0]["version"], "1.0.0");
    }

    #[test]
    fn failed_transfer_releases_and_fails() {
        let mut v = setup();
        as_("agent.test");
        let _ = v.pay(acc("ghost.test"), U128(NEAR));
        with_result(PromiseResult::Failed);
        let _ = v.on_check(Ok(None), acc("ghost.test"), U128(NEAR), U64(T0 / NS_PER_DAY));
        let r = v.on_transfer(acc("ghost.test"), U128(NEAR), U64(T0 / NS_PER_DAY), None);
        assert!(matches!(r, PromiseOrValue::Promise(_)));
        assert_eq!(events().last().unwrap()["event"], "pay_failed");
        assert_eq!(v.get_config().spent_today.0, 0);
    }

    #[test]
    #[should_panic(expected = "PAY_BLOCKED")]
    fn fail_payment_panics() {
        let v = setup();
        as_("vault.test");
        v.fail_payment("PAY_BLOCKED: x".into());
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn agent_cannot_change_limits() {
        let mut v = setup();
        as_("agent.test");
        v.set_limits(U128(100 * NEAR), U128(100 * NEAR));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn agent_cannot_withdraw() {
        let mut v = setup();
        as_("agent.test");
        let _ = v.withdraw(None);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn agent_cannot_swap_registry() {
        let mut v = setup();
        as_("agent.test");
        v.set_registry(acc("fake-registry.test"));
    }

    #[test]
    #[should_panic(expected = "ERR_PER_TX_ABOVE_DAILY")]
    fn limits_validated() {
        let mut v = setup();
        as_("owner.test");
        v.set_limits(U128(10 * NEAR), U128(NEAR));
    }

    #[test]
    fn owner_config_and_withdraw() {
        let mut v = setup();
        as_("owner.test");
        v.set_limits(U128(NEAR), U128(2 * NEAR));
        v.set_agent(acc("agent2.test"));
        assert_eq!(events()[0]["event"], "config_updated");
        let c = v.get_config();
        assert_eq!(c.agent, acc("agent2.test"));
        assert_eq!(c.per_tx_limit.0, NEAR);
        let _ = v.withdraw(Some(U128(NEAR)));
        assert!(called_methods().contains(&("owner.test".into(), "<transfer>".into())));
    }

    #[test]
    fn deposit_emits_event() {
        let mut v = setup();
        testing_env!(ctx("owner.test", T0).attached_deposit(NearToken::from_near(3)).build());
        v.deposit();
        assert_eq!(events()[0]["event"], "deposit");
        assert_eq!(events()[0]["data"][0]["amount"], (3 * NEAR).to_string());
    }

    #[test]
    #[should_panic(expected = "ERR_AGENT_IS_OWNER")]
    fn agent_must_differ_from_owner() {
        as_("vault.test");
        Vault::new(acc("owner.test"), acc("owner.test"), acc("registry.test"), U128(1), U128(1));
    }
}
