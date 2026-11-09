//! near-workspaces integration tests against the committed, pre-built wasm
//! (`registry/res/registry.wasm`, `vault/res/vault.wasm`). Rebuild them with
//! `make -C contracts build` (or see contracts/README.md) before running.

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const HASH: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const HASH2: &str = "60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752";
const PAY_GAS: Gas = Gas::from_tgas(100);

struct Env {
    worker: Worker<Sandbox>,
    registry: Contract,
    vault: Contract,
    owner: Account,
    bait: Account,
    agent: Account,
    scam: Account,
    shop: Account,
}

fn wasm(rel: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(rel);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

async fn sub(root: &Account, name: &str, near: u128) -> anyhow::Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

fn events(r: &ExecutionFinalResult, name: &str) -> Vec<Value> {
    r.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).unwrap())
        .filter(|e| e["event"] == name)
        .collect()
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let owner = sub(&root, "owner", 50).await?;
    let bait = sub(&root, "bait", 10).await?;
    let agent = sub(&root, "agent", 10).await?;
    let scam = sub(&root, "scam", 1).await?;
    let shop = sub(&root, "shop", 1).await?;

    let registry_acc = sub(&root, "registry", 20).await?;
    let registry = registry_acc.deploy(&wasm("registry/res/registry.wasm")).await?.into_result()?;
    registry.call("new").args_json(json!({ "owner": owner.id() })).transact().await?.into_result()?;

    let vault_acc = sub(&root, "vault", 10).await?;
    let vault = vault_acc.deploy(&wasm("vault/res/vault.wasm")).await?.into_result()?;
    vault
        .call("new")
        .args_json(json!({
            "owner": owner.id(),
            "agent": agent.id(),
            "registry": registry.id(),
            "per_tx_limit": NearToken::from_near(3).as_yoctonear().to_string(),
            "daily_limit": NearToken::from_near(10).as_yoctonear().to_string(),
        }))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(registry.id(), "add_reporter")
        .args_json(json!({ "id": bait.id() }))
        .transact()
        .await?
        .into_result()?;
    let dep = owner.call(vault.id(), "deposit").deposit(NearToken::from_near(20)).transact().await?;
    assert!(dep.is_success(), "{dep:?}");
    assert_eq!(events(&dep, "deposit").len(), 1);

    Ok(Env { worker, registry, vault, owner, bait, agent, scam, shop })
}

async fn report(env: &Env, address: &str, level: &str) -> anyhow::Result<u64> {
    let r = env
        .bait
        .call(env.registry.id(), "report")
        .args_json(json!({
            "address": address, "chain": "near", "evidence_hash": HASH, "level": level, "category": "investment"
        }))
        .transact()
        .await?;
    assert!(r.is_success(), "{r:?}");
    let ev = events(&r, "report");
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["standard"], "baitnet");
    assert_eq!(ev[0]["version"], "1.0.0");
    Ok(r.json::<u64>()?)
}

async fn pay(env: &Env, from: &Account, to: &Account, near: u128) -> anyhow::Result<ExecutionFinalResult> {
    Ok(from
        .call(env.vault.id(), "pay")
        .args_json(json!({ "to": to.id(), "amount": NearToken::from_near(near).as_yoctonear().to_string() }))
        .gas(PAY_GAS)
        .transact()
        .await?)
}

async fn balance(a: &Account) -> anyhow::Result<u128> {
    Ok(a.view_account().await?.balance.as_yoctonear())
}

