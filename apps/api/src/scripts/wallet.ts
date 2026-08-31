/**
 * wallet.ts -- create a disposable wallet, or check the configured one's balances.
 *
 *   npm run wallet          # show address + USDC/ETH balances for THETANUTS_PRIVATE_KEY
 *   npm run wallet -- new   # generate a fresh disposable wallet and print its key
 *
 * The generated key is printed to your terminal on purpose: it belongs to a throwaway
 * wallet holding a few dollars, and you need to paste it into .env. Never point this at
 * a wallet you would miss, and never commit .env (it is gitignored).
 */
import { ethers } from "ethers";
import { getClient, USDC, USDC_DECIMALS, canSign } from "../thetanuts/client.js";
import { privateKey, requireRpc } from "../env.js";

const ERC20 = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  if (process.argv.includes("new")) {
    const w = ethers.Wallet.createRandom();
    console.log("\n  A fresh disposable wallet. Put the key in .env, send funds to the address.\n");
    console.log(`  THETANUTS_PRIVATE_KEY=${w.privateKey}\n`);
    console.log(`  address: ${w.address}`);
    console.log("\n  Fund it ON BASE (not Ethereum, not Arbitrum -- the network dropdown matters):");
    console.log("    ~5 USDC   to trade with");
    console.log("    ~$1 ETH   for gas -- without this every transaction fails");
    console.log("\n  Then: npm run wallet    to confirm the funds landed.\n");
    return;
  }

  if (!canSign()) {
    console.error("\n  THETANUTS_PRIVATE_KEY is not set in .env.");
    console.error("  Run:  npm run wallet -- new\n");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(requireRpc());
  const wallet = new ethers.Wallet(privateKey()!, provider);
  const usdc = new ethers.Contract(USDC, ERC20, provider);

  const [eth, bal] = await Promise.all([provider.getBalance(wallet.address), usdc.balanceOf(wallet.address)]);
  const ethAmount = Number(ethers.formatEther(eth));
  const usdcAmount = Number(bal) / 10 ** USDC_DECIMALS;

  console.log(`\n  address: ${wallet.address}`);
  console.log(`  USDC:    ${usdcAmount.toFixed(4)}`);
  console.log(`  ETH:     ${ethAmount.toFixed(6)}  (gas)`);

  const ready = usdcAmount >= 1 && ethAmount > 0.00002;
  if (ready) {
    console.log(`\n  Funded. Next:  npm run fill        (dry run)`);
    console.log(`                 npm run fill -- --live\n`);
  } else {
    if (usdcAmount < 1) console.log(`\n  Not enough USDC -- send ~5 USDC on Base.`);
    if (ethAmount <= 0.00002) console.log(`  Not enough ETH for gas -- send ~$1 of ETH on Base.`);
    console.log("");
  }
}

main().catch((e) => { console.error("\n  FAILED:", e?.message ?? e, "\n"); process.exit(1); });
