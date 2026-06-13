// Placed solar farms — a thin model + localStorage persistence so a company's
// planned farms survive page reloads (per browser/device).

export type FarmClass = "good" | "okay" | "bad" | "excluded"

export interface Farm {
  id: string
  lon: number
  lat: number
  area_m2: number
  cell_id: number | null
  cls: FarmClass // suitability class of the cell it sits on (never "excluded")
  dist_powerline_m: number | null // copied from the host cell for the cost model
  ghi: number | null // host cell annual GHI (J/m²/yr) for the energy baseline
  created: number // epoch ms
}

const KEY = "solario.farms.v1"

export function loadFarms(): Farm[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Farm[]) : []
  } catch {
    return []
  }
}

export function saveFarms(farms: Farm[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(farms))
  } catch {
    /* storage full / disabled — keep running with in-memory state only */
  }
}

export function newFarmId(): string {
  return `farm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}
