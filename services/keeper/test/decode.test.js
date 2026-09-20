import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";

/**
 * 链上返回值的解码。
 *
 * 这一层原本一个测试都没有：keeper 的其他测试都拿手搓的普通对象喂给
 * tasks.js，于是「从合约读回来的东西长什么样」这个问题从没被问过。
 * 结果就是 `(await jury.cases(id)).c` 这种写法一路活到了真实链上——
 * ethers v6 对单返回值函数直接返回值本身，`.c` 永远是 undefined，
 * 而 undefined.phase 只有连上真链才会炸。
 *
 * 所以这里不 mock 合约，而是用真的 ethers.Interface 编码一份返回数据，
 * 让 ethers 自己去解，走的就是线上那条路径。
 */
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.KEEPER_PRIVATE_KEY ??= "0x" + "11".repeat(32);
process.env.ESCROW_FACTORY ??= "0x0000000000000000000000000000000000000001";

const { JURY_ABI, OPTIMISTIC_ABI, readJuryCase, readDispute } = await import("../src/chain.js");

const ADDR = "0x0000000000000000000000000000000000000002";

/** 只有 call 的 runner —— 静态调用不需要别的。返回预先编好的那份数据。 */
function contractReturning(abi, fn, values) {
  const iface = new ethers.Interface(abi);
  const data = iface.encodeFunctionResult(fn, [values]);
  return new ethers.Contract(ADDR, abi, { call: async () => data });
}

describe("链上返回值解码", () => {
  test("readJuryCase 取得到 phase 和各个截止时间", async () => {
    const c = contractReturning(JURY_ABI, "cases", {
      arbitrable: ADDR,
      feeToken: ADDR,
      phase: 2,
      ruling: 1,
      drawBlock: 1000n,
      commitDeadline: 1111n,
      revealDeadline: 2222n,
      appealDeadline: 3333n,
      roundStartedAt: 444n,
      createdAt: 55n,
      rngRequestedAt: 0n,
      rngSource: ethers.ZeroAddress,
      dealBuyer: ADDR,
      dealSeller: ADDR,
      value: 10n ** 21n,
      baseCost: 10n ** 19n,
    });

    const got = await readJuryCase(c, 7n);
    assert.equal(got.id, 7n);
    assert.equal(got.phase, 2, "phase 解不出来，说明又把单返回值多包了一层");
    assert.equal(got.drawBlock, 1000);
    assert.equal(got.commitDeadline, 1111);
    assert.equal(got.revealDeadline, 2222);
    assert.equal(got.appealDeadline, 3333);
    assert.equal(got.roundStartedAt, 444);
    for (const [k, v] of Object.entries(got)) assert.ok(!Number.isNaN(v), k + " 是 NaN");
  });

  test("readDispute 取得到 status 和两个时间戳", async () => {
    const abi = OPTIMISTIC_ABI;
    const frag = new ethers.Interface(abi).getFunction("disputes");
    // 按 ABI 里声明的字段顺序构造，字段改了这里会直接报错而不是静默给 0
    const fields = frag.outputs[0].components.map((c) => c.name);
    const fill = {
      arbitrable: ADDR, token: ADDR, challenger: ADDR, dealBuyer: ADDR, dealSeller: ADDR,
      status: 1, proposedRuling: 2,
      createdAt: 100n, proposedAt: 200n,
      bond: 10n ** 19n, finalCost: 10n ** 19n, value: 10n ** 21n,
    };
    const values = Object.fromEntries(fields.map((n) => {
      assert.ok(n in fill, "ABI 里多了字段 " + n + "，本测试要跟着补");
      return [n, fill[n]];
    }));

    const got = await readDispute(contractReturning(abi, "disputes", values), 3n);
    assert.equal(got.id, 3n);
    assert.equal(got.status, 1, "status 解不出来，说明又把单返回值多包了一层");
    assert.equal(got.createdAt, 100);
    assert.equal(got.proposedAt, 200);
  });
});
