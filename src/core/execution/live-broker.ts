/**
 * The live trading layer.
 *
 * It exists now, with the real shape of the thing, and it is HARD OFF. Three
 * independent gates must all be satisfied before a single order could be sent,
 * and any one of them failing throws rather than silently degrading:
 *
 *   1. LIVE_TRADING_ENABLED must be explicitly true in the config.
 *   2. An API key and secret must be present.
 *   3. The in-process kill switch must not be engaged.
 *
 * Three gates rather than one because the failure mode here is not a bug
 * report, it is money. A single flag can be flipped by a typo in an env file;
 * three cannot be crossed by accident.
 *
 * Two further rules the spec sets and this file encodes:
 *
 *   - THE API KEY MUST NOT HAVE WITHDRAWAL PERMISSION. That cannot be enforced
 *     from here — it is set on the exchange — so `preflight()` states it as a
 *     requirement the operator must verify, and refuses to report "ready"
 *     without an explicit acknowledgement.
 *
 *   - STOPS ARE PLACED ON THE EXCHANGE, not held in this process. A stop that
 *     lives only in a bot's memory does not exist during the network outage,
 *     the crash, or the deploy — which is exactly when it is needed.
 */
import type { AppConfig } from "@/shared/config";
import { createLogger } from "@/shared/logger";
import type { Direction } from "@/core/types";

const log = createLogger("live-broker");

export type LiveOrderKind = "market" | "limit" | "stop_market" | "stop_limit";

export interface LiveOrderRequest {
  readonly symbol: string;
  readonly side: "buy" | "sell";
  readonly kind: LiveOrderKind;
  readonly quantity: number;
  readonly price?: number;
  readonly stopPrice?: number;
  /** Ties the order to the recommendation that caused it. */
  readonly clientOrderId: string;
  readonly reduceOnly?: boolean;
}

export interface LiveOrderResult {
  readonly accepted: boolean;
  readonly exchangeOrderId: string | null;
  readonly reason: string;
}

export class LiveTradingDisabledError extends Error {
  constructor(reason: string) {
    super(`التداول الحقيقي معطّل: ${reason}`);
    this.name = "LiveTradingDisabledError";
  }
}

export interface PreflightReport {
  readonly ready: boolean;
  readonly checks: readonly { id: string; passed: boolean; arabic: string }[];
  readonly arabic: string;
}

/**
 * The live broker.
 *
 * Every method that could place an order calls `assertEnabled()` first. There
 * is deliberately no "dry run" mode here that silently does nothing: a method
 * that pretends to work is worse than one that refuses, because the caller
 * cannot tell the difference.
 */
export class LiveBroker {
  /** Engaged in-process. Survives nothing — that is the point of a kill switch. */
  private killSwitch = false;
  private killReason: string | null = null;
  /** The operator's explicit statement that the key cannot withdraw. */
  private withdrawalPermissionAcknowledged = false;

  constructor(private readonly cfg: AppConfig) {}

  get enabled(): boolean {
    return (
      this.cfg.LIVE_TRADING_ENABLED &&
      Boolean(this.cfg.LIVE_EXCHANGE_API_KEY) &&
      Boolean(this.cfg.LIVE_EXCHANGE_API_SECRET) &&
      !this.killSwitch
    );
  }

  /** Stop everything, now. Reversible only by an explicit call. */
  engageKillSwitch(reason: string): void {
    this.killSwitch = true;
    this.killReason = reason;
    log.error("KILL SWITCH ENGAGED", { reason });
  }

  releaseKillSwitch(): void {
    log.warn("kill switch released", { previousReason: this.killReason });
    this.killSwitch = false;
    this.killReason = null;
  }

  get killSwitchEngaged(): boolean {
    return this.killSwitch;
  }

  /**
   * The operator confirms, out of band, that the API key has no withdrawal
   * permission. We cannot verify this from here — only the exchange knows —
   * so it is recorded as an explicit human assertion rather than assumed.
   */
  acknowledgeWithdrawalPermissionDisabled(): void {
    this.withdrawalPermissionAcknowledged = true;
  }