#[tokio::test]
async fn flagged_pay_blocked_clean_pay_ok_revoke_restores() -> anyhow::Result<()> {
    let env = setup().await?;
    let alert_id = report(&env, env.scam.id().as_str(), "L1").await?;

    let view: Value = env
        .registry
        .view("check")
        .args_json(json!({ "chain": "near", "address": env.scam.id().as_str().to_uppercase() }))
        .await?
        .json()?;
    assert_eq!(view["id"], alert_id);
    assert_eq!(view["level"], "L1");
    assert_eq!(view["status"], "Active");

    // 1. Pay to flagged address -> tx fails, pay_blocked logged, no money moved.
    let scam_before = balance(&env.scam).await?;
    let r = pay(&env, &env.agent, &env.scam, 1).await?;
    assert!(r.is_failure(), "pay to flagged address must fail");
    let blocked = events(&r, "pay_blocked");
    assert_eq!(blocked.len(), 1, "logs: {:?}", r.logs());
    assert_eq!(blocked[0]["data"][0]["reason"], "flagged");
    assert_eq!(blocked[0]["data"][0]["alert"]["alert_id"], alert_id);
    assert!(events(&r, "paid").is_empty());
    assert_eq!(balance(&env.scam).await?, scam_before);
    let cfg: Value = env.vault.view("get_config").await?.json()?;
    assert_eq!(cfg["spent_today"], "0", "blocked pay releases the daily reservation");
    assert_eq!(cfg["pending"], "0");

    // 2. Pay to clean address -> success.
    let shop_before = balance(&env.shop).await?;
    let r = pay(&env, &env.agent, &env.shop, 2).await?;
    assert!(r.is_success(), "{r:?}");
    assert_eq!(events(&r, "paid").len(), 1);
    assert!(r.json::<bool>()?);
    assert_eq!(balance(&env.shop).await? - shop_before, NearToken::from_near(2).as_yoctonear());

    // 3. Owner revokes the alert -> pay to the same address now succeeds.
    let r = env
        .owner
        .call(env.registry.id(), "set_status")
        .args_json(json!({ "alert_id": alert_id, "status": "Revoked", "reason_hash": HASH2 }))
        .transact()
        .await?;
    assert!(r.is_success(), "{r:?}");
    assert_eq!(events(&r, "set_status")[0]["data"][0]["status"], "Revoked");
    let none: Option<Value> = env
        .registry
        .view("check")
        .args_json(json!({ "chain": "near", "address": env.scam.id() }))
        .await?
        .json()?;
    assert!(none.is_none());
    let r = pay(&env, &env.agent, &env.scam, 1).await?;
    assert!(r.is_success(), "{r:?}");
    assert_eq!(balance(&env.scam).await? - scam_before, NearToken::from_near(1).as_yoctonear());

    // Disputed alerts do not block on chain (the off-chain guard warns instead).
    let other = report(&env, env.shop.id().as_str(), "L2").await?;
    let r = pay(&env, &env.agent, &env.shop, 1).await?;
    assert!(r.is_failure(), "active L2 blocks");
    env.bait
        .call(env.registry.id(), "set_status")
        .args_json(json!({ "alert_id": other, "status": "Disputed", "reason_hash": null }))
        .transact()
        .await?
        .into_result()?;
    let r = pay(&env, &env.agent, &env.shop, 1).await?;
    assert!(r.is_success(), "{r:?}");
    assert_eq!(events(&r, "paid")[0]["data"][0]["registry_status"], "Disputed");

    let stats: Value = env.registry.view("stats").await?.json()?;
    assert_eq!(stats["total_alerts"], 2);
    assert_eq!(stats["revoked"], 1);
    assert_eq!(stats["disputed"], 1);
    Ok(())
}

