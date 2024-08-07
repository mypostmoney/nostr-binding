import { CellDep, HexString, helpers, utils, WitnessArgs, Script } from '@ckb-lumos/lumos';
import { ScriptConfig } from '@ckb-lumos/lumos/config';
import { TESTNET_CONFIGS } from './config';
import { TagName } from './tag';
import { bytesToJsonString, jsonStringToBytes } from './util';
import { blockchain } from '@ckb-lumos/base';
import { bytes, number } from '@ckb-lumos/codec';
import { Event, Timestamp } from '@rust-nostr/nostr-sdk';

const { Uint64 } = number;

export interface EventToSign {
  readonly created_at: number;
  readonly kind: number;
  readonly tags: string[][];
  readonly content: string;
}

export interface SignedEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: string[][];
  readonly content: string;
}

export class NostrLock {
  readonly kind = 23334;
  readonly content =
    'Signing a CKB transaction\n\nIMPORTANT: Please verify the integrity and authenticity of connected Nostr client before signing this message\n';
  readonly dummyCkbSigHashAll = '0x' + '00'.repeat(32);

  readonly prefix: 'ckt' | 'ckb';
  readonly scriptConfig: ScriptConfig;

  constructor(scriptConfig = TESTNET_CONFIGS.NOSTR_LOCK, prefix: 'ckt' | 'ckb' = 'ckt') {
    this.prefix = prefix;
    this.scriptConfig = scriptConfig;
  }

  isNostrLock(lock: Script | undefined) {
    if (lock == null) return false;
    return lock.codeHash === this.scriptConfig.CODE_HASH && lock.hashType === this.scriptConfig.HASH_TYPE;
  }

  parseUnlockEventFromWitnessArgs(args: WitnessArgs) {
    const lock = args.lock;
    if (lock) {
      const eventBytes = bytes.bytify(lock);
      const eventJsonString = bytesToJsonString(eventBytes);
      try {
        return Event.fromJson(eventJsonString);
      } catch (error: unknown) {
        console.debug(error);
        return null;
      }
    }
    return null;
  }

  // 20 bytes of pubkey hash
  buildPubkeyHash(ownerPubkey: HexString) {
    const hasher = new utils.CKBHasher();
    hasher.update(bytes.bytify(ownerPubkey));
    return hasher.digestHex().slice(0, 42);
  }

  buildPubkeyScriptArgs(ownerPubkey: HexString) {
    const pubkeyHash = this.buildPubkeyHash(ownerPubkey);
    const lockArgs = '0x00' + pubkeyHash.slice(2);
    return lockArgs;
  }

  buildPowScriptArgs(pow: number) {
    if (pow > 255) {
      throw new Error('max pow value is 255');
    }

    const dummyPubkeyHash = '00'.repeat(20);
    const lockArgs = '0x' + pow.toString(16) + dummyPubkeyHash;
    return lockArgs;
  }

  buildScript(ownerPubkey: HexString) {
    const lockArgs = this.buildPubkeyScriptArgs(ownerPubkey);
    return {
      codeHash: this.scriptConfig.CODE_HASH,
      hashType: this.scriptConfig.HASH_TYPE,
      args: lockArgs,
    };
  }

  // PowLockScript only checks if the witness event is matching specific difficulties instead of a pubkey hash
  buildPowScript(pow: number) {
    const lockArgs = this.buildPowScriptArgs(pow);
    return {
      codeHash: this.scriptConfig.CODE_HASH,
      hashType: this.scriptConfig.HASH_TYPE,
      args: lockArgs,
    };
  }

  encodeToCKBAddress(ownerPubkey: HexString) {
    const lockScript = this.buildScript(ownerPubkey);
    const address = helpers.encodeToAddress(lockScript, { config: { PREFIX: this.prefix, SCRIPTS: {} } });
    return address;
  }

  parseCBKAddressToNostrPubkeyHash(ckbAddress: string) {
    const script = helpers.parseAddress(ckbAddress, { config: { PREFIX: this.prefix, SCRIPTS: {} } });
    if (script.codeHash !== this.scriptConfig.CODE_HASH || script.hashType !== this.scriptConfig.HASH_TYPE) {
      throw new Error('nostr-lock contract script info not match!');
    }

    // 20 bytes hash
    return script.args.slice(4);
  }

  buildCellDeps() {
    const cellDeps: CellDep[] = [
      {
        outPoint: {
          txHash: this.scriptConfig.TX_HASH,
          index: this.scriptConfig.INDEX,
        },
        depType: this.scriptConfig.DEP_TYPE,
      },
    ];
    return cellDeps;
  }

