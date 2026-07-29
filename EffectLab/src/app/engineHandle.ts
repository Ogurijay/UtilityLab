import type { Engine } from '../core/engine'

let current: Engine | null = null

export function setEngine(engine: Engine | null) {
  current = engine
}

export function getEngine() {
  return current
}
