// GET /api/health — is the server up, is a key configured, can it take uploads.
import { health } from '../server/core.mjs'

export default function handler(_req, res) {
  res.status(200).json(health())
}
