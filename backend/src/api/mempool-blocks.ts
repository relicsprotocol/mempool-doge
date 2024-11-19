import logger from '../logger';
import { MempoolBlock, MempoolTransactionExtended, MempoolBlockWithTransactions, MempoolBlockDelta, Ancestor, CompactThreadTransaction, EffectiveFeeStats, TransactionClassified, TransactionCompressed, MempoolDeltaChange, GbtCandidates, PoolTag } from '../mempool.interfaces';
import { Common, OnlineFeeStatsCalculator } from './common';
import config from '../config';
import { Worker } from 'worker_threads';
import path from 'path';
import mempool from './mempool';
import { Acceleration } from './services/acceleration';
import PoolsRepository from '../repositories/PoolsRepository';

const MAX_UINT32 = Math.pow(2, 32) - 1;

class MempoolBlocks {
  private mempoolBlocks: MempoolBlockWithTransactions[] = [];
  private mempoolBlockDeltas: MempoolBlockDelta[] = [];
  private txSelectionWorker: Worker | null = null;

  private nextUid: number = 1;
  private uidMap: Map<number, string> = new Map(); // map short numerical uids to full txids
  private txidMap: Map<string, number> = new Map(); // map full txids back to short numerical uids

  private pools: { [id: number]: PoolTag } = {};

  public getMempoolBlocks(): MempoolBlock[] {
    return this.mempoolBlocks.map((block) => {
      return {
        blockSize: block.blockSize,
        blockVSize: block.blockVSize,
        nTx: block.nTx,
        totalFees: block.totalFees,
        medianFee: block.medianFee,
        feeRange: block.feeRange,
      };
    });
  }

  public getMempoolBlocksWithTransactions(): MempoolBlockWithTransactions[] {
    return this.mempoolBlocks;
  }

  public getMempoolBlockDeltas(): MempoolBlockDelta[] {
    return this.mempoolBlockDeltas;
  }

  public async updatePools$(): Promise<void> {
    if (['mainnet', 'testnet', 'signet', 'doge'].includes(config.MEMPOOL.NETWORK) === false) {
      this.pools = {};
      return;
    }
    const allPools = await PoolsRepository.$getPools();
    this.pools = {};
    for (const pool of allPools) {
      this.pools[pool.uniqueId] = pool;
    }
  }

  private calculateMempoolDeltas(prevBlocks: MempoolBlockWithTransactions[], mempoolBlocks: MempoolBlockWithTransactions[]): MempoolBlockDelta[] {
    const mempoolBlockDeltas: MempoolBlockDelta[] = [];
    for (let i = 0; i < Math.max(mempoolBlocks.length, prevBlocks.length); i++) {
      let added: TransactionClassified[] = [];
      let removed: string[] = [];
      const changed: TransactionClassified[] = [];
      if (mempoolBlocks[i] && !prevBlocks[i]) {
        added = mempoolBlocks[i].transactions;
      } else if (!mempoolBlocks[i] && prevBlocks[i]) {
        removed = prevBlocks[i].transactions.map(tx => tx.txid);
      } else if (mempoolBlocks[i] && prevBlocks[i]) {
        const prevIds = {};
        const newIds = {};
        prevBlocks[i].transactions.forEach(tx => {
          prevIds[tx.txid] = tx;
        });
        mempoolBlocks[i].transactions.forEach(tx => {
          newIds[tx.txid] = true;
        });
        prevBlocks[i].transactions.forEach(tx => {
          if (!newIds[tx.txid]) {
            removed.push(tx.txid);
          }
        });
        mempoolBlocks[i].transactions.forEach(tx => {
          if (!prevIds[tx.txid]) {
            added.push(tx);
          } else if (tx.rate !== prevIds[tx.txid].rate || tx.acc !== prevIds[tx.txid].acc) {
            changed.push(tx);
          }
        });
      }
      mempoolBlockDeltas.push({
        added: added.map(this.compressTx),
        removed,
        changed: changed.map(this.compressDeltaChange),
      });
    }
    return mempoolBlockDeltas;
  }

