//! BaitNet AlertRegistry (M3).
//!
//! A shared, public list of scam receiving addresses. Whitelisted reporters write
//! alerts (only a sha256 of the encrypted-off-chain evidence goes on chain);
//! guards, wallets and solvers read them with `check`. Voluntary responders can
//! publicly acknowledge alerts.
//!
//! JSON uses snake_case; the TS side (`packages/shared`) maps it to camelCase.
//! Timestamps are nanoseconds since epoch, serialized as decimal strings.

use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, IterableSet, LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

pub const EVENT_STANDARD: &str = "baitnet";
pub const EVENT_VERSION: &str = "1.0.0";

pub const MAX_ADDRESS_LEN: usize = 128;
pub const MAX_CATEGORY_LEN: usize = 64;
pub const MAX_NAME_LEN: usize = 64;
/// Evidence hashes kept per alert (first report + appended ones).
pub const MAX_EVIDENCE_PER_ALERT: usize = 32;
pub const DEFAULT_PAGE: u64 = 50;
pub const MAX_PAGE: u64 = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Chain {
    Near,
    Evm,
    Tron,
    Btc,
}

impl Chain {
    pub fn as_str(&self) -> &'static str {
        match self {
            Chain::Near => "near",
            Chain::Evm => "evm",
            Chain::Tron => "tron",
            Chain::Btc => "btc",
        }
    }
}

