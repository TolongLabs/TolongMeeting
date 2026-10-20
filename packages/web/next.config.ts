import type { NextConfig } from 'next'

const config: NextConfig = {
  // A spec that builds the site while another build runs in this folder sets this to a folder of its own.
  ...(process.env.TM_NEXT_DIST_DIR && { distDir: process.env.TM_NEXT_DIST_DIR })
}

export default config
