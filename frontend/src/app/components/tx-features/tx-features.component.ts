import { Component, ChangeDetectionStrategy, OnChanges, Input } from '@angular/core';
import { calcSegwitFeeGains, isFeatureActive } from '../../dogecoin.utils';
import { Transaction } from '../../interfaces/electrs.interface';
import { StateService } from '../../services/state.service';

@Component({
  selector: 'app-tx-features',
  templateUrl: './tx-features.component.html',
  styleUrls: ['./tx-features.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TxFeaturesComponent implements OnChanges {
  @Input() tx: Transaction;

  segwitGains = {
    realizedSegwitGains: 0,
    potentialSegwitGains: 0,
    potentialP2shSegwitGains: 0,
  };
  isRbfTransaction: boolean;

  segwitEnabled: boolean;
  rbfEnabled: boolean;

  constructor(
    private stateService: StateService,
  ) { }

  ngOnChanges() {
    if (!this.tx) {
      return;
    }
    this.segwitEnabled = !this.tx.status.confirmed || isFeatureActive(this.stateService.network, this.tx.status.block_height, 'segwit');
    this.rbfEnabled = !this.tx.status.confirmed || isFeatureActive(this.stateService.network, this.tx.status.block_height, 'rbf');
    this.segwitGains = calcSegwitFeeGains(this.tx);
    this.isRbfTransaction = this.tx.vin.some((v) => v.sequence < 0xfffffffe);
  }
}
