const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * 商家额度池。
 *
 * 它**不是**共享抵押。每笔交易的卖家保证金仍然进到它自己那个托管合约里，
 * 一笔出事不波及别笔 —— 这是托管合约最值钱的性质，不能为了省事丢掉。
 *
 * 共享抵押还更弱：N 笔订单共用一笔押金的话，「同时骗光所有在途订单」
 * 就是最优策略（骗 N 笔收益 N 倍，损失还是那一笔）。所以池子只是个预付账户。
 *
 * 这里要钉住的是它的边界：只动商家自己的钱、只听商家本人的、
 * 随时可全额取回、代付权限不能被拿去给别人刷差评。
 */

const U = (n) => BigInt(Math.round(n * 1e6));

const PRICE = U(1000);
const BOND = U(200);
const FEE_BPS = 50n;

describe("商家额度池", function () {
  let owner, buyer, seller, other, feeBene;
  let token, other20, vault, jury, factory, pool;

  beforeEach(async function () {
    [owner, buyer, seller, other, feeBene] = await ethers.getSigners();

    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    other20 = await (await ethers.getContractFactory("MockERC20")).deploy();
    vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBene.address);
    const impl = await (await ethers.getContractFactory("Escrow")).deploy();

    jury = await (await ethers.getContractFactory("StakedJury")).deploy(
      await token.getAddress(), 3n, U(2000), U(100), owner.address
    );
    await jury.setCost(await token.getAddress(), U(60));
    await jury.setCost(await other20.getAddress(), U(60));

    factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
      await impl.getAddress(), await jury.getAddress(), await vault.getAddress(), FEE_BPS, owner.address
    );
    pool = await (await ethers.getContractFactory("MerchantBond")).deploy(
      await token.getAddress(), await factory.getAddress()
    );
    await factory.setMerchantBond(await pool.getAddress());

    for (const s of [buyer, seller, other]) {
      await token.mint(s.address, U(100000));
      await token.connect(s).approve(await pool.getAddress(), U(100000));
    }
  });

  async function newDeal(sellerAddr = seller.address, t = null) {
    const tokenAddr = t ?? (await token.getAddress());
    const rc = await (await factory.connect(buyer).createDeal(
      tokenAddr, buyer.address, sellerAddr, PRICE, BOND, BOND,
      3 * 24 * 3600, 2 * 24 * 3600, ethers.ZeroHash
    )).wait();
    return ethers.getContractAt(
      "Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal
    );
  }

  describe("池子里只有商家自己的钱", function () {
    it("存入与取回，余额如实变动", async function () {
      await pool.connect(seller).deposit(U(1000));
      expect(await pool.balanceOf(seller.address)).to.equal(U(1000));

      const before = await token.balanceOf(seller.address);
      await pool.connect(seller).withdraw(U(400));
      expect(await pool.balanceOf(seller.address)).to.equal(U(600));
      expect(await token.balanceOf(seller.address) - before).to.equal(U(400));
    });

    it("随时可以全额取回 —— 池子里的钱还没承担任何义务", async function () {
      await pool.connect(seller).deposit(U(1000));
      await pool.connect(seller).withdraw(U(1000));
      expect(await pool.balanceOf(seller.address)).to.equal(0n);
      await expect(pool.connect(seller).withdraw(1n))
        .to.be.revertedWithCustomError(pool, "InsufficientBalance");
    });

    it("取不走别人的额度", async function () {
      await pool.connect(seller).deposit(U(1000));
      await expect(pool.connect(other).withdraw(U(1)))
        .to.be.revertedWithCustomError(pool, "InsufficientBalance");
    });
  });

  describe("用额度支付保证金", function () {
    it("一次调用就完成入金，钱进的是那一笔交易自己的柜子", async function () {
      await pool.connect(seller).deposit(U(1000));
      const deal = await newDeal();

      await pool.connect(seller).fundDeal(await deal.getAddress());

      expect(await pool.balanceOf(seller.address)).to.equal(U(800), "额度扣掉一笔保证金");
      expect(await token.balanceOf(await deal.getAddress())).to.equal(BOND, "钱在柜子里，不在池子里");
      expect(await token.balanceOf(await pool.getAddress())).to.equal(U(800));
    });

    it("额度不足就付不了 —— 在入金这一步就失败，而不是之后才发现", async function () {
      await pool.connect(seller).deposit(U(100));
      const deal = await newDeal();
      await expect(pool.connect(seller).fundDeal(await deal.getAddress()))
        .to.be.revertedWithCustomError(pool, "InsufficientBalance");
    });

    it("还能接几单是可以直接读出来的", async function () {
      await pool.connect(seller).deposit(U(1000));
      expect(await pool.ordersLeft(seller.address, BOND)).to.equal(5n);
      const deal = await newDeal();
      await pool.connect(seller).fundDeal(await deal.getAddress());
      expect(await pool.ordersLeft(seller.address, BOND)).to.equal(4n);
    });

    it("逐笔隔离没有被破坏：两笔交易的钱各在各的柜子里", async function () {
      await pool.connect(seller).deposit(U(1000));
      const a = await newDeal();
      const b = await newDeal();
      await pool.connect(seller).fundDeal(await a.getAddress());
      await pool.connect(seller).fundDeal(await b.getAddress());

      expect(await token.balanceOf(await a.getAddress())).to.equal(BOND);
      expect(await token.balanceOf(await b.getAddress())).to.equal(BOND);
      expect(await pool.balanceOf(seller.address)).to.equal(U(600));
    });

    it("结算后保证金回的是商家钱包，不是池子 —— 补额度是个主动动作", async function () {
      await pool.connect(seller).deposit(U(1000));
      const deal = await newDeal();
      await pool.connect(seller).fundDeal(await deal.getAddress());

      await token.connect(buyer).approve(await deal.getAddress(), PRICE + BOND);
      await deal.connect(buyer).depositBuyer();
      await deal.connect(seller).markDelivered("ipfs://x");

      const walletBefore = await token.balanceOf(seller.address);
      await deal.connect(buyer).confirmReceipt();

      const fee = (PRICE * FEE_BPS) / 10000n;
      expect(await token.balanceOf(seller.address) - walletBefore)
        .to.equal(PRICE - fee + BOND, "货款和保证金都进钱包");
      expect(await pool.balanceOf(seller.address)).to.equal(U(800), "池子余额不会自己回血");
    });
  });

  describe("代付权限不能被拿去害人", function () {
    it("别人动不了你的额度，哪怕那笔交易的卖家就是你", async function () {
      // 放开的话，任何人都能拿商家的额度把他塞进一笔他没同意的交易 ——
      // 钱是商家的，信誉记录也是商家的。花点钱给对手刷差评这条路必须堵死。
      await pool.connect(seller).deposit(U(1000));
      const deal = await newDeal();
      await expect(pool.connect(buyer).fundDeal(await deal.getAddress()))
        .to.be.revertedWithCustomError(pool, "NotSeller");
      await expect(pool.connect(other).fundDeal(await deal.getAddress()))
        .to.be.revertedWithCustomError(pool, "NotSeller");
    });

    it("只认工厂登记过的交易，自制的假柜子一律拒绝", async function () {
      await pool.connect(seller).deposit(U(1000));
      const impl = await (await ethers.getContractFactory("Escrow")).deploy();
      await expect(pool.connect(seller).fundDeal(await impl.getAddress()))
        .to.be.revertedWithCustomError(pool, "NotADeal");
    });

    it("币种对不上就拒绝，不会拿这个池子的钱去付另一种币的单", async function () {
      await pool.connect(seller).deposit(U(1000));
      const deal = await newDeal(seller.address, await other20.getAddress());
      await expect(pool.connect(seller).fundDeal(await deal.getAddress()))
        .to.be.revertedWithCustomError(pool, "WrongToken");
    });

    it("托管合约那侧也收紧了：除了卖家本人和登记的代付方，谁都不能代付", async function () {
      const deal = await newDeal();
      await token.connect(other).approve(await deal.getAddress(), BOND);
      await expect(deal.connect(other).depositSeller())
        .to.be.revertedWithCustomError(deal, "NotParty");
    });

    it("不配置额度池时，行为与从前完全一致", async function () {
      const f2 = await (await ethers.getContractFactory("EscrowFactory")).deploy(
        await (await ethers.getContractFactory("Escrow")).deploy().then((x) => x.getAddress()),
        await jury.getAddress(), await vault.getAddress(), FEE_BPS, owner.address
      );
      const rc = await (await f2.connect(buyer).createDeal(
        await token.getAddress(), buyer.address, seller.address, PRICE, BOND, BOND,
        3 * 24 * 3600, 2 * 24 * 3600, ethers.ZeroHash
      )).wait();
      const deal = await ethers.getContractAt(
        "Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal
      );
      expect(await deal.bondPayer()).to.equal(ethers.ZeroAddress);

      await token.connect(seller).approve(await deal.getAddress(), BOND);
      await deal.connect(seller).depositSeller();
      expect(await token.balanceOf(await deal.getAddress())).to.equal(BOND);
    });
  });
});
