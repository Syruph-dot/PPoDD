import type { PlayerSide } from '../../entities/types';

export const MAX_ENEMY_SLOTS = 8;
export const MAX_BULLET_SLOTS = 12;

export const MOVE_LABELS = [
  'stay',
  'left',
  'right',
  'up',
  'down',
  'up-left',
  'up-right',
  'down-left',
  'down-right',
] as const;

export const FIRE_LABELS = ['keepGun', 'stopGun'] as const;
export const SKILL_LABELS = ['none', 'skill1', 'skill2', 'skill3', 'skill4', 'bomb'] as const;

export function sideToOneHot(side?: PlayerSide | null): [number, number] {
  return side === 'left' ? [1, 0] : [0, 1];
}

function pushRepeatedNames(target: string[], prefix: string, count: number, fields: string[]) {
  for (let slot = 0; slot < count; slot += 1) {
    const slotLabel = `${prefix}_${String(slot + 1).padStart(2, '0')}`;
    for (const field of fields) {
      target.push(`${slotLabel}_${field}`);
    }
  }
}

export function buildPolicyFeatureNames(): string[] {
  const names: string[] = [];

  names.push('side_left', 'side_right');

  names.push(
    'self_x',
    'self_y',
    'self_vx',
    'self_vy',
    'self_health',
    'self_bombs',
    'self_current_charge',
    'self_charge_max',
    'self_is_charging',
  );

  names.push(
    'opponent_x',
    'opponent_y',
    'opponent_vx',
    'opponent_vy',
    'opponent_health',
    'opponent_bombs',
    'opponent_current_charge',
    'opponent_charge_max',
    'opponent_is_charging',
  );

  names.push(
    'boss_present',
    'boss_x',
    'boss_y',
    'boss_width',
    'boss_height',
    'boss_health_ratio',
    'boss_can_take_damage',
    'boss_side_left',
    'boss_side_right',
  );

  names.push(
    'arena_screen_width',
    'arena_screen_height',
    'arena_margin',
    'arena_current_threat',
    'arena_nearby_bullet_count',
    'arena_decision_interval_ms',
  );

  pushRepeatedNames(names, 'enemy', MAX_ENEMY_SLOTS, [
    'present',
    'dx',
    'dy',
    'width',
    'height',
    'health_ratio',
  ]);

  pushRepeatedNames(names, 'bullet', MAX_BULLET_SLOTS, [
    'present',
    'dx',
    'dy',
    'vx',
    'vy',
    'width',
    'height',
    'damage',
    'is_beam_like',
    'is_warning',
    'can_be_destroyed',
    'is_circular',
    'category_barrage',
    'category_player1',
    'category_player2',
  ]);

  return names;
}