import type { NextConfig } from 'next'

const dev = process.env.NODE_ENV !== 'production'

// The remote sign-in view runs noVNC, so its page gets a tight policy of its own. It may load scripts and styles from
// this site only, talk to this site only (its WebSocket is `/vnc/<session>/websockify` on the same origin) and show
// `data:` images (noVNC draws the remote cursor with one). Next's own bootstrap script is inline, which is why
// `script-src` allows `'unsafe-inline'`; the page shows no member-written HTML. Development also needs `eval` and
// the hot-reload WebSocket.
const signinPolicy = [
  "default-src 'none'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ')

const config: NextConfig = {
  // A spec that builds the site while another build runs in this folder sets this to a folder of its own.
  ...(process.env.TM_NEXT_DIST_DIR && { distDir: process.env.TM_NEXT_DIST_DIR }),
  async headers() {
    return [
      { source: '/accounts/:identityId/signin', headers: [{ key: 'Content-Security-Policy', value: signinPolicy }] }
    ]
  }
}

export default config
