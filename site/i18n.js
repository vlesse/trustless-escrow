/**
 * 中英双语。
 *
 * 只有英文一份表：中文写在 HTML 里，切到英文时按 data-i18n 逐个替换。
 * 这样中文是「源文」而不是另一份要同步的译文 —— 改文案时不会出现
 * 两种语言各说一套的情况，那是双语页最常见的问题。
 */
window.SITE_EN = {
  "brand": "Renren Escrow",
  "nav.numbers": "On-chain data",
  "nav.trust": "Why no trust needed",
  "nav.how": "How to use",
  "nav.risk": "Risks",
  "nav.contracts": "Contracts",

  "banner": "Running on testnet · Not audited by a third party · Do not use real funds",

  "hero.h1": "Escrow, with nobody who can take your money",
  "hero.lead": "Funds sit in an on-chain contract and can only move to the buyer or the seller, " +
    "along paths fixed in the code. The operator has no function that withdraws them — " +
    "that is not a promise, it is the absence of that code.",
  "hero.bot": "Open a deal on Telegram",
  "hero.src": "Read the source",

  "num.h2": "On-chain data",
  "num.sub": "Every number below is fetched by your own browser directly from a BSC node. " +
    "Nothing passes through our servers. This page has no backend, so there is no layer we could rewrite.",
  "num.deals": "Deals created",
  "num.locked": "Currently locked",
  "num.disputes": "Disputes / of which challenged",
  "num.jurors": "Jurors / total staked",

  "rev.h3": "Protocol revenue",
  "rev.sub": "The fee is a percentage of the deal value and goes entirely to the FeeVault contract. " +
    "The beneficiary address is written at deployment and is permanently immutable. " +
    "All time = withdrawn + the vault's current balance — both come only from real token movements, " +
    "so neither can be faked by anyone.",
  "rev.total": "Collected, all time",
  "rev.swept": "Withdrawn",
  "rev.pending": "Not yet withdrawn",
  "rev.bene": "Beneficiary",
  "rev.immutable": "immutable",

  "trust.h2": "Why you do not need to trust us",
  "trust.sub": "Each item below maps to a fact you can verify on-chain yourself, not to an assurance.",
  "t1.h": "Funds are never custodied",
  "t1.p": "Each deal is its own contract instance. Funds can only travel the paths written into the code, " +
    "to the buyer or to the seller. The operator is not a valid caller of any transfer function — " +
    "it is not that we promise not to touch it, there is no entry point to touch it with.",
  "t2.h": "The logic cannot be upgraded",
  "t2.p": "The escrow logic lives in one immutable implementation contract, and every deal is a minimal " +
    "clone pointing at it. No proxy, no upgrade path, no \"we'll fix it later\". " +
    "The code you read today is the code that will execute.",
  "t3.h": "Our revenue is on-chain too",
  "t3.p": "The fee beneficiary address is fixed at deployment and immutable. The revenue figure above is " +
    "not a number we typed in; it is read from the contract's ledger. You learn what we earn when we do.",
  "t4.h": "The AI is a default, not an authority",
  "t4.p": "A dispute first gets a proposed ruling from an AI, which posts a bond for it. Anyone — with no " +
    "permission required — can post an equal bond to challenge it and escalate the case to a staked jury. " +
    "Overturning a bad ruling is profitable. That is why the AI is not a single point of failure.",
  "t5.h": "Advancing a case needs no permission",
  "t5.p": "Every step of the jury process (drawing, opening reveal, tallying, finalizing) can be triggered by " +
    "anyone. We run a keeper, but its role is that someone is doing it, not that only it can. " +
    "If it goes offline, anyone else can finish the process.",
  "t6.h": "A failed arbitration layer cannot lock your funds",
  "t6.p": "If a dispute goes unruled for long enough, anyone can trigger a neutral split that returns the funds " +
    "and pays the delinquent arbitration layer nothing. Your money does not get stuck because we broke.",

  "how.h2": "How to use it",
  "h1.h": "Open a deal in the bot",
  "h1.p": "Buyer and seller agree on terms; either side opens the deal in the Telegram bot. " +
    "Opening a deal locks no funds.",
  "h2.h": "Both sides fund it",
  "h2.p": "The buyer deposits the price plus a bond; the seller deposits a bond. The bot hands you a signing " +
    "link and the signature happens in your own wallet — it never touches your private key.",
  "h3.h": "Delivery and acceptance",
  "h3.p": "The seller marks delivery; the buyer confirms receipt and it settles: bonds return, the price goes " +
    "to the seller minus the fee. If the buyer says nothing before the inspection deadline, it releases anyway.",
  "h4.h": "If you disagree, it goes to arbitration",
  "h4.p": "Either side can raise a dispute. The AI proposes a ruling; if nobody challenges it within 48 hours " +
    "it takes effect. If challenged, the case escalates to a staked jury with commit-reveal voting and up to " +
    "three appeal rounds.",

  "risk.h2": "Risks and limits",
  "risk.sub": "This section is blunt because making it pretty would do nothing for you.",
  "r1.h": "Not audited by a third party.",
  "r1.p": "This is the single largest risk. The contracts have a thorough test suite, but tests prove that the " +
    "cases we thought of are fine; an audit looks for the ones we did not. Until an audit is done, " +
    "do not commit money you cannot afford to lose.",
  "r2.h": "The AI will get rulings wrong.",
  "r2.p": "What constrains it is the bond and the open right to challenge, not its accuracy. " +
    "A wrong ruling that nobody challenges will take effect.",
  "r3.h": "The jury is not a court.",
  "r3.p": "It is stake-weighted random selection plus majority vote. It resists small bribes; it does not " +
    "resist a bribe large enough relative to the deal value. Judge high-value deals accordingly.",
  "r4.h": "There is no undo on a blockchain.",
  "r4.p": "A wrong address, a mismatched terms hash, a transaction signed in error — there is no support desk. " +
    "Check the target contract shown on the signing page before you sign.",
  "r5.h": "Currently on testnet.",
  "r5.p": "The numbers above come from BSC testnet. The tokens have no value and the data may reset at any time.",

  "c.h2": "Contract addresses",
  "c.sub": "All deployed on BNB Smart Chain Testnet (chain ID 97). Click through to verify on the block explorer.",

  "foot.sign": "Signing page",
  "foot.src": "Source",
  "foot.fine": "This site offers no investment advice and takes no responsibility for the outcome of any deal. " +
    "The protocol is a set of rules, not a guarantor.",
};
