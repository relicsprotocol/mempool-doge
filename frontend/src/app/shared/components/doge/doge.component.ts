import { Component, Input, OnChanges, OnInit, SimpleChanges } from '@angular/core';
import { Subscription } from 'rxjs';
import { StateService } from '../../../services/state.service';

@Component({
  selector: 'app-doge',
  templateUrl: './doge.component.html',
  styleUrls: ['./doge.component.scss']
})
export class DogeComponent implements OnInit, OnChanges {
  @Input() shibes: number;
  @Input() addPlus = false;
  @Input() valueOverride: string | undefined = undefined;

  value: number;
  unit: string;

  network = '';
  stateSubscription: Subscription;

  constructor(
    private stateService: StateService,
  ) { }

  ngOnInit() {
    this.stateSubscription = this.stateService.networkChanged$.subscribe((network) => this.network = network);
  }

  ngOnDestroy() {
    if (this.stateSubscription) {
      this.stateSubscription.unsubscribe();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this.shibes >= 1_000_000) {
      this.value = (this.shibes / 100_000_000);
      this.unit = 'DOGE'
    } else {
      this.value = Math.round(this.shibes);
      this.unit = 'shibes'
    }
  }
}