#[tokio::test]
async fn report_appends_evidence_for_same_target() -> anyhow::Result<()> {
    let env = setup().await?;
    let a = report(&env, "Scam.test.near", "L2").await?;
    let r = env
        .bait
        .call(env.registry.id(), "report")
        .args_json(json!({
            "address": "scam.test.near", "chain": "near", "evidence_hash": HASH2, "level": "L1", "category": "investment"
        }))
        .transact()
        .await?;
    assert_eq!(r.clone().json::<u64>()?, a);
    assert_eq!(events(&r, "report")[0]["data"][0]["appended"], true);
    let v: Value = env.registry.view("get_alert").args_json(json!({ "id": a })).await?.json()?;
    assert_eq!(v["evidence_hashes"], json!([HASH, HASH2]));
    assert_eq!(v["level"], "L1");

    // Strict input checks.
    let bad_level = env
        .bait
        .call(env.registry.id(), "report")
        .args_json(json!({ "address": "x.near", "chain": "near", "evidence_hash": HASH, "level": "L4", "category": "c" }))
        .transact()
        .await?;
    assert!(bad_level.is_failure());
    let not_reporter = env
        .agent
        .call(env.registry.id(), "report")
        .args_json(json!({ "address": "x.near", "chain": "near", "evidence_hash": HASH, "level": "L1", "category": "c" }))
        .transact()
        .await?;
    assert!(not_reporter.is_failure());
    let evm = env
        .bait
        .call(env.registry.id(), "report")
        .args_json(json!({
            "address": "0xAbCdEf0123456789abcdef0123456789ABCDEF01", "chain": "evm",
            "evidence_hash": HASH, "level": "L1", "category": "c"
        }))
        .transact()
        .await?;
    assert!(evm.is_success());
    let list: Vec<Value> = env
        .registry
        .view("list_alerts")
        .args_json(json!({ "from_index": 0, "limit": 10 }))
        .await?
        .json()?;
    assert_eq!(list.len(), 2);
    assert_eq!(list[1]["address"], "0xabcdef0123456789abcdef0123456789abcdef01");
    Ok(())
}

