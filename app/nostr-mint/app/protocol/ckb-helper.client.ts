import {
  helpers,
  BI,
  Cell,
  Script,
  HashType,
  utils,
  Transaction,
  OutPoint,
} from "@ckb-lumos/lumos";
import offCKB from "offckb.config";
import { blockchain } from "@ckb-lumos/base";
import { bytes } from "@ckb-lumos/codec";

offCKB.initializeLumosConfig();

const lumosConfig = offCKB.lumosConfig;
const indexer = offCKB.indexer;

export async function collectCell(ckbAddress: string, neededCapacity: BI) {
  const fromScript = helpers.parseAddress(ckbAddress, {
    config: lumosConfig,
  });

  let collectedSum = BI.from(0);
  const collected: Cell[] = [];
  const collector = indexer.collector({ lock: fromScript, type: "empty" });
  for await (const cell of collector.collect()) {
    collectedSum = collectedSum.add(cell.cellOutput.capacity);
    collected.push(cell);
    if (collectedSum >= neededCapacity) break;
  }

  if (collectedSum.lt(neededCapacity)) {
    throw new Error(`Not enough CKB, ${collectedSum} < ${neededCapacity}`);
  }

  return collected;
}

export async function collectTypeCell(
  ckbAddress: string,
  type: Script | undefined,
  total: number
) {
  const fromScript = helpers.parseAddress(ckbAddress, {
    config: lumosConfig,
  });

  const collected: Cell[] = [];
  const collector = indexer.collector({ lock: fromScript, type });
  for await (const cell of collector.collect()) {
    collected.push(cell);
    if (collected.length >= total) break;
  }

  if (collected.length < total) {
    throw new Error(`Not enough type cells, ${collected.length} < ${total}`);
  }

  return collected;
}

export async function listTypeCells(
  ckbAddress: string,
  type: Script | undefined,
  maxTotal: number
) {
  const fromScript = helpers.parseAddress(ckbAddress, {
    config: lumosConfig,
  });

  const collected: Cell[] = [];
  const options = type != null ? { lock: fromScript, type } : { lock: fromScript } 
  const collector = indexer.collector(options);
  for await (const cell of collector.collect()) {
    collected.push(cell);
    if (collected.length >= maxTotal) break;
  }

  return collected;
}

export async function capacityOf(address: string): Promise<BI> {
  const collector = indexer.collector({
    lock: helpers.parseAddress(address),
  });

  let balance = BI.from(0);
  for await (const cell of collector.collect()) {
    balance = balance.add(cell.cellOutput.capacity);
  }

  return balance;
}

export function buildAlwaysSuccessLock(): Script {
  return {
    codeHash: lumosConfig.SCRIPTS["ALWAYS_SUCCESS"]!.CODE_HASH,
    hashType: lumosConfig.SCRIPTS["ALWAYS_SUCCESS"]!.HASH_TYPE as HashType,
    args: "0x",
  };
}

export function buildDeadLock(): Script {
  return {
    codeHash: lumosConfig.SCRIPTS["SECP256K1_BLAKE160"]!.CODE_HASH,
    hashType: lumosConfig.SCRIPTS["SECP256K1_BLAKE160"]!.HASH_TYPE as HashType,
    args: "0x" + "00".repeat(20),
  };
}

export function computeTransactionHash(rawTransaction: Transaction) {
  const transactionSerialized = bytes.hexify(
    blockchain.RawTransaction.pack(rawTransaction)
  );
  const rawTXHash = utils.ckbHash(transactionSerialized);
  return rawTXHash;
}

export async function getWitnessByOutpoint(outpoint: OutPoint){
  const txHash = outpoint.txHash;
  const index = +outpoint.index;
  const tx = await offCKB.rpc.getTransaction(txHash);
  if(tx){
    return tx.transaction.witnesses[index];
  }
  return null;
}

