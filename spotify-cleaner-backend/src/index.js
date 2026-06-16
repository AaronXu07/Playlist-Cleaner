import 'dotenv/config'
import express from 'express'
import cookieParser from 'cookie-parser'
import authRoutes from './routes/auth.js'

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(cookieParser())

// CORS — allow requests from the frontend dev server
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  next()
})

// Routes
app.use('/auth', authRoutes)

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.listen(PORT, () => {
  console.log(`Server running on http://127.0.0.1:${PORT}`)
})