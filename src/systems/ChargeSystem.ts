export interface ChargeThresholds {
  level1: number;
  level2: number;
  level3: number;
}

export class ChargeSystem {
  // 初始给予少量可用蓄力，避免按住蓄力键无响应的糟糕体验
  private chargeMax = 20;
  private currentCharge = 0;
  private readonly thresholds: ChargeThresholds = {
    level1: 20,
    level2: 40,
    level3: 60
  };
  private readonly maxCharge = 80;
  // 将蓄力速度降低为当前值的 66%（按用户请求缩减）
  private readonly holdChargeRate = 0.05 * 0.66 * 0.66;

  constructor() {
    // ensure gauge accumulation lower bound equals first-level threshold
    this.chargeMax = this.thresholds.level1;
  }

  getChargeMax(): number {
    return this.chargeMax;
  }

  getCurrentCharge(): number {
    return Math.floor(this.currentCharge);
  }

  getMaxChargeCap(): number {
    return this.maxCharge;
  }

  getThresholds(): ChargeThresholds {
    return this.thresholds;
  }

  getHoldChargeRate(): number {
    return this.holdChargeRate;
  }

  getHoldDurationMsForLevel(level: number): number {
    if (this.holdChargeRate <= 0) return 0;

    let target = 0;
    switch (level) {
      case 1:
        target = this.thresholds.level1;
        break;
      case 2:
        target = this.thresholds.level2;
        break;
      case 3:
        target = this.thresholds.level3;
        break;
      case 4:
        target = this.maxCharge;
        break;
      default:
        return 0;
    }

    // ceil avoids releasing one frame too early when charge updates are discrete.
    return Math.ceil(target / this.holdChargeRate);
  }

  getLevel(): number {
    const charge = this.currentCharge;
    if (charge >= 80) return 4;
    if (charge >= this.thresholds.level3) return 3;
    if (charge >= this.thresholds.level2) return 2;
    if (charge >= this.thresholds.level1) return 1;
    return 0;
  }

  addCharge(amount: number) {
    this.chargeMax = Math.min(this.chargeMax + amount, this.maxCharge);
    // never let gauge accumulation drop below first-level threshold
    if (this.chargeMax < this.thresholds.level1) this.chargeMax = this.thresholds.level1;
  }

  consumeCharge(amount: number): boolean {
    if (this.chargeMax >= amount) {
      this.chargeMax = Math.max(this.chargeMax - amount, this.thresholds.level1);
      return true;
    }
    return false;
  }

  startCharging() {
    this.currentCharge = 0;
  }

  addChargeFromHold(deltaTime: number) {
    // hold-charge (按住 Z 的蓄力值) should not exceed the current accumulated gauge
    // i.e. holding can only build up to what the player has accumulated.
    this.currentCharge = Math.min(this.currentCharge + deltaTime * this.holdChargeRate, this.chargeMax);
  }

  releaseCharge(): number {
    const level = this.getLevel();
    this.currentCharge = 0;
    return level;
  }

  resetCurrentCharge() {
    this.currentCharge = 0;
  }
}