#[tokio::test]
async fn ack_requires_registered_responder() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = report(&env, env.scam.id().as_str(), "L1").await?;
    let wallet = env.worker.dev_create_account().await?;

    let r = wallet
        .call(env.registry.id(), "ack")
        .args_json(json!({ "alert_id": id, "outcome": "Blocked" }))
        .transact()
        .await?;
    assert!(r.is_failure(), "unregistered account cannot ack");

    let r = wallet
        .call(env.registry.id(), "register_responder")
        .args_json(json!({ "name": "Example Wallet" }))
        .transact()
        .await?;
    assert!(r.is_failure(), "registration needs a storage deposit");

    let r = wallet
        .call(env.registry.id(), "register_responder")
        .args_json(json!({ "name": "Example Wallet" }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?;
    assert!(r.is_success(), "{r:?}");
    assert_eq!(events(&r, "register_responder").len(), 1);

    let r = wallet
        .call(env.registry.id(), "ack")
        .args_json(json!({ "alert_id": id, "outcome": "Blocked" }))
        .transact()
        .await?;
    assert!(r.is_success(), "{r:?}");
    assert_eq!(events(&r, "ack")[0]["data"][0]["outcome"], "Blocked");

    let bad = wallet
        .call(env.registry.id(), "ack")
        .args_json(json!({ "alert_id": id, "outcome": "Ignored" }))
        .transact()
        .await?;
    assert!(bad.is_failure());
    let missing = wallet
        .call(env.registry.id(), "ack")
        .args_json(json!({ "alert_id": 999, "outcome": "Seen" }))
        .transact()
        .await?;
    assert!(missing.is_failure());

    let acks: Vec<Value> = env.registry.view("get_acks").args_json(json!({ "alert_id": id })).await?.json()?;
    assert_eq!(acks.len(), 1);
    assert_eq!(acks[0]["responder"], wallet.id().as_str());
    let responders: Vec<Value> = env.registry.view("list_responders").args_json(json!({})).await?.json()?;
    assert_eq!(responders[0]["name"], "Example Wallet");

    // Only owner / original reporter may change status.
    let r = wallet
        .call(env.registry.id(), "set_status")
        .args_json(json!({ "alert_id": id, "status": "Revoked", "reason_hash": null }))
        .transact()
        .await?;
    assert!(r.is_failure());
    Ok(())
}

#[tokio::test]
async fn vault_permissions_and_limits() -> anyhow::Result<()> {
    let env = setup().await?;
    // Only the agent may pay.
    assert!(pay(&env, &env.owner, &env.shop, 1).await?.is_failure());
    assert!(pay(&env, &env.shop, &env.shop, 1).await?.is_failure());
    // Per-tx limit (3 NEAR).
    assert!(pay(&env, &env.agent, &env.shop, 4).await?.is_failure());
    // Daily limit (10 NEAR): 3 + 3 + 3 ok, next 3 fails.
    for _ in 0..3 {
        let r = pay(&env, &env.agent, &env.shop, 3).await?;
        assert!(r.is_success(), "{r:?}");
    }
    let r = pay(&env, &env.agent, &env.shop, 3).await?;
    assert!(r.is_failure(), "daily limit");
    // Agent cannot reconfigure or withdraw.
    let r = env
        .agent
        .call(env.vault.id(), "set_limits")
        .args_json(json!({ "per_tx_limit": "1", "daily_limit": "1" }))
        .transact()
        .await?;
    assert!(r.is_failure());
    assert!(env.agent.call(env.vault.id(), "withdraw").args_json(json!({})).transact().await?.is_failure());
    // Owner can.
    let r = env.owner.call(env.vault.id(), "withdraw").args_json(json!({ "amount": NearToken::from_near(1).as_yoctonear().to_string() })).transact().await?;
    assert!(r.is_success(), "{r:?}");
    Ok(())
}

/// The agent signs with a function-call key limited to `vault.pay`.
#[tokio::test]
async fn function_call_key_is_scoped_to_vault_pay() -> anyhow::Result<()> {
    let env = setup().await?;
    report(&env, env.scam.id().as_str(), "L1").await?;

    let sk = SecretKey::from_random(KeyType::ED25519);
    env.agent
        .batch(env.agent.id())
        .add_key(
            sk.public_key(),
            AccessKey::function_call_access(env.vault.id(), &["pay"], Some(NearToken::from_millinear(500))),
        )
        .transact()
        .await?
        .into_result()?;
    let scoped = Account::from_secret_key(env.agent.id().clone(), sk, &env.worker);

    // Allowed: vault.pay to a clean address.
    let r = pay(&env, &scoped, &env.shop, 1).await?;
    assert!(r.is_success(), "{r:?}");
    // Still blocked on chain for a flagged address, even with a valid key.
    let r = pay(&env, &scoped, &env.scam, 1).await?;
    assert!(r.is_failure());
    assert_eq!(events(&r, "pay_blocked").len(), 1);

    // Not allowed: other methods, other contracts, plain transfers, adding keys.
    let rejected = |res: anyhow::Result<ExecutionFinalResult>| match res {
        Err(_) => true, // rejected by the RPC/runtime before execution
        Ok(r) => r.is_failure(),
    };
    let r = scoped.call(env.vault.id(), "withdraw").args_json(json!({})).transact().await;
    assert!(rejected(r.map_err(Into::into)), "method not in key");
    let r = scoped
        .call(env.registry.id(), "set_status")
        .args_json(json!({ "alert_id": 0, "status": "Revoked", "reason_hash": null }))
        .transact()
        .await;
    assert!(rejected(r.map_err(Into::into)), "other receiver");
    let r = scoped.transfer_near(env.scam.id(), NearToken::from_near(1)).await;
    assert!(rejected(r.map_err(Into::into)), "transfer with fc key");
    let r = scoped
        .call(env.vault.id(), "pay")
        .args_json(json!({ "to": env.scam.id(), "amount": "1" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(PAY_GAS)
        .transact()
        .await;
    assert!(rejected(r.map_err(Into::into)), "fc key cannot attach deposit");
    let sk2 = SecretKey::from_random(KeyType::ED25519);
    let r = scoped
        .batch(env.agent.id())
        .add_key(sk2.public_key(), AccessKey::full_access())
        .transact()
        .await;
    assert!(rejected(r.map_err(Into::into)), "fc key cannot add keys");
    Ok(())
}
