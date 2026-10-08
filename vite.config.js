import { defineConfig } from 'vite';
import { prepareSite } from './src/site/site.js';

export default defineConfig(async () => {
  const site = await prepareSite();
  return {
    base: site.config.base,
    publicDir: '.generated/public',
    plugins: [{
      name: 'static-webcards',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html
          .replace('lang="en"', `lang="${site.config.language}" data-theme="${site.config.theme}"`)
          .replace('<!--site-head-->', site.head)
          .replace('<!--site-body-->', site.body)
      },
      configureServer(server) {
        server.watcher.add(['cards', 'site.config.json']);
        server.watcher.on('change', async (path) => {
          if (!path.includes('/cards/') && !path.endsWith('site.config.json')) return;
          try {
            Object.assign(site, await prepareSite());
            server.ws.send({ type: 'full-reload' });
          } catch (error) {
            server.config.logger.error(error.message);
            server.ws.send({ type: 'error', err: { message: error.message, stack: error.stack } });
          }
        });
      }
    }]
  };
});
