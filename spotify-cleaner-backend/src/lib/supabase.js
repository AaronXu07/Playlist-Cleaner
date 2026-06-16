import { createClient } from '@supabase/supabase-js'

// Use a lazy getter so the client isn't created until after dotenv has loaded
let _client = null

function getSupabase() {
  if (!_client) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env')
    }
    _client = createClient(url, key)
  }
  return _client
}

export default getSupabase