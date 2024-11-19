import { Component, OnInit, AfterViewInit, OnDestroy, HostListener, ViewChild, ElementRef, Inject, ChangeDetectorRef } from '@angular/core';
import { ElectrsApiService } from '../../services/electrs-api.service';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
import {
  switchMap,
  filter,
  catchError,
  retryWhen,
  delay,
  mergeMap,
  tap,
  map,
  retry,
  startWith,
  repeat,
  take
} from 'rxjs/operators';
import { Transaction } from '../../interfaces/electrs.interface';
import { of, merge, Subscription, Observable, Subject, from, throwError, combineLatest, BehaviorSubject } from 'rxjs';
import { StateService } from '../../services/state.service';
import { CacheService } from '../../services/cache.service';
import { WebsocketService } from '../../services/websocket.service';
import { AudioService } from '../../services/audio.service';
import { ApiService } from '../../services/api.service';
import { SeoService } from '../../services/seo.service';
import { StorageService } from '../../services/storage.service';
import { seoDescriptionNetwork } from '../../shared/common.utils';
import { getTransactionFlags, getFeeRate } from '../../shared/transaction.utils';
import { Filter, toFilters } from '../../shared/filters.utils';
import { BlockExtended, CpfpInfo, RbfTree, MempoolPosition, DifficultyAdjustment } from '../../interfaces/node-api.interface';
import { RelativeUrlPipe } from '../../shared/pipes/relative-url/relative-url.pipe';
import { PriceService } from '../../services/price.service';
import { isFeatureActive } from '../../dogecoin.utils';
import { ServicesApiServices } from '../../services/services-api.service';
import { ZONE_SERVICE } from '../../injection-tokens';
import { MiningService, MiningStats } from '../../services/mining.service';
import { ETA, EtaService } from '../../services/eta.service';

interface Pool {
  id: number;
  name: string;
  slug: string;
}

export interface TxAuditStatus {
  seen?: boolean;
  expected?: boolean;
  added?: boolean;
  prioritized?: boolean;
  delayed?: number;
  conflict?: boolean;
  coinbase?: boolean;
  firstSeen?: number;
}

@Component({
  selector: 'app-transaction',
  templateUrl: './transaction.component.html',
  styleUrls: ['./transaction.component.scss'],
})
export class TransactionComponent implements OnInit, AfterViewInit, OnDestroy {
  network = '';
  tx: Transaction;
  txId: string;
  txInBlockIndex: number;
  mempoolPosition: MempoolPosition;
  gotInitialPosition = false;
  isLoadingTx = true;
  error: any = undefined;
  errorUnblinded: any = undefined;
  loadingCachedTx = false;
  waitingForTransaction = false;
  latestBlock: BlockExtended;
  transactionTime = -1;
  subscription: Subscription;
  fetchCpfpSubscription: Subscription;
  transactionTimesSubscription: Subscription;
  fetchRbfSubscription: Subscription;
  fetchCachedTxSubscription: Subscription;
  txReplacedSubscription: Subscription;
  txRbfInfoSubscription: Subscription;
  mempoolPositionSubscription: Subscription;
  queryParamsSubscription: Subscription;
  urlFragmentSubscription: Subscription;
  mempoolBlocksSubscription: Subscription;
  blocksSubscription: Subscription;
  miningSubscription: Subscription;
  auditSubscription: Subscription;
  txConfirmedSubscription: Subscription;
  currencyChangeSubscription: Subscription;
  fragmentParams: URLSearchParams;
  rbfTransaction: undefined | Transaction;
  replaced: boolean = false;
  rbfReplaces: string[];
  rbfInfo: RbfTree;
  cpfpInfo: CpfpInfo | null;
  hasCpfp: boolean = false;
  sigops: number | null;
  adjustedVsize: number | null;
  pool: Pool | null;
  auditStatus: TxAuditStatus | null;
  filters: Filter[] = [];
  showCpfpDetails = false;
  miningStats: MiningStats;
  fetchCpfp$ = new Subject<string>();
  transactionTimes$ = new Subject<string>();
  fetchRbfHistory$ = new Subject<string>();
  fetchCachedTx$ = new Subject<string>();
  fetchMiningInfo$ = new Subject<{ hash: string, height: number, txid: string }>();
  txChanged$ = new BehaviorSubject<boolean>(false); // triggered whenever this.tx changes (long term, we should refactor to make this.tx an observable itself)
  ETA$: Observable<ETA | null>;
  standardETA$: Observable<ETA | null>;
  isCached: boolean = false;
  now = Date.now();
  da$: Observable<DifficultyAdjustment>;
  inputIndex: number;
  outputIndex: number;
  graphExpanded: boolean = false;
  graphWidth: number = 1068;
  graphHeight: number = 360;
  inOutLimit: number = 150;
  maxInOut: number = 0;
  flowPrefSubscription: Subscription;
  hideFlow: boolean = this.stateService.hideFlow.value;
  overrideFlowPreference: boolean = null;
  flowEnabled: boolean;
  tooltipPosition: { x: number, y: number };
  isMobile: boolean;
  firstLoad = true;
  isLoadingFirstSeen = false;

