import { mixHex } from './geometry'
import { LIMB_BY_KEY, type Session } from './types'

/** A used hold, coloured by the limbs that touched it — blended where several did. */
export function holdFill(s: Session, id: number): string {
  const limbs = [...new Set(s.moves.filter((m) => m.holdId === id).map((m) => m.limb))]
  return limbs.length ? mixHex(limbs.map((l) => LIMB_BY_KEY[l].color)) : '#ffffff'
}
