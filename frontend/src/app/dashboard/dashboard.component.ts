import { AfterViewInit, ChangeDetectionStrategy, Component, HostListener, Inject, OnDestroy, OnInit, PLATFORM_ID } from '@angular/core';
import { combineLatest, EMPTY, fromEvent, interval, merge, Observable, of, Subject, Subscription, timer } from 'rxjs';
import { catchError, delayWhen, distinctUntilChanged, filter, map, scan, share, shareReplay, startWith, switchMap, takeUntil, tap, throttleTime } from 'rxjs/operators';
import { AuditStatus, BlockExtended, CurrentPegs, FederationAddress, FederationUtxo, OptimizedMempoolStats, PegsVolume, RecentPeg, TransactionStripped } from '../interfaces/node-api.interface';
import { MempoolInfo, ReplacementInfo } from '../interfaces/websocket.interface';
import { ApiService } from '../services/api.service';
import { StateService } from '../services/state.service';
import { WebsocketService } from '../services/websocket.service';
import { SeoService } from '../services/seo.service';
import { ActiveFilter, FilterMode, GradientMode, toFlags } from '../shared/filters.utils';
import { detectWebGL } from '../shared/graphs.utils';

interface MempoolBlocksData {
  blocks: number;
  size: number;
}

interface MempoolInfoData {
  memPoolInfo: MempoolInfo;
  vBytesPerSecond: number;
  progressWidth: string;
  progressColor: string;
}

