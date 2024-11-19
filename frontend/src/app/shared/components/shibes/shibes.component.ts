import { Component, Input, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { StateService } from '../../../services/state.service';

@Component({
  selector: 'app-shibes',
  templateUrl: './shibes.component.html',
  styleUrls: ['./shibes.component.scss']
})
export class ShibesComponent implements OnInit {
  @Input() shibes: number;
  @Input() digitsInfo = '1.0-0';
  @Input() addPlus = false;
  @Input() valueOverride: string | undefined = undefined;

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

}