  public async $makeBlockTemplates(transactions: string[], newMempool: { [txid: string]: MempoolTransactionExtended }, candidates: GbtCandidates | undefined, saveResults: boolean = false, useAccelerations: boolean = false, accelerationPool?: number): Promise<MempoolBlockWithTransactions[]> {
    const start = Date.now();

    // reset mempool short ids
    if (saveResults) {
      this.resetUids();
    }
    // set missing short ids
    for (const txid of transactions) {
      const tx = newMempool[txid];
      this.setUid(tx, !saveResults);
    }

    const accelerations = useAccelerations ? mempool.getAccelerations() : {};

    // prepare a stripped down version of the mempool with only the minimum necessary data
    // to reduce the overhead of passing this data to the worker thread
    const strippedMempool: Map<number, CompactThreadTransaction> = new Map();
    for (const txid of transactions) {
      const entry = newMempool[txid];
      if (entry.uid !== null && entry.uid !== undefined) {
        const stripped = {
          uid: entry.uid,
          fee: entry.fee + (useAccelerations && (!accelerationPool || accelerations[entry.txid]?.pools?.includes(accelerationPool)) ? (accelerations[entry.txid]?.feeDelta || 0) : 0),
          weight: (entry.adjustedVsize * 4),
          sigops: entry.sigops,
          feePerVsize: entry.adjustedFeePerVsize || entry.feePerVsize  || entry.fee / entry.size || 0,
          effectiveFeePerVsize: entry.effectiveFeePerVsize || entry.adjustedFeePerVsize || entry.feePerVsize || entry.fee / entry.size,
          inputs: entry.vin.map(v => this.getUid(newMempool[v.txid])).filter(uid => (uid !== null && uid !== undefined)) as number[],
        };
        strippedMempool.set(entry.uid, stripped);
      }
    }

    // (re)initialize tx selection worker thread
    if (!this.txSelectionWorker) {
      this.txSelectionWorker = new Worker(path.resolve(__dirname, './tx-selection-worker.js'));
      // if the thread throws an unexpected error, or exits for any other reason,
      // reset worker state so that it will be re-initialized on the next run
      this.txSelectionWorker.once('error', () => {
        this.txSelectionWorker = null;
      });
      this.txSelectionWorker.once('exit', () => {
        this.txSelectionWorker = null;
      });
    }

    // run the block construction algorithm in a separate thread, and wait for a result
    let threadErrorListener;
    try {
      const workerResultPromise = new Promise<{ blocks: number[][], rates: Map<number, number> }>((resolve, reject) => {
        threadErrorListener = reject;
        this.txSelectionWorker?.once('message', (result): void => {
          resolve(result);
        });
        this.txSelectionWorker?.once('error', reject);
      });
      this.txSelectionWorker.postMessage({ type: 'set', mempool: strippedMempool });
      const { blocks, rates } = this.convertResultTxids(await workerResultPromise);

      // clean up thread error listener
      this.txSelectionWorker?.removeListener('error', threadErrorListener);

      const processed = this.processBlockTemplates(newMempool, blocks, null, Object.entries(rates), candidates, accelerations, accelerationPool, saveResults);

      logger.debug(`makeBlockTemplates completed in ${(Date.now() - start)/1000} seconds`);

      return processed;
    } catch (e) {
      logger.err('makeBlockTemplates failed. ' + (e instanceof Error ? e.message : e));
    }
    return this.mempoolBlocks;
  }

  public async $updateBlockTemplates(transactions: string[], newMempool: { [txid: string]: MempoolTransactionExtended }, added: MempoolTransactionExtended[], removed: MempoolTransactionExtended[], candidates: GbtCandidates | undefined, accelerationDelta: string[] = [], saveResults: boolean = false, useAccelerations: boolean = false): Promise<void> {
    if (!this.txSelectionWorker) {
      // need to reset the worker
      await this.$makeBlockTemplates(transactions, newMempool, candidates, saveResults, useAccelerations);
      return;
    }

    const start = Date.now();

    const accelerations = useAccelerations ? mempool.getAccelerations() : {};
    const addedAndChanged: MempoolTransactionExtended[] = useAccelerations ? accelerationDelta.map(txid => newMempool[txid]).filter(tx => tx != null).concat(added) : added;

    for (const tx of addedAndChanged) {
      this.setUid(tx, false);
    }
    const removedTxs = removed.filter(tx => tx.uid != null) as MempoolTransactionExtended[];

    // prepare a stripped down version of the mempool with only the minimum necessary data
    // to reduce the overhead of passing this data to the worker thread
    const addedStripped: CompactThreadTransaction[] = addedAndChanged.filter(entry => entry.uid != null).map(entry => {
      return {
        uid: entry.uid || 0,
        fee: entry.fee + (useAccelerations ? (accelerations[entry.txid]?.feeDelta || 0) : 0),
        weight: (entry.adjustedVsize * 4),
        sigops: entry.sigops,
        feePerVsize: entry.adjustedFeePerVsize || entry.feePerVsize || entry.fee / entry.size || 0,
        effectiveFeePerVsize: entry.effectiveFeePerVsize || entry.adjustedFeePerVsize || entry.feePerVsize  || entry.fee / entry.size || 0,
        inputs: entry.vin.map(v => this.getUid(newMempool[v.txid])).filter(uid => (uid !== null && uid !== undefined)) as number[],
      };
    });

    // run the block construction algorithm in a separate thread, and wait for a result
    let threadErrorListener;
    try {
      const workerResultPromise = new Promise<{ blocks: number[][], rates: Map<number, number> }>((resolve, reject) => {
        threadErrorListener = reject;
        this.txSelectionWorker?.once('message', (result): void => {
          resolve(result);
        });
        this.txSelectionWorker?.once('error', reject);
      });
      this.txSelectionWorker.postMessage({ type: 'update', added: addedStripped, removed: removedTxs.map(tx => tx.uid) as number[] });
      const { blocks, rates } = this.convertResultTxids(await workerResultPromise);

      this.removeUids(removedTxs);

      // clean up thread error listener
      this.txSelectionWorker?.removeListener('error', threadErrorListener);

      this.processBlockTemplates(newMempool, blocks, null, Object.entries(rates), candidates, accelerations, null, saveResults);
      logger.debug(`updateBlockTemplates completed in ${(Date.now() - start) / 1000} seconds`);
    } catch (e) {
      logger.err('updateBlockTemplates failed. ' + (e instanceof Error ? e.message : e));
    }
  }

