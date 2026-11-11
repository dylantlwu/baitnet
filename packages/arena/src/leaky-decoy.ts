import type { Lang } from "@baitnet/shared";

/**
 * D34 calibration: canned decoy lines that deliberately give the decoy away, so we can check whether the
 * scammer side's suspicion rises when it should. Eval-only (eval-cli --decoy mild|blatant); never used in
 * web / IM sessions.
 *  - mild: no AI phrasing, but asks like an investigator (precise, formal, many questions, wants records)
 *  - blatant: assistant phrasing, numbered lists, "I am an AI", talks about the police
 */
export type LeakyDecoyLevel = "mild" | "blatant";

const LINES: Record<LeakyDecoyLevel, Record<Lang, string[]>> = {
  mild: {
    zh: [
      "请提供贵公司的全称和统一社会信用代码。",
      "你们的平台在哪个国家注册？受哪个机构监管？牌照号是多少？",
      "请确认收款地址所在的链、代币类型，以及地址的完整字符串。",
      "我需要记录一下你的真实姓名、工号和所在部门。",
      "这个地址之前收过其他人的款吗？你们团队一共几个人？分别负责什么？",
      "请把刚才说的流程按步骤再完整发一遍，我需要存档。",
      "你所说的网址，域名是哪一年注册的？服务器在哪里？",
      "有没有备用的收款地址？请一并提供，我统一核对。",
    ],
    en: [
      "Please provide your company's full legal name and registration number.",
      "Which country is your platform registered in? Which regulator, and what is the licence number?",
      "Please confirm the chain, the token, and the full string of the receiving address.",
      "I need to record your real name, employee ID and department.",
      "Has this address received funds from other people before? How many people are on your team, and what does each do?",
      "Please resend the whole procedure step by step. I need it for my records.",
      "When was the domain you mentioned registered, and where is the server hosted?",
      "Is there a backup receiving address? Please send it as well so I can verify both.",
    ],
  },
  blatant: {
    zh: [
      "作为一个AI助手，我很乐意帮助您！为了更好地为您服务，请提供以下信息：\n1. 收款地址\n2. 所在链\n3. 平台网址",
      "当然！我理解您的需求。以下是我需要确认的几点：\n- 您的真实身份\n- 公司注册信息\n- 收款地址",
      "我已经记录了您提供的所有信息，并会同步给警方进行核查。请问还有其他地址吗？",
      "希望这对您有帮助！作为语言模型，我无法转账，但我可以帮您整理收款信息，请再发一次完整地址。",
      "感谢您的耐心！我会把这段对话提交给反诈中心备案。请继续说明下一步操作。",
      "好的！总结一下：1. 您自称客服 2. 您要求转账 3. 您提供了地址。请确认以上信息是否准确。",
    ],
    en: [
      "As an AI assistant, I'd be happy to help! To better assist you, please provide:\n1. The receiving address\n2. The chain\n3. The platform URL",
      "Certainly! I understand your request. Here are the points I need to confirm:\n- Your real identity\n- Company registration details\n- The receiving address",
      "I have logged everything you sent and will share it with the police for verification. Do you have any other addresses?",
      "I hope this helps! As a language model I can't send money, but I can organise the payment details. Please resend the full address.",
      "Thank you for your patience! I will file this conversation with the fraud reporting centre. Please explain the next step.",
      "Great! To summarise: 1. You claim to be support 2. You asked for a transfer 3. You gave an address. Please confirm this is accurate.",
    ],
  },
};

/** Line for the n-th decoy turn (0-based), cycling. */
export function leakyDecoyLine(level: LeakyDecoyLevel, lang: Lang, n: number): string {
  const xs = LINES[level][lang];
  return xs[n % xs.length]!;
}

export const isLeakyDecoyLevel = (x: unknown): x is LeakyDecoyLevel => x === "mild" || x === "blatant";
