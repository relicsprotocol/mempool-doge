import { Component, OnInit, OnDestroy, Input, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Env, StateService } from '../../services/state.service';
import { Observable, merge, of, Subscription } from 'rxjs';
import { LanguageService } from '../../services/language.service';
import { NavigationService } from '../../services/navigation.service';
import { MenuComponent } from '../menu/menu.component';
import { StorageService } from '../../services/storage.service';

@Component({
  selector: 'app-master-page',
  templateUrl: './master-page.component.html',
  styleUrls: ['./master-page.component.scss'],
})
export class MasterPageComponent implements OnInit {
  @Input() headerVisible = true;
  @Input() footerVisibleOverride: boolean | null = null;

  env: Env;
  network$: Observable<string>;
  connectionState$: Observable<number>;
  navCollapsed = false;
  isMobile = window.innerWidth <= 767.98;
  officialMempoolSpace = this.stateService.env.OFFICIAL_MEMPOOL_SPACE;
  urlLanguage: string;
  subdomain = '';
  networkPaths: { [network: string]: string };
  networkPaths$: Observable<Record<string, string>>;
  footerVisible = true;
  user: any = undefined;
  menuOpen = false;
  isDropdownVisible: boolean;

  @ViewChild(MenuComponent)
  public menuComponent!: MenuComponent;

  constructor(
    public stateService: StateService,
    private languageService: LanguageService,
    private navigationService: NavigationService,
    private storageService: StorageService,
    private router: Router,
  ) { }

  ngOnInit(): void {
    this.env = this.stateService.env;
    this.connectionState$ = this.stateService.connectionState$;
    this.network$ = merge(of(''), this.stateService.networkChanged$);
    this.urlLanguage = this.languageService.getLanguageForUrl();
    this.navigationService.subnetPaths.subscribe((paths) => {
      this.networkPaths = paths;
      if (this.footerVisibleOverride === null) {
        if (paths.mainnet.indexOf('docs') > -1) {
          this.footerVisible = false;
        } else {
          this.footerVisible = true;
        }
      } else {
        this.footerVisible = this.footerVisibleOverride;
      }
    });

    this.refreshAuth();
    this.setDropdownVisibility();
  }

  setDropdownVisibility(): void {
    const networks = [
      this.env.DOGE_ENABLED,
    ];
    const enabledNetworksCount = networks.filter((networkEnabled) => networkEnabled).length;
    this.isDropdownVisible = enabledNetworksCount > 1;
  }

  collapse(): void {
    this.navCollapsed = !this.navCollapsed;
  }

  isSmallScreen(): boolean {
    return window.innerWidth <= 767.98;
  }

  onResize(): void {
    this.isMobile = this.isSmallScreen();
  }

  brandClick(e): void {
    this.stateService.resetScroll$.next(true);
  }

  onLoggedOut(): void {
    this.refreshAuth();
  }

  refreshAuth(): void {
    this.user = this.storageService.getAuth()?.user ?? null;
  }

  hamburgerClick(event): void {
    if (this.menuComponent) {
      this.menuComponent.hamburgerClick();
      this.menuOpen = this.menuComponent.navOpen;
      event.stopPropagation();
    }
  }

  menuToggled(isOpen: boolean): void {
    this.menuOpen = isOpen;
  }

}