  private assertEnabled(): void {
    if (!this.cfg.LIVE_TRADING_ENABLED) {
      throw new LiveTradingDisabledError("LIVE_TRADING_ENABLED غير مفعّل في الإعدادات");
    }
    if (!this.cfg.LIVE_EXCHANGE_API_KEY || !this.cfg.LIVE_EXCHANGE_API_SECRET) {
      throw new LiveTradingDisabledError("لا يوجد مفتاح أو سرّ للمنصّة");
    }
    if (this.killSwitch) {
      throw new LiveTradingDisabledError(`مفتاح الإيقاف الفوري مفعّل — ${this.killReason ?? "بلا سبب مسجّل"}`);
    }
    if (!this.withdrawalPermissionAcknowledged) {
      throw new LiveTradingDisabledError(
        "لم يُؤكَّد أن مفتاح المنصّة بلا صلاحية سحب. " +
          "هذا شرط لا يمكن التحقّق منه برمجياً — راجع إعدادات المفتاح على المنصّة ثم أكّده صراحةً.",
      );
    }
  }

  /** What would have to be true before a single order could be sent. */
  preflight(): PreflightReport {
    const checks = [
      {
        id: "config_enabled",
        passed: this.cfg.LIVE_TRADING_ENABLED,
        arabic: this.cfg.LIVE_TRADING_ENABLED
          ? "LIVE_TRADING_ENABLED مفعّل"
          : "LIVE_TRADING_ENABLED معطّل — وهذا هو الوضع الافتراضي والصحيح حتى تُراجَع نتائج التداول الورقي",
      },
      {
        id: "credentials",
        passed: Boolean(this.cfg.LIVE_EXCHANGE_API_KEY && this.cfg.LIVE_EXCHANGE_API_SECRET),
        arabic: this.cfg.LIVE_EXCHANGE_API_KEY
          ? "مفتاح المنصّة موجود"
          : "لا يوجد مفتاح للمنصّة",
      },
      {
        id: "no_withdrawal_permission",
        passed: this.withdrawalPermissionAcknowledged,
        arabic: this.withdrawalPermissionAcknowledged
          ? "أُكّد أن المفتاح بلا صلاحية سحب"
          : "لم يُؤكَّد بعد أن المفتاح بلا صلاحية سحب — لا يمكن للبرنامج التحقّق من ذلك، وهو مسؤوليتك على المنصّة",
      },
      {
        id: "kill_switch",
        passed: !this.killSwitch,
        arabic: this.killSwitch ? `مفتاح الإيقاف الفوري مفعّل: ${this.killReason}` : "مفتاح الإيقاف الفوري غير مفعّل",
      },
    ];

    const ready = checks.every((c) => c.passed);
    return {
      ready,
      checks,
      arabic: ready
        ? "كل شروط التداول الحقيقي متحقّقة. راجع نتائج التداول الورقي قبل التفعيل."
        : `التداول الحقيقي غير جاهز: ${checks.filter((c) => !c.passed).map((c) => c.arabic).join(" · ")}`,
    };
  }

  /**
   * Place an entry order. Throws unless all gates pass.
   *
   * The exchange call itself is intentionally not implemented: wiring a real
   * order path before the paper results justify it would be building the one
   * part of this system that can lose money on the strength of untested logic.
   */
  async placeEntry(_order: LiveOrderRequest): Promise<LiveOrderResult> {
    this.assertEnabled();
    throw new LiveTradingDisabledError(
      "مسار إرسال الأوامر لم يُنفَّذ بعد عمداً. " +
        "لن يُوصَل قبل مراجعة نتائج التداول الورقي على فترة كافية.",
    );
  }

  /**
   * Place the protective stop ON THE EXCHANGE.
   *
   * Separate from the entry and mandatory: a stop held in this process does
   * not exist during a crash, a deploy, or a network partition — precisely
   * the moments it matters most.
   */
  async placeProtectiveStop(
    _symbol: string,
    _direction: Direction,
    _quantity: number,
    _stopPrice: number,
    _clientOrderId: string,
  ): Promise<LiveOrderResult> {
    this.assertEnabled();
    throw new LiveTradingDisabledError("مسار وقف المنصّة لم يُنفَّذ بعد عمداً");
  }

  async cancelAll(_symbol?: string): Promise<number> {
    this.assertEnabled();
    throw new LiveTradingDisabledError("مسار الإلغاء لم يُنفَّذ بعد عمداً");
  }

  /** Arabic status line for the settings page. */
  statusAr(): string {
    if (this.killSwitch) return `متوقّف فوراً — ${this.killReason}`;
    if (!this.cfg.LIVE_TRADING_ENABLED) return "معطّل — التنفيذ ورقي بالكامل";
    if (!this.cfg.LIVE_EXCHANGE_API_KEY) return "مفعّل في الإعدادات لكن بلا مفتاح";
    if (!this.withdrawalPermissionAcknowledged) return "بانتظار تأكيد أن المفتاح بلا صلاحية سحب";
    return "جاهز — لكن مسار الأوامر غير موصول بعد";
  }
}
