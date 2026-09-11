// 编译全部合约。无框架依赖，直接驱动 solc-js，
// 任何人 clone 仓库后 `npm i && npm run build` 即可复现字节码。
import solc from "solc";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = join(root, "contracts");

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".sol") ? [p] : [];
  });
}

const sources = {};
for (const file of walk(contractsDir)) {
  const key = relative(contractsDir, file).split("\\").join("/");
  sources[key] = { content: readFileSync(file, "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

// import 解析：合约里用的是相对路径，统一映射回 contracts/ 下
function findImports(path) {
  const candidates = [join(contractsDir, path), join(root, path)];
  for (const c of candidates) {
    try {
      return { contents: readFileSync(c, "utf8") };
    } catch {}
  }
  return { error: "File not found: " + path };
}

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

const errors = (out.errors ?? []).filter((e) => e.severity === "error");
const warnings = (out.errors ?? []).filter((e) => e.severity !== "error");

for (const w of warnings) console.log("WARN  " + w.formattedMessage.trim() + "\n");
for (const e of errors) console.error("ERROR " + e.formattedMessage.trim() + "\n");

if (errors.length) {
  console.error(`\n编译失败：${errors.length} 个错误`);
  process.exit(1);
}

mkdirSync(join(root, "out"), { recursive: true });
let count = 0;
for (const [file, contracts] of Object.entries(out.contracts ?? {})) {
  for (const [name, c] of Object.entries(contracts)) {
    writeFileSync(
      join(root, "out", `${name}.json`),
      JSON.stringify({ abi: c.abi, bytecode: c.evm.bytecode.object }, null, 2)
    );
    const size = c.evm.deployedBytecode.object.length / 2;
    console.log(`  ${name.padEnd(22)} ${String(size).padStart(6)} bytes${size > 24576 ? "  << 超过 24KB 部署上限!" : ""}`);
    count++;
  }
}
console.log(`\n编译成功：${count} 个合约，${warnings.length} 个警告`);
