const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * 店铺模式：卖家上架一次，买家点一下就下单。
 *
 * 要守住的几件事：
 *   1. 一笔交易里开单 + 双方入金，当场生效；任何一步不满足就整笔回滚，谁的钱都没动
 *   2. 上架后价格和条款不能改 —— 买家下单时看到的就是成交的
 *   3. 「代买家付款」这个权限只有店铺有，而店铺只替亲自下单的人付
 *   4. 每一单仍是独立的托管合约；结算、退款只打给买卖双方本人，不回到店铺
 */

const U = (n) => BigInt(Math.round(n * 1e6));
const PRICE = U(100);
const BB = U(30);
const SB = U(50);
const FEE_BPS = 100n;
const FEE = (PRICE * FEE_BPS) / 10000n;
const DELIVERY = 24 * 3600;
const INSPECTION = 12 * 3600;
const TERMS_TEXT = "商品：游戏点卡 100 元面值\n交付：下单后 24 小时内发卡密\n验收：卡密能正常充值";
const TERMS = ethers.keccak256(ethers.toUtf8Bytes(TERMS_TEXT));
// 一个合法的压缩公钥（secp256k1 生成元），当买家的取货公钥用
const PICKUP = "0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const State = { Open: 1n, Funded: 2n, Delivered: 3n, Disputed: 4n, Resolved: 5n, Cancelled: 6n };