  private processBlockTemplates(mempool: { [txid: string]: MempoolTransactionExtended }, blocks: string[][], blockWeights: number[] | null, rates: [string, number][], candidates: GbtCandidates | undefined, accelerations: { [txid: string]: Acceleration }, accelerationPool, saveResults): MempoolBlockWithTransactions[] {
    for (const txid of Object.keys(candidates?.txs ?? mempool)) {
      if (txid in mempool) {
        mempool[txid].ancestors = [];
        mempool[txid].descendants = [];
        mempool[txid].bestDescendant = null;
      }
    }
    for (const [txid, rate] of rates) {
      if (txid in mempool) {
        mempool[txid].effectiveFeePerVsize = rate;
      }
    }

    const lastBlockIndex = blocks.length - 1;
    let hasBlockStack = blocks.length >= 8;
    let stackWeight;
    let feeStatsCalculator: OnlineFeeStatsCalculator | void;
    if (hasBlockStack) {
      if (blockWeights && blockWeights[7] !== null) {
        stackWeight = blockWeights[7];
      } else {
        stackWeight = blocks[lastBlockIndex].reduce((total, tx) => total + (mempool[tx]?.weight || 0), 0);
      }
      hasBlockStack = stackWeight > config.MEMPOOL.BLOCK_WEIGHT_UNITS;
      feeStatsCalculator = new OnlineFeeStatsCalculator(stackWeight, 0.5, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
    }

    const isAcceleratedBy : { [txid: string]: number[] | false } = {};

    const sizeLimit = (config.MEMPOOL.BLOCK_WEIGHT_UNITS / 4) * 1.2;
    // update this thread's mempool with the results
    let mempoolTx: MempoolTransactionExtended;
    const mempoolBlocks: MempoolBlockWithTransactions[] = blocks.map((block, blockIndex) => {
      let totalSize = 0;
      let totalVsize = 0;
      let totalWeight = 0;
      let totalFees = 0;
      const transactions: MempoolTransactionExtended[] = [];

      // backfill purged transactions
      if (candidates?.txs && blockIndex === blocks.length - 1) {
        for (const txid of Object.keys(mempool)) {
          if (!candidates.txs[txid]) {
            block.push(txid);
          }
        }
      }

      for (const txid of block) {
        if (txid) {
          mempoolTx = mempool[txid];

          // todo not sure if hack needed anymore
          mempoolTx.weight = mempoolTx.vsize;

          // save position in projected blocks
          mempoolTx.position = {
            block: blockIndex,
            vsize: totalVsize + (mempoolTx.vsize / 2),
          };

          const acceleration = accelerations[txid];
          if (isAcceleratedBy[txid] || (acceleration && (!accelerationPool || acceleration.pools.includes(accelerationPool)))) {
            mempoolTx.acceleration = true;
            mempoolTx.acceleratedBy = isAcceleratedBy[txid] || acceleration?.pools;
            mempoolTx.acceleratedAt = acceleration?.added;
            mempoolTx.feeDelta = acceleration?.feeDelta;
            for (const ancestor of mempoolTx.ancestors || []) {
              mempool[ancestor.txid].acceleration = true;
              mempool[ancestor.txid].acceleratedBy = mempoolTx.acceleratedBy;
              mempool[ancestor.txid].acceleratedAt = mempoolTx.acceleratedAt;
              mempool[ancestor.txid].feeDelta = mempoolTx.feeDelta;
              isAcceleratedBy[ancestor.txid] = mempoolTx.acceleratedBy;
            }
          } else {
            delete mempoolTx.acceleration;
          }

          // online calculation of stack-of-blocks fee stats
          if (hasBlockStack && blockIndex === lastBlockIndex && feeStatsCalculator) {
            feeStatsCalculator.processNext(mempoolTx);
          }

          totalSize += mempoolTx.size;
          totalVsize += mempoolTx.vsize;
          totalWeight += mempoolTx.weight;
          totalFees += mempoolTx.fee;

          if (totalVsize <= sizeLimit) {
            transactions.push(mempoolTx);
          }
        }
      }
      return this.dataToMempoolBlocks(
        block,
        transactions,
        totalSize,
        totalWeight,
        totalFees,
        (hasBlockStack && blockIndex === lastBlockIndex && feeStatsCalculator) ? feeStatsCalculator.getRawFeeStats() : undefined,
      );
    });

    if (saveResults) {
      const deltas = this.calculateMempoolDeltas(this.mempoolBlocks, mempoolBlocks);
      this.mempoolBlocks = mempoolBlocks;
      this.mempoolBlockDeltas = deltas;
    }

    return mempoolBlocks;
  }

  private dataToMempoolBlocks(transactionIds: string[], transactions: MempoolTransactionExtended[], totalSize: number, totalWeight: number, totalFees: number, feeStats?: EffectiveFeeStats ): MempoolBlockWithTransactions {
    if (!feeStats) {
      feeStats = Common.calcEffectiveFeeStatistics(transactions.filter(t => t.fee > 0));
    }
    return {
      blockSize: totalSize,
      blockVSize: (totalWeight / 4), // fractional vsize to avoid rounding errors
      nTx: transactionIds.length,
      totalFees: totalFees,
      medianFee: feeStats.medianFee, // Common.percentile(transactions.map((tx) => tx.effectiveFeePerVsize), config.MEMPOOL.RECOMMENDED_FEE_PERCENTILE),
      feeRange: feeStats.feeRange, //Common.getFeesInRange(transactions, rangeLength),
      transactionIds: transactionIds,
      transactions: transactions.map((tx) => Common.classifyTransaction(tx)),
    };
  }

  private resetUids(): void {
    this.uidMap.clear();
    this.txidMap.clear();
    this.nextUid = 1;
  }

  private setUid(tx: MempoolTransactionExtended, skipSet = false): number {
    if (!this.txidMap.has(tx.txid) || !skipSet) {
      const uid = this.nextUid;
      this.nextUid++;
      this.uidMap.set(uid, tx.txid);
      this.txidMap.set(tx.txid, uid);
      tx.uid = uid;
      return uid;
    } else {
      tx.uid = this.txidMap.get(tx.txid) as number;
      return tx.uid;
    }
  }

  private getUid(tx: MempoolTransactionExtended): number | void {
    if (tx) {
      return this.txidMap.get(tx.txid);
    }
  }

  private removeUids(txs: MempoolTransactionExtended[]): void {
    for (const tx of txs) {
      const uid = this.txidMap.get(tx.txid);
      if (uid != null) {
        this.uidMap.delete(uid);
        this.txidMap.delete(tx.txid);
      }
      tx.uid = undefined;
    }
  }

  private convertResultTxids({ blocks, rates }: { blocks: number[][], rates: Map<number, number> })
    : { blocks: string[][], rates: { [root: string]: number } } {
    const convertedBlocks: string[][] = blocks.map(block => block.map(uid => {
      return this.uidMap.get(uid) || '';
    }));
    const convertedRates = {};
    for (const rateUid of rates.keys()) {
      const rateTxid = this.uidMap.get(rateUid);
      if (rateTxid) {
        convertedRates[rateTxid] = rates.get(rateUid);
      }
    }
    return { blocks: convertedBlocks, rates: convertedRates } as { blocks: string[][], rates: { [root: string]: number } };
  }

  public compressTx(tx: TransactionClassified): TransactionCompressed {
    if (tx.acc) {
      return [
        tx.txid,
        tx.fee,
        tx.vsize,
        tx.value,
        Math.round((tx.rate || (tx.fee / tx.vsize)) * 100) / 100,
        tx.flags,
        tx.time || 0,
        1,
      ];
    } else {
      return [
        tx.txid,
        tx.fee,
        tx.vsize,
        tx.value,
        Math.round((tx.rate || (tx.fee / tx.vsize)) * 100) / 100,
        tx.flags,
        tx.time || 0,
      ];
    }
  }

  public compressDeltaChange(tx: TransactionClassified): MempoolDeltaChange {
    return [
      tx.txid,
      Math.round((tx.rate || (tx.fee / tx.vsize)) * 100) / 100,
      tx.flags,
      tx.acc ? 1 : 0,
    ];
  }
}

export default new MempoolBlocks();
