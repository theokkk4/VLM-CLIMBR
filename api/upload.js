// POST /api/upload — hands the browser a short-lived token to put a clip in
// Vercel Blob. Clips are far bigger than a function's 4.5 MB request body, so
// they go to storage first and /api/analyze reads them from there.
import { handleUpload } from '@vercel/blob/client'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  try {
    const json = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'],
        maximumSizeInBytes: 500 * 1024 * 1024,
        addRandomSuffix: true,
      }),
      onUploadCompleted: async () => {},
    })
    res.status(200).json(json)
  } catch (err) {
    res.status(400).json({ error: err.message ?? String(err) })
  }
}
