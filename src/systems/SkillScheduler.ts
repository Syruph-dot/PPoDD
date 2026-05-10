import { Game } from '../core/Game';
import { Player } from '../core/Player';

export type SkillId = 'none' | 'skill1' | 'skill2' | 'skill3' | 'skill4' | 'bomb' | 'shoot';

export class SkillScheduler {
  // Trigger a high-level skill. Returns the executed skill id or 'none' if nothing executed.
  triggerSkill(skill: SkillId, player: Player, game: Game): SkillId {
    if (!player) return 'none';

    const avail = player.getAvailableSkills();

    if (skill === 'none') return 'none';

    if (skill === 'bomb') {
      if (avail.bomb) {
        player.useBomb(game);
        return 'bomb';
      }
      return 'none';
    }

    if (skill === 'shoot') {
      // shoot is a fallback short press
      player.shoot(game);
      return 'shoot';
    }

    // skillN mapping
    if (skill.startsWith('skill')) {
      const n = parseInt(skill.replace('skill', ''), 10);
      if (isNaN(n) || n < 1 || n > 4) return 'none';

      // map availability: skill1..skill4
      const mapping = [false, avail.skill1, avail.skill2, avail.skill3, avail.skill4];
      if (!mapping[n]) return 'none';

      const ok = player.executeSkill(n, game);
      return ok ? (('skill' + n) as SkillId) : 'none';
    }

    return 'none';
  }

  // Convenience: returns an ordered array of booleans matching ['skill1','skill2','skill3','skill4','bomb']
  buildMask(player: Player): boolean[] {
    const avail = player.getAvailableSkills();
    return [avail.skill1, avail.skill2, avail.skill3, avail.skill4, avail.bomb];
  }
}
