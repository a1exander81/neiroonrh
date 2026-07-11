const { ethers } = require("hardhat");

// Fixed, audited fee wallets — see contracts/README.md for rationale.
const NEIRO_TOKEN = process.env.NEIRO_TOKEN_ADDRESS || "0x00aF23339838240bA3bb42E424936B521d31041f";
const LP_WALLET = process.env.LP_WALLET_ADDRESS || "0x78a851D19E2152bB7162d8924CB2Bd088aca95C8";
const OWNER_FEE_WALLET = process.env.OWNER_FEE_WALLET_ADDRESS || "0xc2413696576176d1e31D55a2DEdA609906a15596";
const ECO_WALLET = process.env.ECO_WALLET_ADDRESS || "0x13864051772FDFBce895d21a483eee02edaeB445";

async function main() {
  const [deployer] = await ethers.getSigners();
  const admin = process.env.ADMIN_ADDRESS || deployer.address;

  console.log("Deployer:", deployer.address);
  console.log("Admin (owner):", admin);
  console.log("NEIRO token:", NEIRO_TOKEN);
  console.log("LP wallet:", LP_WALLET);
  console.log("Owner fee wallet:", OWNER_FEE_WALLET);
  console.log("Eco wallet:", ECO_WALLET);

  const NeiroMiner = await ethers.getContractFactory("NeiroMiner");
  const miner = await NeiroMiner.deploy(NEIRO_TOKEN, LP_WALLET, OWNER_FEE_WALLET, ECO_WALLET, admin);
  await miner.waitForDeployment();

  const address = await miner.getAddress();
  console.log("\nNeiroMiner deployed to:", address);
  console.log("\nNext steps:");
  console.log("1. Verify the contract on the Robinhood Chain explorer.");
  console.log("2. As the admin wallet, approve NEIRO to the contract and call");
  console.log("   notifyRewardAmount(amount, durationSeconds) to open the first reward stream.");
  console.log("3. Update the frontend contract address/ABI to point at:", address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
