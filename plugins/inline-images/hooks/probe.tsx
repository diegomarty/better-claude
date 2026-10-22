// The surface module of a probe: an unpainted region as tall as the block of an answer it stands
// in, that says how many rows the block was laid out in, so the hooks module knows where each block
// is and can float a card over the rows above or below one.
import type { ClientModule } from 'claude-code'

const LOOK_MS = 100

const Probe: ClientModule<null, { rows: number }> = (props, surface) => {
  if (surface.state === undefined) {
    surface.setState({ rows: -1 })
    surface.every(LOOK_MS, () => {
      // A region not laid out yet (0 rows) says nothing.
      if (surface.rows === 0 || surface.rows === surface.state?.rows) return
      surface.setState({ rows: surface.rows })
      surface.post({ rows: surface.rows })
    })
  }
  const { Box } = surface.elements
  return <Box />
}

export default Probe
