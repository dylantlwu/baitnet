import { describe, expect, it } from "vitest";
import { MemoryIdentityService, TelegramApi, TelegramError, delayScale, langOf, maybeSplit, shanghai, typingDelayMs } from "../src/index.js";

describe("模拟真人", () => {
  it("停顿 2–8 秒，随长度增加；环境变量可缩到 0", () => {
    const short = typingDelayMs("好的", 1, () => 0);
    const long = typingDelayMs("我们团队做量化八年了，AI 模型只做跨交易所价差，不赌方向，所以风险极低。你先别急着投钱。".repeat(3), 1, () => 0);
    expect(short).toBeGreaterThanOrEqual(2000);
    expect(long).toBeLessThanOrEqual(8000);
    expect(long).toBeGreaterThan(short);
    expect(typingDelayMs("任何话", 0)).toBe(0);
    expect(delayScale({ BAITNET_IM_DELAY_SCALE: "0" })).toBe(0);
    expect(delayScale({})).toBe(1);
  });

  it("长回复偶尔在句子边界拆成两条；地址不会被拆开", () => {
    const text = "这个平台我之前听说过，好像挺多人在用的。不过我想先确认一下，你们的充值地址是哪个链的？";
    expect(maybeSplit(text, () => 0.99)).toEqual([text]);
    const parts = maybeSplit(text, () => 0);
    expect(parts).toHaveLength(2);
    expect(parts.join("")).toBe(text.replace(/\s+/g, ""));
    const addr = "充值地址是 TWABPPqD9WBnrrcojkvzJt4WPDNwL6xBz7 记得用 TRC20 网络转账哦";
    for (const p of maybeSplit(addr, () => 0)) expect(p.includes("TWABPP") ? p.includes("TWABPPqD9WBnrrcojkvzJt4WPDNwL6xBz7") : true).toBe(true);
    expect(maybeSplit("短句。", () => 0)).toEqual(["短句。"]);
  });
});

describe("语言与时区", () => {
  it("英文客户端 → en，其余默认中文", () => {
    expect(langOf("en")).toBe("en");
    expect(langOf("en-GB")).toBe("en");
    expect(langOf("zh-hans")).toBe("zh");
    expect(langOf("ru")).toBe("zh");
    expect(langOf(undefined)).toBe("zh");
  });
  it("上海时间", () => {
    expect(shanghai(new Date("2026-11-10T01:00:00Z"))).toEqual({ day: "2026-11-10", hour: 9 });
    expect(shanghai(new Date("2026-11-09T17:00:00Z"))).toEqual({ day: "2026-11-10", hour: 1 });
  });
});

describe("TelegramApi", () => {
  it("网络错误/5xx/429 会重试，401 不重试；错误信息里没有 token", async () => {
    const token = "42:SECRET-abc_def";
    let n = 0;
    const api = new TelegramApi({
      token,
      sleep: async () => {},
      fetch: (async (url: string) => {
        n++;
        if (n === 1) throw new Error(`connect ECONNRESET ${url}`);
        if (n === 2) return new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } }), { status: 429 });
        return new Response(JSON.stringify({ ok: true, result: { id: 1 } }));
      }) as unknown as typeof fetch,
    });
    expect(await api.call("getMe")).toEqual({ id: 1 });
    expect(n).toBe(3);

    const bad = new TelegramApi({
      token,
      sleep: async () => {},
      fetch: (async (url: string) => {
        throw new Error(`getaddrinfo ENOTFOUND ${url}`);
      }) as unknown as typeof fetch,
      retries: 1,
    });
    const err = (await bad.call("getMe").catch((e) => e)) as TelegramError;
    expect(err.network).toBe(true);
    expect(err.message).not.toContain("SECRET");
    expect(err.message).toContain("<token>");

    let calls = 0;
    const unauthorized = new TelegramApi({
      token,
      sleep: async () => {},
      fetch: (async () => (calls++, new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), { status: 401 }))) as unknown as typeof fetch,
    });
    await expect(unauthorized.call("getMe")).rejects.toMatchObject({ code: 401 });
    expect(calls).toBe(1);
    expect(() => new TelegramApi({ token: "not-a-token" })).toThrow(/malformed/);
  });
});

describe("MemoryIdentityService", () => {
  it("绑定、额度、reviewers", async () => {
    const id = new MemoryIdentityService({ llmDailyLimit: 2 });
    id.invite("abc", "阿明", "expert", "u1");
    id.invite("rev", "Dylan", "reviewer", "u2");
    expect(await id.bindByCode("telegram", "1", undefined, "nope")).toBeNull();
    expect((await id.bindByCode("telegram", "1", "aming", "ABC"))?.id).toBe("u1");
    expect((await id.bindByCode("lark", "ou_1", undefined, "abc"))?.bindings).toHaveLength(2); // same code, second IM account
    await id.bindByCode("telegram", "2", undefined, "rev");
    expect((await id.reviewers("telegram")).map((r) => r.externalId)).toEqual(["2"]);
    expect(await id.consumeLlmQuota("u1")).toBe(true);
    expect(await id.consumeLlmQuota("u1")).toBe(true);
    expect(await id.consumeLlmQuota("u1")).toBe(false);
    id.revoke("abc");
    expect(await id.bindByCode("telegram", "3", undefined, "abc")).toBeNull();
  });
});
