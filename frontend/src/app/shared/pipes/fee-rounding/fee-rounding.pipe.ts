import { formatNumber } from "@angular/common";
import { Inject, LOCALE_ID, Pipe, PipeTransform } from "@angular/core";

@Pipe({
  name: "feeRounding",
})
export class FeeRoundingPipe implements PipeTransform {
  constructor(
    @Inject(LOCALE_ID) private locale: string,
  ) {}

  transform(fee: number, rounding = null): string {
    // Handle fees in millions with 'm'
    if (fee >= 1000000) {
      const millions = fee / 1000000;
      return `${formatNumber(millions, this.locale, '1.0-1')}m`;
    }

    // Handle fees in thousands with 'k' and 1 decimal
    if (fee >= 1000) {
      const thousands = fee / 1000;
      return `${formatNumber(thousands, this.locale, '1.0-1')}k`;
    }

    // Handle standard formatting for smaller fees
    if (rounding) {
      return formatNumber(fee, this.locale, rounding);
    }

    if (fee >= 100) {
      return formatNumber(fee, this.locale, '1.0-0');
    } else if (fee < 10) {
      return formatNumber(fee, this.locale, '1.2-2');
    }

    return formatNumber(fee, this.locale, '1.1-1');
  }
}
