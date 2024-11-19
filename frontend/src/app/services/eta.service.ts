import { Injectable } from '@angular/core';
import { CpfpInfo, DifficultyAdjustment, MempoolPosition, SinglePoolStats } from '../interfaces/node-api.interface';
import { StateService } from './state.service';
import { MempoolBlock } from '../interfaces/websocket.interface';
import { Transaction } from '../interfaces/electrs.interface';
import { MiningService, MiningStats } from './mining.service';
import { getFeeRate } from '../shared/transaction.utils';
import { Observable, combineLatest, map, of, share, shareReplay, tap } from 'rxjs';

export interface ETA {
  now: number, // time at which calculation performed
  time: number, // absolute time expected (in unix epoch ms)
  wait: number, // expected wait time in ms
  blocks: number, // expected number of blocks (rounded up to next integer)
}

@Injectable({
  providedIn: 'root'
})
export class EtaService {
  constructor(
    private stateService: StateService,
    private miningService: MiningService,
  ) { }

  mempoolPositionFromFees(feerate: number, mempoolBlocks: MempoolBlock[]): MempoolPosition {
    for (let txInBlockIndex = 0; txInBlockIndex < mempoolBlocks.length; txInBlockIndex++) {
      const block = mempoolBlocks[txInBlockIndex];
      for (let i = 0; i < block.feeRange.length - 1; i++) {
        if (feerate < block.feeRange[i + 1] && feerate >= block.feeRange[i]) {
          const feeRangeIndex = i;
          const feeRangeChunkSize = 1 / (block.feeRange.length - 1);

          const txFee = feerate - block.feeRange[i];
          const max = block.feeRange[i + 1] - block.feeRange[i];
          const blockLocation = txFee / max;

          const chunkPositionOffset = blockLocation * feeRangeChunkSize;
          const feePosition = feeRangeChunkSize * feeRangeIndex + chunkPositionOffset;

          const blockedFilledPercentage = (block.blockVSize > this.stateService.blockVSize ? this.stateService.blockVSize : block.blockVSize) / this.stateService.blockVSize;

          return {
            block: txInBlockIndex,
            vsize: (1 - feePosition) * blockedFilledPercentage * this.stateService.blockVSize,
          };
        }
      }
      if (feerate >= block.feeRange[block.feeRange.length - 1]) {
        // at the very front of this block
        return {
          block: txInBlockIndex,
          vsize: 0,
        };
      }
    }
    // at the very back of the last block
    return {
      block: mempoolBlocks.length - 1,
      vsize: mempoolBlocks[mempoolBlocks.length - 1].blockVSize,
    };
  }

  calculateETA(
    network: string,
    tx: Transaction,
    mempoolBlocks: MempoolBlock[],
    position: { txid: string, position: MempoolPosition, cpfp: CpfpInfo | null },
    da: DifficultyAdjustment,
    miningStats: MiningStats,
  ): ETA | null {
    // return this.calculateETA(tx, this.accelerationPositions, position, mempoolBlocks, da, isAccelerated)
    if (!tx || !mempoolBlocks) {
      return null;
    }
    const now = Date.now();

    // use known projected position, or fall back to feerate-based estimate
    const mempoolPosition = position?.position ?? this.mempoolPositionFromFees(tx.effectiveFeePerVsize || tx.feePerVsize, mempoolBlocks);
    if (!mempoolPosition) {
      return null;
    }

    // Liquid block time is always 60 seconds
    if (network === 'liquid' || network === 'liquidtestnet') {
      return {
        now,
        time: now + (60_000 * (mempoolPosition.block + 1)),
        wait: (60_000 * (mempoolPosition.block + 1)),
        blocks: mempoolPosition.block + 1,
      };
    }

    // difficulty adjustment estimate is required to know avg block time on non-Liquid networks
    if (!da) {
      return null;
    }

    const blocks = mempoolPosition.block + 1;
    const wait = da.adjustedTimeAvg * (mempoolPosition.block + 1);
    return {
      now,
      time: wait + now + da.timeOffset,
      wait,
      blocks,
    };
  }

  /**
   *
      - Let $\{C_i\}$ be the set of pools.
      - $P(C_i)$ is the probability that a random block belongs to pool $C_i$.
      - $N(C_i)$ is the number of blocks that need to be mined before a block by pool $C_i$ contains the given transaction.
      - $H(n)$ is the proportion of hashrate for which the transaction is in mempool block ≤ $n$
      - $S(n)$ is the probability of the transaction being mined in block $n$
        - by definition, $S(max) = 1$ , where $max$ is the maximum depth of the transaction in any mempool, and therefore $S(n>max) = 0$
      - $Q$ is the expected number of blocks before the transaction is confirmed
      - $E$ is the expected time before the transaction is confirmed

      - $S(i) = H(i) \times (1 - \sum_{j=0}^{i-1} S(j))$
        - the probability of mining a block including the transaction at this depth, multiplied by the probability that it hasn't already been mined at an earlier depth.
      - $Q = \sum_{i=0}^{max} S(i) \times (i+1)$
        - number of blocks, weighted by the probability that the block includes the transaction
      - $E = Q \times T$
        - expected number of blocks, multiplied by the avg time per block
    */
  calculateETAFromShares(shares: { block: number, hashrateShare: number }[], da: DifficultyAdjustment, now: number = Date.now()): ETA {
      const max = shares.reduce((max, share) => Math.max(max, share.block), 0);

      let tailProb = 0;
      let Q = 0;
      for (let i = 0; i < max; i++) {
        // find H_i
        const H = shares.reduce((total, share) => total + (share.block <= i ? share.hashrateShare : 0), 0);
        // find S_i
        const S = H * (1 - tailProb);
        // accumulate sum (S_i x i)
        Q += (S * (i + 1));
        // accumulate sum (S_j)
        tailProb += S;
      }
      // at max depth, the transaction is guaranteed to be mined in the next block if it hasn't already
      Q += (1-tailProb);
      const eta = da.timeAvg * Q; // T x Q

      return {
        now,
        time: eta + now + da.timeOffset,
        wait: eta,
        blocks: Math.ceil(eta / da.adjustedTimeAvg),
      };
  }

  getFeeRateFromCpfpInfo(tx: Transaction, cpfpInfo: CpfpInfo | null): number {
    if (!cpfpInfo) {
      return tx.fee / (tx.weight / 4);
    }

    const relatives = [...(cpfpInfo.ancestors || []), ...(cpfpInfo.descendants || [])];
    if (cpfpInfo.bestDescendant && !cpfpInfo.descendants?.length) {
      relatives.push(cpfpInfo.bestDescendant);
    }

    if (!!relatives.length) {
      const totalWeight = tx.weight + relatives.reduce((prev, val) => prev + val.weight, 0);
      const totalFees = tx.fee + relatives.reduce((prev, val) => prev + val.fee, 0);

      return totalFees / (totalWeight / 4);
    }

    return tx.fee / (tx.weight / 4);

  }
}
