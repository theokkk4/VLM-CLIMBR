// GET /api/models — can the configured key use SAM 3.1 and ViTPose+? Free: it only lists models.
import { checkKey } from '../server/core.mjs'

export default async function handler(_req, res) {
  res.status(200).json(await checkKey())
}