interface MempoolStatsData {
  mempool: OptimizedMempoolStats[];
  weightPerSecond: any;
}

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardComponent implements OnInit, OnDestroy, AfterViewInit {
  network$: Observable<string>;
  mempoolBlocksData$: Observable<MempoolBlocksData>;
  mempoolInfoData$: Observable<MempoolInfoData>;
  mempoolLoadingStatus$: Observable<number>;
  vBytesPerSecondLimit = 1667;
  transactions$: Observable<TransactionStripped[]>;
  blocks$: Observable<BlockExtended[]>;
  replacements$: Observable<ReplacementInfo[]>;
  latestBlockHeight: number;
  mempoolTransactionsWeightPerSecondData: any;
  mempoolStats$: Observable<MempoolStatsData>;
  transactionsWeightPerSecondOptions: any;
  isLoadingWebSocket$: Observable<boolean>;
  currentPeg$: Observable<CurrentPegs>;
  auditStatus$: Observable<AuditStatus>;
  auditUpdated$: Observable<boolean>;
  currentReserves$: Observable<CurrentPegs>;
  recentPegsList$: Observable<RecentPeg[]>;
  pegsVolume$: Observable<PegsVolume[]>;
  federationAddresses$: Observable<FederationAddress[]>;
  federationAddressesNumber$: Observable<number>;
  federationUtxosNumber$: Observable<number>;
  expiredUtxos$: Observable<FederationUtxo[]>;
  emergencySpentUtxosStats$: Observable<any>;
  fullHistory$: Observable<any>;
  isLoad: boolean = true;
  filterSubscription: Subscription;
  mempoolInfoSubscription: Subscription;
  currencySubscription: Subscription;
  currency: string;
  incomingGraphHeight: number = 300;
  webGlEnabled = true;
  private lastPegBlockUpdate: number = 0;
  private lastPegAmount: string = '';
  private lastReservesBlockUpdate: number = 0;

  goggleResolution = 82;
  goggleCycle: { index: number, name: string, mode: FilterMode, filters: string[], gradient: GradientMode }[] = [
    { index: 0, name: $localize`:@@dfc3c34e182ea73c5d784ff7c8135f087992dac1:All`, mode: 'and', filters: [], gradient: 'age' },
    { index: 1, name: $localize`Consolidation`, mode: 'and', filters: ['consolidation'], gradient: 'fee' },
    { index: 2, name: $localize`Coinjoin`, mode: 'and', filters: ['coinjoin'], gradient: 'fee' },
    { index: 3, name: $localize`Data`, mode: 'or', filters: ['inscription', 'fake_pubkey', 'op_return'], gradient: 'fee' },
  ];
  goggleFlags = 0n;
  goggleMode: FilterMode = 'and';
  gradientMode: GradientMode = 'age';
  goggleIndex = 0;

  private destroy$ = new Subject();

  constructor(
    public stateService: StateService,
    private apiService: ApiService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
    @Inject(PLATFORM_ID) private platformId: Object,
  ) {
    this.webGlEnabled = this.stateService.isBrowser && detectWebGL();
  }

  ngAfterViewInit(): void {
    this.stateService.focusSearchInputDesktop();
  }

  ngOnDestroy(): void {
    this.filterSubscription.unsubscribe();
    this.mempoolInfoSubscription.unsubscribe();
    this.currencySubscription.unsubscribe();
    this.websocketService.stopTrackRbfSummary();
    this.destroy$.next(1);
    this.destroy$.complete();
  }

  ngOnInit(): void {
    this.onResize();
    this.isLoadingWebSocket$ = this.stateService.isLoadingWebSocket$;
    this.seoService.resetTitle();
    this.seoService.resetDescription();
    this.websocketService.want(['blocks', 'stats', 'mempool-blocks', 'live-2h-chart']);
    this.websocketService.startTrackRbfSummary();
    this.network$ = merge(of(''), this.stateService.networkChanged$);
    this.mempoolLoadingStatus$ = this.stateService.loadingIndicators$
      .pipe(
        map((indicators) => indicators.mempool !== undefined ? indicators.mempool : 100)
      );

    this.filterSubscription = this.stateService.activeGoggles$.subscribe((active: ActiveFilter) => {
      const activeFilters = active.filters.sort().join(',');
      for (const goggle of this.goggleCycle) {
        if (goggle.mode === active.mode) {
          const goggleFilters = goggle.filters.sort().join(',');
          if (goggleFilters === activeFilters) {
            this.goggleIndex = goggle.index;
            this.goggleFlags = toFlags(goggle.filters);
            this.goggleMode = goggle.mode;
            this.gradientMode = active.gradient;
            return;
          }
        }
      }
      this.goggleCycle.push({
        index: this.goggleCycle.length,
        name: 'Custom',
        mode: active.mode,
        filters: active.filters,
        gradient: active.gradient,
      });
      this.goggleIndex = this.goggleCycle.length - 1;
      this.goggleFlags = toFlags(active.filters);
      this.goggleMode = active.mode;
    });

    this.mempoolInfoData$ = combineLatest([
      this.stateService.mempoolInfo$,
      this.stateService.vbytesPerSecond$
    ]).pipe(
      map(([mempoolInfo, vbytesPerSecond]) => {
        const percent = Math.round((Math.min(vbytesPerSecond, this.vBytesPerSecondLimit) / this.vBytesPerSecondLimit) * 100);

        let progressColor = 'bg-success';
        if (vbytesPerSecond > 1667) {
          progressColor = 'bg-warning';
        }
        if (vbytesPerSecond > 3000) {
          progressColor = 'bg-danger';
        }

        const mempoolSizePercentage = (mempoolInfo.usage / mempoolInfo.maxmempool * 100);
        let mempoolSizeProgress = 'bg-danger';
        if (mempoolSizePercentage <= 50) {
          mempoolSizeProgress = 'bg-success';
        } else if (mempoolSizePercentage <= 75) {
          mempoolSizeProgress = 'bg-warning';
        }

        return {
          memPoolInfo: mempoolInfo,
          vBytesPerSecond: vbytesPerSecond,
          progressWidth: percent + '%',
          progressColor: progressColor,
          mempoolSizeProgress: mempoolSizeProgress,
        };
      })
    );

    this.mempoolInfoSubscription = this.mempoolInfoData$.subscribe();

    this.mempoolBlocksData$ = this.stateService.mempoolBlocks$
      .pipe(
        map((mempoolBlocks) => {
          const size = mempoolBlocks.map((m) => m.blockSize).reduce((a, b) => a + b, 0);
          const vsize = mempoolBlocks.map((m) => m.blockVSize).reduce((a, b) => a + b, 0);

          return {
            size: size,
            blocks: Math.ceil(vsize / this.stateService.blockVSize)
          };
        })
      );

    this.transactions$ = this.stateService.transactions$;

    this.blocks$ = this.stateService.blocks$
      .pipe(
        tap((blocks) => {
          this.latestBlockHeight = blocks[0].height;
        }),
        switchMap((blocks) => {
          if (this.stateService.env.MINING_DASHBOARD === true) {
            for (const block of blocks) {
              // @ts-ignore: Need to add an extra field for the template
              block.extras.pool.logo = `/resources/mining-pools/` +
                block.extras.pool.slug + '.svg';
            }
          }
          return of(blocks.slice(0, 6));
        })
      );

    this.replacements$ = this.stateService.rbfLatestSummary$;

    this.mempoolStats$ = this.stateService.connectionState$
      .pipe(
        filter((state) => state === 2),
        switchMap(() => this.apiService.list2HStatistics$().pipe(
          catchError((e) => {
            return of(null);
          })
        )),
        switchMap((mempoolStats) => {
          return merge(
            this.stateService.live2Chart$
              .pipe(
                scan((acc, stats) => {
                  const now = Date.now() / 1000;
                  const start = now - (2 * 60 * 60);
                  acc.unshift(stats);
                  acc = acc.filter(p => p.added >= start);
                  return acc;
                }, (mempoolStats || []))
              ),
            of(mempoolStats)
          );
        }),
        map((mempoolStats) => {
          if (mempoolStats) {
            return {
              mempool: mempoolStats,
              weightPerSecond: this.handleNewMempoolData(mempoolStats.concat([])),
            };
          } else {
            return null;
          }
        }),
        shareReplay(1),
      );

    this.currencySubscription = this.stateService.fiatCurrency$.subscribe((fiat) => {
      this.currency = fiat;
    });
  }

  handleNewMempoolData(mempoolStats: OptimizedMempoolStats[]) {
    mempoolStats.reverse();
    const labels = mempoolStats.map(stats => stats.added);

    return {
      labels: labels,
      series: [mempoolStats.map((stats) => [stats.added * 1000, stats.vbytes_per_second])],
    };
  }

  trackByBlock(index: number, block: BlockExtended) {
    return block.height;
  }

  getArrayFromNumber(num: number): number[] {
    return Array.from({ length: num }, (_, i) => i + 1);
  }

  setFilter(index): void {
    const selected = this.goggleCycle[index];
    this.stateService.activeGoggles$.next(selected);
  }

  @HostListener('window:resize', ['$event'])
  onResize(): void {
    if (window.innerWidth >= 992) {
      this.incomingGraphHeight = 300;
      this.goggleResolution = 82;
    } else if (window.innerWidth >= 768) {
      this.incomingGraphHeight = 215;
      this.goggleResolution = 80;
    } else {
      this.incomingGraphHeight = 180;
      this.goggleResolution = 86;
    }
  }
}