  featuresEnabled: boolean;
  segwitEnabled: boolean;
  rbfEnabled: boolean;
  hasEffectiveFeeRate: boolean;
  scrollIntoAccelPreview = false;
  cashappEligible = false;
  auditEnabled: boolean = this.stateService.env.AUDIT && this.stateService.env.BASE_MODULE === 'mempool' && this.stateService.env.MINING_DASHBOARD === true;
  isMempoolSpaceBuild = this.stateService.isMempoolSpaceBuild;

  @ViewChild('graphContainer')
  graphContainer: ElementRef;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private relativeUrlPipe: RelativeUrlPipe,
    private electrsApiService: ElectrsApiService,
    public stateService: StateService,
    private cacheService: CacheService,
    private websocketService: WebsocketService,
    private audioService: AudioService,
    private apiService: ApiService,
    private servicesApiService: ServicesApiServices,
    private seoService: SeoService,
    private priceService: PriceService,
    private storageService: StorageService,
    private miningService: MiningService,
    private etaService: EtaService,
    private cd: ChangeDetectorRef,
    @Inject(ZONE_SERVICE) private zoneService: any,
  ) {}

  ngOnInit() {
    this.miningService.getMiningStats('1w').subscribe(stats => {
      this.miningStats = stats;
    });

    this.websocketService.want(['blocks', 'mempool-blocks']);
    this.stateService.networkChanged$.subscribe(
      (network) => {
        this.network = network;
      }
    );

    this.setFlowEnabled();
    this.flowPrefSubscription = this.stateService.hideFlow.subscribe((hide) => {
      this.hideFlow = !!hide;
      this.setFlowEnabled();
    });

    this.da$ = this.stateService.difficultyAdjustment$.pipe(
      tap(() => {
        this.now = Date.now();
      })
    );

    this.urlFragmentSubscription = this.route.fragment.subscribe((fragment) => {
      this.fragmentParams = new URLSearchParams(fragment || '');
      const vin = parseInt(this.fragmentParams.get('vin'), 10);
      const vout = parseInt(this.fragmentParams.get('vout'), 10);
      this.inputIndex = (!isNaN(vin) && vin >= 0) ? vin : null;
      this.outputIndex = (!isNaN(vout) && vout >= 0) ? vout : null;
    });

    this.blocksSubscription = this.stateService.blocks$.subscribe((blocks) => {
      this.latestBlock = blocks[0];
    });

    this.transactionTimesSubscription = this.transactionTimes$.pipe(
      tap(() => {
        this.isLoadingFirstSeen = true;
      }),
      switchMap((txid) => this.apiService.getTransactionTimes$([txid]).pipe(
        retry({ count: 2, delay: 2000 }),
        // Try again until we either get a valid response, or the transaction is confirmed
        repeat({ delay: 2000 }),
        filter((transactionTimes) => transactionTimes?.length && transactionTimes[0] > 0 && !this.tx.status?.confirmed),
        take(1),
      )),
    )
    .subscribe((transactionTimes) => {
      this.isLoadingFirstSeen = false;
      if (transactionTimes?.length && transactionTimes[0]) {
        this.transactionTime = transactionTimes[0];
      }
    });

    this.fetchCpfpSubscription = this.fetchCpfp$
      .pipe(
        switchMap((txId) =>
          this.apiService
            .getCpfpinfo$(txId)
            .pipe(retryWhen((errors) => errors.pipe(
              mergeMap((error) => {
                if (!this.tx?.status || this.tx.status.confirmed) {
                  return throwError(error);
                } else {
                  return of(null);
                }
              }),
              delay(2000)
            )),
            catchError(() => {
              return of(null);
            })
          )
        ),
        catchError(() => {
          return of(null);
        })
      )
      .subscribe((cpfpInfo) => {
        this.setCpfpInfo(cpfpInfo);
      });

    this.fetchRbfSubscription = this.fetchRbfHistory$
    .pipe(
      switchMap((txId) =>
        this.apiService
          .getRbfHistory$(txId)
      ),
      catchError(() => {
        return of(null);
      })
    ).subscribe((rbfResponse) => {
      this.rbfInfo = rbfResponse?.replacements;
      this.rbfReplaces = rbfResponse?.replaces || null;
    });

    this.fetchCachedTxSubscription = this.fetchCachedTx$
    .pipe(
      tap(() => {
        this.loadingCachedTx = true;
      }),
      switchMap((txId) =>
        this.apiService
          .getRbfCachedTx$(txId)
      ),
      catchError(() => {
        return of(null);
      })
    ).subscribe((tx) => {
      this.loadingCachedTx = false;
      if (!tx) {
        this.seoService.logSoft404();
        return;
      }
      this.seoService.clearSoft404();

      if (!this.tx) {
        this.tx = tx;
        this.setFeatures();
        this.isCached = true;
        if (tx.fee === undefined) {
          this.tx.fee = 0;
        }
        this.tx.feePerVsize = tx.fee / (tx.weight / 4);
        this.isLoadingTx = false;
        this.error = undefined;
        this.waitingForTransaction = false;
        this.graphExpanded = false;
        this.transactionTime = tx.firstSeen || 0;
        this.setupGraph();

        this.fetchRbfHistory$.next(this.tx.txid);
        this.txRbfInfoSubscription = this.stateService.txRbfInfo$.subscribe((rbfInfo) => {
          if (this.tx) {
            this.rbfInfo = rbfInfo;
          }
        });
        this.txChanged$.next(true);
      }
    });

    this.miningSubscription = this.fetchMiningInfo$.pipe(
      filter((target) => target.txid === this.txId && !this.pool),
      tap(() => {
        this.pool = null;
      }),
      switchMap(({ hash, height }) => {
        const foundBlock = this.cacheService.getCachedBlock(height) || null;
        return foundBlock ? of(foundBlock.extras.pool) : this.apiService.getBlock$(hash).pipe(
          map(block => block.extras.pool),
          retry({ count: 3, delay: 2000 }),
          catchError(() => of(null))
        );
      }),
      catchError((e) => {
        return of(null);
      })
    ).subscribe(pool => {
      this.pool = pool;
    });

    this.auditSubscription = this.fetchMiningInfo$.pipe(
      filter((target) => target.txid === this.txId),
      tap(() => {
        this.auditStatus = null;
      }),
      switchMap(({ hash, height, txid }) => {
        const auditAvailable = this.isAuditAvailable(height);
        const isCoinbase = this.tx.vin.some(v => v.is_coinbase);
        const fetchAudit = auditAvailable && !isCoinbase;
        if (fetchAudit) {
        // If block audit is already cached, use it to get transaction audit
          const blockAuditLoaded = this.apiService.getBlockAuditLoaded(hash);
          if (blockAuditLoaded) {
            return this.apiService.getBlockAudit$(hash).pipe(
              map(audit => {
                const isAdded = audit.addedTxs.includes(txid);
                const isPrioritized = audit.prioritizedTxs.includes(txid);
                const isConflict = audit.fullrbfTxs.includes(txid);
                const isExpected = audit.template.some(tx => tx.txid === txid);
                const firstSeen = audit.template.find(tx => tx.txid === txid)?.time;
                const wasSeen = audit.version === 1 ? !audit.unseenTxs.includes(txid) : (isExpected || isPrioritized);
                return {
                  seen: wasSeen,
                  expected: isExpected,
                  added: isAdded && (audit.version === 0 || !wasSeen),
                  prioritized: isPrioritized,
                  conflict: isConflict,
                  firstSeen,
                };
              })
            )
          } else {
            return this.apiService.getBlockTxAudit$(hash, txid).pipe(
              retry({ count: 3, delay: 2000 }),
              catchError(() => {
                return of(null);
              })
            )
          }
        } else {
          return of(isCoinbase ? { coinbase: true } : null);
        }
      }),
    ).subscribe(auditStatus => {
      this.auditStatus = auditStatus;
      if (this.auditStatus?.firstSeen) {
        this.transactionTime = this.auditStatus.firstSeen;
      }
    });

    this.mempoolPositionSubscription = this.stateService.mempoolTxPosition$.subscribe(txPosition => {
      this.now = Date.now();
      if (txPosition && txPosition.txid === this.txId && txPosition.position) {
        this.mempoolPosition = txPosition.position;
        if (this.tx && !this.tx.status.confirmed) {
          const txFeePerVSize = getFeeRate(this.tx);
          this.stateService.markBlock$.next({
            txid: txPosition.txid,
            txFeePerVSize,
            mempoolPosition: this.mempoolPosition,
          });
          this.txInBlockIndex = this.mempoolPosition.block;

          if (txPosition.cpfp !== undefined) {
            if (txPosition.position.feeDelta) {
              txPosition.cpfp.feeDelta = txPosition.position.feeDelta;
            }
            this.setCpfpInfo(txPosition.cpfp);
          }

          if (this.stateService.network === 'dogecoin') {
            this.miningService.getMiningStats('1w').subscribe(stats => {
              this.miningStats = stats;
            });
            if (txPosition.position?.block > 0 && this.tx.weight < 4000) {
              this.cashappEligible = true;
            }
          }
        }
        this.gotInitialPosition = true;
      } else {
        this.mempoolPosition = null;
      }
    });

    this.subscription = this.zoneService.wrapObservable(this.route.paramMap
      .pipe(
        switchMap((params: ParamMap) => {
          const urlMatch = (params.get('id') || '').split(':');
          if (urlMatch.length === 2 && urlMatch[1].length === 64) {
            const vin = parseInt(urlMatch[0], 10);
            this.txId = urlMatch[1];
            // rewrite legacy vin syntax
            if (!isNaN(vin)) {
              this.fragmentParams.set('vin', vin.toString());
              this.fragmentParams.delete('vout');
            }
            this.router.navigate([this.relativeUrlPipe.transform('/tx'), this.txId], {
              queryParamsHandling: 'merge',
              fragment: this.fragmentParams.toString(),
            });
          } else {
            this.txId = urlMatch[0];
            const vout = parseInt(urlMatch[1], 10);
            if (urlMatch.length > 1 && !isNaN(vout)) {
              // rewrite legacy vout syntax
              this.fragmentParams.set('vout', vout.toString());
              this.fragmentParams.delete('vin');
              this.router.navigate([this.relativeUrlPipe.transform('/tx'), this.txId], {
                queryParamsHandling: 'merge',
                fragment: this.fragmentParams.toString(),
              });
            }
          }
          if (window.innerWidth <= 767.98) {
            this.router.navigate([this.relativeUrlPipe.transform('/tx'), this.txId], {
              queryParamsHandling: 'merge',
              preserveFragment: true,
              queryParams: { mode: 'details' },
              replaceUrl: true,
            });
          }
          this.seoService.setTitle(
            $localize`:@@bisq.transaction.browser-title:Transaction: ${this.txId}:INTERPOLATION:`
          );
          const network = this.stateService.network === 'liquid' || this.stateService.network === 'liquidtestnet' ? 'Liquid' : 'Bitcoin';
          const seoDescription = seoDescriptionNetwork(this.stateService.network);
          this.seoService.setDescription($localize`:@@meta.description.bitcoin.transaction:Get real-time status, addresses, fees, script info, and more for ${network}${seoDescription} transaction with txid ${this.txId}.`);
          this.resetTransaction();
          return merge(
            of(true),
            this.stateService.connectionState$.pipe(
              filter(
                (state) => state === 2 && this.tx && !this.tx.status?.confirmed
              )
            )
          );
        }),
        switchMap(() => {
          let transactionObservable$: Observable<Transaction>;
          const cached = this.cacheService.getTxFromCache(this.txId);
          if (cached && cached.fee !== -1) {
            transactionObservable$ = of(cached);
          } else {
            transactionObservable$ = this.electrsApiService
              .getTransaction$(this.txId)
              .pipe(
                catchError(this.handleLoadElectrsTransactionError.bind(this))
              );
          }
          return merge(
            transactionObservable$,
            this.stateService.mempoolTransactions$
          );
        }),
        switchMap((tx) => {
          return of(tx);
        })
      ))
      .subscribe((tx: Transaction) => {
          if (!tx) {
            this.fetchCachedTx$.next(this.txId);
            this.seoService.logSoft404();
            return;
          }
          this.seoService.clearSoft404();

          this.tx = tx;
          this.setFeatures();
          this.isCached = false;
          if (tx.fee === undefined) {
            this.tx.fee = 0;
          }
          if (this.tx.sigops != null) {
            this.sigops = this.tx.sigops;
            this.adjustedVsize = Math.max(this.tx.weight / 4, this.sigops * 5);
          }
          this.tx.feePerVsize = tx.fee / (tx.weight / 4);
          this.txChanged$.next(true);
          this.isLoadingTx = false;
          this.error = undefined;
          this.loadingCachedTx = false;
          this.waitingForTransaction = false;
          this.websocketService.startTrackTransaction(tx.txid);
          this.graphExpanded = false;
          this.setupGraph();

          if (!tx.status?.confirmed) {
            if (tx.firstSeen) {
              this.transactionTime = tx.firstSeen;
            } else {
              this.transactionTimes$.next(tx.txid);
            }
          } else {
            this.fetchMiningInfo$.next({ hash: tx.status.block_hash, height: tx.status.block_height, txid: tx.txid });
            this.transactionTime = 0;
          }

          if (this.tx?.status?.confirmed) {
            this.stateService.markBlock$.next({
              blockHeight: tx.status.block_height,
            });
            this.fetchCpfp$.next(this.tx.txid);
          } else {
            const txFeePerVSize = getFeeRate(this.tx);
            if (tx.cpfpChecked) {
              this.stateService.markBlock$.next({
                txid: tx.txid,
                txFeePerVSize,
                mempoolPosition: this.mempoolPosition,
              });
              this.setCpfpInfo({
                ancestors: tx.ancestors,
                bestDescendant: tx.bestDescendant,
              });
              const hasRelatives = !!(tx.ancestors?.length || tx.bestDescendant || tx.descendants);
              this.hasEffectiveFeeRate = hasRelatives || (tx.effectiveFeePerVsize && tx.effectiveFeePerVsize !== (this.tx.fee / (this.tx.weight / 4)) && tx.effectiveFeePerVsize !== (tx.fee / Math.ceil(tx.weight / 4)));
            } else {
              this.fetchCpfp$.next(this.tx.txid);
            }
          }
          this.fetchRbfHistory$.next(this.tx.txid);
          this.currencyChangeSubscription?.unsubscribe();
          this.currencyChangeSubscription = this.stateService.fiatCurrency$.pipe(
            switchMap((currency) => {
              return tx.status.block_time ? this.priceService.getBlockPrice$(tx.status.block_time, true, currency).pipe(
                tap((price) => tx['price'] = price),
              ) : of(undefined);
            })
          ).subscribe();

          setTimeout(() => { this.applyFragment(); }, 0);

          this.cd.detectChanges();
        },
        (error) => {
          this.error = error;
          this.seoService.logSoft404();
          this.isLoadingTx = false;
        }
      );

    this.txConfirmedSubscription = this.stateService.txConfirmed$.subscribe(([txConfirmed, block]) => {
      if (txConfirmed && this.tx && !this.tx.status.confirmed && txConfirmed === this.tx.txid) {
        this.tx.status = {
          confirmed: true,
          block_height: block.height,
          block_hash: block.id,
          block_time: block.timestamp,
        };
        this.pool = block.extras.pool;
        this.txChanged$.next(true);
        this.stateService.markBlock$.next({ blockHeight: block.height });
        this.audioService.playSound('magic');
        this.fetchMiningInfo$.next({ hash: block.id, height: block.height, txid: this.tx.txid });
      }
    });

    this.txReplacedSubscription = this.stateService.txReplaced$.subscribe((rbfTransaction) => {
      if (!this.tx) {
        this.error = new Error();
        this.loadingCachedTx = false;
        this.waitingForTransaction = false;
      }
      this.rbfTransaction = rbfTransaction;
      this.replaced = true;
      this.stateService.markBlock$.next({});

      if (rbfTransaction && !this.tx) {
        this.fetchCachedTx$.next(this.txId);
      }
    });

    this.txRbfInfoSubscription = this.stateService.txRbfInfo$.subscribe((rbfInfo) => {
      if (this.tx) {
        this.rbfInfo = rbfInfo;
      }
    });

    this.queryParamsSubscription = this.route.queryParams.subscribe((params) => {
      if (params.showFlow === 'false') {
        this.overrideFlowPreference = false;
      } else if (params.showFlow === 'true') {
        this.overrideFlowPreference = true;
      } else {
        this.overrideFlowPreference = null;
      }
      this.setFlowEnabled();
      this.setGraphSize();
    });

    this.mempoolBlocksSubscription = this.stateService.mempoolBlocks$.subscribe((mempoolBlocks) => {
      this.now = Date.now();

      if (!this.tx || this.mempoolPosition) {
        return;
      }

      const txFeePerVSize =
        this.tx.effectiveFeePerVsize || this.tx.fee / (this.tx.weight / 4);

      let found = false;
      this.txInBlockIndex = 0;
      for (const block of mempoolBlocks) {
        for (let i = 0; i < block.feeRange.length - 1 && !found; i++) {
          if (
            txFeePerVSize <= block.feeRange[i + 1] &&
            txFeePerVSize >= block.feeRange[i]
          ) {
            this.txInBlockIndex = mempoolBlocks.indexOf(block);
            found = true;
          }
        }
      }
      if (!found && mempoolBlocks.length && txFeePerVSize < mempoolBlocks[mempoolBlocks.length - 1].feeRange[0]) {
        this.txInBlockIndex = 7;
      }
    });

    this.ETA$ = combineLatest([
      this.stateService.mempoolTxPosition$.pipe(startWith(null)),
      this.stateService.mempoolBlocks$.pipe(startWith(null)),
      this.stateService.difficultyAdjustment$.pipe(startWith(null)),
      this.txChanged$,
    ]).pipe(
      map(([position, mempoolBlocks, da]) => {
        return this.etaService.calculateETA(
          this.network,
          this.tx,
          mempoolBlocks,
          position,
          da,
          this.miningStats,
        );
      })
    );
  }

  ngAfterViewInit(): void {
    this.setGraphSize();
  }

  dismissAccelAlert(): void {
    this.storageService.setValue('accel-cta-type', 'button');
  }

  handleLoadElectrsTransactionError(error: any): Observable<any> {
    if (error.status === 404 && /^[a-fA-F0-9]{64}$/.test(this.txId)) {
      this.websocketService.startMultiTrackTransaction(this.txId);
      this.waitingForTransaction = true;
    }
    this.error = error;
    this.seoService.logSoft404();
    this.isLoadingTx = false;
    return of(false);
  }

  setCpfpInfo(cpfpInfo: CpfpInfo): void {
    if (!cpfpInfo || !this.tx) {
      this.cpfpInfo = null;
      this.hasCpfp = false;
      this.hasEffectiveFeeRate = false;
      return;
    }
    const firstCpfp = this.cpfpInfo == null;
    // merge ancestors/descendants
    const relatives = [...(cpfpInfo.ancestors || []), ...(cpfpInfo.descendants || [])];
    if (cpfpInfo.bestDescendant && !cpfpInfo.descendants?.length) {
      relatives.push(cpfpInfo.bestDescendant);
    }
    const hasRelatives = !!relatives.length;
    if (!cpfpInfo.effectiveFeePerVsize && hasRelatives) {
      const totalWeight =
        this.tx.weight +
        relatives.reduce((prev, val) => prev + val.weight, 0);
      const totalFees =
        this.tx.fee +
        relatives.reduce((prev, val) => prev + val.fee, 0);
      this.tx.effectiveFeePerVsize = totalFees / (totalWeight / 4);
    } else {
      this.tx.effectiveFeePerVsize = cpfpInfo.effectiveFeePerVsize || this.tx.effectiveFeePerVsize || this.tx.feePerVsize || (this.tx.fee / (this.tx.weight / 4));
    }

    this.txChanged$.next(true);

    this.cpfpInfo = cpfpInfo;
    if (this.cpfpInfo.adjustedVsize && this.cpfpInfo.sigops != null) {
      this.sigops = this.cpfpInfo.sigops;
      this.adjustedVsize = this.cpfpInfo.adjustedVsize;
    }
    this.hasCpfp =!!(this.cpfpInfo && relatives.length);
    this.hasEffectiveFeeRate = hasRelatives || (this.tx.effectiveFeePerVsize && this.tx.effectiveFeePerVsize !== (this.tx.fee / (this.tx.weight / 4)) && this.tx.effectiveFeePerVsize !== (this.tx.fee / Math.ceil(this.tx.weight / 4)));
  }

  setFeatures(): void {
    if (this.tx) {
      this.segwitEnabled = !this.tx.status.confirmed || isFeatureActive(this.stateService.network, this.tx.status.block_height, 'segwit');
      this.rbfEnabled = !this.tx.status.confirmed || isFeatureActive(this.stateService.network, this.tx.status.block_height, 'rbf');
      this.tx.flags = getTransactionFlags(this.tx, null, null, this.tx.status?.block_time, this.stateService.network);
      this.filters = this.tx.flags ? toFilters(this.tx.flags).filter(f => f.txPage) : [];
    } else {
      this.segwitEnabled = false;
      this.rbfEnabled = false;
    }
    this.featuresEnabled = this.segwitEnabled || this.rbfEnabled;
  }

  isAuditAvailable(blockHeight: number): boolean {
    if (!this.auditEnabled) {
      return false;
    }
    switch (this.stateService.network) {
      case 'testnet':
        if (blockHeight < this.stateService.env.TESTNET_BLOCK_AUDIT_START_HEIGHT) {
          return false;
        }
        break;
      case 'signet':
        if (blockHeight < this.stateService.env.SIGNET_BLOCK_AUDIT_START_HEIGHT) {
          return false;
        }
        break;
      default:
        if (blockHeight < this.stateService.env.MAINNET_BLOCK_AUDIT_START_HEIGHT) {
          return false;
        }
    }
    return true;
  }

  resetTransaction() {
    this.firstLoad = false;
    this.gotInitialPosition = false;
    this.error = undefined;
    this.tx = null;
    this.txChanged$.next(true);
    this.setFeatures();
    this.waitingForTransaction = false;
    this.isLoadingTx = true;
    this.rbfTransaction = undefined;
    this.replaced = false;
    this.transactionTime = -1;
    this.cpfpInfo = null;
    this.adjustedVsize = null;
    this.sigops = null;
    this.hasEffectiveFeeRate = false;
    this.rbfInfo = null;
    this.rbfReplaces = [];
    this.filters = [];
    this.showCpfpDetails = false;
    this.cashappEligible = false;
    this.txInBlockIndex = null;
    this.mempoolPosition = null;
    this.pool = null;
    this.auditStatus = null;
    document.body.scrollTo(0, 0);
    this.leaveTransaction();
  }

  leaveTransaction() {
    this.websocketService.stopTrackingTransaction();
    this.stateService.markBlock$.next({});
  }

  roundToOneDecimal(cpfpTx: any): number {
    return +(cpfpTx.fee / (cpfpTx.weight / 4)).toFixed(1);
  }

  setupGraph() {
    this.maxInOut = Math.min(this.inOutLimit, Math.max(this.tx?.vin?.length || 1, this.tx?.vout?.length + 1 || 1));
    this.graphHeight = this.graphExpanded ? this.maxInOut * 15 : Math.min(360, this.maxInOut * 80);
  }

  toggleGraph() {
    const showFlow = !this.flowEnabled;
    this.stateService.hideFlow.next(!showFlow);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { showFlow: showFlow },
      queryParamsHandling: 'merge',
      fragment: 'flow'
    });
  }

  setFlowEnabled() {
    this.flowEnabled = (this.overrideFlowPreference != null ? this.overrideFlowPreference : !this.hideFlow);
  }

  expandGraph() {
    this.graphExpanded = true;
    this.graphHeight = this.maxInOut * 15;
  }

  collapseGraph() {
    this.graphExpanded = false;
    this.graphHeight = Math.min(360, this.maxInOut * 80);
  }

  // simulate normal anchor fragment behavior
  applyFragment(): void {
    const anchor = Array.from(this.fragmentParams.entries()).find(([frag, value]) => value === '');
    if (anchor?.length) {
      const anchorElement = document.getElementById(anchor[0]);
      if (anchorElement) {
        anchorElement.scrollIntoView();
      }
    }
  }

  @HostListener('window:resize', ['$event'])
  setGraphSize(): void {
    this.isMobile = window.innerWidth < 850;
    if (this.graphContainer?.nativeElement && this.stateService.isBrowser) {
      setTimeout(() => {
        if (this.graphContainer?.nativeElement?.clientWidth) {
          this.graphWidth = this.graphContainer.nativeElement.clientWidth;
        } else {
          setTimeout(() => { this.setGraphSize(); }, 1);
        }
      }, 1);
    }
  }

  isLoggedIn(): boolean {
    const auth = this.storageService.getAuth();
    return auth !== null;
  }

  ngOnDestroy() {
    this.subscription.unsubscribe();
    this.fetchCpfpSubscription.unsubscribe();
    this.transactionTimesSubscription.unsubscribe();
    this.fetchRbfSubscription.unsubscribe();
    this.fetchCachedTxSubscription.unsubscribe();
    this.txReplacedSubscription.unsubscribe();
    this.txRbfInfoSubscription.unsubscribe();
    this.queryParamsSubscription.unsubscribe();
    this.flowPrefSubscription.unsubscribe();
    this.urlFragmentSubscription.unsubscribe();
    this.mempoolBlocksSubscription.unsubscribe();
    this.mempoolPositionSubscription.unsubscribe();
    this.blocksSubscription.unsubscribe();
    this.miningSubscription?.unsubscribe();
    this.auditSubscription?.unsubscribe();
    this.txConfirmedSubscription?.unsubscribe();
    this.currencyChangeSubscription?.unsubscribe();
    this.leaveTransaction();
  }
}
