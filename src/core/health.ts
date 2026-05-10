const HEALTH_EPSILON = 1e-9;

export function normalizeHealth(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  // 先规整到整数（捕捉因浮点运算导致的 ±1ulp 整数偏差）
  const nearestInteger = Math.round(value);
  if (Math.abs(value - nearestInteger) < HEALTH_EPSILON) {
    return nearestInteger;
  }

  // 再规整到 2 位小数：游戏内所有伤害值最多 2 位小数（0.6, 93.75），
  // 此举消除 IEEE 754 显示噪声（如 1.4000000000000002 → 1.4）并防止误差累积
  return Math.round(value * 100) / 100;
}