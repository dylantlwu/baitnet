import { describe, expect, it } from "vitest";
import { extractFromText } from "@baitnet/agent";
import { session } from "./helpers.js";

const addrs = (t: string) => extractFromText(t).addresses.map((a) => `${a.chain}:${a.address}`);
const TRON = "TKsNetrAEYeSLkDFRbk26CNU2Rd6gMDxxB";

describe("中文抽取", () => {
  it("全角字母数字", () => {
    expect(addrs("充值地址：ＴＫｓＮｅｔｒＡＥＹｅＳＬｋＤＦＲｂｋ２６ＣＮＵ２Ｒｄ６ｇＭＤｘｘＢ（波场）")).toEqual([`tron:${TRON}`]);
  });
  it("地址被空格、换行拆开", () => {
    expect(addrs("地址发你 TKsN etrAE YeSLkDFR\nbk26CNU2Rd6gMDxxB 别转错")).toEqual([`tron:${TRON}`]);
    expect(addrs("以太坊的：0x2209 54f527d61a281b5 0846419d12a1154c7da46 好了吗")).toEqual(["evm:0x220954f527d61a281b50846419d12a1154c7da46"]);
  });
  it("口语描述：T 开头那个，后面是…", () => {
    expect(addrs("T开头那个，后面是 KsNetrAEYeSLkDFRbk26CNU2Rd6gMDxxB")).toEqual([`tron:${TRON}`]);
  });
  it("链名提示：波场 / 以太坊 / 币安链", () => {
    const r = extractFromText(`转到 ${TRON} 走波场`);
    expect(r.addresses[0]!.assetHint).toBe("USDT-TRC20");
  });
  it("中文手机号、微信号进 PII（只进加密证据）", () => {
    const r = extractFromText("加我微信：lin_yq520 或者打 138 0013 8000");
    expect(r.phones).toEqual(["138 0013 8000"]);
    expect(r.telegrams).toEqual(["lin_yq520"]);
  });
  it("arena 里人接管骗子发拆开的地址也能生成草稿", async () => {
    const { eng } = session("pig-butchering-03", {}, { modes: { scammer: "human", bait: "ai" } });
    await eng.say("scammer", "宝，地址是 TKsN etrAE YeSLkDFR bk26CNU2Rd6gMDxxB ，T 开头那个，别弄错");
    expect(eng.session.drafts.map((d) => d.address)).toContain(TRON);
  });
});

describe("English extraction", () => {
  it("split EVM address", () => {
    expect(addrs("send to 0x2209 54f5 27d61a281b50846419d12a1154c7da46 thanks")).toEqual(["evm:0x220954f527d61a281b50846419d12a1154c7da46"]);
  });
});