describe("店铺模式", function () {
  let owner, seller, buyer, buyer2, outsider, feeBene;
  let token, vault, arb, factory, store;

  beforeEach(async function () {
    [owner, seller, buyer, buyer2, outsider, feeBene] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBene.address);
    const impl = await (await ethers.getContractFactory("Escrow")).deploy();
    arb = await (await ethers.getContractFactory("DirectArbitrator")).deploy();
    await arb.setCost(U(20));
    factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
      await impl.getAddress(), await arb.getAddress(), await vault.getAddress(), FEE_BPS, owner.address);
    store = await (await ethers.getContractFactory("MerchantBond")).deploy(
      await token.getAddress(), await factory.getAddress());
    await factory.setMerchantBond(await store.getAddress());

    for (const s of [seller, buyer, buyer2, outsider]) {
      await token.mint(s.address, U(10000));
      await token.connect(s).approve(await store.getAddress(), U(10000));
    }
    await store.connect(seller).deposit(SB * 3n);                      // 额度：够接 3 单
    await store.connect(seller).list(PRICE, BB, SB, DELIVERY, INSPECTION, TERMS_TEXT, 5);
  });

  const LID = 1n;
  async function buy(who = buyer) {
    const rc = await (await store.connect(who).buy(LID, PICKUP)).wait();
    const ev = rc.logs.map((l) => { try { return store.interface.parseLog(l); } catch { return null; } })
      .find((x) => x && x.name === "Purchased");
    return ethers.getContractAt("Escrow", ev.args.deal);
  }
  const bal = (a) => token.balanceOf(a);

  // ------------------------------------------------------------ 下单

  it("点一下就下单：开单、双方入金、当场生效，全在一笔交易里", async function () {
    const b0 = await bal(buyer.address);
    const deal = await buy();
    expect(await deal.state()).to.equal(State.Funded, "下单完成时交易就已经生效");
    expect(await deal.buyer()).to.equal(buyer.address, "买家就是下单的人");
    expect(await deal.seller()).to.equal(seller.address);
    expect(await deal.buyerPayer()).to.equal(await store.getAddress());
    expect(await deal.termsHash()).to.equal(TERMS, "条款就是上架时那一份");
    expect(await bal(await deal.getAddress())).to.equal(PRICE + BB + SB);
    expect(b0 - (await bal(buyer.address))).to.equal(PRICE + BB, "买家只付货款 + 自己的押金");
    expect(await store.balanceOf(seller.address)).to.equal(SB * 2n, "卖家额度扣掉一份押金");
    const l = await store.listings(LID);
    expect([l.stock, l.sold]).to.deep.equal([4n, 1n]);
    expect(await bal(await store.getAddress())).to.equal(SB * 2n, "店铺里只剩卖家额度，不截留买家一分钱");
  });

  it("之后的流程和普通交易一模一样；结算只打给买卖双方本人", async function () {
    const deal = await buy();
    const s0 = await bal(seller.address), b0 = await bal(buyer.address), p0 = await bal(await store.getAddress());
    await deal.connect(seller).markDelivered("sha256:...");
    await deal.connect(buyer).confirmReceipt();
    expect((await bal(seller.address)) - s0).to.equal(PRICE - FEE + SB, "货款扣手续费 + 押金回到卖家钱包");
    expect((await bal(buyer.address)) - b0).to.equal(BB);
    expect(await bal(await store.getAddress())).to.equal(p0, "店铺不收回任何东西");
  });

  it("卖家不发货：买家取回全款，退到买家本人，不回店铺", async function () {
    const deal = await buy();
    const b0 = await bal(buyer.address), s0 = await bal(seller.address);
    await time.increase(DELIVERY + 1);
    await deal.connect(buyer).claimNonDelivery();
    expect((await bal(buyer.address)) - b0).to.equal(PRICE + BB);
    expect((await bal(seller.address)) - s0).to.equal(SB, "无过错取消，卖家押金原额退回他的钱包");
  });

  it("店铺下的单也能起争议、认输、和解", async function () {
    const deal = await buy();
    await deal.connect(seller).markDelivered("x");
    await deal.connect(buyer).raiseDispute("卡密无法充值");
    const b0 = await bal(buyer.address);
    await deal.connect(seller).concede();
    expect((await bal(buyer.address)) - b0).to.equal(PRICE + BB + SB - U(20));
  });

  // ------------------------------------------------------------ 不满足就整笔回滚

  it("卖家额度不够：整笔回滚，买家的钱、库存都不动", async function () {
    await buy(); await buy(); await buy();                            // 额度用完
    const b0 = await bal(buyer2.address), l0 = await store.listings(LID);
    await expect(store.connect(buyer2).buy(LID, PICKUP)).to.be.revertedWithCustomError(store, "InsufficientBalance");
    expect(await bal(buyer2.address)).to.equal(b0);
    expect((await store.listings(LID)).stock).to.equal(l0.stock);
  });

  it("押金是并发上限、不是总量上限：结算后卖家补回额度就能接着卖", async function () {
    const deals = [await buy(), await buy(), await buy()];
    await expect(store.connect(buyer2).buy(LID, PICKUP)).to.be.revertedWithCustomError(store, "InsufficientBalance");
    for (const d of deals) {
      await d.connect(seller).markDelivered("x");
      await d.connect(buyer).confirmReceipt();
    }
    // 押金回到了卖家钱包；卖家（或他的自动发货程序）存回额度
    await store.connect(seller).deposit(SB * 3n);
    await buy(buyer2);
  });

  it("售罄自动停；下架后不能买；只有卖家能上下架", async function () {
    await store.connect(seller).updateListing(LID, true, 1);
    await buy();
    await expect(store.connect(buyer2).buy(LID, PICKUP)).to.be.revertedWithCustomError(store, "SoldOut");

    await store.connect(seller).updateListing(LID, false, 10);
    await expect(store.connect(buyer2).buy(LID, PICKUP)).to.be.revertedWithCustomError(store, "ListingInactive");
    await expect(store.connect(outsider).updateListing(LID, true, 10)).to.be.revertedWithCustomError(store, "NotListingOwner");
  });

  it("没授权给店铺就下不了单，什么都不发生", async function () {
    await token.connect(buyer2).approve(await store.getAddress(), 0);
    await expect(store.connect(buyer2).buy(LID, PICKUP)).to.be.reverted;
    expect(await store.balanceOf(seller.address)).to.equal(SB * 3n);
  });

  it("卖家不能买自己的商品（刷单）", async function () {
    await expect(store.connect(seller).buy(LID, PICKUP)).to.be.revertedWithCustomError(factory, "SamePartyBothSides");
  });

  it("不存在的商品", async function () {
    await expect(store.connect(buyer).buy(999, PICKUP)).to.be.revertedWithCustomError(store, "UnknownListing");
  });

  // ------------------------------------------------------------ 代付权限

  /*
   * 「代买家付款」如果谁都能设，第三方就能替一个毫不知情的地址开单付款，
   * 再用卖家一方的争议给他刷出一条败诉记录。所以只有店铺能设，
   * 而店铺只替亲自下单的人付。
   */
  it("只有店铺能开带买家代付方的单", async function () {
    await expect(factory.connect(outsider).createDealFor(await token.getAddress(), buyer.address, seller.address,
      PRICE, BB, SB, DELIVERY, INSPECTION, TERMS)).to.be.revertedWithCustomError(factory, "NotMerchantBond");
  });

  it("普通开单没有买家代付方：店铺不能替别人的普通交易付款", async function () {
    const rc = await (await factory.connect(seller).createDeal(await token.getAddress(), buyer.address, seller.address,
      PRICE, BB, SB, DELIVERY, INSPECTION, TERMS)).wait();
    const deal = await ethers.getContractAt("Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal);
    expect(await deal.buyerPayer()).to.equal(ethers.ZeroAddress);
    await expect(deal.connect(outsider).depositBuyer()).to.be.revertedWithCustomError(deal, "NotParty");
  });

  // ------------------------------------------------------------ 条款不可变

  // ------------------------------------------------------------ 条款全文上链

  it("条款全文存在链上，哈希由合约自己算：买家看到的就是成交的那一份", async function () {
    const l = await store.listings(LID);
    expect(l.terms).to.equal(TERMS_TEXT);
    expect(l.termsHash).to.equal(ethers.keccak256(ethers.toUtf8Bytes(l.terms)));
    const deal = await buy();
    expect(await deal.termsHash()).to.equal(l.termsHash);
  });

  it("空条款、超长条款都不能上架", async function () {
    await expect(store.connect(seller).list(PRICE, BB, SB, DELIVERY, INSPECTION, "", 1))
      .to.be.revertedWithCustomError(store, "BadTerms");
    await expect(store.connect(seller).list(PRICE, BB, SB, DELIVERY, INSPECTION, "字".repeat(1400), 1))
      .to.be.revertedWithCustomError(store, "BadTerms");
  });

  it("按卖家查商品、按订单查来源商品和取货公钥 —— 全是状态，不靠日志", async function () {
    await store.connect(seller).list(PRICE, BB, SB, DELIVERY, INSPECTION, "第二件商品", 1);
    expect(await store.listingsOfLength(seller.address)).to.equal(2n);
    expect(await store.listingsOf(seller.address, 1)).to.equal(2n);
    const deal = await buy();
    expect(await store.listingOf(await deal.getAddress())).to.equal(LID);
    expect(await store.pickupKeyOf(await deal.getAddress())).to.equal(PICKUP);
  });

  it("取货公钥格式不对就不让下单；实物商品可以不传", async function () {
    for (const bad of ["0x04" + "11".repeat(32), "0x02" + "11".repeat(31), "0x05" + "11".repeat(32)]) {
      await expect(store.connect(buyer).buy(LID, bad)).to.be.revertedWithCustomError(store, "BadPickupKey");
    }
    await store.connect(buyer).buy(LID, "0x");
  });

  // ------------------------------------------------------------ 加密交付

  it("加密交付：密文存在交易合约里，交付同时开始验收计时", async function () {
    const deal = await buy();
    const goods = "0x" + "ab".repeat(91);
    await deal.connect(seller).deliverSealed(goods);
    expect(await deal.sealedGoods()).to.equal(goods, "买家两天后来取也得在，所以存状态不存日志");
    expect(await deal.state()).to.equal(State.Delivered);
    expect(await deal.inspectionDeadline()).to.be.greaterThan(0n);
  });

  it("加密交付的规矩和普通标记交付一样：只有卖家、只在交付期内", async function () {
    const deal = await buy();
    await expect(deal.connect(buyer).deliverSealed("0x01")).to.be.revertedWithCustomError(deal, "NotParty");
    await expect(deal.connect(seller).deliverSealed("0x")).to.be.revertedWithCustomError(deal, "SealedTooLarge");
    await expect(deal.connect(seller).deliverSealed("0x" + "00".repeat(1025))).to.be.revertedWithCustomError(deal, "SealedTooLarge");
    await time.increase(DELIVERY + 1);
    await expect(deal.connect(seller).deliverSealed("0x01")).to.be.revertedWithCustomError(deal, "TooLate");
  });

  // ------------------------------------------------------------ 取货钥匙：从签名到卡密

  /*
   * 整条链路用真实的签名、真实的链上状态跑一遍：
   * 买家签名 → 推出取货钥匙 → 下单时把公钥记上链 → 卖家从链上读公钥加密卡密 →
   * 密文存进交易合约 → 买家从合约读密文、重新签名、解开。
   * 用的是签名页和发货程序共用的那一份 pickup.js。
   */
  describe("取货钥匙", function () {
    const P = require("../services/signing-page/pickup.js");
    const CODE = "CARD-8842-XK19-ZZ07  密码 553190";

    async function buyerKey(who) {
      return P.keyFromSignature(await who.signMessage(P.pickupMessage(who.address)));
    }

    it("买家下单时记下公钥，卖家加密，买家从合约里解开 —— 原文一字不差", async function () {
      const key = await buyerKey(buyer);
      const rc = await (await store.connect(buyer).buy(LID, key.compressedPublicKey)).wait();
      const dealAddr = rc.logs.map((l) => { try { return store.interface.parseLog(l); } catch { return null; } })
        .find((x) => x && x.name === "Purchased").args.deal;
      const deal = await ethers.getContractAt("Escrow", dealAddr);

      // 卖家：只从链上拿公钥，不经过任何人
      const pub = await store.pickupKeyOf(dealAddr);
      await deal.connect(seller).deliverSealed(await P.seal(pub, CODE));

      // 买家：换个时间、换个地方，重新签一次名就能取
      const again = await buyerKey(buyer);
      expect(await P.open(again, await deal.sealedGoods())).to.equal(CODE);
    });

    it("同一个钱包每次签出来的钥匙都一样 —— 所以不用保存任何东西", async function () {
      const a = await buyerKey(buyer), b = await buyerKey(buyer);
      expect(a.privateKey).to.equal(b.privateKey);
      expect((await buyerKey(buyer2)).privateKey).to.not.equal(a.privateKey, "不同钱包的钥匙必须不同");
    });

    it("别人的钥匙解不开；密文被改一个字节也解不开（不会解出一张假卡密）", async function () {
      const key = await buyerKey(buyer);
      const sealed = await P.seal(key.compressedPublicKey, CODE);
      await expect(P.open(await buyerKey(buyer2), sealed)).to.be.rejected;
      const bytes = ethers.getBytes(sealed);
      bytes[bytes.length - 1] ^= 1;
      await expect(P.open(key, ethers.hexlify(bytes))).to.be.rejected;
    });

    it("同一段卡密每次加密出来都不同（每次一把新的临时钥匙），但都能解开", async function () {
      const key = await buyerKey(buyer);
      const a = await P.seal(key.compressedPublicKey, CODE), b = await P.seal(key.compressedPublicKey, CODE);
      expect(a).to.not.equal(b);
      expect(await P.open(key, a)).to.equal(CODE);
      expect(await P.open(key, b)).to.equal(CODE);
    });

    it("一张卡密加密后远小于合约的上限", async function () {
      const key = await buyerKey(buyer);
      const n = ethers.getBytes(await P.seal(key.compressedPublicKey, CODE)).length;
      expect(n).to.be.lessThan(200);
    });
  });

  it("上架后价格和条款改不了：唯一能动的只有上下架和库存", async function () {
    const before = await store.listings(LID);
    await store.connect(seller).updateListing(LID, true, 99);
    const after = await store.listings(LID);
    for (const k of ["seller", "price", "buyerBond", "sellerBond", "deliveryWindow", "inspectionWindow", "termsHash", "terms"]) {
      expect(after[k]).to.equal(before[k], `${k} 不能变`);
    }
    // 合约上也根本没有改价的函数
    const writes = store.interface.fragments
      .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
      .map((f) => f.name);
    expect(writes.filter((n) => /price|terms|edit|set/i.test(n))).to.deep.equal([]);
    expect(writes.sort()).to.deep.equal(["buy", "deposit", "fundDeal", "list", "updateListing", "withdraw"],
      "新增任何能改状态的函数都要在这里过目 —— 它可能就是一个改价入口");
  });
});