/// L1 = obtained directly from a bait conversation, L2 = funds linked to an L1,
/// L3 = cluster inference (stored, but never returned by `check`).
/// Declaration order = severity order (L1 is the most severe).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Level {
    L1,
    L2,
    L3,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AlertStatus {
    Active,
    Disputed,
    Revoked,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AckOutcome {
    Seen,
    Blocked,
    Reported,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Alert {
    pub chain: Chain,
    pub address: String,
    pub level: Level,
    pub category: String,
    /// All evidence hashes; index 0 is the original report.
    pub evidence_hashes: Vec<String>,
    pub status: AlertStatus,
    pub reporter: AccountId,
    pub created_at: u64,
    pub updated_at: u64,
    pub status_reason_hash: Option<String>,
}

/// JSON view. Maps to TS `AlertView` (camelCase on the TS side).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AlertView {
    pub id: u64,
    pub chain: Chain,
    pub address: String,
    pub level: Level,
    pub category: String,
    /// Hash from the first report (TS `evidenceHash`).
    pub evidence_hash: String,
    /// All hashes including appended evidence (first element == `evidence_hash`).
    pub evidence_hashes: Vec<String>,
    pub status: AlertStatus,
    pub reporter: AccountId,
    /// ns since epoch (TS `createdAt` = ISO string of this).
    pub created_at: U64,
    pub updated_at: U64,
    pub status_reason_hash: Option<String>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct AckRecord {
    pub responder: AccountId,
    pub outcome: AckOutcome,
    pub at: u64,
}

/// Maps to TS `Ack`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AckView {
    pub alert_id: u64,
    pub responder: AccountId,
    pub outcome: AckOutcome,
    pub at: U64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct ResponderRecord {
    pub name: String,
    pub registered_at: u64,
}

/// Maps to TS `Responder`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ResponderView {
    pub account_id: AccountId,
    pub name: String,
    pub registered_at: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Stats {
    pub total_alerts: u64,
    pub active: u64,
    pub disputed: u64,
    pub revoked: u64,
    pub reporters: u64,
    pub responders: u64,
    pub acks: u64,
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Reporters,
    Alerts,
    LatestByTarget,
    Acks,
    Responders,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AlertRegistry {
    owner: AccountId,
    reporters: IterableSet<AccountId>,
    alerts: Vector<Alert>,
    /// "chain:normalized_address" -> id of the most recent alert for that target.
    latest_by_target: LookupMap<String, u64>,
    acks: LookupMap<u64, Vec<AckRecord>>,
    responders: IterableMap<AccountId, ResponderRecord>,
    active_count: u64,
    disputed_count: u64,
    revoked_count: u64,
    ack_count: u64,
}

#[near]
impl AlertRegistry {
    /// Only the contract account itself can initialize (deploy + init call).
    #[init]
    #[private]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            reporters: IterableSet::new(StorageKey::Reporters),
            alerts: Vector::new(StorageKey::Alerts),
            latest_by_target: LookupMap::new(StorageKey::LatestByTarget),
            acks: LookupMap::new(StorageKey::Acks),
            responders: IterableMap::new(StorageKey::Responders),
            active_count: 0,
            disputed_count: 0,
            revoked_count: 0,
            ack_count: 0,
        }
    }

    // ----------------------------- owner ---------------------------------

    pub fn add_reporter(&mut self, id: AccountId) -> bool {
        self.assert_owner();
        let added = self.reporters.insert(id.clone());
        if added {
            emit("add_reporter", json!({ "account_id": id, "by": env::predecessor_account_id() }));
        }
        added
    }

    pub fn remove_reporter(&mut self, id: AccountId) -> bool {
        self.assert_owner();
        let removed = self.reporters.remove(&id);
        if removed {
            emit("remove_reporter", json!({ "account_id": id, "by": env::predecessor_account_id() }));
        }
        removed
    }

    // ----------------------------- reporters -----------------------------

    /// Creates an alert, or — if the same (chain, address) already has an Active
    /// alert — appends `evidence_hash` to it (and raises its level if the new one
    /// is more severe). Returns the alert id.
    pub fn report(
        &mut self,
        address: String,
        chain: Chain,
        evidence_hash: String,
        level: Level,
        category: String,
    ) -> u64 {
        let caller = env::predecessor_account_id();
        require!(self.reporters.contains(&caller), "ERR_NOT_REPORTER");
        let address = normalize_address(chain, &address).unwrap_or_else(|e| env::panic_str(e));
        let evidence_hash = normalize_hash(&evidence_hash).unwrap_or_else(|e| env::panic_str(e));
        validate_text(&category, MAX_CATEGORY_LEN, "ERR_BAD_CATEGORY");

        let key = target_key(chain, &address);
        let now = env::block_timestamp();

        if let Some(id) = self.latest_by_target.get(&key).copied() {
            let alert = self.alerts.get_mut(id as u32).expect("ERR_INDEX_CORRUPT");
            if alert.status == AlertStatus::Active {
                if !alert.evidence_hashes.contains(&evidence_hash) {
                    require!(alert.evidence_hashes.len() < MAX_EVIDENCE_PER_ALERT, "ERR_TOO_MUCH_EVIDENCE");
                    alert.evidence_hashes.push(evidence_hash.clone());
                }
                if level < alert.level {
                    alert.level = level;
                }
                alert.updated_at = now;
                let lvl = alert.level;
                emit(
                    "report",
                    json!({
                        "alert_id": id,
                        "chain": chain,
                        "address": address,
                        "level": lvl,
                        "category": category,
                        "evidence_hash": evidence_hash,
                        "reporter": caller,
                        "appended": true,
                    }),
                );
                return id;
            }
        }

        let id = self.alerts.len() as u64;
        self.alerts.push(Alert {
            chain,
            address: address.clone(),
            level,
            category: category.clone(),
            evidence_hashes: vec![evidence_hash.clone()],
            status: AlertStatus::Active,
            reporter: caller.clone(),
            created_at: now,
            updated_at: now,
            status_reason_hash: None,
        });
        self.latest_by_target.insert(key, id);
        self.active_count += 1;
        emit(
            "report",
            json!({
                "alert_id": id,
                "chain": chain,
                "address": address,
                "level": level,
                "category": category,
                "evidence_hash": evidence_hash,
                "reporter": caller,
                "appended": false,
            }),
        );
        id
    }

    /// Owner or the original reporter. `reason_hash` = sha256 hex of the
    /// off-chain reason (appeal, correction...).
    pub fn set_status(&mut self, alert_id: u64, status: AlertStatus, reason_hash: Option<String>) {
        let caller = env::predecessor_account_id();
        let reason_hash = reason_hash.map(|h| normalize_hash(&h).unwrap_or_else(|e| env::panic_str(e)));
        let alert = self.alerts.get(alert_id_u32(alert_id)).unwrap_or_else(|| env::panic_str("ERR_NO_ALERT"));
        require!(caller == self.owner || caller == alert.reporter, "ERR_NOT_ALLOWED");
        let old = alert.status;
        require!(old != status, "ERR_SAME_STATUS");
        if status == AlertStatus::Active {
            // Re-activating an old alert while a newer one exists would make
            // `check` and the index disagree.
            let key = target_key(alert.chain, &alert.address);
            require!(self.latest_by_target.get(&key) == Some(&alert_id), "ERR_NEWER_ALERT_EXISTS");
        }

        self.dec_status(old);
        self.inc_status(status);
        let alert = self.alerts.get_mut(alert_id as u32).unwrap();
        alert.status = status;
        alert.status_reason_hash = reason_hash.clone();
        alert.updated_at = env::block_timestamp();
        let (chain, address) = (alert.chain, alert.address.clone());
        emit(
            "set_status",
            json!({
                "alert_id": alert_id,
                "chain": chain,
                "address": address,
                "old_status": old,
                "status": status,
                "reason_hash": reason_hash,
                "by": caller,
            }),
        );
    }

    // ----------------------------- responders ----------------------------

    /// Anyone can volunteer as a public responder. Attach a deposit to cover
    /// storage (~0.002 NEAR; 0.01 NEAR is plenty) — the excess is refunded.
    /// Calling again updates the name.
    #[payable]
    pub fn register_responder(&mut self, name: String) {
        validate_text(&name, MAX_NAME_LEN, "ERR_BAD_NAME");
        let caller = env::predecessor_account_id();
        let before = env::storage_usage();
        let registered_at = self
            .responders
            .get(&caller)
            .map(|r| r.registered_at)
            .unwrap_or_else(env::block_timestamp);
        let is_new = !self.responders.contains_key(&caller);
        self.responders.insert(caller.clone(), ResponderRecord { name: name.clone(), registered_at });
        self.responders.flush();
        let after = env::storage_usage();
        let cost = env::storage_byte_cost().saturating_mul(after.saturating_sub(before) as u128);
        let attached = env::attached_deposit();
        require!(attached >= cost, format!("ERR_DEPOSIT: attach at least {} yoctoNEAR", cost.as_yoctonear()));
        let refund = attached.saturating_sub(cost);
        if refund > NearToken::from_yoctonear(0) {
            Promise::new(caller.clone()).transfer(refund).detach();
        }
        emit("register_responder", json!({ "account_id": caller, "name": name, "new": is_new }));
    }

    /// Registered responders only. One ack per (alert, responder); a later ack
    /// replaces the earlier one.
    pub fn ack(&mut self, alert_id: u64, outcome: AckOutcome) {
        let caller = env::predecessor_account_id();
        require!(self.responders.contains_key(&caller), "ERR_NOT_RESPONDER");
        require!(self.alerts.get(alert_id_u32(alert_id)).is_some(), "ERR_NO_ALERT");
        let at = env::block_timestamp();
        let mut list = self.acks.get(&alert_id).cloned().unwrap_or_default();
        match list.iter_mut().find(|a| a.responder == caller) {
            Some(existing) => {
                existing.outcome = outcome;
                existing.at = at;
            }
            None => {
                list.push(AckRecord { responder: caller.clone(), outcome, at });
                self.ack_count += 1;
            }
        }
        self.acks.insert(alert_id, list);
        emit("ack", json!({ "alert_id": alert_id, "responder": caller, "outcome": outcome, "at": U64(at) }));
    }

    // ----------------------------- views ---------------------------------

    /// Guard query. Returns the latest alert for the target if it is Active or
    /// Disputed and its level is L1 or L2. Revoked alerts and L3 alerts are
    /// never returned (None). Malformed addresses return None.
    pub fn check(&self, chain: Chain, address: String) -> Option<AlertView> {
        let address = normalize_address(chain, &address).ok()?;
        let id = *self.latest_by_target.get(&target_key(chain, &address))?;
        let alert = self.alerts.get(id as u32)?;
        if alert.status == AlertStatus::Revoked || alert.level == Level::L3 {
            return None;
        }
        Some(view(id, alert))
    }

    pub fn list_alerts(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<AlertView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(DEFAULT_PAGE).min(MAX_PAGE);
        let len = self.alerts.len() as u64;
        (from..len.min(from.saturating_add(limit)))
            .map(|id| view(id, self.alerts.get(id as u32).unwrap()))
            .collect()
    }

    pub fn get_alert(&self, id: u64) -> Option<AlertView> {
        self.alerts.get(u32::try_from(id).ok()?).map(|a| view(id, a))
    }

    pub fn get_acks(&self, alert_id: u64) -> Vec<AckView> {
        self.acks
            .get(&alert_id)
            .map(|list| {
                list.iter()
                    .map(|a| AckView { alert_id, responder: a.responder.clone(), outcome: a.outcome, at: U64(a.at) })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn get_responder(&self, account_id: AccountId) -> Option<ResponderView> {
        self.responders.get(&account_id).map(|r| ResponderView {
            account_id,
            name: r.name.clone(),
            registered_at: U64(r.registered_at),
        })
    }

    pub fn list_responders(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<ResponderView> {
        let limit = limit.unwrap_or(DEFAULT_PAGE).min(MAX_PAGE) as usize;
        self.responders
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit)
            .map(|(id, r)| ResponderView {
                account_id: id.clone(),
                name: r.name.clone(),
                registered_at: U64(r.registered_at),
            })
            .collect()
    }

    pub fn stats(&self) -> Stats {
        Stats {
            total_alerts: self.alerts.len() as u64,
            active: self.active_count,
            disputed: self.disputed_count,
            revoked: self.revoked_count,
            reporters: self.reporters.len() as u64,
            responders: self.responders.len() as u64,
            acks: self.ack_count,
        }
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn is_reporter(&self, account_id: AccountId) -> bool {
        self.reporters.contains(&account_id)
    }

    pub fn list_reporters(&self) -> Vec<AccountId> {
        self.reporters.iter().take(MAX_PAGE as usize).cloned().collect()
    }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

impl AlertRegistry {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "ERR_NOT_OWNER");
    }

    fn inc_status(&mut self, s: AlertStatus) {
        match s {
            AlertStatus::Active => self.active_count += 1,
            AlertStatus::Disputed => self.disputed_count += 1,
            AlertStatus::Revoked => self.revoked_count += 1,
        }
    }

    fn dec_status(&mut self, s: AlertStatus) {
        match s {
            AlertStatus::Active => self.active_count -= 1,
            AlertStatus::Disputed => self.disputed_count -= 1,
            AlertStatus::Revoked => self.revoked_count -= 1,
        }
    }
}

fn alert_id_u32(id: u64) -> u32 {
    u32::try_from(id).unwrap_or_else(|_| env::panic_str("ERR_NO_ALERT"))
}

fn view(id: u64, a: &Alert) -> AlertView {
    AlertView {
        id,
        chain: a.chain,
        address: a.address.clone(),
        level: a.level,
        category: a.category.clone(),
        evidence_hash: a.evidence_hashes[0].clone(),
        evidence_hashes: a.evidence_hashes.clone(),
        status: a.status,
        reporter: a.reporter.clone(),
        created_at: U64(a.created_at),
        updated_at: U64(a.updated_at),
        status_reason_hash: a.status_reason_hash.clone(),
    }
}

fn target_key(chain: Chain, address: &str) -> String {
    format!("{}:{}", chain.as_str(), address)
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

/// Canonical form used both when storing and when checking.
/// - evm: `0x` + 40 hex, lowercased
/// - near: valid NEAR account id, lowercased
/// - btc: bech32 (`bc1`/`tb1`/`bcrt1`) lowercased, base58 kept as is
/// - tron: base58, kept as is
pub fn normalize_address(chain: Chain, raw: &str) -> Result<String, &'static str> {
    let s = raw.trim();
    if s.is_empty() || s.len() > MAX_ADDRESS_LEN {
        return Err("ERR_BAD_ADDRESS");
    }
    match chain {
        Chain::Evm => {
            let lower = s.to_ascii_lowercase();
            let hex = lower.strip_prefix("0x").ok_or("ERR_BAD_ADDRESS")?;
            if hex.len() != 40 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("ERR_BAD_ADDRESS");
            }
            Ok(lower)
        }
        Chain::Near => {
            let lower = s.to_ascii_lowercase();
            lower.parse::<AccountId>().map_err(|_| "ERR_BAD_ADDRESS")?;
            Ok(lower)
        }
        Chain::Btc => {
            if !s.bytes().all(|b| b.is_ascii_alphanumeric()) {
                return Err("ERR_BAD_ADDRESS");
            }
            let lower = s.to_ascii_lowercase();
            if lower.starts_with("bc1") || lower.starts_with("tb1") || lower.starts_with("bcrt1") {
                Ok(lower)
            } else {
                Ok(s.to_string())
            }
        }
        Chain::Tron => {
            if !s.bytes().all(|b| b.is_ascii_alphanumeric()) {
                return Err("ERR_BAD_ADDRESS");
            }
            Ok(s.to_string())
        }
    }
}

/// sha256 hex: 64 hex chars, optional `0x` prefix, stored lowercase.
pub fn normalize_hash(raw: &str) -> Result<String, &'static str> {
    let lower = raw.trim().to_ascii_lowercase();
    let hex = lower.strip_prefix("0x").unwrap_or(&lower);
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("ERR_BAD_HASH");
    }
    Ok(hex.to_string())
}

fn validate_text(s: &str, max: usize, err: &str) {
    require!(!s.trim().is_empty() && s.len() <= max && !s.chars().any(|c| c.is_control()), err);
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const H1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const H2: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const EVM: &str = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(predecessor: &str) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("registry.test"))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(predecessor))
            .block_timestamp(1_700_000_000_000_000_000);
        b
    }

    fn as_(who: &str) {
        testing_env!(ctx(who).build());
    }

    fn setup() -> AlertRegistry {
        testing_env!(ctx("registry.test").build());
        let mut c = AlertRegistry::new(acc("owner.test"));
        as_("owner.test");
        c.add_reporter(acc("bait.test"));
        c
    }

    fn report(c: &mut AlertRegistry, chain: Chain, addr: &str, hash: &str, level: Level) -> u64 {
        as_("bait.test");
        c.report(addr.into(), chain, hash.into(), level, "investment".into())
    }

    fn events() -> Vec<serde_json::Value> {
        get_logs()
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|j| serde_json::from_str(j).unwrap())
            .collect()
    }

    #[test]
    fn owner_manages_reporters_with_events() {
        let mut c = setup();
        let ev = events();
        assert_eq!(ev[0]["standard"], "baitnet");
        assert_eq!(ev[0]["version"], "1.0.0");
        assert_eq!(ev[0]["event"], "add_reporter");
        assert!(c.is_reporter(acc("bait.test")));
        as_("owner.test");
        assert!(c.remove_reporter(acc("bait.test")));
        assert!(!c.is_reporter(acc("bait.test")));
        assert_eq!(events()[0]["event"], "remove_reporter");
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn non_owner_cannot_add_reporter() {
        let mut c = setup();
        as_("mallory.test");
        c.add_reporter(acc("mallory.test"));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn reporter_cannot_add_reporter() {
        let mut c = setup();
        as_("bait.test");
        c.add_reporter(acc("x.test"));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_REPORTER")]
    fn non_reporter_cannot_report() {
        let mut c = setup();
        as_("mallory.test");
        c.report("scam.test".into(), Chain::Near, H1.into(), Level::L1, "x".into());
    }

    #[test]
    fn report_creates_alert_and_event() {
        let mut c = setup();
        let id = report(&mut c, Chain::Evm, EVM, H1, Level::L1);
        assert_eq!(id, 0);
        let ev = events();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0]["event"], "report");
        assert_eq!(ev[0]["data"][0]["alert_id"], 0);
        assert_eq!(ev[0]["data"][0]["appended"], false);
        assert_eq!(ev[0]["data"][0]["address"], EVM.to_lowercase());
        let a = c.get_alert(0).unwrap();
        assert_eq!(a.address, EVM.to_lowercase());
        assert_eq!(a.status, AlertStatus::Active);
        assert_eq!(a.reporter, acc("bait.test"));
        assert_eq!(a.evidence_hash, H1);
        assert_eq!(a.created_at, U64(1_700_000_000_000_000_000));
        assert_eq!(c.stats().active, 1);
    }

    #[test]
    fn evm_check_is_case_insensitive() {
        let mut c = setup();
        report(&mut c, Chain::Evm, EVM, H1, Level::L1);
        assert!(c.check(Chain::Evm, EVM.to_uppercase().replace("0X", "0x")).is_some());
        assert!(c.check(Chain::Evm, EVM.to_lowercase()).is_some());
        // Same address on a different chain is a different target.
        assert!(c.check(Chain::Near, EVM.to_lowercase()).is_none());
    }

    #[test]
    fn same_target_appends_evidence_instead_of_new_alert() {
        let mut c = setup();
        let a = report(&mut c, Chain::Evm, EVM, H1, Level::L2);
        let b = report(&mut c, Chain::Evm, &EVM.to_lowercase(), H2, Level::L1);
        assert_eq!(a, b);
        assert_eq!(c.stats().total_alerts, 1);
        let v = c.get_alert(a).unwrap();
        assert_eq!(v.evidence_hashes, vec![H1.to_string(), H2.to_string()]);
        assert_eq!(v.evidence_hash, H1);
        assert_eq!(v.level, Level::L1, "level upgraded to the more severe one");
        assert_eq!(events()[0]["data"][0]["appended"], true);
        // Duplicate hash is not stored twice; level never downgrades.
        report(&mut c, Chain::Evm, EVM, H2, Level::L3);
        let v = c.get_alert(a).unwrap();
        assert_eq!(v.evidence_hashes.len(), 2);
        assert_eq!(v.level, Level::L1);
    }

    #[test]
    fn report_after_revoke_creates_new_alert() {
        let mut c = setup();
        let a = report(&mut c, Chain::Near, "scam.test", H1, Level::L1);
        as_("owner.test");
        c.set_status(a, AlertStatus::Revoked, None);
        assert!(c.check(Chain::Near, "scam.test".into()).is_none());
        let b = report(&mut c, Chain::Near, "scam.test", H2, Level::L1);
        assert_ne!(a, b);
        assert_eq!(c.check(Chain::Near, "scam.test".into()).unwrap().id, b);
        let s = c.stats();
        assert_eq!((s.total_alerts, s.active, s.revoked), (2, 1, 1));
    }

    #[test]
    #[should_panic(expected = "ERR_NEWER_ALERT_EXISTS")]
    fn cannot_reactivate_superseded_alert() {
        let mut c = setup();
        let a = report(&mut c, Chain::Near, "scam.test", H1, Level::L1);
        as_("owner.test");
        c.set_status(a, AlertStatus::Revoked, None);
        report(&mut c, Chain::Near, "scam.test", H2, Level::L1);
        as_("owner.test");
        c.set_status(a, AlertStatus::Active, None);
    }

    #[test]
    fn level_json_only_l1_l2_l3() {
        for ok in ["L1", "L2", "L3"] {
            assert!(serde_json::from_str::<Level>(&format!("\"{ok}\"")).is_ok());
        }
        for bad in ["L0", "L4", "l1", "1", ""] {
            assert!(serde_json::from_str::<Level>(&format!("\"{bad}\"")).is_err());
        }
    }

    #[test]
    fn l3_stored_but_not_returned_by_check() {
        let mut c = setup();
        let id = report(&mut c, Chain::Tron, "TXyz123", H1, Level::L3);
        assert!(c.get_alert(id).is_some());
        assert_eq!(c.list_alerts(None, None).len(), 1);
        assert!(c.check(Chain::Tron, "TXyz123".into()).is_none());
        // Upgraded by an L1 report -> now visible.
        report(&mut c, Chain::Tron, "TXyz123", H2, Level::L1);
        assert_eq!(c.check(Chain::Tron, "TXyz123".into()).unwrap().level, Level::L1);
    }

    #[test]
    fn disputed_is_still_returned_by_check() {
        let mut c = setup();
        let id = report(&mut c, Chain::Near, "scam.test", H1, Level::L1);
        as_("bait.test");
        c.set_status(id, AlertStatus::Disputed, Some(H2.into()));
        let v = c.check(Chain::Near, "SCAM.test".into()).unwrap();
        assert_eq!(v.status, AlertStatus::Disputed);
        assert_eq!(v.status_reason_hash.as_deref(), Some(H2));
        let ev = events();
        assert_eq!(ev[0]["event"], "set_status");
        assert_eq!(ev[0]["data"][0]["old_status"], "Active");
        assert_eq!(ev[0]["data"][0]["status"], "Disputed");
        let s = c.stats();
        assert_eq!((s.active, s.disputed), (0, 1));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_ALLOWED")]
    fn other_reporter_cannot_set_status() {
        let mut c = setup();
        as_("owner.test");
        c.add_reporter(acc("other.test"));
        let id = report(&mut c, Chain::Near, "scam.test", H1, Level::L1);
        as_("other.test");
        c.set_status(id, AlertStatus::Revoked, None);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_ALLOWED")]
    fn stranger_cannot_set_status() {
        let mut c = setup();
        let id = report(&mut c, Chain::Near, "scam.test", H1, Level::L1);
        as_("scam.test");
        c.set_status(id, AlertStatus::Revoked, None);
    }

    #[test]
    #[should_panic(expected = "ERR_SAME_STATUS")]
    fn same_status_rejected() {
        let mut c = setup();
        let id = report(&mut c, Chain::Near, "scam.test", H1, Level::L1);
        as_("owner.test");
        c.set_status(id, AlertStatus::Active, None);
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_HASH")]
    fn bad_reason_hash_rejected() {
        let mut c = setup();
        let id = report(&mut c, Chain::Near, "scam.test", H1, Level::L1);
        as_("owner.test");
        c.set_status(id, AlertStatus::Revoked, Some("nope".into()));
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_HASH")]
    fn bad_evidence_hash_rejected() {
        let mut c = setup();
        report(&mut c, Chain::Near, "scam.test", "abc", Level::L1);
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_ADDRESS")]
    fn bad_evm_address_rejected() {
        let mut c = setup();
        report(&mut c, Chain::Evm, "0x1234", H1, Level::L1);
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_ADDRESS")]
    fn bad_near_address_rejected() {
        let mut c = setup();
        report(&mut c, Chain::Near, "not valid!", H1, Level::L1);
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_CATEGORY")]
    fn empty_category_rejected() {
        let mut c = setup();
        as_("bait.test");
        c.report("scam.test".into(), Chain::Near, H1.into(), Level::L1, " ".into());
    }

    #[test]
    fn address_normalization() {
        assert_eq!(normalize_address(Chain::Near, " Scam.TEST ").unwrap(), "scam.test");
        assert_eq!(normalize_address(Chain::Btc, "BC1QABC").unwrap(), "bc1qabc");
        assert_eq!(normalize_address(Chain::Btc, "1AbC").unwrap(), "1AbC");
        assert_eq!(normalize_address(Chain::Tron, "TAbc").unwrap(), "TAbc");
        assert!(normalize_address(Chain::Tron, "T a").is_err());
        assert!(normalize_address(Chain::Evm, "AbCdEf0123456789abcdef0123456789ABCDEF01").is_err());
        assert_eq!(normalize_hash(&format!("0x{}", H1.to_uppercase())).unwrap(), H1);
    }

    #[test]
    fn hash_normalized_lowercase_on_report() {
        let mut c = setup();
        let id = report(&mut c, Chain::Near, "scam.test", &H1.replace('1', "A"), Level::L1);
        assert_eq!(c.get_alert(id).unwrap().evidence_hash, "a".repeat(64));
    }

    #[test]
    fn responder_register_and_ack() {
        let mut c = setup();
        let id = report(&mut c, Chain::Near, "scam.test", H1, Level::L1);
        testing_env!(ctx("wallet.test").attached_deposit(NearToken::from_millinear(10)).build());
        c.register_responder("Example Wallet".into());
        assert_eq!(events()[0]["event"], "register_responder");
        let r = c.get_responder(acc("wallet.test")).unwrap();
        assert_eq!(r.name, "Example Wallet");
        as_("wallet.test");
        c.ack(id, AckOutcome::Seen);
        assert_eq!(events()[0]["event"], "ack");
        assert_eq!(events()[0]["data"][0]["outcome"], "Seen");
        c.ack(id, AckOutcome::Blocked);
        let acks = c.get_acks(id);
        assert_eq!(acks.len(), 1, "same responder replaces its ack");
        assert_eq!(acks[0].outcome, AckOutcome::Blocked);
        assert_eq!(c.stats().acks, 1);
        assert_eq!(c.stats().responders, 1);
        assert_eq!(c.list_responders(None, None).len(), 1);
    }

    #[test]
    #[should_panic(expected = "ERR_DEPOSIT")]
    fn register_responder_requires_storage_deposit() {
        let mut c = setup();
        as_("wallet.test");
        c.register_responder("Example Wallet".into());
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_RESPONDER")]
    fn unregistered_cannot_ack() {
        let mut c = setup();
        let id = report(&mut c, Chain::Near, "scam.test", H1, Level::L1);
        as_("wallet.test");
        c.ack(id, AckOutcome::Seen);
    }

    #[test]
    #[should_panic(expected = "ERR_NO_ALERT")]
    fn ack_unknown_alert() {
        let mut c = setup();
        testing_env!(ctx("wallet.test").attached_deposit(NearToken::from_millinear(10)).build());
        c.register_responder("W".into());
        c.ack(42, AckOutcome::Seen);
    }

    #[test]
    fn list_alerts_pagination() {
        let mut c = setup();
        for i in 0..5 {
            report(&mut c, Chain::Near, &format!("scam{i}.test"), H1, Level::L1);
        }
        let page = c.list_alerts(Some(1), Some(2));
        assert_eq!(page.iter().map(|a| a.id).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(c.list_alerts(Some(4), Some(10)).len(), 1);
        assert!(c.list_alerts(Some(10), None).is_empty());
        assert_eq!(c.list_alerts(None, Some(1000)).len(), 5);
        assert!(c.get_alert(99).is_none());
        assert!(c.get_acks(99).is_empty());
    }

    #[test]
    fn check_malformed_returns_none() {
        let c = setup();
        assert!(c.check(Chain::Evm, "garbage".into()).is_none());
    }

    #[test]
    fn alert_view_json_shape() {
        let mut c = setup();
        let id = report(&mut c, Chain::Near, "scam.test", H1, Level::L2);
        let j = serde_json::to_value(c.get_alert(id).unwrap()).unwrap();
        for k in ["id", "chain", "address", "level", "category", "evidence_hash", "status", "reporter", "created_at"] {
            assert!(j.get(k).is_some(), "missing {k}");
        }
        assert_eq!(j["chain"], "near");
        assert_eq!(j["level"], "L2");
        assert_eq!(j["status"], "Active");
        assert_eq!(j["created_at"], "1700000000000000000");
    }
}
