import { defineConfig } from 'vite';
import { copyFile } from 'wpsjs/vite_plugins';
import { serveSharedFiles } from '../shared-assets.js';

export default defineConfig({
  base: './',
  plugins: [
    serveSharedFiles(),
    copyFile({ src: '../../ribbon.xml', dest: 'ribbon.xml' }),
    copyFile({ src: '../../main.js', dest: 'main.js' }),
    copyFile({ src: '../../panel.html', dest: 'panel.html' }),
    copyFile({ src: '../../panel.js', dest: 'panel.js' }),
    copyFile({ src: '../../panel.css', dest: 'panel.css' }),
  ],
  server: {
    host: '0.0.0.0',
  },
});
