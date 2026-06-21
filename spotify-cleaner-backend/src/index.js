import 'dotenv/config'
import express from 'express'
import cookieParser from 'cookie-parser'
import authRoutes from './routes/auth.js'
import apiRoutes from './routes/api.js'
import { startPollingEngine } from './lib/poller.js'

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(cookieParser())

// CORS — allow requests from the frontend dev server.
// Accept both 127.0.0.1 and localhost so either browser address works.
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
].filter(Boolean)

app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }
  next()
})

// Routes
app.use('/auth', authRoutes)
app.use('/api', apiRoutes)

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.listen(PORT, async () => {
  console.log(`Server running on http://127.0.0.1:${PORT}`)
  await startPollingEngine()
})