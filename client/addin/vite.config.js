import { defineConfig } from 'vite';
import { copyFile } from 'wpsjs/vite_plugins';

export default defineConfig({
  base: './',
  plugins: [
    copyFile({ src: 'ribbon.xml' }),
    copyFile({ src: 'main.js' }),
    copyFile({ src: 'panel.html' }),
    copyFile({ src: 'panel.js' }),
    copyFile({ src: 'panel.css' }),
  ],
  server: {
    host: '0.0.0.0',
  },
});
