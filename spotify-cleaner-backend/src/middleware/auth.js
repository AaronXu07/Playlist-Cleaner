import jwt from 'jsonwebtoken'

export default function requireAuth(req, res, next) {
  const token = req.cookies?.session

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    req.user = { userId: payload.userId, spotifyId: payload.spotifyId }
    next()
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'Invalid or expired session' })
    }
    throw err
  }
}
