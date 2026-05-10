export class ScoreSystem {
  private totalScore = 0;
  private comboScore = 0;
  private nextBossThreshold = 480;

  private readonly bossThresholdStep = 1200;
  private readonly comboBonusCap = 0.8;
  private readonly comboBonusScale = 250;
  private readonly enemyKillBaseScore = 8;
  private readonly enemyKillPerHealthScore = 1;
  private readonly bulletClearScore = 2;
  private readonly bossKillScore = 150;
  private readonly reverseScore = 120;

  reset() {
    this.totalScore = 0;
    this.comboScore = 0;
    this.nextBossThreshold = this.bossThresholdStep;
  }

  getTotalScore(): number {
    return this.totalScore;
  }

  getComboScore(): number {
    return this.comboScore;
  }

  getVisibleScore(): number {
    return this.totalScore + this.comboScore;
  }

  getNextBossThreshold(): number {
    return this.nextBossThreshold;
  }

  addEnemyKill(maxHealth: number): number {
    const points = this.enemyKillBaseScore + Math.max(0, Math.round(maxHealth)) * this.enemyKillPerHealthScore;
    this.comboScore += points;
    return points;
  }

  addBulletClear(count = 1): number {
    const safeCount = Math.max(0, Math.floor(count));
    if (safeCount <= 0) {
      return 0;
    }

    const points = safeCount * this.bulletClearScore;
    this.comboScore += points;
    return points;
  }

  addBossKill(): number {
    this.comboScore += this.bossKillScore;
    return this.bossKillScore;
  }

  addReverse(): number {
    this.comboScore += this.reverseScore;
    return this.reverseScore;
  }

  bankCombo(): number {
    if (this.comboScore <= 0) {
      return 0;
    }

    const banked = Math.round(this.comboScore * this.getComboBonusMultiplier());
    this.totalScore += banked;
    this.comboScore = 0;
    return banked;
  }

  // Clear the pending combo slot (visible +value). Called by game when an
  // interrupt should immediately wipe any unbanked combo points.
  clearComboSlot() {
    this.comboScore = 0;
  }

  getComboBonusMultiplier(): number {
    return 1 + Math.min(this.comboBonusCap, this.comboScore / this.comboBonusScale);
  }

  shouldTriggerBoss(): boolean {
    return this.totalScore >= this.nextBossThreshold;
  }

  advanceBossThreshold() {
    this.nextBossThreshold += this.bossThresholdStep;
  }
}