  async signTx(txSkeleton: helpers.TransactionSkeletonType, signer: (_event: EventToSign) => Promise<SignedEvent>) {
    const lockIndexes: Array<number> = [];
    for (const [index, cell] of txSkeleton.get('inputs').entries()) {
      if (this.isNostrLock(cell.cellOutput.lock)) {
        lockIndexes.push(index);
      }
    }

    if (lockIndexes.length === 0) {
      throw new Error('there is no nostr lock input.');
    }

    console.debug('lockIndexes:', lockIndexes);
    const dummyEvent = this.buildDummyEvent();
    const dummyLength = jsonStringToBytes(dummyEvent).length;
    console.debug('dummyEvent and length: ', dummyEvent, dummyLength);

    const witnessIndex = lockIndexes[0];
    const dummyLock = '0x' + '00'.repeat(dummyLength);
    const newWitnessArgs: WitnessArgs = {
      lock: dummyLock,
    };

    while (witnessIndex >= txSkeleton.get('witnesses').size) {
      txSkeleton = txSkeleton.update('witnesses', (witnesses) => witnesses.push('0x'));
    }

    let witness: string = txSkeleton.get('witnesses').get(witnessIndex)!;

    if (witness !== '0x') {
      const witnessArgs = blockchain.WitnessArgs.unpack(bytes.bytify(witness));
      const inputType = witnessArgs.inputType;
      if (inputType) {
        newWitnessArgs.inputType = inputType;
      }
      const outputType = witnessArgs.outputType;
      if (outputType) {
        newWitnessArgs.outputType = outputType;
      }
    }
    witness = bytes.hexify(blockchain.WitnessArgs.pack(newWitnessArgs));
    txSkeleton = txSkeleton.update('witnesses', (witnesses) => witnesses.set(witnessIndex, witness));

    const sigHashAll = this.buildSigHashAll(txSkeleton, lockIndexes);
    console.debug('sighash_all = ', sigHashAll);

    const event = this.buildUnlockEvent(sigHashAll);

    const signedEvent = await signer(event);
    const eventJson = jsonStringToBytes(JSON.stringify(signedEvent));
    console.debug('eventJson.byteLength: ', eventJson.byteLength, signedEvent);

    // put signed event into witness
    {
      let witness: string = txSkeleton.get('witnesses').get(witnessIndex)!;
      if (witness !== '0x') {
        const witnessArgs = blockchain.WitnessArgs.unpack(bytes.bytify(witness));
        witnessArgs.lock = bytes.hexify(eventJson);
        witness = bytes.hexify(blockchain.WitnessArgs.pack(witnessArgs));
        txSkeleton = txSkeleton.update('witnesses', (witnesses) => witnesses.set(witnessIndex, witness));
      }
    }

    return txSkeleton;
  }

  buildSigHashAll(txSkeleton: helpers.TransactionSkeletonType, lockIndexes: Array<number>) {
    const tx = helpers.createTransactionFromSkeleton(txSkeleton);
    const txHash = utils.ckbHash(blockchain.RawTransaction.pack(tx));
    const inputs = txSkeleton.get('inputs');
    const witness = txSkeleton.witnesses.get(lockIndexes[0]);
    if (witness == null) throw new Error('not get lock index!');

    let count = 0;

    const hasher = new utils.CKBHasher();
    hasher.update(txHash);
    count += 32;

    const witnessLength = bytes.bytify(witness).length;
    hasher.update(bytes.hexify(Uint64.pack(witnessLength)));
    count += 8;
    hasher.update(witness);
    count += witnessLength;

    // group
    if (lockIndexes.length > 1) {
      for (const index of lockIndexes) {
        const witness = txSkeleton.witnesses.get(lockIndexes[index]);
        if (witness == null) throw new Error('not get lock index!');
        const witnessLength = bytes.bytify(witness).length;
        hasher.update(bytes.hexify(Uint64.pack(witnessLength)));
        count += 8;
        hasher.update(witness);
        count += witnessLength;
      }
    }

    const witnessSize = txSkeleton.witnesses.size;

    if (inputs.size < witnessSize) {
      for (let j = inputs.size; j < witnessSize; j++) {
        const witness = txSkeleton.witnesses.get(j);
        if (witness == null) throw new Error('not get lock index!');
        const witnessLength = bytes.bytify(witness).length;
        hasher.update(bytes.hexify(Uint64.pack(witnessLength)));
        count += 8;
        hasher.update(witness);
        count += witnessLength;
      }
    }

    const message = hasher.digestHex();
    console.debug(`Hashed ${count} bytes in sighash_all`, message.length);
    return message;
  }

  buildDummyEvent() {
    const tags = [[TagName.ckbSigHashAll, this.dummyCkbSigHashAll.slice(2)]];
    const event = {
      id: '00'.repeat(32),
      pubkey: '00'.repeat(32),
      tags,
      created_at: Timestamp.now().asSecs(),
      kind: this.kind,
      content: this.content,
      sig: '00'.repeat(64),
    };

    return JSON.stringify(event);
  }

  buildUnlockEvent(ckbSigHashAll: HexString): EventToSign {
    const unlockEvent: EventToSign = {
      tags: [[TagName.ckbSigHashAll, ckbSigHashAll.slice(2)]],
      created_at: Timestamp.now().asSecs(),
      kind: this.kind,
      content: this.content,
    };
    return unlockEvent;
  }
}
