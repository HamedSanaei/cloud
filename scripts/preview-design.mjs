import { createServer } from 'vite'
import { fixture } from '../test/fixtures.mjs'

// Explicit opt-in, loopback-only fixture preview. Never uses production credentials or services.
const server = await createServer({
  define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/__design_preview__') },
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  plugins: [{ name: 'isolated-design-preview', transformIndexHtml() {
    return [{ tag: 'aside', attrs: { style: 'position:fixed;bottom:0;left:0;right:0;z-index:10000;padding:6px;background:#fff7cc;color:#111827;text-align:center;font:12px Tahoma', role: 'note', dir: 'rtl' }, children: 'پیش‌نمایش طراحی — تمام اطلاعات و موجودی‌ها آزمایشی هستند؛ بدون اتصال به سرویس واقعی.', injectTo: 'body' }]
  }, configureServer(vite) {
    vite.middlewares.use('/__design_preview__', (req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(fixture((req.url ?? '/').split('?')[0])))
    })
    vite.middlewares.use('/', (_req, res, next) => { res.setHeader('X-Design-Preview', 'synthetic-fixtures-no-real-services'); next() })
  } }],
})
await server.listen()
server.printUrls()
